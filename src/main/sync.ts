import { createHash } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { SCHEDULE_FILE, parseSchedule, type InboxAction, type InboxItem, type SyncStatus } from '../shared/types'
import {
  clearSyncMark,
  getCourses,
  getDeadlines,
  getInboxDone,
  getSyncConfig,
  getSyncMark,
  getSyncOutcome,
  getTodos,
  markInboxDone,
  setSyncOutcome,
  readNote,
  setSyncMark,
} from './store'

/**
 * Deadlines and classes onto Google Calendar, so the phone gets notifications.
 *
 * Tartan is not a server and cannot be awake at 9am the day a pset is due. Google can. So the
 * only job here is to POST the semester to an Apps Script web app that runs as the user and
 * writes real events with real reminders; everything that has to happen while the laptop is
 * shut happens on Google's side.
 *
 * Two rules the whole design hangs on:
 *  - Only POST when something actually changed. A hash of the payload is compared against the
 *    last one Google accepted, so opening the app fifty times costs zero requests.
 *  - Every id Tartan sends round-trips through the event description, so a re-sync updates the
 *    event it made last time instead of laying a second one on top of it.
 */

interface DeadlinePayload {
  id: string
  title: string
  course: string
  kind: string
  due: string
  done: boolean
  notes: string
}

interface ClassPayload {
  id: string
  code: string
  title: string
  day: number
  start: string
  end: string
  location: string
  /** YYYY-MM-DD. Defaults to the term bounds; narrower for a mini course. */
  from: string
  until: string
}

interface TodoPayload {
  id: string
  text: string
  course: string
  due: string
  done: boolean
}

interface Payload {
  secret: string
  termStart: string
  termEnd: string
  classesHash: string
  classes: ClassPayload[]
  deadlines: DeadlinePayload[]
  todos: TodoPayload[]
  /**
   * Every space code, so the phone page can recognise a "research: " prefix the way it recognises
   * "cs101: " — without this list it would have to guess which title prefixes are tags.
   */
  codes: string[]
}

/** Long enough to absorb a run of checkbox ticks, short enough that you never wait for it. */
const DEBOUNCE_MS = 5000
const TIMEOUT_MS = 60_000

let lastError: string | null = null
let lastSummary: string | null = null
/**
 * Read from disk once, lazily. NOT at module scope: this file is imported before loadConfig() runs
 * in whenReady, so an eager read would seed both from an empty config and quietly discard the
 * failure it exists to preserve.
 */
let hydrated = false
function hydrateOutcome(): void {
  if (hydrated) return
  hydrated = true
  const saved = getSyncOutcome()
  lastError = saved.error
  lastSummary = saved.summary
}
let timer: NodeJS.Timeout | null = null
let running: Promise<SyncStatus> | null = null
let queued = false

/**
 * The id is echoed back to us inside the event description, so it has to survive a round trip
 * through a whitespace-delimited marker. ICS UIDs are the only ids we do not generate ourselves.
 */
const tagOf = (id: string): string => id.replace(/\s+/g, '_')

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

async function buildPayload(): Promise<Payload> {
  const { secret, termStart, termEnd } = getSyncConfig()
  const [courses, deadlines, todos, scheduleText] = await Promise.all([
    getCourses(),
    getDeadlines(),
    getTodos(),
    readNote(SCHEDULE_FILE),
  ])
  const byId = new Map(courses.map((c) => [c.id, c]))

  const classes: ClassPayload[] = parseSchedule(scheduleText).map((m) => {
    const course = byId.get(m.courseId)
    return {
      // Stable across syncs so a schedule that did not change is not rebuilt.
      id: `class-${tagOf(m.courseId)}-${m.day}-${m.start.replace(':', '')}`,
      code: course?.code ?? m.courseId,
      title: course?.title ?? '',
      day: m.day,
      start: m.start,
      end: m.end,
      location: m.location,
      // A mini course occupies the same slot as another for half the term, so its series has to
      // stop at the mini boundary rather than at the term boundary.
      from: m.from ?? termStart,
      until: m.until ?? termEnd,
    }
  })

  return {
    secret,
    termStart,
    termEnd,
    // Classes are rebuilt wholesale, so they get their own hash — a new pset must not churn
    // twenty recurring series.
    classesHash: hash({ classes, termStart, termEnd }),
    classes,
    deadlines: deadlines.map((d) => ({
      id: tagOf(d.id),
      title: d.title,
      course: d.courseId ? (byId.get(d.courseId)?.code ?? '') : '',
      kind: d.kind,
      due: d.due,
      done: d.done,
      notes: d.notes ?? '',
    })),
    todos: todos.map((t) => ({
      id: tagOf(t.id),
      text: t.text,
      course: t.courseId ? (byId.get(t.courseId)?.code ?? '') : '',
      due: t.due ?? '',
      done: t.done,
    })),
    codes: courses.map((c) => c.code),
  }
}

