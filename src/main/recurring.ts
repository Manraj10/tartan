import { readDismissed, readEvents } from './feeds'
import { getDeadlines, getRecurring, getTodos, setDeadlines, setRecurring, setTodos } from './store'
import { ruleTarget, type Deadline, type RecurringRule, type Todo } from '../shared/types'

/**
 * Rules → rows. recurring.json holds the rules; this turns them into ordinary deadlines and todos
 * a few weeks ahead, on the same launch/focus/interval chain the Canvas import rides. From then on
 * an occurrence is just a row: it ticks, syncs to Google, folds on the Calendar, and deletes like
 * anything else — no view knows recurrence exists.
 *
 * The discipline is importFeedDeadlines', copied deliberately:
 *  - deterministic ids (`rec-<rule>-<YYYY-MM-DD>`), so a re-run never duplicates and never
 *    touches `done`;
 *  - dismissed.json tombstones gate CREATION only, so a deleted occurrence stays deleted while
 *    an undone deletion (the row put back by Ctrl+Z) is left alone;
 *  - no await between reading a data file and writing it back;
 *  - and, beyond the import: RECONCILIATION. Rules are hand-editable, so every run also prunes
 *    future unticked rec- rows the rules no longer want — a retargeted rule (todo → deadline),
 *    a dropped weekday, or a deleted rule cleans up after itself on the next pass instead of
 *    stranding three weeks of orphans. Ticked rows and the past are records of work; they stay.
 *
 * Everything here is serialised through one promise chain: addRule, removeRule and materialize
 * all read-modify-write the same small files, and interleaving two of them loses one's write.
 */

/**
 * Deadlines get three weeks: far enough that Google's day-before reminders always exist.
 * Todos get one: they are chores, every open one renders on the Todos strip and the phone page,
 * and six future "gym" rows on a flat list is noise pretending to be planning.
 */
const AHEAD_DEADLINE_DAYS = 21
const AHEAD_TODO_DAYS = 7

const pad2 = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

const uidOf = (ruleId: string, day: string): string => `rec-${ruleId}-${day}`

/**
 * The day an occurrence was made for, read back from its id. Not its current due: T, D, → Today
 * and a Calendar drag all move `due` while the id stays, and a moved row is still the rule's.
 */
const madeFor = (uid: string): string => {
  const day = uid.slice(-10)
  // '' sorts before every day, so a hand-written 'rec-legacy' is never "in the future" and never pruned.
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

/** A hand-written row may have no id, a number, or be null; only a string can be a rec- row. */
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Days the university is dark, straight from the already-subscribed academic calendar: "Fall
 * Break; No Classes", "Thanksgiving Break", "Democracy Day; No Classes". A weekly quiz does not
 * happen on a Friday nobody is on campus, and a habit skipped over a break should pause, not
 * fail — so rules simply do not materialize on these days, and the reconcile pass removes any
 * occurrence that a break later swallows. A missing feed means an empty set, never an error.
 */
const BREAK_RE = /\b(break|no classes|holiday|recess)\b/i

async function breakDays(): Promise<Set<string>> {
  const days = new Set<string>()
  try {
    for (const e of await readEvents()) {
      if (!e.allDay || !BREAK_RE.test(e.title)) continue
      // All-day ICS ends are exclusive, so iterate [start, end).
      const [y, m, d] = e.start.split('-').map(Number)
      const stop = e.end
      const cur = new Date(y, m - 1, d)
      for (let i = 0; i < 60 && ymd(cur) < stop; i++) {
        days.add(ymd(cur))
        cur.setDate(cur.getDate() + 1)
      }
      if (e.start === stop) days.add(e.start)
    }
  } catch {
    // No cached feeds yet. Rules run every scheduled day, exactly as before this existed.
  }
  return days
}

let chain: Promise<unknown> = Promise.resolve()
/** One writer at a time. The previous op's failure must not wedge the queue, hence the catch. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

interface Occurrence {
  rule: RecurringRule
  uid: string
  /** YYYY-MM-DD of the day it lands on. */
  day: string
  /** What goes in `due`: the day, or a full ISO timestamp when the rule carries a time. */
  due: string
  target: 'deadline' | 'todo'
}

/** Every occurrence every rule wants inside the window. Pure of the data files and of dismissed.json. */
function wanted(rules: RecurringRule[], today: Date, skip: Set<string>): Occurrence[] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const out: Occurrence[] = []
  for (const rule of rules) {
    // recurring.json is hand-editable, so a malformed rule is skipped, never thrown on.
    if (!rule || !rule.id || !rule.text || !Array.isArray(rule.days) || !rule.days.length) continue
    const target = ruleTarget(rule)
    const ahead = target === 'deadline' ? AHEAD_DEADLINE_DAYS : AHEAD_TODO_DAYS
    for (let i = 0; i < ahead; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      if (!rule.days.includes((d.getDay() + 6) % 7)) continue // getDay() Sun=0 → Meeting.day Mon=0
      const day = ymd(d)
      if (skip.has(day)) continue
      if (rule.from && day < rule.from) continue
      if (rule.until && day > rule.until) continue
      let due = day
      if (target === 'deadline' && typeof rule.time === 'string') {
        const [h, m] = rule.time.split(':').map(Number)
        if (Number.isFinite(h) && Number.isFinite(m)) {
          due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).toISOString()
        }
      }
      out.push({ rule, uid: uidOf(rule.id, day), day, due, target })
    }
  }
  return out
}

