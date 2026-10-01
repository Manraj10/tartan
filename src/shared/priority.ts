import type { Deadline } from './types'

/**
 * What to do next, when everything is "due this week".
 *
 * Due date alone is a bad answer: it puts a participation worksheet due at 11:59 tonight above an
 * exam on Friday, and a reading above the pset it is reading for. So urgency is scaled by what the
 * thing actually is, and work that is already late — but recently late, still worth handing in —
 * outranks work that has not come due yet.
 *
 * Deliberately three inputs and no more. A score nobody can predict is a score nobody trusts, and
 * the only honest use of this is ordering a list.
 */

/** Exams move a grade; a worksheet moves a participation tick. */
const KIND_WEIGHT: Record<string, number> = {
  exam: 3,
  quiz: 2.2,
  pset: 2,
  reading: 1.2,
  admin: 1,
  other: 0.8,
}

const HOUR = 3600000

export interface Priority {
  score: number
  /** Why this sits where it sits, in the words the row already uses. */
  reason: string
}

const kindWeight = (kind: string): number => KIND_WEIGHT[kind] ?? KIND_WEIGHT.other

const dueAt = (due: string): number =>
  new Date(due.length === 10 ? `${due}T23:59:00` : due).getTime()

export function priorityOf(d: Deadline, now: Date = new Date()): Priority {
  const at = dueAt(d.due)
  if (isNaN(at)) return { score: 0, reason: 'no due date' }
  const hours = (at - now.getTime()) / HOUR

  if (hours < 0) {
    // Late and recent is the most recoverable work there is; past about a week it is a record, not
    // a task, so it decays rather than sitting at the top of the list for the rest of the term.
    const daysLate = -hours / 24
    const urgency = 2 - Math.min(daysLate, 7) / 7
    const days = Math.max(1, Math.round(daysLate))
    return { score: kindWeight(d.kind) * urgency, reason: `${days} day${days === 1 ? '' : 's'} late` }
  }
  // Halves every day out: due in 24h counts half as loudly as due now.
  const urgency = 1 / (1 + hours / 24)
  const reason = hours < 24 ? `due in ${Math.max(1, Math.round(hours))}h` : `due in ${Math.round(hours / 24)} days`
  return { score: kindWeight(d.kind) * urgency, reason }
}

/** Highest first; a tie is broken by the clock, so equal work still reads in time order. */
export const byPriority = (now: Date = new Date()) =>
  (a: Deadline, b: Deadline): number =>
    priorityOf(b, now).score - priorityOf(a, now).score || dueAt(a.due) - dueAt(b.due)

/** "exam · due in 18h" — for a title attribute, not a new thing on screen. */
export const priorityNote = (d: Deadline, now: Date = new Date()): string =>
  `${d.kind} · ${priorityOf(d, now).reason}`
