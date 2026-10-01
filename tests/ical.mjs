import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { transformSync } from 'esbuild'
const source = readFileSync(new URL('../src/main/ical.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm' })
const { parseCalendar, normalizeFeedUrl, describeFetchError, courseKeys, splitCanvasTitle, guessKind, EVENT_CAP } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const ok = (value, message) => {
  assert.ok(value, message)
  checks++
}

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n')
const vevent = (uid, ...lines) => ['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT']
const DAY = 86400000

// A fixed "today", so the window and the nearest-first truncation do not depend on the run date.
const now = new Date(2026, 8, 30, 12)
const from = new Date(now.getTime() - 365 * DAY)
const to = new Date(now.getTime() + 365 * DAY)
const parse = (text, cap) => parseCalendar(text, from, to, cap, now)

// --- Daily rules that started long ago ---------------------------------------------------------

/** The rule walked one occurrence at a time from DTSTART, with no shortcuts: the ground truth. */
function walked({ start, interval = 1, count = null, until = null }) {
  const out = []
  for (let k = 0; count === null || k < count; k++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k * interval, 9)
    if (d > to || (until && d > until)) break
    if (d >= from) out.push(d.getTime())
  }
  return out
}
const daily = (start, rule) =>
  ics(vevent('d', `DTSTART:${start}T090000`, 'DTEND:' + start + 'T093000', `RRULE:FREQ=DAILY${rule ? ';' + rule : ''}`, 'SUMMARY:Daily'))
const startsOf = (text) => parse(text).events.map((e) => e.start.getTime())

const since2019 = startsOf(daily('20190101'))
ok(since2019.length >= 730 && since2019.length <= 732, `daily since 2019 has a whole window, got ${since2019.length}`)
eq(since2019, walked({ start: new Date(2019, 0, 1) }), 'daily since 2019 matches walking it day by day')
const since2024 = startsOf(daily('20240101'))
ok(new Date(since2024.at(-1)) >= new Date(to.getTime() - 2 * DAY), 'daily since 2024 still runs to the end of the window')
eq(since2024, walked({ start: new Date(2024, 0, 1) }), 'daily since 2024 matches walking it day by day')

// The jump has to land on exactly the occurrences the slow walk would: every interval, with and
// without a COUNT that runs out before, inside, or after the window.
for (const interval of [1, 2, 3, 7, 10]) {
  for (const count of [null, 40, 400, 1200, 5000]) {
    const rule = `INTERVAL=${interval}${count ? `;COUNT=${count}` : ''}`
    eq(startsOf(daily('20190103', rule)), walked({ start: new Date(2019, 0, 3), interval, count }), `daily ${rule}`)
  }
}
const until = new Date(2026, 0, 1, 23)
eq(
  startsOf(daily('20190101', 'UNTIL=20260101T230000')),
  walked({ start: new Date(2019, 0, 1), until }),
  'UNTIL still ends a series that was jumped into',
)
eq(startsOf(daily('20280101')).length, 0, 'a daily series that starts after the window is not pulled back into it')
const future = startsOf(daily('20260925'))
eq(future[0], new Date(2026, 8, 25, 9).getTime(), 'a series that started last week still begins at DTSTART')

// Weekly from 2019 was already right; it must stay right with a count that spans the year.
const weekly = parse(ics(vevent('w', 'DTSTART:20190102T090000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:W'))).events
ok(weekly.length >= 104 && weekly.length <= 106, `weekly since 2019 is ~105 in the window, got ${weekly.length}`)

// A rule with several days a week spends more of the forward budget per week than a daily one does.
const weekdays = startsOf(ics(vevent('m', 'DTSTART:20190101T090000', 'DTEND:20190101T093000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'SUMMARY:M')))
let expected = 0
for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 9); d <= to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9)) {
  if (d >= from && d.getDay() % 6 !== 0) expected++
}
eq(weekdays.length, expected, 'Monday to Friday since 2019 fills the whole window')

// --- Too many events to show: keep the ones nearest today, and say how many went -----------------

// Event i lands on one of the 720 days around today, at one of 14 hours.
const slot = (i) => new Date(2026, 8, 30 + (i % 720) - 360, 8 + (Math.floor(i / 720) % 14))
const z = (v) => String(v).padStart(2, '0')
const crowd = (n) =>
  ics(
    ...Array.from({ length: n }, (_, i) => {
      const d = slot(i)
      return vevent(`e${i}`, `DTSTART:${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}T${z(d.getHours())}0000`, 'SUMMARY:x')
    }),
  )
