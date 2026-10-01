/**
 * A real iCalendar reader.
 *
 * The old parseIcs handled folding, escapes and plain DATE/DATE-TIME values, which is enough for a
 * flat list of Canvas assignments and nothing else. Every general-purpose calendar — an academic
 * calendar, a class schedule, a club's events — is mostly RRULE, and a parser that ignores it shows
 * one occurrence of a weekly event and drops the other fourteen.
 *
 * Hand-written because the dependency budget is `marked` and `katex`. That is a real constraint,
 * not an aesthetic one: rrule.js alone is larger than both.
 *
 * Timezones: a TZID naming an IANA zone ("America/New_York") is resolved to the real instant with
 * Intl.DateTimeFormat, which ships the IANA database, so no dependency is needed. A floating time
 * (no zone at all) is local wall clock, which is what the spec says it means. A TZID Intl does not
 * know — Outlook writes "Eastern Standard Time", and we do not carry a table of those — falls back
 * to local wall clock, exact only when the feed's zone is this machine's.
 *
 * Recurring events are expanded by repeating the start's LOCAL time of day, so a zoned series is an
 * hour off in every week where this machine's clock is on the other side of its daylight-saving
 * change from the week the series started. A zone that never changes clocks is the bad case, not a
 * rare one: a weekly 09:00 Asia/Kolkata series read on an Eastern machine is off in every week the
 * US is on the other time than at the start (roughly 30 of 40 for a winter start). Two zones
 * that both change clocks (a London class seen from Pittsburgh) disagree only for the few weeks
 * between their changeovers. And a series with a TZID we cannot resolve ("Eastern Standard Time") is
 * silently read as local time throughout, so it is exact only on a machine in that zone. One-off
 * events with a resolvable TZID are exact.
 */

import type { Deadline } from '../shared/types'

export interface IcsEvent {
  uid: string
  summary: string
  location: string
  description: string
  /** Local wall-clock. */
  start: Date
  end: Date
  allDay: boolean
}

/** More than this many events in the window and the feed is shown partially. See parseCalendar. */
export const EVENT_CAP = 2000

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

/** RFC 5545 folds at 75 octets; a continuation begins with a single space or tab. */
function unfold(text: string): string[] {
  const out: string[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1)
    else out.push(line)
  }
  return out
}

function parseProp(line: string): Prop | null {
  const sep = line.indexOf(':')
  if (sep === -1) return null
  const head = line.slice(0, sep)
  const value = line.slice(sep + 1)
  const parts = head.split(';')
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: parts[0].toUpperCase(), params, value }
}

const unescape = (s: string): string =>
  s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>()

/** How far ahead of UTC the zone's clock is at this instant, in ms. Null for a name Intl does not know. */
function zoneOffset(tz: string, at: number): number | null {
  let f = zoneFormats.get(tz)
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
    } catch {
      f = null // RangeError: not an IANA name
    }
    zoneFormats.set(tz, f)
  }
  if (!f) return null
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - at
}

/**
 * The instant at which a clock in `tz` reads these fields (month is 0-based), or null for an
 * unknown zone. The offset is looked up at a guess, then again at the answer, because across a
 * DST change the two differ. A time inside the spring-forward gap does not exist on that clock;
 * as the spec asks, it is read with the offset from before the gap.
 */
function zonedTime(tz: string, y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
  const wall = Date.UTC(y, mo, d, h, mi, s)
  const first = zoneOffset(tz, wall)
  if (first === null) return null
  const guess = wall - first
  const second = zoneOffset(tz, guess) ?? first
  if (second === first) return new Date(guess)
  const retry = wall - second
  return new Date(zoneOffset(tz, retry) === second ? retry : guess)
}

