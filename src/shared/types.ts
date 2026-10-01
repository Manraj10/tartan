// Shared between main, preload and renderer. Keep this dependency-free.

export interface CourseLink {
  id: string
  label: string
  url: string
}

export interface Course {
  id: string // slug, also the notes subfolder name, e.g. "01-101"
  code: string
  title: string
  color: string // hex, used for the dot and the calendar chip
  units: number
  links: CourseLink[]
  /** Optional Canvas/other .ics feed. Empty means this course is manual-only. */
  icsUrl?: string
}

export type DeadlineKind = 'pset' | 'exam' | 'quiz' | 'reading' | 'admin' | 'other'

export interface Deadline {
  id: string
  courseId: string | null
  title: string
  /** ISO 8601. Date-only values are stored as YYYY-MM-DD and treated as all-day. */
  due: string
  kind: DeadlineKind
  done: boolean
  notes?: string
  source: 'manual' | 'ics' | 'recurring'
  /** ICS UID, or `rec-<rule>-<date>` for a materialized occurrence — a re-run updates, never duplicates. */
  uid?: string
  /** Lifted out of an 'events' feed by its `promote` pattern: an event, so it ticks itself once over. */
  promoted?: boolean
  /** A talk or fair entered by hand rather than work: same rule, it ticks itself once over. */
  event?: boolean
}

/**
 * One recurring rule — "gym every mon wed", "01-101 quiz every friday 3pm". Lives in
 * recurring.json, hand-editable like everything else. The rule is the source; occurrences are
 * materialized into deadlines.json / todos.json a few weeks ahead and are ordinary rows from
 * then on: they tick, sync, and delete exactly like everything around them.
 */
export interface RecurringRule {
  id: string
  text: string
  courseId: string | null
  kind: DeadlineKind
  /** Mon=0 … Sun=6, matching Meeting.day. */
  days: number[]
  /** 'HH:MM'. Present means every occurrence is a timed deadline. */
  time?: string
  /** Optional YYYY-MM-DD bounds, mini-course style. Absent means always. */
  from?: string
  until?: string
}

/**
 * What a rule materializes as. Mirrors the one-field capture's "a date means a deadline": a time
 * or a real kind means graded-work treatment (calendar, reminders, due-today counts); anything
 * else is a chore and goes to the todo list. Correctable in the capture field by dismissing the
 * kind chip, the same way every other parse is corrected.
 */
export const ruleTarget = (r: RecurringRule): 'deadline' | 'todo' =>
  r.time || r.kind !== 'other' ? 'deadline' : 'todo'

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_SHORT = WEEKDAY_LABELS

/** "every Mon & Wed", "every day" — one phrasing for chips, notices and the Settings list. */
export function everyLabel(days: number[]): string {
  if (days.length === 7) return 'every day'
  return `every ${days.map((d) => DAY_SHORT[d]).join(' & ')}`
}

/**
 * A plain todo. Deliberately one flat global list, not per-course and not per-note: the things
 * that go here ("email the 01-101 TA") are exactly the ones that have no natural home, and a list
 * you have to choose a location for is a list you stop using.
 *
 * Order is the array's own order — there is no sort field to keep in sync with a drag.
 */
export interface Todo {
  id: string
  text: string
  done: boolean
  /** Optional tag. Most todos have no course. */
  courseId: string | null
  /** Optional YYYY-MM-DD. A todo with a date is still not a deadline. */
  due?: string
  created: string
  completedAt?: string
}

/**
 * A subscribed calendar. Read-only: Tartan fetches, caches and displays, and never writes back.
 *
 * `mode` is the important field. An academic calendar is a few hundred institutional dates you
 * never act on — add/drop deadlines, breaks, finals week — and turning those into deadlines would
 * bury the four things you actually owe someone. A Canvas feed is the opposite: every item is work.
 *   'events'    → shown on the Calendar and Today, never tickable, never in a deadline count.
 *   'deadlines' → merged into deadlines.json keyed on ICS UID, exactly as the old import did.
 */