const big = parse(crowd(5040))
eq(big.events.length, EVENT_CAP, 'a feed over the cap is cut to the cap')
eq(big.dropped, 5040 - EVENT_CAP, 'and says how many it left out')
ok(big.events.every((e, i, all) => i === 0 || all[i - 1].start <= e.start), 'what is kept stays in date order')
const distances = Array.from({ length: 5040 }, (_, i) => Math.abs(slot(i).getTime() - now.getTime())).sort((a, b) => a - b)
ok(big.events.every((e) => Math.abs(e.start.getTime() - now.getTime()) <= distances[EVENT_CAP - 1]), 'the events nearest today are the ones kept')
ok(big.events[0].start < now && big.events.at(-1).start > now, 'the cut is not file order: both sides of today survive')
eq(parse(crowd(300)).dropped, 0, 'a small feed loses nothing')
const flood = parse(crowd(25000))
eq(flood.events.length, EVENT_CAP, 'a hostile feed is still cut to the cap')
ok(flood.dropped > 10000, 'and is cut early rather than expanded whole')
ok(flood.atLeast, 'and says its count is a floor, because it stopped reading')
ok(!big.atLeast && !parse(crowd(300)).atLeast, 'while an oversize feed that was read whole has an exact count')

// --- Time zones ---------------------------------------------------------------------------------

const at = (tzParams, value, endValue) =>
  parse(ics(vevent('z', `DTSTART${tzParams}:${value}`, `DTEND${tzParams}:${endValue ?? value}`, 'SUMMARY:z'))).events[0]
const ny = ';TZID=America/New_York'
eq(at(ny, '20261005T090000', '20261005T100000').start.toISOString(), '2026-10-05T13:00:00.000Z', 'New York in October is UTC-4')
eq(at(ny, '20261005T090000', '20261005T100000').end.toISOString(), '2026-10-05T14:00:00.000Z', 'and so is the end')
eq(at(ny, '20261201T090000').start.toISOString(), '2026-12-01T14:00:00.000Z', 'New York in December is UTC-5')
eq(at(';TZID=Europe/London', '20260330T090000').start.toISOString(), '2026-03-30T08:00:00.000Z', 'London on BST')
eq(at(';TZID=Europe/London', '20261201T090000').start.toISOString(), '2026-12-01T09:00:00.000Z', 'London on GMT')
eq(at(';TZID=Asia/Kolkata', '20261005T090000').start.toISOString(), '2026-10-05T03:30:00.000Z', 'a half-hour zone')
eq(at(';TZID=Australia/Sydney', '20260115T090000').start.toISOString(), '2026-01-14T22:00:00.000Z', 'southern summer is UTC+11')
eq(at(';TZID=Australia/Sydney', '20260615T090000').start.toISOString(), '2026-06-14T23:00:00.000Z', 'southern winter is UTC+10')
eq(at(ny, '20260308T080000').start.toISOString(), '2026-03-08T12:00:00.000Z', 'just after spring forward')
eq(at(ny, '20260308T013000').start.toISOString(), '2026-03-08T06:30:00.000Z', 'just before spring forward')
eq(at(ny, '20260308T023000').start.toISOString(), '2026-03-08T07:30:00.000Z', 'a time inside the gap reads with the offset from before it')
eq(at(ny, '20261101T013000').start.toISOString(), '2026-11-01T05:30:00.000Z', 'an ambiguous fall-back time is the first one')
eq(at(ny, '20261005T000000').start.toISOString(), '2026-10-05T04:00:00.000Z', 'midnight in a zone is not read as 24:00')
eq(at(';TZID=Australia/Sydney', '20260101T003000').start.toISOString(), '2025-12-31T13:30:00.000Z', 'and a zone ahead of UTC can land in the year before')
eq(at(ny, '20261101T023000').start.toISOString(), '2026-11-01T07:30:00.000Z', 'and the hour after it is already standard time')
const overnight = at(ny, '20260307T230000', '20260308T030000')
eq((overnight.end - overnight.start) / 3600000, 3, 'an event across the DST change lasts the hours it really lasts')
eq(at(';TZID=Not/AZone', '20261005T090000').start.getTime(), new Date(2026, 9, 5, 9).getTime(), 'a zone name we cannot resolve stays local wall clock')
eq(at(';TZID=Eastern Standard Time', '20261005T090000').start.getTime(), new Date(2026, 9, 5, 9).getTime(), 'a Windows zone name too')
eq(at('', '20261005T090000').start.getTime(), new Date(2026, 9, 5, 9).getTime(), 'a floating time is local wall clock')
eq(at('', '20261005T090000Z').start.toISOString(), '2026-10-05T09:00:00.000Z', 'a Z time is UTC')
const allDay = at(`;VALUE=DATE${ny}`, '20261005', '20261006')
ok(allDay.allDay && allDay.start.getTime() === new Date(2026, 9, 5).getTime(), 'a date is never shifted by a zone')

