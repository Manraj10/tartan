import assert from 'node:assert/strict'
import { build, transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The parsers live next to the React views that use them, so bundle each view (react included, it
// is only imported, never rendered) and load the result from a data: URL, like day-plan.mjs does.
async function load(entry) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../src/renderer/src/${entry}`, import.meta.url))],
    alias: { '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)) },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
}

const { parseScheduleText, mergeMeetings } = await load('views/Schedule.tsx')
const { parseSyllabus } = await load('components/SyllabusImport.tsx')
const { slugify } = await load('views/Settings.tsx')
const catalogSource = readFileSync(new URL('../src/main/catalog.ts', import.meta.url), 'utf8')
const { lookupCourses } = await import(
  `data:text/javascript;base64,${Buffer.from(transformSync(catalogSource, { loader: 'ts', format: 'esm' }).code).toString('base64')}`
)

const course = (code, id = code.toLowerCase().replace(/\s+/g, '-')) => ({ id, code, title: code, color: '#000', units: 9, links: [] })
const row = (m) => `${m.courseId}|${m.day}|${m.start}|${m.end}|${m.location}`
const rows = (ms) => ms.map(row)

/* ---------- SIO blocks ---------- */

const lab = course('03-110')
// Two meeting patterns in one block: each keeps its own days, time and room.
assert.deepEqual(
  rows(
    parseScheduleText(
      [
        'INTRO LAB SCIENCE', '03110 1', 'Dr X', 'x@example.edu',
        'M W', '11:00AM to 11:50AM', 'Room 210',
        'T', '02:00PM to 03:50PM', 'Room 118',
        'Click for more info',
      ].join('\n'),
      [lab],
    ),
  ),
  ['03-110|0|11:00|11:50|Room 210', '03-110|2|11:00|11:50|Room 210', '03-110|1|14:00|15:50|Room 118'],
)

// The documented single-pattern layout still reads the same, and a section with no room does not
// take the next section's title for one.
const calc = course('01-101')
const writing = course('02-201')
assert.deepEqual(
  rows(
    parseScheduleText(
      [
        'INTRO TO COMPUTING', '01101 A1', 'Jane Faculty', 'jf@example.edu', 'M W F', '09:00AM to 09:50AM', 'Hall 5', 'Click for more info',
        'WRITING SEMINAR', '02201 A', 'Some One', 'T Th', '02:00PM to 03:20PM', 'Click for more info',
        'NEXT COURSE', '01101 B', 'M', '01:00PM to 01:50PM', 'Room 210',
      ].join('\n'),
      [calc, writing],
    ),
  ),
  [
    '01-101|0|09:00|09:50|Hall 5', '01-101|2|09:00|09:50|Hall 5', '01-101|4|09:00|09:50|Hall 5',
    '02-201|1|14:00|15:20|', '02-201|3|14:00|15:20|',
    '01-101|0|13:00|13:50|Room 210',
  ],
)
assert.equal(parseScheduleText('TBA section\n01101 A1\nTBA\nDNM DNM\n', [calc]).length, 0)
// Days on the line after the room still belong to the time above them.
assert.deepEqual(
  rows(parseScheduleText(['X', '01101 A1', '09:00AM to 09:50AM', 'Hall 5', 'M W F'].join('\n'), [calc])),
  ['01-101|0|09:00|09:50|Hall 5', '01-101|2|09:00|09:50|Hall 5', '01-101|4|09:00|09:50|Hall 5'],
)

/* ---------- one-line pastes ---------- */

const cs101 = course('CS 101')
const cs1010 = course('CS 1010')
const one = (text, cs = [cs101]) => rows(parseScheduleText(text, cs))

// Only the end time carries am/pm: borrow it, and never leave "pm" in the room.
assert.deepEqual(one('CS 101 Tue/Thu 1:00-2:15pm Hall 5'), ['cs-101|1|13:00|14:15|Hall 5', 'cs-101|3|13:00|14:15|Hall 5'])
assert.deepEqual(one('CS 101 MWF 2:00 - 3:15 PM'), ['cs-101|0|14:00|15:15|', 'cs-101|2|14:00|15:15|', 'cs-101|4|14:00|15:15|'])
assert.deepEqual(one('CS 101 MW 11:00-12:15pm'), ['cs-101|0|11:00|12:15|', 'cs-101|2|11:00|12:15|'])
assert.deepEqual(one('CS 101 MW 9:00am-10:15'), ['cs-101|0|09:00|10:15|', 'cs-101|2|09:00|10:15|'])
assert.deepEqual(one('CS 101 M 11:00am-12:15'), ['cs-101|0|11:00|12:15|'])
// Both marked, minute-less, 24-hour.
assert.deepEqual(one('CS 101 MWF 9am-9:50am'), ['cs-101|0|09:00|09:50|', 'cs-101|2|09:00|09:50|', 'cs-101|4|09:00|09:50|'])
assert.deepEqual(one('Mon Wed 14:00 15:15 CS 101'), ['cs-101|0|14:00|15:15|', 'cs-101|2|14:00|15:15|'])
// Day words TTh and TuTh, and a hyphenless course number.
assert.deepEqual(one('CS 101 TTh 2:00PM-3:15PM Hall 5'), ['cs-101|1|14:00|15:15|Hall 5', 'cs-101|3|14:00|15:15|Hall 5'])
assert.deepEqual(one('CS 101 TuTh 2:00PM-3:15PM Hall 5'), ['cs-101|1|14:00|15:15|Hall 5', 'cs-101|3|14:00|15:15|Hall 5'])
assert.deepEqual(one('CS101 MWF 9:00AM 9:50AM'), ['cs-101|0|09:00|09:50|', 'cs-101|2|09:00|09:50|', 'cs-101|4|09:00|09:50|'])
assert.deepEqual(one('01101 MWF 10:00AM 10:50AM Hall 5', [calc]).length, 3)
// A backwards range and a line with no days are rejected, not guessed.
assert.deepEqual(one('CS 101 MWF 3:00PM 2:00PM'), [])
assert.deepEqual(one('CS 101 3:00PM 4:00PM'), [])

// The longest code wins, and the code is never read as the room.
assert.deepEqual(one('CS 1010 MWF 11:00AM 11:50AM Hall 9', [cs101, cs1010]), [
  'cs-1010|0|11:00|11:50|Hall 9', 'cs-1010|2|11:00|11:50|Hall 9', 'cs-1010|4|11:00|11:50|Hall 9',
])
assert.deepEqual(one('CS 101 MWF 11:00AM 11:50AM Hall 9', [cs1010, cs101]).map((r) => r.split('|')[0]), ['cs-101', 'cs-101', 'cs-101'])
assert.deepEqual(one('MWF 9:00AM 9:50AM CS 101')[0], 'cs-101|0|09:00|09:50|')

// A block followed by a plain line: the line is its own class, and the block keeps its own time.
assert.deepEqual(
  rows(
    parseScheduleText(
      ['CONCEPTS', '01101 A1', 'M W F', '09:00AM to 09:50AM', 'Hall 5', 'CS 101 TR 1:00PM 2:15PM'].join('\n'),
      [calc, cs101],
    ),
  ),
  ['01-101|0|09:00|09:50|Hall 5', '01-101|2|09:00|09:50|Hall 5', '01-101|4|09:00|09:50|Hall 5', 'cs-101|1|13:00|14:15|', 'cs-101|3|13:00|14:15|'],
)

/* ---------- re-pasting ---------- */

// The user's from/until survive a refresh, and a fresh room still lands.
const mini = { courseId: '01-102', day: 0, start: '11:00', end: '11:50', location: '', from: '2026-09-01', until: '2026-10-16' }
const merged = mergeMeetings([mini], [{ courseId: '01-102', day: 0, start: '11:00', end: '11:50', location: 'Room 210' }])
assert.deepEqual(merged, [{ ...mini, location: 'Room 210' }])
assert.equal(mergeMeetings([mini], [{ courseId: '01-102', day: 2, start: '11:00', end: '11:50', location: 'Room 210' }]).length, 2)
// A re-paste with no room keeps the one typed in by hand.
const roomed = { ...mini, location: 'Room 210' }
assert.deepEqual(mergeMeetings([roomed], [{ courseId: '01-102', day: 0, start: '11:00', end: '11:50', location: '' }]), [roomed])

/* ---------- syllabus ---------- */

const dates = (text, year = 2026) => parseSyllabus(text, year).map((r) => `${r.due} ${r.title}`)

// The due column wins over the assigned one, and no label is left behind.
assert.deepEqual(dates('Homework 4 | Assigned Oct 5 | Due Oct 12'), ['2026-10-12 Homework 4'])
assert.deepEqual(dates('Email the professor by 10/2 at 5pm'), ['2026-10-02 Email the professor at 5pm'])
assert.deepEqual(dates('Week 1 | Sep 14 | Pset 1 due'), ['2026-09-14 Pset 1'])
assert.deepEqual(dates('Sep 14 - Sep 16: Workshop'), ['2026-09-16 Workshop'])

// Day-first dates, and a four-digit year that is not a day.
assert.deepEqual(dates('14 September 2026 - Essay 1 due'), ['2026-09-14 Essay 1'])
assert.deepEqual(dates('Semaine 1 - 14 September 2026 - Essay 1 due'), ['2026-09-14 Semaine 1 - Essay 1'])
assert.deepEqual(dates('14/09/2026 Problem set 1'), ['2026-09-14 Problem set 1'])
assert.deepEqual(dates('Mon 15 Sep: Quiz'), ['2026-09-15 Quiz'])
assert.deepEqual(dates('3 Oct 2026 Midterm exam'), ['2026-10-03 Midterm exam'])
assert.deepEqual(dates('Due 03.10.2026 Lab report'), ['2026-10-03 Lab report'])
assert.deepEqual(dates('Sep 14, 2026 Pset 1'), ['2026-09-14 Pset 1'])
// Month-first stays month-first when a number follows the month, and 03/10 stays American.
assert.deepEqual(dates('Problem set 2 Oct 5'), ['2026-10-05 Problem set 2'])
assert.deepEqual(dates('03/10/2026 Quiz'), ['2026-03-10 Quiz'])
assert.deepEqual(dates('pages 10-12 reading'), [])

// The year comes from the caller, and a month before the first one belongs to the next year.
assert.deepEqual(dates('Sep 14 Pset 1\nDec 9 Final exam\nJan 20 Grades post', 2027), [
  '2027-09-14 Pset 1', '2027-12-09 Final exam', '2028-01-20 Grades post',
])
assert.deepEqual(dates('Jan 12 Spring semester begins\nSep 14 Pset 1', 2030), ['2030-01-12 Spring semester begins', '2030-09-14 Pset 1'])
// Only a sharp fall against the PREVIOUS date rolls the year, so key dates above the weekly table
// and a late-add date below an earlier one both stay in the year written on the form.
assert.deepEqual(
  dates('Important dates: Midterm Oct 14, Final Dec 10\nWeek 1 Sep 2 Intro\nWeek 2 Sep 9 Loops\nWeek 3 Sep 16 Pset 1 due'),
  ['2026-09-02 Intro', '2026-09-09 Loops', '2026-09-16 Pset 1', '2026-12-10 Important dates: Midterm , Final'],
)
assert.deepEqual(dates('Sep 14 Pset 1\nAugust 28 Late add'), ['2026-08-28 Late add', '2026-09-14 Pset 1'])
// The bump carries forward: everything after Dec -> Jan is next year, not just the first January row.
assert.deepEqual(dates('Nov 5 Pset 6\nDec 10 Final exam\nJan 14 Spring begins\nFeb 2 Pset 1'), [
  '2026-11-05 Pset 6', '2026-12-10 Final exam', '2027-01-14 Spring begins', '2027-02-02 Pset 1',
])

// One stray early-month row rolls the year and the next row rolls it back, so later rows are not
// pushed a year ahead.
assert.deepEqual(dates('Nov 20 Pset 9\nJan 5 Spring registration\nDec 1 Final project'), [
  '2026-11-20 Pset 9', '2026-12-01 Final project', '2027-01-05 Spring registration',
])

// "may" the verb is not May the month, except month-first, or with a capital, ordinal, "of" or year.
for (const prose of ['Unit 2 may be skipped', 'Reading 5 may help', 'Problem set 3 may be resubmitted']) {
  assert.deepEqual(dates(prose), [], prose)
}
assert.deepEqual(dates('14 May Quiz'), ['2026-05-14 Quiz'])
assert.deepEqual(dates('14 May 2027 Quiz'), ['2027-05-14 Quiz'])
assert.deepEqual(dates('14 may 2027 Quiz'), ['2027-05-14 Quiz'])
assert.deepEqual(dates('2nd of may Quiz'), ['2026-05-02 Quiz'])
assert.deepEqual(dates('may 14 Quiz'), ['2026-05-14 Quiz'])

// Brackets emptied by lifting the dates out leave nothing behind, and the words that belong to the
// phrase ("deadline", "opens", "starts", "posted") stay unless a colon or dash makes them a label.
assert.deepEqual(dates('Lab 4 (assigned Oct 5, due Oct 12)'), ['2026-10-12 Lab 4'])
assert.deepEqual(dates('Lab 4 [assigned Oct 5 | due Oct 12]'), ['2026-10-12 Lab 4'])
assert.deepEqual(dates('Drop deadline Oct 20'), ['2026-10-20 Drop deadline'])
assert.deepEqual(dates('Withdrawal deadline Nov 6'), ['2026-11-06 Withdrawal deadline'])
assert.deepEqual(dates('Registration opens Oct 5'), ['2026-10-05 Registration opens'])
assert.deepEqual(dates('Semester starts Sep 1'), ['2026-09-01 Semester starts'])
assert.deepEqual(dates('Grades posted Nov 5'), ['2026-11-05 Grades posted'])
assert.deepEqual(dates('Homework 4 | Posted: Oct 5 | Due: Oct 12'), ['2026-10-12 Homework 4'])

// A range written "Sep 14 to Sep 18" lifts out as one span: no "to", hyphen, en dash or colon is left
// stranded in the title, but a title that really starts with "To" keeps it.
assert.deepEqual(dates('Week 3 – Sep 14 to Sep 18 Loops'), ['2026-09-18 Loops'])
assert.deepEqual(dates('Week 3 – Sep 14 to Sep 18 – Loops'), ['2026-09-18 Loops'])
assert.deepEqual(dates('Week 3: Sep 14 to Sep 18: Loops'), ['2026-09-18 Loops'])
assert.deepEqual(dates('Sep 14 through Sep 18: Midterm review'), ['2026-09-18 Midterm review'])
assert.deepEqual(dates('Sep 14 thru Sep 18 - Project work'), ['2026-09-18 Project work'])
assert.deepEqual(dates('Loops (Sep 14 to Sep 18)'), ['2026-09-18 Loops'])
assert.deepEqual(dates('Reading: Sep 14 to Sep 18: Chapter 3'), ['2026-09-18 Reading: Chapter 3'])
assert.deepEqual(dates('Project work through Sep 18'), ['2026-09-18 Project work'])
assert.deepEqual(dates('To Kill a Mockingbird due Sep 14'), ['2026-09-14 To Kill a Mockingbird'])

/* ---------- space ids ---------- */

// A space's code becomes its notes folder, and renameCourse accepts only letters, digits, dot,
// underscore and dash with a letter or digit first. Whatever slugify hands over must pass that.
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
for (const [code, id] of [
  ['01-101', '01-101'],
  ['MATH/101', 'math-101'],
  ['  CS 101  ', 'cs-101'],
  ['Café 101', 'cafe-101'],
  ['Zürich & Co.', 'zurich-co'],
  ['ＣＳ １０１', 'cs-101'],
  ['Lab: "Intro?"', 'lab-intro'],
  ['a_b.c', 'a_b.c'],
  ['..-x-..', 'x'],
  ['_x', 'x'],
  ['Side Project (research)', 'side-project-research'],
]) {
  assert.equal(slugify(code), id, code)
  assert.match(slugify(code), FOLDER, code)
}
// Nothing a folder name can use is left, so the Save check refuses it rather than creating a "" space.
for (const code of ['', '   ', '日本語', '***', '--']) assert.equal(slugify(code), '', code)

/* ---------- catalog lookup ---------- */

// Every way the lookup can fail comes back as a reason the paste dialog can show, never a throw.
const realFetch = globalThis.fetch
const answer = (status, body) => async () => new Response(body, { status })
const lookup = async (fetchImpl) => {
  globalThis.fetch = fetchImpl
  try {
    return await lookupCourses(['01101'])
  } finally {
    globalThis.fetch = realFetch
  }
}
const ok = await lookup(answer(200, JSON.stringify([{ courseID: '01-101', name: 'Intro', units: '10.0', department: 'Computing' }])))
assert.deepEqual([ok.error, ok.courses.map((c) => [c.code, c.units])], [null, [['01-101', 10]]])
assert.equal((await lookup(answer(200, '[]'))).error, null)
for (const [label, fetchImpl, reason] of [
  ['502', answer(502, 'bad gateway'), /scottylabs.*HTTP 502/],
  ['html', answer(200, '<html>maintenance</html>'), /scottylabs.*not course data/],
  ['null', answer(200, 'null'), /scottylabs.*not course data/],
  ['offline', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, /Could not reach course\.apis\.scottylabs\.org \(ECONNREFUSED\)/],
  ['timeout', async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }, /did not answer/],
]) {
  const r = await lookup(fetchImpl)
  assert.deepEqual(r.courses, [], label)
  assert.match(r.error, reason, label)
}

console.log('Course import: checks passed (SIO blocks, one-line pastes, re-pasting, syllabus dates, space ids and catalog failures).')