/** Parses a DATE or DATE-TIME. Returns null when the value is not a date at all. */
function parseDate(value: string, params: Record<string, string>): { at: Date; allDay: boolean } | null {
  const v = value.trim()
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    return { at: new Date(Number(y), Number(m) - 1, Number(d)), allDay: true }
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v)
  if (!dt) return null
  const [, y, mo, d, h, mi, s, z] = dt
  const n = [y, mo, d, h, mi, s].map(Number)
  const at = z
    ? new Date(Date.UTC(n[0], n[1] - 1, n[2], n[3], n[4], n[5]))
    : // A TZID that Intl knows is exact. Floating, or a zone name we cannot resolve, is local wall clock.
      ((params.TZID ? zonedTime(params.TZID, n[0], n[1] - 1, n[2], n[3], n[4], n[5]) : null) ??
      new Date(n[0], n[1] - 1, n[2], n[3], n[4], n[5]))
  return { at, allDay: params.VALUE === 'DATE' }
}

/** ISO 8601 duration, the subset calendars actually emit: P[n]DT[n]H[n]M[n]S and P[n]W. */
function parseDuration(v: string): number {
  const w = /^[+-]?P(\d+)W$/.exec(v.trim())
  if (w) return Number(w[1]) * 7 * 86400000
  const m = /^[+-]?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim())
  if (!m) return 0
  const [, d, h, mi, s] = m
  return (Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) * 1000
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count: number | null
  until: Date | null
  /** Day-of-week codes with an optional ordinal, e.g. "-1SU" = last Sunday. */
  byDay: { ord: number | null; day: number }[]
  byMonthDay: number[]
  byMonth: number[]
}

function parseRule(value: string): Rule | null {
  const parts: Record<string, string> = {}
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=')
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1)
  }
  const freq = parts.FREQ?.toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null

  const byDay = (parts.BYDAY ?? '')
    .split(',')
    .filter(Boolean)
    .map((token) => {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim())
      if (!m) return null
      return { ord: m[1] ? Number(m[1]) : null, day: DAY_CODES.indexOf(m[2].toUpperCase()) }
    })
    .filter((d): d is { ord: number | null; day: number } => d !== null)

  const nums = (key: string): number[] =>
    (parts[key] ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n))

  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    count: parts.COUNT ? Number(parts.COUNT) : null,
    until: parts.UNTIL ? (parseDate(parts.UNTIL, {})?.at ?? null) : null,
    byDay,
    byMonthDay: nums('BYMONTHDAY'),
    byMonth: nums('BYMONTH'),
  }
}

const addDays = (d: Date, n: number): Date => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** Copies the time-of-day from `from` onto the calendar date `d`. */
const withTime = (d: Date, from: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), from.getHours(), from.getMinutes(), from.getSeconds())

/** Nth matching weekday of a month; ord < 0 counts back from the end. */
function nthWeekday(year: number, month: number, day: number, ord: number): Date | null {
  if (ord > 0) {
    const first = new Date(year, month, 1)
    const shift = (day - first.getDay() + 7) % 7
    const at = new Date(year, month, 1 + shift + (ord - 1) * 7)
    return at.getMonth() === month ? at : null
  }
  const last = new Date(year, month + 1, 0)
  const shift = (last.getDay() - day + 7) % 7
  const at = new Date(year, month, last.getDate() - shift + (ord + 1) * 7)
  return at.getMonth() === month ? at : null
}

/** Whole calendar days from a's date to b's date. Via UTC, so a DST change cannot make a day 23 or 25 hours. */
const daysBetween = (a: Date, b: Date): number =>
  Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86400000,
  )

/**
 * Expand a rule into concrete start times inside [from, to].
 *
 * Bounded twice on purpose: an RRULE with no COUNT and no UNTIL is infinite, and a feed with a
 * typo can ask for a million occurrences. The window keeps the work proportional to what is on
 * screen; the cap keeps a malformed feed from hanging the main process. The cap counts only what is
 * still ahead of `near` (today): an old series must not spend its budget on the past and then stop
 * showing next month.
 */