const series = ics(
  vevent('s', `DTSTART${ny}:20261005T090000`, `DTEND${ny}:20261005T100000`, 'RRULE:FREQ=WEEKLY;COUNT=3', `EXDATE${ny}:20261012T090000`, 'SUMMARY:Seminar'),
)
eq(parse(series).events.map((e) => e.start.toISOString()), ['2026-10-05T13:00:00.000Z', '2026-10-19T13:00:00.000Z'], 'a zoned EXDATE removes its occurrence')
const moved = ics(
  vevent('s', `DTSTART${ny}:20261005T090000`, `DTEND${ny}:20261005T100000`, 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Seminar'),
  vevent('s', `RECURRENCE-ID${ny}:20261012T090000`, `DTSTART${ny}:20261012T110000`, `DTEND${ny}:20261012T120000`, 'SUMMARY:Moved'),
)
const movedEvents = parse(moved).events
eq(movedEvents.map((e) => e.summary), ['Seminar', 'Moved', 'Seminar'], 'a zoned RECURRENCE-ID finds the occurrence it replaces')
eq(movedEvents[1].start.toISOString(), '2026-10-12T15:00:00.000Z', 'at its new time')

// --- Feed links ---------------------------------------------------------------------------------

const url = (s) => normalizeFeedUrl(s).url
eq(url('webcal://x.org/cal.ics'), 'https://x.org/cal.ics', 'webcal is https underneath')
eq(url('WEBCALS://x.org/cal.ics?t=1'), 'https://x.org/cal.ics?t=1', 'so is webcals, in any case')
eq(url('webcal://127.0.0.1:8080/c.ics'), 'https://127.0.0.1:8080/c.ics', 'a webcal link keeps its port')
eq(url('events.cmu.edu/cal.ics'), 'https://events.cmu.edu/cal.ics', 'a link copied without its scheme gets one')
eq(url('  http://a.example/c.ics  '), 'http://a.example/c.ics', 'whitespace is trimmed, http is left alone')
eq(url('localhost:8080/x.ics'), 'https://localhost:8080/x.ics', 'a host and port is not a scheme')
for (const bad of ['ftp://x.org/c.ics', 'file:///C:/c.ics', 'mailto:a@b.co', 'javascript:alert(1)', 'C:\\cal.ics']) {
  ok(/Only http/.test(normalizeFeedUrl(bad).error), `${bad} is refused by name`)
}
for (const bad of ['not a url', 'https://', '   ']) ok(normalizeFeedUrl(bad).error, `${JSON.stringify(bad)} is refused`)

const reason = (code, message = 'x') => describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) }), 20000)
ok(/refused/.test(reason('ECONNREFUSED')), 'refused')
ok(/could not look up that server/.test(reason('ENOTFOUND')), 'unknown host')
ok(/address is wrong, or you are offline/.test(reason('ENOTFOUND')), 'and it does not blame the address alone, because an offline laptop says the same')
ok(/name lookup/.test(reason('EAI_AGAIN')), 'DNS down')
ok(/timed out/.test(reason('UND_ERR_CONNECT_TIMEOUT')), 'connect timeout')
ok(/refused/.test(describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ECONNREFUSED' }] } }), 1)), 'a refusal nested in an AggregateError')
ok(/refused/.test(describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }), 1)), 'a refusal only named in the message')
ok(/certificate/.test(reason('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate')), 'a bad certificate')
eq(describeFetchError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 20000), 'No answer in 20s.', 'the timeout keeps its wording')
ok(!/offline/.test(reason('WHATEVER', 'something odd')), 'an unknown cause is quoted, not guessed as "offline"')

// The real thing, not a hand-built imitation of it: what this Node's fetch throws for each failure.
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)) })
const loop = await listen((req, res) => { res.writeHead(302, { Location: '/' }); res.end() })
const closed = await listen(() => {})
const closedPort = closed.address().port
await new Promise((r) => closed.close(r))
const why = (u) => fetch(u, { redirect: 'follow' }).then(() => 'fetched', (e) => describeFetchError(e, 20000))
ok(/redirect/i.test(await why(`http://127.0.0.1:${loop.address().port}/`)), 'a redirect loop says so')
ok(/refused/.test(await why(`http://127.0.0.1:${closedPort}/`)), 'a closed port says so')
await new Promise((r) => loop.close(r))

// --- Canvas titles and kinds ----------------------------------------------------------------------

