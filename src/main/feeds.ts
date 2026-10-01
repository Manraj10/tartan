import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  EVENT_CAP,
  courseKeys,
  describeFetchError,
  guessKind,
  normalizeFeedUrl,
  parseCalendar,
  splitCanvasTitle,
  type IcsEvent,
} from './ical'
import { dataDir, getCourses, getDeadlines, getSubscriptions, setDeadlines } from './store'
import type { Deadline, FeedEvent, FeedStatus, ImportResult, Subscription } from '../shared/types'

/**
 * Subscribed calendars.
 *
 * Every fetch writes the raw .ics to disk before it is parsed, and every read falls back to that
 * cache. A calendar you cannot see on the campus wifi is worse than useless, and a feed that 404s
 * once should not erase a semester of dates from the screen.
 *
 * Expansion is windowed rather than total: an RRULE with no UNTIL is infinite, so the window is
 * what makes the work proportional to what is actually on screen.
 */

const cacheDir = (): string => path.join(dataDir(), '.cache', 'feeds')
const cacheFile = (id: string): string => path.join(cacheDir(), `${id}.ics`)
const metaFile = (): string => path.join(cacheDir(), 'status.json')

/** A year back and a year forward. Wide enough for "when was add/drop", bounded enough to stay fast. */
const WINDOW_BACK_DAYS = 365
const WINDOW_FWD_DAYS = 365
/** Work is imported from a month back: older than that is history, and it would all arrive overdue. */
const IMPORT_BACK_DAYS = 30
/** A feed that has not been refreshed in this long is refetched on launch. */
const STALE_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

/**
 * A deadline row as this module writes it: the subscription that made it rides along, so removing
 * or switching off a feed can take its unticked items with it. Not in shared/types yet, and
 * nothing else needs to read it.
 */
type FeedRow = Deadline & { subscriptionId?: string }

type StatusMap = Record<string, { at?: string; error?: string | null }>

async function readStatus(): Promise<StatusMap> {
  try {
    return JSON.parse(await fs.readFile(metaFile(), 'utf8')) as StatusMap
  } catch {
    return {}
  }
}