async function materializeLocked(force: boolean): Promise<{ changed: number }> {
  const rules = await getRecurring()
  // `force` is removeRule needing the prune pass even with zero rules left. Without it a
  // rule-less data folder costs one ENOENT and nothing else.
  if (!rules.length && !force) return { changed: 0 }
  const want = wanted(rules, new Date(), await breakDays())
  const wantDeadlines = want.filter((w) => w.target === 'deadline')
  const wantTodos = want.filter((w) => w.target === 'todo')
  const today = ymd(new Date())
  let changed = 0

  {
    // Tombstones re-read directly before the file they gate, so a deletion that landed while an
    // earlier await was pending is honoured, not resurrected from a stale snapshot.
    const dismissed = await readDismissed()
    const existing = await getDeadlines()
    // Read → reconcile → write with nothing async in between, exactly like importFeedDeadlines.
    const keep = new Set(wantDeadlines.map((w) => w.uid))
    const kept = existing.filter((d) => {
      const uid = str(d?.uid)
      return !(uid?.startsWith('rec-') && !d.done && madeFor(uid) >= today && !keep.has(uid))
    })
    const have = new Set(existing.map((d) => str(d?.uid)))
    const nowMs = Date.now()
    const fresh = wantDeadlines
      // Only creation is gated: "standup 9am" added at 5pm must not arrive already overdue. Rows
      // that exist stay in `keep`, so a timed occurrence that has since passed is never pruned.
      .filter((w) => !have.has(w.uid) && !dismissed.has(w.uid) && !(w.due.length > 10 && new Date(w.due).getTime() < nowMs))
      .map(
        (w): Deadline => ({
          id: w.uid,
          courseId: w.rule.courseId ?? null,
          title: w.rule.text,
          due: w.due,
          kind: w.rule.kind,
          done: false,
          source: 'recurring',
          uid: w.uid,
        }),
      )
    if (fresh.length || kept.length !== existing.length) {
      await setDeadlines([...kept, ...fresh])
      changed += fresh.length + (existing.length - kept.length)
    }
  }

  {
    const dismissed = await readDismissed()
    const existing = await getTodos()
    const keep = new Set(wantTodos.map((w) => w.uid))
    const kept = existing.filter((t) => {
      const id = str(t?.id)
      return !(id?.startsWith('rec-') && !t.done && madeFor(id) >= today && !keep.has(id))
    })
    const have = new Set(existing.map((t) => str(t?.id)))
    const created = new Date().toISOString()
    const fresh = wantTodos
      .filter((w) => !have.has(w.uid) && !dismissed.has(w.uid))
      .map(
        (w): Todo => ({
          id: w.uid,
          text: w.rule.text,
          courseId: w.rule.courseId ?? null,
          done: false,
          due: w.day,
          created,
        }),
      )
    if (fresh.length || kept.length !== existing.length) {
      await setTodos([...kept, ...fresh])
      changed += fresh.length + (existing.length - kept.length)
    }
  }

  return { changed }
}

/**
 * Materialize missing occurrences and prune unwanted ones. Runs on launch, focus, the interval,
 * and right after a rule changes. Returns how many rows moved so callers can skip the follow-up
 * sync — and the renderer notify — when nothing did.
 */
export const materializeRecurring = (): Promise<{ changed: number }> => locked(() => materializeLocked(false))

/** Upsert by id — a replayed phone action carries the same id and lands on the same rule. */
export const addRule = (rule: RecurringRule): Promise<RecurringRule[]> =>
  locked(async () => {
    const rules = await getRecurring()
    const i = rules.findIndex((r) => r.id === rule.id)
    if (i === -1) rules.push(rule)
    else rules[i] = rule
    await setRecurring(rules)
    await materializeLocked(false)
    return rules
  })

/**
 * Remove a rule. The reconcile pass takes its future unticked occurrences with it — a deleted
 * rule that leaves three weeks of orphans behind was not deleted. Forced, because pruning the
 * last rule's rows matters exactly when zero rules remain.
 */
export const removeRule = (id: string): Promise<RecurringRule[]> =>
  locked(async () => {
    const rules = (await getRecurring()).filter((r) => r.id !== id)
    await setRecurring(rules)
    await materializeLocked(true)
    return rules
  })