function expand(rule: Rule, dtstart: Date, from: Date, to: Date, near: Date, cap = 400): Date[] {
  const out: Date[] = []
  const hardEnd = rule.until && rule.until < to ? rule.until : to
  let emitted = 0
  let ahead = 0
  let steps = 0
  const maxSteps = 2000

  const push = (at: Date): boolean => {
    if (at < dtstart) return true
    if (rule.until && at > rule.until) return false
    if (rule.count !== null && emitted >= rule.count) return false
    emitted++
    if (at >= from && at <= to) {
      out.push(at)
      if (at >= near) ahead++
    }
    return ahead < cap
  }

  if (rule.freq === 'DAILY') {
    // Start one occurrence before the window instead of walking up from DTSTART: a daily event
    // from 2019 used to spend its whole step budget in the past and never reach today. The skipped
    // occurrences still count toward COUNT, which is why `emitted` is set rather than left at zero.
    const skip = Math.max(0, Math.floor(daysBetween(dtstart, from) / rule.interval) - 1)
    emitted = skip
    let d = addDays(dtstart, skip * rule.interval)
    for (; d <= hardEnd && steps++ < maxSteps; d = addDays(d, rule.interval)) {
      if (!push(withTime(d, dtstart))) break
    }
    return out
  }

  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length ? rule.byDay.map((b) => b.day) : [dtstart.getDay()]
    // Anchor on the week containing DTSTART so INTERVAL counts whole weeks from there.
    const anchor = addDays(dtstart, -dtstart.getDay())
    outer: for (let w = new Date(anchor); w <= hardEnd && steps++ < maxSteps; w = addDays(w, 7 * rule.interval)) {
      for (const day of [...days].sort((a, b) => a - b)) {
        if (!push(withTime(addDays(w, day), dtstart))) break outer
      }
    }
    return out
  }

  const monthStep = rule.freq === 'MONTHLY' ? rule.interval : 12 * rule.interval
  for (
    let m = new Date(dtstart.getFullYear(), dtstart.getMonth(), 1);
    m <= hardEnd && steps++ < maxSteps;
    m = new Date(m.getFullYear(), m.getMonth() + monthStep, 1)
  ) {
    if (rule.byMonth.length && !rule.byMonth.includes(m.getMonth() + 1)) continue
    const candidates: Date[] = []
    if (rule.byDay.length) {
      for (const b of rule.byDay) {
        if (b.ord === null) {
          // Every matching weekday in the month.
          for (let d = 1; d <= new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate(); d++) {
            const at = new Date(m.getFullYear(), m.getMonth(), d)
            if (at.getDay() === b.day) candidates.push(at)
          }
        } else {
          const at = nthWeekday(m.getFullYear(), m.getMonth(), b.day, b.ord)
          if (at) candidates.push(at)
        }
      }
    } else {
      for (const day of rule.byMonthDay.length ? rule.byMonthDay : [dtstart.getDate()]) {
        const last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()
        const dom = day > 0 ? day : last + day + 1
        if (dom >= 1 && dom <= last) candidates.push(new Date(m.getFullYear(), m.getMonth(), dom))
      }
    }
    candidates.sort((a, b) => a.getTime() - b.getTime())
    let stop = false
    for (const c of candidates) {
      if (!push(withTime(c, dtstart))) {
        stop = true
        break
      }
    }
    if (stop) break
  }
  return out
}

/** Same shape as the keys used for EXDATE matching: local date-time to the second. */
const stamp = (d: Date): string =>
  `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`

/**
 * Read a calendar and return every occurrence that falls inside [from, to].
 *
 * CANCELLED events are dropped, EXDATEs are removed, and a VEVENT carrying RECURRENCE-ID replaces
 * the occurrence it names — that is how a feed says "this one week the seminar moved".
 *
 * More than `cap` occurrences in the window is a feed too big to show whole. The ones nearest `near`
 * (today) are kept and `dropped` says how many were left out, so the caller can tell the user
 * instead of silently showing whatever happened to come first in the file. `atLeast` is true when
 * reading was cut short by the backstop below, so `dropped` is then only a floor.
 */