/** A new address starts clean: the last error and success line were about the old one. */
export function forgetOutcome(): void {
  hydrated = true
  lastError = null
  lastSummary = null
  setSyncOutcome(null, null)
}

export function syncStatus(): SyncStatus {
  hydrateOutcome()
  const cfg = getSyncConfig()
  return {
    ...cfg,
    at: getSyncMark().at,
    // With no URL the card says "Not set up yet." — a red error or a success line beside that is
    // about an address that is gone.
    error: cfg.url ? lastError : null,
    last: cfg.url ? lastSummary : null,
    busy: running !== null,
    dirty: false,
  }
}

/** Reads the payload back so the UI can say "there is something to send" without sending it. */
export async function syncStatusFresh(): Promise<SyncStatus> {
  const status = syncStatus()
  if (!status.url) return status
  try {
    const { secret: _secret, ...rest } = await buildPayload()
    status.dirty = hash(rest) !== getSyncMark().hash
  } catch {
    // A status line is not worth failing over.
  }
  return status
}

/** The URL as a web address, or null for anything Node would only answer with "Invalid URL". */
function webAddress(text: string): URL | null {
  try {
    const u = new URL(text)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

/**
 * The real window. Not getAllWindows()[0], which can be the quick-capture window; that one is the
 * only page loaded with #capture (index.ts tracks it by identity, but cannot be imported from here).
 */
export const mainWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.getURL().endsWith('#capture'))

/** Never throws. A failed sync is a line in Settings, not a crashed app. */
async function run(force: boolean): Promise<SyncStatus> {
  // Before the first write below: the lazy load in syncStatus() would otherwise overwrite this
  // run's outcome with the saved one, so the first sync after launch could never show its error.
  hydrateOutcome()
  const { url } = getSyncConfig()
  if (!url) {
    lastError = null
    lastSummary = null
    return syncStatus()
  }

  // Apps Script's deployment links end in /exec; anything else is usually the editor or a /dev test URL.
  let oddPath = false
  try {
    const address = webAddress(url)
    if (!address) throw new Error('That is not a web address. Paste the /exec URL from Apps Script → Deploy.')
    oddPath = !address.pathname.endsWith('/exec')

    const payload = await buildPayload()
    if (!payload.secret) throw new Error('Set a shared secret first — it has to match the one in Script properties.')

    const { secret: _secret, ...rest } = payload
    const fingerprint = hash(rest)
    if (!force && fingerprint === getSyncMark().hash) {
      lastError = null
      return syncStatus()
    }

    /**
     * The payload is full desired state, so an empty one is an instruction to delete the entire
     * semester from Google — every deadline and every class series. And empty is indistinguishable
     * from missing: readJson returns [] on ENOENT and readNote returns ''. The data folder sits in
     * a Drive-synced path, so "briefly not there" is a thing that actually happens.
     *
     * Only guard once something has been synced before, so a genuinely fresh install still works,
     * and let `force` through as the deliberate escape hatch behind "Re-send everything".
     */
    if (!force && getSyncMark().hash && !payload.deadlines.length && !payload.classes.length) {
      throw new Error(
        'Refusing to sync an empty semester — the data folder looks empty or unreadable. Use "Re-send everything" if that is really what you want.',
      )
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `rebuild` rides outside the payload, so it never enters the fingerprint above. Clearing
      // the LOCAL hash is not enough to rebuild classes: Google keeps its own class hash, which
      // still matches, so "Re-send everything" could not restore a series deleted by hand — which
      // is the one thing its tooltip promises.
      body: JSON.stringify({ ...payload, rebuild: force }),
      // Apps Script answers /exec with a 302 to script.googleusercontent.com. doPost has already
      // run by then; the redirect only serves the response body, so following it is correct.
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Google returned HTTP ${res.status}. ${text.slice(0, 200)}`)

    let data: {
      ok?: boolean
      error?: string
      created?: number
      updated?: number
      deleted?: number
      classes?: string
      calendar?: string
      todos?: string
    }
    try {
      data = JSON.parse(text) as typeof data
    } catch {
      throw new Error(
        'Google returned a web page instead of JSON. The deployment is usually set to "Execute as: Me" and "Who has access: Anyone" — check both, and make sure the URL ends in /exec.',
      )
    }
    if (!data.ok) throw new Error(data.error ?? 'The script reported a failure with no reason.')

    setSyncMark(fingerprint, new Date().toISOString())
    lastSummary = [
      `${data.created ?? 0} added`,
      `${data.updated ?? 0} updated`,
      `${data.deleted ?? 0} removed`,
      `classes ${data.classes ?? 'unchanged'}`,
      data.todos ? `todos ${data.todos}` : '',
      data.calendar ? `→ ${data.calendar}` : '',
      oddPath ? 'the address does not end in /exec' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    lastError = null
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } }
    if (e.name === 'TimeoutError') {
      lastError = `No answer from Google in ${TIMEOUT_MS / 1000}s.`
    } else if (e.message === 'fetch failed') {
      // Node buries the real reason in `cause`, and "fetch failed" on its own tells you nothing
      // when the actual problem is a typo in the URL.
      const why = e.cause?.code ?? e.cause?.message ?? 'no further detail'
      lastError = `Could not reach that URL (${why}). Check it is the /exec link and that you are online.`
    } else {
      lastError = e.message
    }
    if (oddPath) lastError += ' The address does not end in /exec.'
  }
  return syncStatus()
}

/**
 * Serialised. Two overlapping runs would race on the same events, and a sync asked for while one
 * is in flight is collapsed into a single re-run afterwards — so a burst of edits still ends with
 * one request carrying the final state.
 */
export function syncNow(force = false): Promise<SyncStatus> {
  if (running) {
    queued = true
    return running
  }
  running = run(force).finally(() => {
    running = null
    // Outcome to disk on every attempt, success or failure. These were module variables, so a
    // sync that had been failing for days came back clean after a restart while the timestamp
    // beside it still showed the last success.
    setSyncOutcome(lastError, lastSummary)
    if (queued) {
      queued = false
      void syncNow(false)
    }
  })
  return running
}

/** Called from every handler that changes something Google is holding. */
export function scheduleSync(): void {
  if (!getSyncConfig().url) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void syncNow(false)
  }, DEBOUNCE_MS)
}

/** Is there a debounced sync still waiting, or one in flight? */
export const syncPending = (): boolean => timer !== null || running !== null

/**
 * Send anything still waiting, now. Ticking a pset and shutting the laptop inside the debounce
 * window used to drop the sync on the floor: the timer died with the process and Google never
 * heard, so the phone went on showing work that was already done.
 *
 * Bounded, because quitting must not hang on a dead network — a lost sync is recoverable on next
 * launch, a laptop that will not shut is not.
 */
export async function flushSync(timeoutMs = 4000): Promise<void> {
  if (!syncPending()) return
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  await Promise.race([
    syncNow(false).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

/** Next sync sends everything, whether or not Tartan thinks anything changed. */
export function resyncEverything(): Promise<SyncStatus> {
  clearSyncMark()
  return syncNow(true)
}

/* ------------------------------------------------------------------ inbox (phone → Tartan) */

/**
 * The phone can tick things off. Those actions queue on Google's side — the laptop is usually
 * shut — and Tartan collects them with a poll.
 *
 * The poll is deliberately NOT the sync POST. The sync POST returns early on an unchanged payload
 * hash, which is exactly the state the laptop is in while the phone is being used: piggy-backing
 * would deliver the queue only once the LAPTOP had already changed something, which is backwards.
 * A separate body shape on the same URL costs a few hundred bytes and no calendar work, and it
 * keeps the ack out of the fingerprint so acking can never force a full calendar re-sync.
 *
 * Nothing here writes to the data folder. Every applied action is handed to the window, which owns
 * deadlines.json and todos.json and is already their only writer. Two processes doing
 * read-modify-write on the same whole-file array is how a tick gets overwritten by a snapshot taken
 * before it — and the ack would then tell Google to forget the only remaining copy.
 */
const POLL_THROTTLE_MS = 60_000

let polling = false
let lastPollAt = 0
/**
 * null = not yet established. Keyed by URL: a fixed address is a different script, and a cache that
 * outlived the address left the inbox dead until quit. A redeploy at the SAME address still waits
 * for a relaunch.
 */
let inboxProbe: { url: string; ok: boolean } | null = null

/**
 * Refuse to poll a deployment that predates the inbox.
 *
 * This is not politeness, it is damage control. The old doPost has no `poll` branch: it would fall
 * straight through to sync(body), where `body.deadlines || []` turns a poll into a full desired
 * state of NOTHING — and Google would delete every deadline and every class series. The poll body
 * is small and innocent-looking and would wipe the calendar.
 *
 * The probe is a GET, which has no side effects on either version. Older deployments answer with a
 * different greeting, one containing "Writing to:"; current ones do not. So the absence of
 * "Writing to:" is the handshake, and it costs one request per launch.
 */
async function scriptSupportsInbox(url: string): Promise<boolean> {
  if (inboxProbe?.url === url) return inboxProbe.ok
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
    const text = await res.text()
    inboxProbe = { url, ok: res.ok && !text.includes('Writing to:') }
  } catch {
    // Unreachable proves nothing, so decline to poll and try again next launch.
    inboxProbe = null
    return false
  }
  return inboxProbe.ok
}

/**
 * The wire carries tagOf(id), which collapses whitespace and is therefore not invertible: the only
 * safe direction is to tag the local ids and compare. Two rows that tag to the same string resolve
 * to nothing at all rather than to a guess.
 */
function resolveTarget(target: string, rows: { id: string }[]): string | null {
  const hits = rows.filter((r) => tagOf(r.id) === target)
  return hits.length === 1 ? hits[0].id : null
}

/** Never throws. A failed poll is a line in Settings, exactly like a failed sync. */
export async function pollInbox(force = false): Promise<void> {
  const { url, secret } = getSyncConfig()
  if (!url || !secret || polling) return
  if (!force && Date.now() - lastPollAt < POLL_THROTTLE_MS) return
  polling = true
  hydrateOutcome()
  try {
    // Never send a poll to a script that would read it as "delete the semester".
    if (!(await scriptSupportsInbox(url))) return
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, poll: true, applied: getInboxDone() }),
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Google returned HTTP ${res.status}. ${text.slice(0, 200)}`)
    const data = JSON.parse(text) as { ok?: boolean; error?: string; queue?: InboxAction[] }
    if (!data.ok) throw new Error(data.error ?? 'The script reported a failure with no reason.')
    lastPollAt = Date.now()

    // Already applied once; Google has simply not been told yet, and this poll's ack does that.
    // The ledger is why an ack lost at quit costs nothing.
    const done = new Set(getInboxDone())
    const fresh = (data.queue ?? []).filter((a) => a?.id && !done.has(a.id))
    if (!fresh.length) return

    const [deadlines, todos] = await Promise.all([getDeadlines(), getTodos()])
    const items: InboxItem[] = fresh.map((a) => ({
      ...a,
      localId:
        a.kind === 'deadline.done'
          ? resolveTarget(a.target ?? '', deadlines)
          : a.kind === 'todo.done'
            ? resolveTarget(a.target ?? '', todos)
            : null,
    }))

    // No window means no writer. The actions stay unacked and arrive again next poll, which is the
    // safe direction: nothing is lost by waiting.
    mainWindow()?.webContents.send('inbox', items)
  } catch (err) {
    const e = err as Error
    lastError =
      e.name === 'TimeoutError'
        ? `Phone inbox: no answer from Google in ${TIMEOUT_MS / 1000}s.`
        : `Phone inbox: ${e.message}`
  } finally {
    polling = false
  }
}

/** The window reporting what it actually wrote to disk. Recorded before the next poll can ask. */
export const inboxApplied = (ids: string[]): void => markInboxDone(ids)
