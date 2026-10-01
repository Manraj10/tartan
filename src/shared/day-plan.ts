import type { FeedEvent, Meeting } from './types'

export const DAY_START = 8 * 60
export const DAY_END = 23 * 60
export const MIN_GAP = 45
export const toMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
export const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** 12-hour clock for minutes since midnight. 1440 is the end of a day, so it reads midnight, not noon. */
export const clock = (min: number): string => {
  const h = Math.floor(min / 60) % 24
  return `${h % 12 === 0 ? 12 : h % 12}:${String(min % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

const HALF_DAY_MS = 12 * 60 * 60_000

/**
 * Informational rather than busy time: an all-day event, or a timed one longer than 12 hours that
 * crosses a local midnight. A feed can export a five-week series as ONE event (SCS TechNights, Sep 24
 * to Oct 29); clipped to each day it touches it blocked 00:00-24:00 on all of them. An overnight
 * event under 12 hours (23:00 to 09:30) is a real commitment and still blocks its hours.
 */
export function isBanner(event: FeedEvent): boolean {
  if (event.allDay) return true
  const a = new Date(event.start)
  const b = new Date(event.end)
  return b.getTime() - a.getTime() > HALF_DAY_MS && new Date(a).setHours(24, 0, 0, 0) < b.getTime()
}

/** Rescheduling changes the local day without silently removing a timed deadline's clock. */
export function moveDueToDay(due: string, day: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return day
  const date = new Date(due)
  const [year, month, dateOfMonth] = day.split('-').map(Number)
  date.setFullYear(year, month - 1, dateOfMonth)
  return date.toISOString()
}

/**
 * "Move to today" for overdue triage: keeps the clock like moveDueToDay, unless that clock has
 * already passed — yesterday's 9 am quiz moved at 5 pm would still be late, so it goes all-day.
 */
export function moveOverdueToDay(due: string, day: string, now: Date = new Date()): string {
  const moved = moveDueToDay(due, day)
  return moved.length > 10 && new Date(moved) < now ? day : moved
}

/** Inclusive starts, exclusive ends. Date-only calendar events may span several local days. */
export function eventsOnDay(events: FeedEvent[], day: string): FeedEvent[] {
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  const date = (value: string): Date => new Date(value.length === 10 ? `${value}T00:00:00` : value)
  return events.filter(event => {
    const a = date(event.start)
    const b = date(event.end)
    return a < end && (b > start || (a.getTime() === b.getTime() && a >= start))
  })
}

/** A shared start time alone is a conflict, not evidence that an event is a duplicate. */
export function mirrorsClass(event: FeedEvent, meetings: Meeting[]): boolean {
  if (event.allDay || !/\b(lecture|recitation|class)\b/i.test(event.title)) return false
  const start = new Date(event.start)
  const end = new Date(event.end)
  if (localDay(start) !== localDay(end)) return false
  const codes = event.title.match(/\b\d{2}-?\d{3}\b/g) ?? []
  return meetings.some(m => codes.some(code => code.replace('-', '') === m.courseId.replace('-', '')) &&
    toMinutes(m.start) === start.getHours() * 60 + start.getMinutes() &&
    toMinutes(m.end) === end.getHours() * 60 + end.getMinutes())
}

export interface DayBlock {
  key: string
  start: number
  end: number
  kind: 'class' | 'event'
  title: string
  meeting?: Meeting
  event?: FeedEvent
}

/** Clip multi-day events to this local day; merge busy time before computing usable openings. */
export function buildDayPlan(meetings: Meeting[], events: FeedEvent[], day: string, nowMin: number) {
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  const minute = (date: Date): number => date.getHours() * 60 + date.getMinutes()
  const blocks: DayBlock[] = meetings.filter(m => toMinutes(m.end) > toMinutes(m.start)).map((m, i) => ({
    key: `c-${i}-${m.courseId}`, start: toMinutes(m.start), end: toMinutes(m.end),
    kind: 'class', title: m.courseId, meeting: m,
  }))
  const seen = new Set<string>()
  for (const event of events) {
    const a = new Date(event.start)
    const b = new Date(event.end)
    if (isBanner(event) || !(a < end && (b > start || (a.getTime() === b.getTime() && a >= start)) && b >= a) || mirrorsClass(event, meetings)) continue
    // Identical copies on two subscribed calendars count once; unrelated simultaneous events stay.
    const key = `${event.title.trim().toLowerCase()}|${a.getTime()}|${b.getTime()}`
    if (seen.has(key)) continue
    seen.add(key)
    blocks.push({ key: `e-${event.subscriptionId}-${event.uid}-${a.getTime()}`,
      start: a < start ? 0 : minute(a), end: b >= end ? 1440 : minute(b),
      kind: 'event', title: event.title, event })
  }
  blocks.sort((a, b) => a.start - b.start || a.end - b.end)
  const gaps: { start: number; end: number }[] = []
  let cursor = Math.max(DAY_START, nowMin)
  for (const block of blocks) {
    if (block.end <= block.start) continue
    const until = Math.min(block.start, DAY_END)
    if (until - cursor >= MIN_GAP) gaps.push({ start: cursor, end: until })
    cursor = Math.max(cursor, block.end)
  }
  if (DAY_END - cursor >= MIN_GAP) gaps.push({ start: cursor, end: DAY_END })
  // A day's small event list needs only a pairwise overlap check.
  const conflicts: { a: DayBlock; b: DayBlock }[] = []
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length && blocks[j].start < blocks[i].end; j++) {
      if (blocks[i].end > blocks[i].start && blocks[j].end > blocks[j].start && Math.min(blocks[i].end, blocks[j].end) > nowMin) conflicts.push({ a: blocks[i], b: blocks[j] })
    }
  }
  return { blocks, gaps, conflicts, freeMinutes: gaps.reduce((sum, gap) => sum + gap.end - gap.start, 0) }
}