export function parseCalendar(
  text: string,
  from: Date,
  to: Date,
  cap = EVENT_CAP,
  near = new Date(),
): { events: IcsEvent[]; dropped: number; atLeast: boolean } {
  const lines = unfold(text)
  const blocks: Prop[][] = []
  let current: Prop[] | null = null

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = []
      continue
    }
    if (line === 'END:VEVENT') {
      if (current) blocks.push(current)
      current = null
      continue
    }
    if (!current) continue
    const p = parseProp(line)
    if (p) current.push(p)
  }

  const overrides = new Map<string, Prop[]>()
  const series: Prop[][] = []
  for (const b of blocks) {
    const rid = b.find((p) => p.name === 'RECURRENCE-ID')
    const uid = b.find((p) => p.name === 'UID')?.value ?? ''
    if (rid) {
      const at = parseDate(rid.value, rid.params)
      if (at) overrides.set(`${uid}|${stamp(at.at)}`, b)
    } else {
      series.push(b)
    }
  }

  const out: IcsEvent[] = []

  const build = (props: Prop[], startAt: Date, allDay: boolean, span: number): IcsEvent => ({
    uid: props.find((p) => p.name === 'UID')?.value ?? `${stamp(startAt)}`,
    summary: unescape(props.find((p) => p.name === 'SUMMARY')?.value ?? 'Untitled').trim(),
    location: unescape(props.find((p) => p.name === 'LOCATION')?.value ?? '').trim(),
    description: unescape(props.find((p) => p.name === 'DESCRIPTION')?.value ?? '').trim(),
    start: startAt,
    end: new Date(startAt.getTime() + span),
    allDay,
  })

  let atLeast = false
  for (const props of series) {
    // A backstop against a feed built to hang us, not a limit anyone reaches: real calendars are a
    // few hundred events. Past it the rest of the file is ignored, so `dropped` is then a floor.
    if (out.length >= cap * 10) {
      atLeast = true
      break
    }
    if (props.find((p) => p.name === 'STATUS')?.value.toUpperCase() === 'CANCELLED') continue

    const dtstartProp = props.find((p) => p.name === 'DTSTART')
    if (!dtstartProp) continue
    const dtstart = parseDate(dtstartProp.value, dtstartProp.params)
    if (!dtstart) continue

    const dtendProp = props.find((p) => p.name === 'DTEND')
    const durProp = props.find((p) => p.name === 'DURATION')
    const dtend = dtendProp ? parseDate(dtendProp.value, dtendProp.params) : null
    // An all-day DTEND is exclusive, so a one-day event ends the following midnight.
    const span = dtend
      ? Math.max(0, dtend.at.getTime() - dtstart.at.getTime())
      : durProp
        ? parseDuration(durProp.value)
        : dtstart.allDay
          ? 86400000
          : 3600000

    const uid = props.find((p) => p.name === 'UID')?.value ?? ''

    const excluded = new Set<string>()
    for (const ex of props.filter((p) => p.name === 'EXDATE')) {
      for (const v of ex.value.split(',')) {
        const at = parseDate(v, ex.params)
        if (at) excluded.add(stamp(at.at))
      }
    }

    const ruleProp = props.find((p) => p.name === 'RRULE')
    const rule = ruleProp ? parseRule(ruleProp.value) : null

    let starts: Date[]
    if (rule) {
      starts = expand(rule, dtstart.at, from, to, near)
    } else {
      starts = dtstart.at <= to && dtstart.at.getTime() + span >= from.getTime() ? [dtstart.at] : []
    }

    // RDATE adds one-off occurrences to a series.
    for (const rd of props.filter((p) => p.name === 'RDATE')) {
      for (const v of rd.value.split(',')) {
        const at = parseDate(v, rd.params)
        if (at && at.at >= from && at.at <= to) starts.push(at.at)
      }
    }

    for (const at of starts) {
      const key = stamp(at)
      if (excluded.has(key)) continue
      const override = overrides.get(`${uid}|${key}`)
      if (override) {
        const oStart = override.find((p) => p.name === 'DTSTART')
        const parsed = oStart ? parseDate(oStart.value, oStart.params) : null
        if (override.find((p) => p.name === 'STATUS')?.value.toUpperCase() === 'CANCELLED') continue
        out.push(build(override, parsed?.at ?? at, parsed?.allDay ?? dtstart.allDay, span))
      } else {
        out.push(build(props, at, dtstart.allDay, span))
      }
    }
  }

  const byStart = (a: IcsEvent, b: IcsEvent): number => a.start.getTime() - b.start.getTime()
  if (out.length <= cap) return { events: out.sort(byStart), dropped: 0, atLeast }
  const t = near.getTime()
  out.sort((a, b) => Math.abs(a.start.getTime() - t) - Math.abs(b.start.getTime() - t))
  const events = out.slice(0, cap).sort(byStart)
  return { events, dropped: out.length - cap, atLeast }
}