async function writeStatus(next: StatusMap): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true })
  const tmp = `${metaFile()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(tmp, metaFile())
}

/**
 * Fetch a feed's text. The one fetch both the subscription path and the one-shot import use, so the
 * same link gets the same timeout, the same headers and the same explanation when it fails.
 * Returns the error rather than throwing — one dead feed must not take the others down with it.
 */
async function fetchFeed(link: string): Promise<{ text: string } | { error: string }> {
  try {
    // Inside the try: a hand-edited entry with no url must fail that one feed, not reject them all.
    const target = normalizeFeedUrl(String(link ?? ''))
    if ('error' in target) return target
    const res = await fetch(target.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Some hosts serve a login page to a default user-agent and iCalendar to a calendar client.
      headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'Tartan/0.1 (personal student app)' },
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const text = await res.text()
    // Almost always an HTML login page behind a URL that needed a token.
    if (!text.includes('BEGIN:VCALENDAR')) {
      return { error: 'That URL did not return a calendar. Check it is the .ics feed link and not the web page.' }
    }
    return { text }
  } catch (err) {
    return { error: describeFetchError(err, FETCH_TIMEOUT_MS) }
  }
}

/** Fetch one feed into the cache. Returns the error string, or null once it is on disk. */
async function refreshOne(sub: Subscription): Promise<string | null> {
  const got = await fetchFeed(sub.url)
  if ('error' in got) return got.error
  try {
    await fs.mkdir(cacheDir(), { recursive: true })
    const tmp = `${cacheFile(sub.id)}.tmp`
    await fs.writeFile(tmp, got.text, 'utf8')
    await fs.rename(tmp, cacheFile(sub.id))
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/** Refreshes every enabled feed in parallel and records what happened to each. */
export async function refreshFeeds(only?: string): Promise<FeedStatus[]> {
  const subs = (await getSubscriptions()).filter((s) => s.enabled && (!only || s.id === only))
  const status = await readStatus()
  await Promise.all(
    subs.map(async (s) => {
      const error = await refreshOne(s)
      status[s.id] = error ? { ...status[s.id], error } : { at: new Date().toISOString(), error: null }
    }),
  )
  await writeStatus(status)
  return feedStatus()
}

/**
 * Refetch only what is missing or stale — a launch should not re-download an hour-old feed.
 * Returns how many feeds were actually fetched, so a caller can skip the re-import when nothing
 * moved. Cheap to call often: with nothing stale it is one small JSON read and no network.
 */
export async function refreshStaleFeeds(): Promise<number> {
  const subs = (await getSubscriptions()).filter((s) => s.enabled)
  if (!subs.length) return 0
  const status = await readStatus()
  const now = Date.now()
  const due = subs.filter((s) => {
    const at = status[s.id]?.at
    if (!at) return true
    const age = now - Date.parse(at)
    return !Number.isFinite(age) || age > STALE_MS
  })
  for (const s of due) await refreshFeeds(s.id)
  return due.length
}

/**
 * How many events each feed left out of view, from the last time it was parsed. Memory only: it is
 * rebuilt by the next read, and a "showing 2000 of 5000" left on disk would outlive the feed that
 * caused it.
 */
const clipped = new Map<string, { n: number; atLeast: boolean }>()
/** `atLeast` is parseCalendar's: the count is a floor, because it gave up reading the file. */
const noteClipped = (id: string, n: number, atLeast: boolean): void => {
  if (n) clipped.set(id, { n, atLeast })
  else clipped.delete(id)
}

/**
 * `events` is what the feed contributes right now: chips in view for an events feed, tickable rows
 * for a work feed, so neither kind of feed can look identical when it found nothing and when it
 * worked. `note` is set when the feed was too big to show whole.
 */
export async function feedStatus(): Promise<(FeedStatus & { note?: string })[]> {
  const subs = await getSubscriptions()
  const status = await readStatus()
  const chips = new Map<string, number>()
  for (const e of await readEvents()) chips.set(e.subscriptionId, (chips.get(e.subscriptionId) ?? 0) + 1)
  const rows = new Map<string, number>()
  for (const d of (await getDeadlines()) as FeedRow[]) {
    if (d.subscriptionId) rows.set(d.subscriptionId, (rows.get(d.subscriptionId) ?? 0) + 1)
  }
  return subs.map((s) => {
    const dropped = clipped.get(s.id)
    return {
      id: s.id,
      at: status[s.id]?.at ?? null,
      error: status[s.id]?.error ?? null,
      events: (s.mode === 'deadlines' ? rows : chips).get(s.id) ?? 0,
      ...(dropped
        ? {
            note: `Too big to show whole: ${dropped.atLeast ? 'at least ' : ''}${EVENT_CAP + dropped.n} events in range, showing the ${EVENT_CAP} nearest today.`,
          }
        : {}),
    }
  })
}

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Tartan's own events, coming back at it through a feed.
 *
 * Subscribing to a calendar that Tartan also WRITES to is the only way to see things added on the
 * phone, but every deadline Tartan pushed is sitting in that same calendar carrying the marker
 * `sync.ts` stamps into the description. Without this guard each one returns as a second, feed-shaped
 * copy of a row Tartan already has, and the whole semester renders twice.
 *
 * The marker is the same string the sync round-trips ids through, so this cannot drift from it:
 * an event Tartan did not create has no `TartanSync id=` and is always kept.
 */
const isOwnEcho = (description: string): boolean => description.includes('TartanSync id=')

/**
 * Promotion. An 'events' feed can name the few events worth an alarm — a tech talk in a feed of
 * thesis defenses — and those become deadline rows, because a chip on the desktop never reaches
 * the phone. One predicate for both sides, so an event is a row or a chip and never both.
 *
 * Null means this feed promotes nothing. A pattern that does not compile is hand-edited JSON with a
 * typo, and it falls back to plain events rather than taking every feed down with it.
 */
export function promotion(s: Subscription): ((e: IcsEvent) => boolean) | null {
  if (s.mode !== 'events' || !s.promote) return null
  try {
    const want = new RegExp(s.promote, 'i')
    const skip = s.promoteExclude ? new RegExp(s.promoteExclude, 'i') : null
    // The title says what an event is; the room can only veto. "5th Floor Lobby" does not make a
    // poster session a lobby day, but "By Invitation Only" in the location is not a door you can use.
    return (e) =>
      want.test(e.summary) && !skip?.test(`${e.summary} | ${e.location}`) && !isOwnEcho(e.description)
  } catch {
    return null
  }
}

/** One occurrence of a recurring event: the UID alone names the whole series. */
const occurrenceKey = (e: IcsEvent): string => `${e.uid}#${e.allDay ? ymd(e.start) : e.start.toISOString()}`