export interface Subscription {
  id: string
  name: string
  url: string
  mode: 'events' | 'deadlines'
  /** Binds a feed to a course, so a Canvas feed's items land tagged. */
  courseId: string | null
  color: string
  enabled: boolean
  /**
   * 'events' feeds only. Case-insensitive regex sources: `promote` against the title, and
   * `promoteExclude` against "title | location" so a room like "By Invitation Only" can veto.
   * A match becomes a deadline row — the only kind that reaches the phone — instead of a chip.
   */
  promote?: string
  promoteExclude?: string
}

/** One expanded occurrence from a subscribed feed. Never persisted as user data. */
export interface FeedEvent {
  subscriptionId: string
  uid: string
  title: string
  /** ISO timestamp, or YYYY-MM-DD when the source said all-day. */
  start: string
  end: string
  allDay: boolean
  location: string
}

export interface FeedStatus {
  id: string
  /** ISO time of the last successful fetch, from the on-disk cache. */
  at: string | null
  error: string | null
  events: number
}

export interface NoteMeta {
  /** Path relative to the notes/ root, e.g. "01-101/2026-08-24-limits.md" */
  path: string
  courseId: string | null
  title: string
  updated: string
  /**
   * Set only for a Google Doc. Drive for desktop leaves a `.gdoc` stub — a few bytes of JSON
   * holding the document id — wherever the doc lives, so a doc dropped into a course folder is
   * already a file in the data folder. Listing them costs nothing and makes the notes list the
   * whole index of a course's writing rather than half of it. Opens in the browser, never edited here.
   */
  docUrl?: string
}

export interface ImportResult {
  added: number
  updated: number
  skipped: number
  error?: string
}

/**
 * How many days before it is due you should already have started. Derived, not a field — a lead
 * time asked for on every deadline is the field nobody fills in twice.
 *
 * Without this an exam on Friday is invisible until Friday, sitting in an undifferentiated "This
 * week" next to a 20-minute admin task.
 */
export const LEAD_DAYS: Record<DeadlineKind, number> = {
  exam: 5,
  quiz: 3,
  pset: 2,
  other: 1,
  reading: 0,
  admin: 0,
}

/* ---------- one-field capture ---------- */

export type EntrySpanType = 'course' | 'kind' | 'date' | 'time' | 'every'

/** A recognised run of the input. Rendered as a chip so it can be handed back to the title. */
export interface EntrySpan {
  start: number
  end: number
  text: string
  type: EntrySpanType
  /** What the chip says, e.g. "Fri 21 Aug" rather than the raw "friday". */
  label: string
}

export interface ParsedEntry {
  title: string
  courseId: string | null
  kind: DeadlineKind
  /** YYYY-MM-DD, an ISO timestamp when a time was given, or '' for no date. */
  due: string
  /** "every mon wed" was typed: this line is a recurring rule, and `due` stays empty. */
  every: { days: number[]; time?: string } | null
  spans: EntrySpan[]
}

const KIND_WORDS: Record<string, DeadlineKind> = {
  pset: 'pset', psets: 'pset', hw: 'pset', homework: 'pset', assignment: 'pset', lab: 'pset',
  exam: 'exam', midterm: 'exam', final: 'exam', finals: 'exam',
  quiz: 'quiz',
  reading: 'reading', read: 'reading', chapter: 'reading',
  admin: 'admin', form: 'admin', email: 'admin',
}

/**
 * Words that name a kind only in some contexts, each tested against the text AFTER the word: a
 * "final project" is not an exam, a "lab meeting" is not a pset, and "form a study group" is a
 * verb. "form" counts only as the last word or when a deadline or "of what" word follows ("form
 * due fri", "form for housing").
 * The test runs on the line with any date, time and course already cut out, so "sign form friday"
 * ends in "form".
 */