/**
 * The helpers below are about feeds, not iCalendar, and live here only because this is the one
 * module with no Electron or store import — the unit tests load it as it stands.
 */

/**
 * What the user typed into a URL box, made into something fetch will take. webcal:// is how
 * Apple, Outlook and Google say "subscribe to this" and is https underneath; a bare
 * "events.cmu.edu/x.ics" is a link someone copied without its scheme.
 */
export function normalizeFeedUrl(input: string): { url: string } | { error: string } {
  let u = input.trim().replace(/^webcal(s?):\/\//i, 'https://')
  if (!u) return { error: 'Paste a calendar link first.' }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(u)
  // "host:8080/x" is a host and port, not a scheme; "mailto:x" and "file:x" are schemes with no "//".
  if (scheme ? !/^https?$/i.test(scheme[1]) : /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(u)) {
    return { error: 'Only http, https and webcal links are supported.' }
  }
  if (!scheme) u = `https://${u}`
  try {
    if (!new URL(u).hostname) throw new Error('no host')
  } catch {
    return { error: 'That does not look like a web address.' }
  }
  return { url: u }
}

/** Node's network error codes in words. The fetch error itself only ever says "fetch failed". */
const NETWORK_CAUSES: Record<string, string> = {
  ECONNREFUSED: 'the server refused the connection',
  // Offline Windows machines report this too, so it cannot blame the address alone.
  ENOTFOUND: 'could not look up that server: the address is wrong, or you are offline',
  EAI_AGAIN: 'the name lookup failed (are you offline?)',
  ETIMEDOUT: 'the connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
  ECONNRESET: 'the connection was cut off',
  EHOSTUNREACH: 'the host cannot be reached from here',
  ENETUNREACH: 'there is no network connection',
}

/**
 * Turns whatever fetch threw into a sentence that says what actually went wrong. The reason is on
 * `cause`, sometimes nested one level down in an AggregateError, and for a few failures only in
 * its message — so look in all three before giving up and quoting it.
 */
export function describeFetchError(err: unknown, timeoutMs: number): string {
  const e = err as Error & { cause?: { code?: string; message?: string; errors?: { code?: string }[] } }
  if (e.name === 'TimeoutError') return `No answer in ${timeoutMs / 1000}s.`
  if (e.message !== 'fetch failed') return e.message ?? String(err)
  const cause = e.cause
  const message = cause?.message ?? ''
  const code = cause?.code ?? cause?.errors?.[0]?.code ?? /\b(E[A-Z]{4,}|UND_ERR_[A-Z_]+)\b/.exec(message)?.[1]
  if (code && NETWORK_CAUSES[code]) return `Could not reach it: ${NETWORK_CAUSES[code]}.`
  if (/redirect/i.test(message)) return 'Too many redirects: the link sends you round in a circle.'
  if (/certificate|CERT_|SELF_SIGNED|self.signed/i.test(`${code ?? ''} ${message}`)) {
    return `Could not reach it: its security certificate was rejected (${code ?? message}).`
  }
  return message ? `Could not reach it: ${message}.` : 'Could not reach it.'
}

/** "01-101", "01101" and "CS 101" all reduce to a key a Canvas tag can be compared with. */
const courseKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Every key a space answers to — its id AND its code, because renaming the code leaves the id behind. */
export function courseKeys(courses: { id: string; code: string }[]): Map<string, string> {
  const keys = new Map<string, string>()
  for (const c of courses) {
    for (const k of [courseKey(c.id), courseKey(c.code)]) if (k && !keys.has(k)) keys.set(k, c.id)
  }
  return keys
}

/** A bracket word that reads as a section rather than a title: 001, F26, IS, C1, S01, Fall. */
const SECTION_WORD = /^(\d+|[a-z]{1,2}\d*|fall|spring|summer|winter)$/i

/**
 * Canvas ends every assignment title with its section in brackets — "HW 1 [01101]",
 * "Wk 2 Report [02201-C1]", "Essay Draft [ENGL 1010]". When the bracket names one of
 * your spaces the tag is the only thing that says which course the work belongs to, so take the
 * course and drop the tag. When it names nothing we know ("Quiz [Week 2]") it is part of the title,
 * and stripping it would leave two courses' "Homework 3" indistinguishable.
 *
 * Words are matched, not substrings: "CS101-001 Fall 2026" is the word CS101 (then a section), and
 * must not file under a space coded CS1010. The longest run of leading words wins.
 *
 * One leading word with no digit is thin evidence when more words follow: "T [Writing Assignment 3]"
 * is not a section of a space coded WRITING, and stripping it would leave the title "T". So then the
 * rest has to read as a section tag — digits, a short token like F26, IS or C1, or a term — else the
 * title is left alone. A numeric code ("01101 Lecture") is specific enough to stand on its own.
 */
export function splitCanvasTitle(
  summary: string,
  keys: Map<string, string>,
): { title: string; courseId: string | null } {
  const whole = { title: summary.trim(), courseId: null }
  const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(summary)
  if (!m || !m[1].trim()) return whole
  const words = m[2].split(/[\s\-_/]+/).filter(Boolean)
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const courseId = keys.get(courseKey(words.slice(0, n).join('')))
    if (courseId && (n > 1 || /\d/.test(words[0]) || words.slice(1).every((w) => SECTION_WORD.test(w)))) {
      return { title: m[1].trim(), courseId }
    }
  }
  return whole
}