/**
 * The row key for each promoted event. A one-off keeps its bare UID, so a rescheduled talk moves
 * its row instead of leaving the old time behind with a live alarm. Only a UID that repeats inside
 * the parse is a series, and each of its occurrences needs a row of its own.
 */
function promotedKeys(events: IcsEvent[]): (e: IcsEvent) => string {
  const count = new Map<string, number>()
  for (const e of events) count.set(e.uid, (count.get(e.uid) ?? 0) + 1)
  return (e) => ((count.get(e.uid) ?? 0) > 1 ? occurrenceKey(e) : e.uid)
}

const DESCRIPTION_CAP = 900
/** Longer than any talk or fair day, shorter than the gap before it would read as overdue. */
const PROMOTED_GRACE_MS = 12 * 60 * 60 * 1000

/**
 * What the phone shows under a promoted event. The signup link goes first because it is the one
 * thing you act on, and the listing buries it under three paragraphs about the company.
 */
function promotedNotes(e: IcsEvent): string {
  // "Please register here: https://…" and SCS's own "RSVP: <newline> https://…" both count; a URL
  // three paragraphs later does not.
  const link = /\b(?:register|registration|rsvp|apply|sign[\s-]?up)\b[^\n]{0,60}?\s*(https?:\/\/[^\s<>"|]+)/i.exec(
    e.description,
  )
  const url = link?.[1].replace(/[.,;:!?)\]]+$/, '')
  const body = e.description.replace(/\s+/g, ' ').trim()
  return [
    url ? `SIGN UP -> ${url}` : 'No signup link on the listing',
    // The Google event carries no location, so without this line the phone never learns the room.
    e.location ? `WHERE -> ${e.location}` : '',
    body.length > DESCRIPTION_CAP ? `${body.slice(0, DESCRIPTION_CAP).trimEnd()}…` : body,
    /^https?:\/\//.test(e.uid) ? `Listing: ${e.uid}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Every occurrence from every cached 'events' feed, inside the window. Parsed on demand rather
 * than stored: the cache is the .ics, so a change to the expander takes effect without a refetch,
 * and there is no derived file to fall out of sync with the source.
 */
export async function readEvents(): Promise<FeedEvent[]> {
  const subs = (await getSubscriptions()).filter((s) => s.enabled && s.mode === 'events')
  if (!subs.length) return []
  const now = new Date()
  const from = new Date(now.getTime() - WINDOW_BACK_DAYS * 86400000)
  const to = new Date(now.getTime() + WINDOW_FWD_DAYS * 86400000)

  // Hide a promoted event only once it IS a row. One that ended before an import saw it, or whose
  // row was deleted, still belongs on the calendar as a chip.
  const rows = new Set((await getDeadlines()).map((d) => d.uid).filter((u): u is string => !!u))

  const out: FeedEvent[] = []
  for (const s of subs) {
    let text: string
    try {
      text = await fs.readFile(cacheFile(s.id), 'utf8')
    } catch {
      continue // never fetched, or the cache was cleared
    }
    const promoted = promotion(s)
    const { events, dropped, atLeast } = parseCalendar(text, from, to)
    noteClipped(s.id, dropped, atLeast)
    for (const e of events) {
      if (isOwnEcho(e.description)) continue
      if (promoted?.(e) && (rows.has(e.uid) || rows.has(occurrenceKey(e)))) continue
      out.push({
        subscriptionId: s.id,
        uid: e.uid,
        title: e.summary,
        start: e.allDay ? ymd(e.start) : e.start.toISOString(),
        end: e.allDay ? ymd(e.end) : e.end.toISOString(),
        allDay: e.allDay,
        location: e.location,
      })
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

/**
 * Deleting an imported item has to stick. Without this the next refresh finds the UID missing
 * from deadlines.json, decides it is new, and puts it straight back — so a Canvas entry you do
 * not want ("Week 1 Day 1") is undeletable, and it reappears silently rather than visibly.
 *
 * Lives in .cache/ because it is bookkeeping about a feed, not something to hand-edit. Deleting
 * the cache folder only means dismissed items come back, which is the recoverable direction.
 */
const dismissedFile = (): string => path.join(cacheDir(), 'dismissed.json')

/** Shared with recurring.ts: `rec-…` occurrence uids tombstone in the same file as ICS uids. */
export async function readDismissed(): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(dismissedFile(), 'utf8')) as unknown
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Tombstone the uids of rows the user just deleted, so no re-import or re-materialization can
 * resurrect them. EXPLICIT on purpose: this used to be inferred by diffing the renderer's write
 * against disk, and the day main became a mid-session writer (recurring materialization, the
 * 15-minute interval) that inference turned "a row the renderer had not heard about yet" into
 * "a row the user deleted" — permanently. Only a deliberate delete may reach this; a row merely
 * missing from a stale write is transient and comes back on the next import/materialize pass.
 */
export async function dismissUids(uids: string[]): Promise<void> {
  if (!uids.length) return
  const dismissed = await readDismissed()
  for (const uid of uids) dismissed.add(uid)
  await fs.mkdir(cacheDir(), { recursive: true })
  const tmp = `${dismissedFile()}.tmp`
  await fs.writeFile(tmp, JSON.stringify([...dismissed], null, 2), 'utf8')
  await fs.rename(tmp, dismissedFile())
}

/** Work is read from a month back to a year ahead; see IMPORT_BACK_DAYS. */
const importWindow = (now: Date): { from: Date; to: Date } => ({
  from: new Date(now.getTime() - IMPORT_BACK_DAYS * 86400000),
  to: new Date(now.getTime() + WINDOW_FWD_DAYS * 86400000),
})

/** Feeds that write rows into deadlines.json: Work feeds, and Events feeds that promote something. */
const importsRows = (s: Subscription): boolean =>
  s.enabled && (s.mode === 'deadlines' || (s.mode === 'events' && !!s.promote))

/** Everything a merge needs from disk, read up front so the merge itself can be synchronous. */
interface MergeEnv {
  rows: FeedRow[]
  byUid: Map<string, FeedRow>
  /** Course id by every name a space answers to; see courseKeys. */
  courses: Map<string, string>
  dismissed: Set<string>
  now: Date
  /** Row keys a feed still lists, so the sweep below does not tick off an event that is running. */
  seen: Set<string>
  /** Rows dropped because their feed was switched off; see loadMergeEnv. */
  removed: number
}

/**
 * `idle` names feeds that still exist but no longer make rows — switched off, or moved to Events.
 * Their unticked rows go with them; a ticked one is a record of work you did and stays. A feed
 * deleted outright is forgetFeed's job, not this one's: that is decided from the feed list, and a
 * list that failed to read (a typo in a hand edit) looks exactly like an empty one.
 */
async function loadMergeEnv(now: Date, idle = new Set<string>()): Promise<MergeEnv> {
  // Only ever file work under a course that actually exists in courses.json.
  const courses = courseKeys(await getCourses())
  const dismissed = await readDismissed()
  const all = (await getDeadlines()) as FeedRow[]
  const rows = all.filter((d) => d.done || !d.subscriptionId || !idle.has(d.subscriptionId))
  const byUid = new Map(rows.filter((d) => d.uid).map((d) => [d.uid as string, d]))
  return { rows, byUid, courses, dismissed, now, seen: new Set(), removed: all.length - rows.length }
}

/**
 * Merge one feed's events into env.rows. The subscription import and the one-shot import both come
 * through here, so the same link gives the same rows whichever door it was pasted into: titles
 * cleaned, kinds guessed, courses bound, deleted items left deleted.
 *
 * `pick` is null for a Work feed. For an Events feed it is the promotion test, and only what it
 * accepts becomes a row. A row is counted once however many of its fields moved.
 */
function mergeEvents(
  env: MergeEnv,
  events: IcsEvent[],
  feed: { id?: string; courseId: string | null; pick: ((e: IcsEvent) => boolean) | null },
): { added: number; updated: number } {
  const { rows, byUid, dismissed, now, seen } = env
  const { pick } = feed
  const keyOf = pick ? promotedKeys(events) : (e: IcsEvent): string => e.uid
  let added = 0
  let updated = 0
  for (const e of events) {
    if (isOwnEcho(e.description) || (pick && !pick(e))) continue
    const key = keyOf(e)
    seen.add(key)
    const due = e.allDay ? ymd(e.start) : e.start.toISOString()
    const { title, courseId: tagged } = pick
      ? { title: e.summary.trim(), courseId: null }
      : splitCanvasTitle(e.summary, env.courses)
    // A feed bound to one course wins; otherwise the title's own tag decides.
    const courseId = feed.courseId ?? tagged
    const notes = pick ? promotedNotes(e) : undefined
    const over = e.end.getTime() < now.getTime()
    const prev = byUid.get(key)
    if (prev) {
      let touched = false
      if (prev.due !== due || prev.title !== title || (pick && prev.notes !== notes)) {
        prev.due = due
        prev.title = title
        if (pick) prev.notes = notes
        touched = true
      }
      // Forward only: an event that has ended is done, and nothing here ever un-ticks a row.
      if (prev.promoted && over && !prev.done) {
        prev.done = true
        touched = true
      }
      // Backfill a course for rows imported before the title was being read, and the feed for rows
      // imported before rows remembered one. Counting it is what makes it stick — the write is
      // guarded on added||updated, so a backfill on its own used to be computed in memory and then
      // thrown away.
      if (!prev.courseId && courseId) {
        prev.courseId = courseId
        touched = true
      }
      if (feed.id && !prev.subscriptionId) {
        prev.subscriptionId = feed.id
        touched = true
      }
      if (touched) updated++
    } else if (dismissed.has(e.uid) || dismissed.has(key)) {
      continue // deleted here on purpose; do not resurrect it
    } else if (pick && over) {
      continue // already happened; a new row for it could only ever be overdue
    } else {
      const row: FeedRow = {
        // SCS UIDs are URLs. Every Canvas UID is already [A-Za-z0-9_-], so its id is unchanged.
        id: `ics-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`,
        courseId,
        title,
        due,
        kind: pick ? 'admin' : guessKind(title),
        done: false,
        source: 'ics',
        uid: key,
        ...(feed.id ? { subscriptionId: feed.id } : {}),
        ...(pick ? { notes, promoted: true } : {}),
      }
      rows.push(row)
      byUid.set(key, row)
      added++
    }
  }
  return { added, updated }
}

/**
 * Merge 'deadlines'-mode feeds into deadlines.json, keyed on ICS UID so a re-import updates in
 * place. `done` is never clobbered — only the schedule and the title can move, because ticking
 * something off is the one fact the feed does not know.
 *
 * 'events' feeds with `promote` set contribute only their promoted events. Those are the exception
 * to `done`: an event that has ended ticks itself, since a talk you missed is not debt you still owe.
 *
 * Rows a switched-off feed made are removed here too, and counted in `updated`: callers only ask
 * whether anything changed, and a removal is a change the phone has to hear about.
 */
export async function importFeedDeadlines(): Promise<{ added: number; updated: number }> {
  // No early return when nothing qualifies: the sweep at the bottom also ticks hand-entered event
  // rows, and those need no feed at all. With no subscriptions the feed loop simply does nothing.
  const all = await getSubscriptions()
  const subs = all.filter(importsRows)

  const now = new Date()
  const { from, to } = importWindow(now)

  // Every cache file is read BEFORE deadlines.json, because everything from the read below to the
  // write at the end has to be synchronous. An await in the middle of a read-modify-write on a
  // whole-file array is how a tick that lands during the pause gets overwritten by a snapshot
  // taken before it — and this now runs on window focus, which is exactly when someone is ticking.
  const feeds: { sub: Subscription; text: string }[] = []
  for (const s of subs) {
    try {
      feeds.push({ sub: s, text: await fs.readFile(cacheFile(s.id), 'utf8') })
    } catch {
      continue
    }
  }

  const env = await loadMergeEnv(now, new Set(all.filter((s) => !importsRows(s)).map((s) => s.id)))
  let added = 0
  let updated = env.removed

  for (const { sub: s, text } of feeds) {
    // Null for a deadlines feed. An events feed whose pattern does not compile promotes nothing.
    const pick = s.mode === 'events' ? (promotion(s) ?? (() => false)) : null
    const { events, dropped, atLeast } = parseCalendar(text, from, to)
    noteClipped(s.id, dropped, atLeast)
    const merged = mergeEvents(env, events, { id: s.id, courseId: s.courseId, pick })
    added += merged.added
    updated += merged.updated
  }

  // The SCS feed drops a day soon after it passes, so an event that ended while the laptop slept
  // never reaches the end-time check above. Rows still in the feed are left to that check, so a
  // hackathon is not ticked off while it is still running. Hand-entered events have no feed at all
  // and only ever reach this path.
  const cutoff = now.getTime() - PROMOTED_GRACE_MS
  for (const d of env.rows) {
    if (!(d.promoted || d.event) || d.done || (d.uid && env.seen.has(d.uid))) continue
    // A date-only due is the whole local day, not UTC midnight at its start.
    const at = d.due.length === 10 ? new Date(`${d.due}T23:59:59`).getTime() : Date.parse(d.due)
    if (at < cutoff) {
      d.done = true
      updated++
    }
  }

  if (added || updated) await setDeadlines(env.rows)
  return { added, updated }
}

/**
 * The one-shot "Import a calendar feed" box. Same fetch, window and merge as a subscription, so a
 * link pasted here and the same link subscribed to give identical rows and never rewrite each
 * other's titles. Nothing is remembered about the link, so its rows start out belonging to no feed.
 * That does not make them permanent: a subscription that later lists the same UID claims the row
 * (see mergeEvents), and removing or switching off that subscription then deletes it unless ticked.
 */
export async function importFeedUrl(link: string, courseId: string | null): Promise<ImportResult> {
  const got = await fetchFeed(link)
  if ('error' in got) return { added: 0, updated: 0, skipped: 0, error: got.error }
  const now = new Date()
  const { from, to } = importWindow(now)
  const { events } = parseCalendar(got.text, from, to)
  if (!events.length) {
    const error = `No events in that feed from ${IMPORT_BACK_DAYS} days ago to a year from now.`
    return { added: 0, updated: 0, skipped: 0, error }
  }
  const env = await loadMergeEnv(now)
  const { added, updated } = mergeEvents(env, events, { courseId, pick: null })
  if (added || updated) await setDeadlines(env.rows)
  return { added, updated, skipped: events.length - added - updated }
}

/**
 * Removes a feed's cache when it is deleted, so a stale .ics cannot resurrect its events, and its
 * unticked rows with it. Nothing else could say which rows it made, and deleting a feed while two
 * hundred of its deadlines stay behind is not what anyone meant. Ticked rows stay.
 */
async function forget(id: string): Promise<void> {
  await fs.rm(cacheFile(id), { force: true })
  const status = await readStatus()
  delete status[id]
  await writeStatus(status)
  clipped.delete(id)
  const all = (await getDeadlines()) as FeedRow[]
  const rows = all.filter((d) => d.done || d.subscriptionId !== id)
  if (rows.length !== all.length) await setDeadlines(rows)
}

/**
 * Saving a list with several feeds removed calls this once per feed, all at once, and each one
 * rewrites deadlines.json from its own read — so the last to finish would put the others' rows
 * back. They take turns instead.
 */
let forgetting: Promise<unknown> = Promise.resolve()
export function forgetFeed(id: string): Promise<void> {
  const run = forgetting.then(() => forget(id))
  forgetting = run.catch(() => undefined)
  return run
}