const KIND_CONTEXT: Record<string, RegExp> = {
  final: /^(?!\s+(?:project|paper|draft|report|presentation|essay|proposal)\b)/i,
  lab: /^(?!\s+(?:meeting|hours)\b)/i,
  form: /^[\s.,;:!?]*$|^\s+(?:due|by|before|on|at|until|for|to|from|with|and)\b/i,
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// Real spellings only. A bare stem plus `[a-z]*` made "Marketing 5" and "decide 3 options" dates.
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const ORD = '(?:st|nd|rd|th)'

const pad2 = (n: number): string => String(n).padStart(2, '0')
const ymdOf = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

const shortDate = (d: Date): string =>
  d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

/**
 * Reads one line of plain text into a deadline or a todo.
 *
 * The point is that adding a pset should cost fewer keystrokes than the pset is worth, and that
 * you should not have to decide "deadline or todo" before typing a character. **The presence of a
 * parsed date is what decides**: a date means a deadline, no date means a todo.
 *
 * Pure and dependency-free so it can be reasoned about, and shared so the Today form, the Todos
 * form and the global capture window cannot disagree about what a line means.
 *
 * Over-eager matching is the real hazard here — "Read chapter 3 May" must not silently lose May.
 * Every match is returned as a span so the UI can show it as a chip and hand it back on request.
 * `ignore` holds rejected matches as `type:text`, NOT offsets: offsets shift on the next keystroke,
 * so a rejection keyed on them would silently reattach itself to a different word.
 */
export function parseEntry(
  text: string,
  courses: { id: string; code: string }[],
  opts: { now?: Date; ignore?: string[] } = {},
): ParsedEntry {
  const now = opts.now ?? new Date()
  const ignore = new Set((opts.ignore ?? []).map((k) => k.toLowerCase()))
  const claimed = new Array<boolean>(text.length).fill(false)
  /** Claimed stops re-matching; blanked removes from the title. The kind word is claimed but
      never blanked — in "pset 4" the word "pset" IS the title, and cutting it leaves "4". */
  const blanked = new Array<boolean>(text.length).fill(false)
  const spans: EntrySpan[] = []

  const isFree = (s: number, e: number): boolean => {
    for (let i = s; i < e; i++) if (claimed[i]) return false
    return true
  }
  const take = (s: number, e: number, type: EntrySpanType, label: string, keep = false): boolean => {
    const raw = text.slice(s, e)
    if (ignore.has(spanKey(type, raw)) || !isFree(s, e)) return false
    for (let i = s; i < e; i++) {
      claimed[i] = true
      if (!keep) blanked[i] = true
    }
    spans.push({ start: s, end: e, text: raw, type, label })
    return true
  }

  // Course first: "01-101" would otherwise look like a date to the 8/21 recogniser.
  let courseId: string | null = null
  for (const c of courses) {
    const bare = c.code.replace(/[^A-Za-z0-9]/g, '')
    // An empty alternative matches the gap before any trailing space and tags the line with that
    // space, so it is dropped — but a code with no ASCII letter or digit ('演習') still matches itself.
    const alts = [c.code, bare].filter(Boolean).map(escapeRe)
    if (!alts.length) continue
    const re = new RegExp(`(?<![\\w-])#?(${alts.join('|')})(?![\\w-])`, 'i')
    const m = re.exec(text)
    if (m && m.index !== undefined && take(m.index, m.index + m[0].length, 'course', c.code)) {
      courseId = c.id
      break
    }
  }

  const mask = (flags: boolean[]): string => text.split('').map((ch, i) => (flags[i] ? ' ' : ch)).join('')

  // "every friday" must claim its day word before the date pass reads it as this coming Friday.
  // That holds when the chip is DISMISSED too: the phrase is claimed without a span, so rejecting
  // the recurrence returns the words to the title instead of letting findDate quietly turn
  // "every mon" into a one-off deadline next Monday.
  const claimInert = (s: number, e: number): void => {
    for (let i = s; i < e; i++) claimed[i] = true
  }
  const everyDays = findEvery(text, isFree, take, claimInert)
  const date = everyDays ? null : findDate(text, now, isFree, take)
  // With no date or rule a bare "3:30" is as likely a verse or a ratio as a time, so only the
  // unambiguous spellings count (see findTime).
  const strict = !date && !everyDays
  // A date-like word the date pass refused ("essay 10/5-11:59pm", "oct 5th-5pm") means the line
  // names a day this parser could not read. Defaulting its time to today would invent a date, so
  // the whole line stays text instead.
  const leftover =
    strict &&
    new RegExp(`\\b${MONTH}\\b\\.?\\s*\\d|\\b\\d{1,2}\\s+${MONTH}\\b|\\b\\d{1,2}/\\d{1,2}\\b|\\b\\d{1,2}${ORD}\\b`, 'i').test(mask(claimed))
  const time = leftover ? null : findTime(text, isFree, take, strict)

  // Kind last, so a context test sees the line with the date, time and course already cut out:
  // "sign form friday" and "submit form 5pm" end in "form" once those are gone.
  let kind: DeadlineKind = 'other'
  const open = mask(claimed)
  for (const m of text.matchAll(/\b[a-z]+\b/gi)) {
    const w = m[0].toLowerCase()
    // hasOwn: a bare lookup answers "constructor" and "toString" with Object's own functions.
    if (!Object.hasOwn(KIND_WORDS, w) || m.index === undefined) continue
    if (KIND_CONTEXT[w] && !KIND_CONTEXT[w].test(open.slice(m.index + w.length))) continue
    const word = KIND_WORDS[w]
    if (take(m.index, m.index + m[0].length, 'kind', KIND_LABELS[word], true)) {
      kind = word
      break
    }
  }

  let due = ''
  // A time with no date is today at that time, or tomorrow if that moment has gone: a timed line
  // is a deadline, never a todo.
  const day = date ?? (time && !everyDays ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : null)
  if (day) {
    if (time) {
      day.setHours(time.h, time.m, 0, 0)
      if (!date && day <= now) day.setDate(day.getDate() + 1)
      due = day.toISOString()
    } else {
      due = ymdOf(day)
    }
  }

  // Cutting "friday" out of "pset 4 due friday" leaves a dangling "due". Strip the prepositions
  // that only existed to introduce something already removed. The same goes for a spaced dash that
  // separated the removed date from the removed time ("pset 4 - oct 5 - 11:59pm" leaves "pset 4 - -").
  let title = mask(blanked)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
  for (let i = 0; i < 3; i++) {
    const next = title.replace(/[\s,–—-]*\b(due|by|on|at|before|until|till)\b[\s,–—-]*$/i, '').replace(/\s+[–—-]+$/, '').trim()
    if (next === title) break
    title = next
  }

  return {
    title,
    courseId,
    kind,
    due,
    every: everyDays
      ? { days: everyDays, ...(time ? { time: `${pad2(time.h)}:${pad2(time.m)}` } : {}) }
      : null,
    spans: spans.sort((a, b) => a.start - b.start),
  }
}

/**
 * "every mon wed", "every tuesday and thursday", "every day", "every weekday", and "on mondays",
 * "on tuesdays and thursdays". Returns Mon=0 day indices. Conservative on purpose: only "every …"
 * or "on <plural days>" makes a rule. Bare "daily", "weekly", "weekdays" and "mondays" are title
 * words ("Daily Bruin article", "Mondays with Morrie"), and a bare singular ("friday") is a date.
 * The day words belong to the every-span, so the date pass cannot read "every friday" as one
 * deadline this coming Friday — which is the failure that would silently swallow the rule.
 */
function findEvery(
  text: string,
  isFree: (s: number, e: number) => boolean,
  take: Taker,
  claimInert: (s: number, e: number) => void,
): number[] | null {
  const name = '(?:sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)'
  const list = (d: string): string => `${d}(?:\\s*(?:,|and|&)\\s*${d}|\\s+${d})*`
  const re = new RegExp(
    `\\b(?:every\\s+(day|weekdays?|${list(`${name}(?:day)?s?`)})|on\\s+(${list(`${name}days`)}))\\b`,
    'i',
  )
  const m = re.exec(text)
  if (!m || m.index === undefined || !isFree(m.index, m.index + m[0].length)) return null

  const spec = (m[1] ?? m[2]).toLowerCase()
  let days: number[]
  if (spec === 'day') {
    days = [0, 1, 2, 3, 4, 5, 6]
  } else if (/^weekdays?$/.test(spec)) {
    days = [0, 1, 2, 3, 4]
  } else {
    const found = new Set<number>()
    for (const w of spec.matchAll(/[a-z]+/g)) {
      const idx = DAY_NAMES.findIndex((d) => d.startsWith(w[0].slice(0, 3)))
      // getDay() order (Sun=0) → Meeting.day order (Mon=0). Separator words ("and") match nothing.
      if (idx >= 0) found.add((idx + 6) % 7)
    }
    days = [...found].sort((a, b) => a - b)
    if (!days.length) return null
  }

  const label =
    days.length === 7 ? 'Every day' : days.length === 5 && days[4] === 4 ? 'Every weekday' : `Every ${days.map((d) => DAY_SHORT[d]).join(' & ')}`
  if (take(m.index, m.index + m[0].length, 'every', label)) return days
  // isFree passed above, so a refused take can only mean the chip was dismissed. The words stay
  // in the title — claimed so no later recognizer can reinterpret them, unblanked so they render.
  claimInert(m.index, m.index + m[0].length)
  return null
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Stable identity for a rejected match, so it stays rejected as the line keeps being typed. */
export const spanKey = (type: EntrySpanType, text: string): string => `${type}:${text.toLowerCase()}`

type Taker = (s: number, e: number, type: EntrySpanType, label: string) => boolean

function findDate(text: string, now: Date, isFree: (s: number, e: number) => boolean, take: Taker): Date | null {
  const at = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const today = at(now)

  const tryOne = (re: RegExp, build: (m: RegExpExecArray) => Date | null): Date | null => {
    const m = re.exec(text)
    if (!m || m.index === undefined || !isFree(m.index, m.index + m[0].length)) return null
    const d = build(m)
    if (!d || Number.isNaN(d.getTime())) return null
    return take(m.index, m.index + m[0].length, 'date', shortDate(d)) ? d : null
  }

  const plusDays = (n: number): Date => {
    const d = new Date(today)
    d.setDate(d.getDate() + n)
    return d
  }

  /**
   * One rule for every spelling of month + day. An impossible date (sep 31, 2/30) is refused, not
   * left to overflow into the next month. With no year typed, a date already past means next year.
   */
  const calendarDate = (mo: number, day: number, year?: number): Date | null => {
    const make = (y: number): Date | null => {
      const d = new Date(y, mo, day)
      return d.getMonth() === mo ? d : null
    }
    const d = make(year ?? today.getFullYear())
    return year === undefined && d && d < today ? make(today.getFullYear() + 1) : d
  }
  const named = (m: RegExpExecArray, mi: number, di: number): Date | null =>
    calendarDate(MONTH_NAMES.indexOf(m[mi].slice(0, 3).toLowerCase()), Number(m[di]), m[3] ? Number(m[3]) : undefined)

  // A typed year is claimed only from this year to five years out. Anything else is not a year —
  // "oct 5 2000 words" keeps "2000" in the title — and a numeric date with such a year is refused.
  const years = Array.from({ length: 6 }, (_, i) => String(today.getFullYear() + i))
  const YR = years.join('|')
  const YY = years.map((y) => y.slice(2)).join('|')
  const year = `(?:,?\\s+(${YR})\\b)?`
  // The lookahead refuses a "day" that is really a clock hour or the start of a range: "dec 11:59pm",
  // "may 9 pm" and "oct 3-4pm" invent no date and keep their words for the time parser. A range's
  // dash is TIGHT: "oct 5 - 11:59pm" is a date, a separator, then a time.
  const monthFirst = new RegExp(
    `\\b${MONTH}\\b\\.?\\s+(\\d{1,2})${ORD}?\\b(?!:\\d|\\s*[ap]\\.?m\\b|[-–—]\\s*\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\b)${year}`,
    'i',
  )
  // Day-first is accepted only with an ordinal ("5th oct"), "of" ("5 of october") or a year
  // ("5 oct 2027"). A plain "3 dec" is title text: "Homework 3 dec", "Read chapter 3 May".
  const dayFirst = new RegExp(`(?<![\\w/-])(\\d{1,2})(?:${ORD}(?:\\s+of)?|\\s+of)\\s+${MONTH}\\b\\.?${year}`, 'i')
  const dayFirstYear = new RegExp(`(?<![\\w/-])(\\d{1,2})${ORD}?\\s+(?:of\\s+)?${MONTH}\\b\\.?,?\\s+(${YR})\\b`, 'i')

  // Ordered most-specific first, so "next friday" is not eaten by "friday".
  return (
    tryOne(/\b(today|tonight)\b/i, () => new Date(today)) ??
    tryOne(/\b(tomorrow|tmrw|tmr)\b/i, () => plusDays(1)) ??
    tryOne(/\bin\s+(\d{1,3})\s+days?\b/i, (m) => plusDays(Number(m[1]))) ??
    tryOne(/(?<!\w)\+(\d{1,3})d\b/i, (m) => plusDays(Number(m[1]))) ??
    // `(?:day)?` and not `[a-z]*day?`: the latter is d + a + optional y, so it demanded at least
    // "da" after the stem and every bare abbreviation silently failed — "friday" parsed, "fri"
    // became an undated todo. `[a-z]*` alone would be worse still, matching "sun" in "sunscreen".
    tryOne(/\bnext\s+(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?\b/i, (m) => weekday(m[1], today, true)) ??
    tryOne(/\b(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?\b/i, (m) => weekday(m[1], today, false)) ??
    // Day-first is tried first: its ordinal / "of" / year makes it the more explicit spelling, so
    // "5th oct 11 slides" is the 5th, not "oct 11".
    tryOne(dayFirst, (m) => named(m, 2, 1)) ??
    tryOne(dayFirstYear, (m) => named(m, 2, 1)) ??
    tryOne(monthFirst, (m) => named(m, 1, 2)) ??
    tryOne(new RegExp(`(?<![\\d/-])(${YR})-(\\d\\d)-(\\d\\d)(?![\\d/-])`), (m) => calendarDate(Number(m[2]) - 1, Number(m[3]), Number(m[1]))) ??
    tryOne(new RegExp(`(?<![\\d/-])(\\d{1,2})\\/(\\d{1,2})(?:\\/(${YR}|${YY}))?(?![\\d/-])`), (m) =>
      calendarDate(Number(m[1]) - 1, Number(m[2]), m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined),
    )
  )
}

/** The next occurrence of that weekday. `after` forces it a week further out for "next X". */
function weekday(token: string, today: Date, after: boolean): Date {
  const t = token.toLowerCase()
  const idx = DAY_NAMES.findIndex((d) => d.startsWith(t.slice(0, 3)))
  if (idx < 0) return today
  const d = new Date(today)
  let delta = (idx - d.getDay() + 7) % 7
  if (delta === 0) delta = 7 // "friday" on a Friday means the next one
  d.setDate(d.getDate() + delta + (after ? 7 : 0))
  return d
}

/**
 * `strict` is a line with no date and no rule: the time alone decides deadline-or-todo, so only
 * unambiguous spellings count — am/pm, noon, midnight, "at H:MM". A bare "3:30" stays title text
 * ("John 3:16 reading", "Office hours 2:30"). With a date or rule beside it, "fri 17:30" is fine.
 */
function findTime(
  text: string,
  isFree: (s: number, e: number) => boolean,
  take: Taker,
  strict: boolean,
): { h: number; m: number } | null {
  const tryOne = (re: RegExp, build: (m: RegExpExecArray) => { h: number; m: number } | null) => {
    const m = re.exec(text)
    if (!m || m.index === undefined || !isFree(m.index, m.index + m[0].length)) return null
    const v = build(m)
    if (!v) return null
    const label = `${v.h % 12 === 0 ? 12 : v.h % 12}:${pad2(v.m)}${v.h < 12 ? 'am' : 'pm'}`
    return take(m.index, m.index + m[0].length, 'time', label) ? v : null
  }

  return (
    // "5pm", "5:00 p.m.", "11:59 P.M." — dots optional. A leading "3-" or "9am-" is a range whose
    // END is the due time; the whole range leaves the title so "meeting 3-4pm" is not left as "meeting 3-".
    // A bare number needs a tight dash to start a range: "pset 4 - 5pm" is the time 5pm, and the 4
    // stays in the title. A start with its own am/pm may be spaced: "meeting 3pm - 4pm".
    tryOne(/\b(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\s*[-–—]\s*|\d{1,2}(?::\d{2})?[-–—]\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?/i, (m) => {
      if (Number(m[1]) < 1 || Number(m[1]) > 12) return null
      let h = Number(m[1]) % 12
      if (m[3].toLowerCase() === 'p') h += 12
      const min = m[2] ? Number(m[2]) : 0
      return min > 59 ? null : { h, m: min }
    }) ??
    // "midnight friday" means the end of Friday, the way "due midnight" means tonight — not 00:00
    // at the start of the day, which would put "pset by midnight" 14 hours in the past. So it is
    // 11:59pm of the named day, the same stamp as typing it.
    // "12 noon" / "12:00 midnight" take their 12 with them rather than leaving it in the title.
    tryOne(/\b(?:at\s+)?(?:12(?::00)?\s+)?(noon|midnight)\b/i, (m) => (m[1].toLowerCase() === 'noon' ? { h: 12, m: 0 } : { h: 23, m: 59 })) ??
    // ...unless that 12 is the day of a date already read ("essay oct 12 noon"): then the word alone.
    tryOne(/\b(?:at\s+)?(noon|midnight)\b/i, (m) => (m[1].toLowerCase() === 'noon' ? { h: 12, m: 0 } : { h: 23, m: 59 })) ??
    // The guard keeps "13:00 pm" from being read as 13:00 once the am/pm form has refused it.
    tryOne(new RegExp(`\\b(?:at\\s+)${strict ? '' : '?'}(\\d{1,2}):(\\d{2})\\b(?!\\s*[ap]\\.?m\\b)`, 'i'), (m) => {
      const h = Number(m[1])
      const min = Number(m[2])
      return h > 23 || min > 59 ? null : { h, m: min }
    })
  )
}

/** Google Calendar sync settings the Settings screen can edit. */
export interface SyncConfigPatch {
  url?: string
  secret?: string
  /** YYYY-MM-DD. Bounds the recurring class events. */
  termStart?: string
  termEnd?: string
}

export interface SyncStatus {
  url: string
  secret: string
  termStart: string
  termEnd: string
  /** ISO time of the last sync Google accepted. */
  at: string | null
  error: string | null
  /** Plain-English summary of what that sync did. */
  last: string | null
  busy: boolean
  /** Local changes Google has not been told about yet. */
  dirty: boolean
}

/** One class meeting. Mon=0 … Sun=6, matching what the schedule file stores. */
export interface Meeting {
  courseId: string
  day: number
  start: string
  end: string
  location: string
  /**
   * Optional YYYY-MM-DD bounds. A mini course occupies the same slot as another for half the
   * term — two of them can share one weekly slot in different buildings — and without a range the
   * app shows two classes at once and cannot say which building to walk to.
   * Absent means the whole term.
   */
  from?: string
  until?: string
}

/** Is this meeting running on the given YYYY-MM-DD? Unbounded meetings always are. */
export function meetsOn(m: Meeting, day: string): boolean {
  if (m.from && day < m.from) return false
  if (m.until && day > m.until) return false
  return true
}

/** The class schedule is a note, so it syncs and hand-edits like everything else. */
export const SCHEDULE_FILE = '_schedule.md'

/** 'H:MM' / 'HH:MM' → normalised 'HH:MM', or null if it is not a real time. */
export function normTime(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/**
 * Read the schedule file. Lives here rather than in the Schedule view because main needs it too,
 * to put today's classes on the phone page — and two copies of a parser is two copies of a bug.
 */
export function parseSchedule(text: string): Meeting[] {
  const out: Meeting[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('|')
    if (parts.length < 5) continue
    const courseId = parts[0].trim()
    const dayRaw = parts[1].trim()
    const start = normTime(parts[2])
    const end = normTime(parts[3])
    if (!courseId || !/^[0-6]$/.test(dayRaw) || !start || !end) continue
    const date = (v: string | undefined): string | undefined =>
      v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined
    out.push({
      courseId,
      day: Number(dayRaw),
      start,
      end,
      location: (parts[4] ?? '').trim(),
      // Fields 6 and 7 are optional, so every existing five-field line still parses.
      ...(date(parts[5]) ? { from: date(parts[5]) } : {}),
      ...(date(parts[6]) ? { until: date(parts[6]) } : {}),
    })
  }
  return out
}

export const KIND_LABELS: Record<DeadlineKind, string> = {
  pset: 'Problem set',
  exam: 'Exam',
  quiz: 'Quiz',
  reading: 'Reading',
  admin: 'Admin',
  other: 'Other',
}

/** One thing done on the phone, waiting for Tartan to pick it up. Server-assigned id, server clock. */
export interface InboxAction {
  id: string
  kind: 'deadline.done' | 'todo.done' | 'todo.add'
  /** The tagged id of the row to tick, from the event's TartanSync marker. Absent on todo.add. */
  target?: string
  /** todo.add only. */
  text?: string
  course?: string
  at: string
}

/** What main hands the window: the same action with its target already resolved to a local id. */
export interface InboxItem extends InboxAction {
  localId: string | null
}