const keys = courseKeys([
  { id: '02-110', code: '02-110' },
  { id: 'old-101', code: '01-101' }, // a placeholder whose code was renamed; its id is still the old one
  { id: 'cs-101', code: 'CS 101' },
  { id: 'cs-1010', code: 'CS 1010' },
  { id: 'writing', code: 'WRITING' },
  { id: '04-101', code: '04101' },
  { id: '02-201', code: '02-201' },
  { id: 'is', code: 'IS' },
])
const split = (t) => splitCanvasTitle(t, keys)
eq(split('HW 1 [01101]'), { title: 'HW 1', courseId: 'old-101' }, 'a tag files under the space whose CODE matches, not only its id')
eq(split('Problem Set [02110-A]'), { title: 'Problem Set', courseId: '02-110' }, 'and a section suffix is fine')
eq(split('Lab Report [01-101 Sec A]'), { title: 'Lab Report', courseId: 'old-101' }, 'a hyphenated tag')
eq(split('Homework 3 [CS101-001 Fall 2026]'), { title: 'Homework 3', courseId: 'cs-101' }, 'a non-CMU code with a section')
eq(split('Homework 3 [CS1010-001 Fall 2026]'), { title: 'Homework 3', courseId: 'cs-1010' }, 'CS1010 is not CS101')
eq(split('Essay [CS 101]'), { title: 'Essay', courseId: 'cs-101' }, 'a code with a space')
eq(split('Homework 3 [MATH200-002 Fall 2026]'), { title: 'Homework 3 [MATH200-002 Fall 2026]', courseId: null }, 'a tag that is no space of yours stays in the title')
eq(split('Quiz [Week 2]'), { title: 'Quiz [Week 2]', courseId: null }, 'a bracket that is not a course is part of the title')
eq(split('Essay Draft [ENGL 1010]'), { title: 'Essay Draft [ENGL 1010]', courseId: null }, 'an unknown course keeps its tag so two courses stay apart')
eq(split('Wk 2 REP_ Submit to Canvas [02201-C1]'), { title: 'Wk 2 REP_ Submit to Canvas', courseId: '02-201' }, 'a numeric code with a section tag after it')
eq(split('Reading [04101-IS F26 ]'), { title: 'Reading', courseId: '04-101' }, 'and with a program and a term, padded')
eq(split('Lab [IS F26 ]'), { title: 'Lab', courseId: 'is' }, 'a letter code followed by a term')
eq(split('Essay [Writing F26]'), { title: 'Essay', courseId: 'writing' }, 'a course word then a section tag is still a tag')
eq(split('Memo [WRITING]'), { title: 'Memo', courseId: 'writing' }, 'a bracket that is only the course word')
eq(split('T [Writing Assignment 3]'), { title: 'T [Writing Assignment 3]', courseId: null }, 'a course word followed by real words is part of the title, not a tag')
eq(split('HW 1 [01101 Lecture]'), { title: 'HW 1', courseId: 'old-101' }, 'a numeric code followed by a word is still the course')
eq(split('[01101]'), { title: '[01101]', courseId: null }, 'a title that is only a tag is left whole')
eq(split('  Read chapter 4  '), { title: 'Read chapter 4', courseId: null }, 'no bracket, just trimmed')

const kinds = {
  'Final Project Proposal': 'pset',
  'Final Paper Draft': 'pset',
  'Final project presentation': 'pset',
  'Final Exam': 'exam',
  Final: 'exam',
  'Final (Section 2)': 'exam',
  'Midterm Exam': 'exam',
  'Midterm 1': 'exam',
  'Quiz 3': 'quiz',
  'Reading Week 3': 'reading',
  'HW 4': 'pset',
  'Lab Report': 'other',
  'Consent survey': 'admin',
  // A bare "final" is an exam when it is the last word or beside exam-ish words, and work otherwise.
  'Final exam review': 'exam',
  'Final Examination': 'exam',
  'Take-home final': 'exam',
  'Math final': 'exam',
  'Midterm and Final': 'exam',
  'Final Review': 'exam',
  'Final Lab Report': 'other',
  'Final Case Study': 'other',
  'Final Reading Response': 'reading',
  'Final - Project Proposal': 'pset',
  'Final: Project': 'pset',
  'Group Talk_Submit Final Slides w. Notes': 'other',
  'Final Proposal': 'other',
  'Final Reflection Memo': 'other',
  'Peer Review: Final Draft': 'pset',
  'Quiz Final': 'exam',
}
for (const [title, kind] of Object.entries(kinds)) eq(guessKind(title), kind, `${title} is ${kind}`)

console.log(`ICS reader and feed helpers: ${checks} checks passed (long-running daily rules, truncation, time zones, links, errors, Canvas titles, kinds).`)