/**
 * Sort work by what it costs you, because LEAD_DAYS turns the kind into how early Today starts
 * shouting. Everything Canvas ships is 'other' otherwise, and an exam would surface the same
 * day as a two-minute survey.
 *
 * A bare "final" is usually the first word of a piece of work ("Final Lab Report", "Final Project
 * Proposal"), and five days of exam lead time would bury the week under it. So on its own it means an
 * exam only when it is the last word ("Math final", "Take-home final" — a lone "Final" too), or
 * is followed only by test, quiz or review ("Final Review", not "Peer Review: Final Draft"). "Exam", "examination" and "midterm" are exams wherever they are.
 * A bracketed or parenthesised tag is not part of the title here: "Final (Section 2)" is "Final".
 */
const EXAM = /\b(exam|examination|midterm)\b/i
const FINAL_EXAM = /\bfinal([\W_]*(test|quiz|review))?$/i
const isExam = (title: string): boolean =>
  EXAM.test(title) || FINAL_EXAM.test(title.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[\W_]+$/, ''))

const KIND_HINTS: [RegExp, Deadline['kind']][] = [
  [/\b(quiz|test)\b/i, 'quiz'],
  [/\b(hw|homework|pset|problem set|assignment|project|paper|draft|essay)\b/i, 'pset'],
  [/\b(reading|read)\b/i, 'reading'],
  [/\b(survey|scale|module|orientation|training|consent|confirm completion)\b/i, 'admin'],
]

export function guessKind(title: string): Deadline['kind'] {
  if (isExam(title)) return 'exam'
  for (const [re, kind] of KIND_HINTS) if (re.test(title)) return kind
  return 'other'
}
