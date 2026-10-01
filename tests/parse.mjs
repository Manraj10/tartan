import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
const source = readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm' })
const { parseEntry } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

// A Wednesday. Every date below is worked out from it, never from the real clock.
const now = new Date('2026-09-30T14:00:00')
const courses = [
  { id: '01-101', code: '01-101' },
  { id: 'odd', code: '演習' },
]
const parse = (text) => parseEntry(text, courses, { now })
/** The due as local 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM', whatever the machine's zone. */
const when = (due) => {
  if (!due) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due
  const d = new Date(due)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const due = (text) => when(parse(text).due)

// 1. Month words must be real spellings.
assert.deepEqual([parse('Marketing 5').due, parse('Marketing 5').title], ['', 'Marketing 5'])
assert.equal(parse('decide 3 options').due, '')
assert.equal(parse('Read novel 2 by 10/5').title, 'Read novel 2')
assert.equal(due('Read novel 2 by 10/5'), '2026-10-05')
assert.equal(due('essay sept 7'), '2027-09-07')
assert.equal(due('essay december 3'), '2026-12-03')
assert.equal(parse('Read chapter 3 May').due, '')

// 2. Times: dots, noon, midnight, and the 24-hour fallback that used to steal digits.
assert.equal(due('essay fri 5:00 p.m.'), '2026-10-02 17:00')
assert.equal(due('essay fri 11:59 P.M.'), '2026-10-02 23:59')
assert.equal(due('essay fri 9 a.m.'), '2026-10-02 09:00')
assert.equal(due('essay fri 5 p.m.'), '2026-10-02 17:00')
assert.equal(due('essay fri at noon'), '2026-10-02 12:00')
assert.equal(parse('essay fri at noon').title, 'essay')
// Midnight is the end of the day named (11:59pm), so "by midnight" is tonight, not 14 hours ago.
assert.equal(due('essay midnight friday'), '2026-10-02 23:59')
assert.equal(due('pset by midnight'), '2026-09-30 23:59')
assert.equal(due('essay fri 12 am'), '2026-10-02 00:00')
assert.equal(due('essay fri 12 pm'), '2026-10-02 12:00')
assert.equal(due('essay fri 17:30'), '2026-10-02 17:30')
assert.equal(parse('essay fri 13:00 pm').due, '2026-10-02')
assert.equal(parse('essay fri 5pm amazing').title, 'essay amazing')
// A time alone is today at that time: a deadline, not a todo.
assert.equal(due('call mom 5pm'), '2026-09-30 17:00')
// 6:30 has already gone by at 14:00, so the line means tomorrow morning.
assert.equal(due('call mom at 6:30'), '2026-10-01 06:30')
assert.equal(due('call mom at 6:30pm'), '2026-09-30 18:30')
assert.equal(parse('call mom at 6:30').title, 'call mom')
assert.equal(due('lunch noon'), '2026-10-01 12:00')
assert.equal(parse('call mom').due, '')
// With no date, a bare H:MM is not a time: verses, ratios, office hours and course digits keep their digits.
for (const t of ['John 3:16 reading', 'ratio 3:10 problem set', 'Office hours 2:30', '01-101 pset 4 3:30']) {
  assert.equal(parse(t).due, '', t)
  assert.equal(parse(t).every, null, t)
}
assert.equal(parse('John 3:16 reading').title, 'John 3:16 reading')
assert.equal(parse('ratio 3:10 problem set').title, 'ratio 3:10 problem set')
assert.equal(parse('Office hours 2:30').title, 'Office hours 2:30')
assert.equal(parse('01-101 pset 4 3:30').title, 'pset 4 3:30')
assert.equal(parse('01-101 pset 4 3:30').courseId, '01-101')
// ...but beside a date it is, as it always was.
assert.equal(due('Office hours fri 2:30'), '2026-10-02 02:30')
// Ranges: the END is the due time and the whole range leaves the title, never "meeting 3-".
assert.equal(due('meeting 3-4pm'), '2026-09-30 16:00')
assert.equal(parse('meeting 3-4pm').title, 'meeting')
assert.equal(due('meeting 3:30-4:30pm'), '2026-09-30 16:30')
assert.equal(parse('meeting 3:30-4:30pm').title, 'meeting')
assert.equal(due('meeting fri 9am-5pm'), '2026-10-02 17:00')
assert.equal(parse('meeting fri 9am-5pm').title, 'meeting')
assert.equal(parse('meeting 3-4').due, '')
assert.equal(parse('meeting 3-4').title, 'meeting 3-4')
// "12 noon" / "12 midnight" take their 12 with them.
assert.equal(due('lunch fri 12 noon'), '2026-10-02 12:00')
assert.equal(parse('lunch fri 12 noon').title, 'lunch')
assert.equal(due('essay fri 12 midnight'), '2026-10-02 23:59')
assert.equal(parse('essay fri 12 midnight').title, 'essay')

assert.equal(due('lunch 12:00 noon'), '2026-10-01 12:00')
assert.equal(parse('lunch 12:00 noon').title, 'lunch')
assert.equal(due('essay fri 12:00 midnight'), '2026-10-02 23:59')
assert.equal(parse('essay fri 12:00 midnight').title, 'essay')
// A SPACED dash between a date and a time is a separator, not a range: the date stays a date.
for (const [t, want, title] of [
  ['essay due oct 5 - 11:59pm', '2026-10-05 23:59', 'essay'],
  ['essay oct 5 - 5pm', '2026-10-05 17:00', 'essay'],
  ['Pset 4 - Oct 5 - 11:59pm', '2026-10-05 23:59', 'Pset 4'],
  ['essay oct 5 – 11:59pm', '2026-10-05 23:59', 'essay'],
]) {
  assert.equal(due(t), want, t)
  assert.equal(parse(t).title, title, t)
}
// ...and the digit before a spaced dash is not the start of a range, so it stays in the title.
assert.equal(due('pset 4 - 5pm friday'), '2026-10-02 17:00')
assert.equal(parse('pset 4 - 5pm friday').title, 'pset 4')
assert.equal(parse('pset 4 - 5pm friday').kind, 'pset')
assert.equal(due('Reading 3 - 5pm'), '2026-09-30 17:00')
assert.equal(parse('Reading 3 - 5pm').title, 'Reading 3')
// A tight dash is still a range, and a spaced one is not.
assert.equal(due('meeting 3 - 4pm'), '2026-09-30 16:00')
assert.equal(parse('meeting 3 - 4pm').title, 'meeting 3')
// "oct 3-4pm" could be Oct 3 at 4pm or a range on some day; neither guess is safe, so it stays text.
assert.deepEqual([parse('essay oct 3-4pm').due, parse('essay oct 3-4pm').title], ['', 'essay oct 3-4pm'])
// "on <singular day>" is a date, never a rule; only "on <plural days>" repeats.
assert.equal(due('pset due on friday'), '2026-10-02')
assert.equal(parse('pset due on friday').every, null)
assert.equal(parse('pset due on friday').title, 'pset')
assert.equal(due('exam on monday at 9am'), '2026-10-05 09:00')
assert.equal(parse('exam on monday at 9am').every, null)
assert.equal(parse('exam on monday at 9am').title, 'exam')

// 3. Other spellings of a date, and an explicit year that leaves the title.
assert.equal(due('essay oct 5th'), '2026-10-05')
assert.equal(due('essay 5th oct'), '2026-10-05')
assert.equal(due('essay 5 of october'), '2026-10-05')
assert.equal(due('essay 5th of october'), '2026-10-05')
assert.equal(parse('essay 5th oct').title, 'essay')
assert.equal(due('essay 2026-10-05'), '2026-10-05')
assert.equal(due('essay oct 5 2027'), '2027-10-05')
assert.equal(parse('essay oct 5 2027').title, 'essay')
assert.equal(due('essay oct 5, 2027'), '2027-10-05')
assert.equal(parse('essay oct 5, 2027').title, 'essay')
assert.equal(due('essay 5 oct 2027'), '2027-10-05')
assert.equal(due('essay 10/5/27'), '2027-10-05')
assert.equal(parse('pset 4 march').due, '')
assert.equal(due('pset 4 oct 10'), '2026-10-10')
assert.equal(due('essay oct 5'), '2026-10-05')

// 3b. Day-first needs an ordinal, "of" or a year. A plain "N month" is ordinary title text.
for (const t of ['Homework 3 dec', 'assignment 2 march', 'quiz 3 march', 'Lab 3 may', 'Exam 1 march', 'read 3 may', 'project 2 may', 'Read chapter 3 May', 'ch. 3 may', 'essay 5 oct']) {
  assert.equal(parse(t).due, '', t)
  assert.equal(parse(t).title, t, t)
}

// 3b2. A clock time after a month word is not a day: no invented date, and the time is not mangled.
// "3 dec" names a day the parser refuses, so its time is not moved to tonight either: the line stays text.
for (const t of ['Homework 3 dec 11:59pm', 'Lab 3 may 9:30am', 'Lab 3 may 9 am', 'Homework 3 dec 3-4pm', 'Homework 3 dec, 5pm']) {
  assert.deepEqual([parse(t).due, parse(t).title], ['', t], t)
}
assert.equal(due('essay 5th oct 11:59pm'), '2026-10-05 23:59')
assert.equal(parse('essay 5th oct 11:59pm').title, 'essay')
assert.equal(due('essay 5 of october 11:59pm'), '2026-10-05 23:59')
assert.equal(due('essay 5th oct 3:30pm'), '2026-10-05 15:30')
assert.equal(parse('essay 5th oct 3:30pm').title, 'essay')
assert.equal(due('essay 5th oct 3-4pm'), '2026-10-05 16:00')
assert.equal(parse('essay 5th oct 3-4pm').title, 'essay')
assert.equal(due('pset 4 due 5th oct 3-4pm'), '2026-10-05 16:00')
assert.equal(parse('pset 4 due 5th oct 3-4pm').title, 'pset 4')
assert.equal(due('essay 5th oct 11 slides'), '2026-10-05')
assert.equal(due('essay oct 5 11:59pm'), '2026-10-05 23:59')
assert.equal(due('essay oct 11 3-4pm'), '2026-10-11 16:00')

// 3c. A typed year counts only from this year to five years out; any other number stays in the title.
assert.equal(due('write essay oct 5 2000 words'), '2026-10-05')
assert.equal(parse('write essay oct 5 2000 words').title, 'write essay 2000 words')
assert.equal(due('essay oct 5 2031'), '2031-10-05')
assert.equal(due('essay oct 5 2032'), '2026-10-05')
assert.equal(parse('essay oct 5 2032').title, 'essay 2032')
assert.equal(parse('essay 2000-10-05').due, '')
assert.equal(parse('essay 2000-10-05').title, 'essay 2000-10-05')
assert.equal(parse('essay 10/5/2000').due, '')
assert.equal(parse('essay 5 oct 2000').due, '')

// 4. Rollover and validity.
assert.equal(due('essay 1/15'), '2027-01-15')
assert.equal(due('essay sep 5'), '2027-09-05')
assert.equal(due('essay sep 30'), '2026-09-30')
assert.equal(due('essay sep 1 2026'), '2026-09-01')
assert.equal(parse('essay sep 31').due, '')
assert.equal(parse('essay 2/30').due, '')
assert.equal(parse('essay 13/5').due, '')
assert.equal(parse('essay oct 0').due, '')
assert.equal(parse('essay sep 31').title, 'essay sep 31')

// 5. Kind words that only count in context.
const kind = (text) => parse(text).kind
assert.equal(kind('final exam friday'), 'exam')
assert.equal(kind('finals'), 'exam')
assert.equal(kind('midterm'), 'exam')
assert.equal(kind('final friday'), 'exam')
for (const t of ['final project', 'final paper', 'final draft', 'final report', 'final presentation', 'final essay', 'final proposal']) {
  assert.equal(kind(t), 'other', t)
}
assert.equal(kind('final project pset 5'), 'pset')
assert.equal(kind('lab 3'), 'pset')
assert.equal(kind('lab meeting'), 'other')
assert.equal(kind('lab hours'), 'other')
assert.equal(kind('form a study group'), 'other')
assert.equal(kind('sign the housing form'), 'admin')
assert.equal(kind('form due friday'), 'admin')
assert.equal(kind('housing form.'), 'admin')
// "form" before a date, time or course still names an admin task: the check sees the line without them.
for (const t of ['housing form friday', 'sign form friday', 'tax form tomorrow', 'fafsa form oct 5', 'submit form 5pm', 'sign form 01-101']) {
  assert.equal(kind(t), 'admin', t)
}
assert.equal(kind('form a study group friday'), 'other')
// "form" followed by for/to/from/with/and is still the paperwork noun.
for (const t of ['application form for housing friday', 'immunization form to health center friday', 'form for housing friday', 'form from the registrar friday', 'form with signature friday', 'form and receipt friday']) {
  assert.equal(kind(t), 'admin', t)
}
// Object's own properties are not kind words.
assert.equal(kind('fix constructor bug'), 'other')
assert.equal(kind('toString is wrong'), 'other')

// 6. Recurrence words. Day indices are Mon=0; today is a Wednesday.
const every = (text) => parse(text).every
assert.deepEqual(every('gym every day').days, [0, 1, 2, 3, 4, 5, 6])
assert.deepEqual(every('gym every weekday').days, [0, 1, 2, 3, 4])
assert.equal(parse('gym every weekday').spans[0].label, 'Every weekday')
assert.deepEqual(every('every friday').days, [4])
assert.deepEqual(every('gym on tuesdays and thursdays').days, [1, 3])
assert.equal(parse('gym on tuesdays and thursdays').title, 'gym')
assert.deepEqual(every('gym every mon wed').days, [0, 2])
assert.deepEqual(every('gym every tuesday and thursday at 3pm').days, [1, 3])
assert.equal(every('gym every fri at 3pm').time, '15:00')
assert.equal(parse('gym every fri at 3pm').due, '')
// A bare singular stays a date, not a rule.
assert.equal(parse('gym friday').every, null)
assert.equal(due('gym friday'), '2026-10-02')
// Dismissing the chip returns the words to the title and never turns them into a date.
const dismissed = parseEntry('gym every day', courses, { now, ignore: ['every:every day'] })
assert.equal(dismissed.every, null)
assert.equal(dismissed.title, 'gym every day')
assert.equal(dismissed.due, '')
const dismissedDay = parseEntry('gym every mon', courses, { now, ignore: ['every:every mon'] })
assert.equal(dismissedDay.every, null)
assert.equal(dismissedDay.due, '')
assert.equal(dismissedDay.title, 'gym every mon')
// Only an explicit "every ..." or "on <plural days>" makes a rule. Cadence words and bare plurals are title text.
for (const t of ['gym daily', 'gym everyday', 'gym weekdays', 'review weekly', 'gym mondays', 'Mondays with Morrie', 'Daily Bruin article']) {
  assert.equal(parse(t).every, null, t)
  assert.equal(parse(t).due, '', t)
  assert.equal(parse(t).title, t, t)
}
assert.equal(due('weekly reading response due friday'), '2026-10-02')
assert.equal(parse('weekly reading response due friday').title, 'weekly reading response')
assert.equal(parse('weekly reading response due friday').every, null)
assert.equal(due('write weekly reflection by oct 5'), '2026-10-05')
assert.equal(parse('write weekly reflection by oct 5').title, 'write weekly reflection')
assert.equal(due('Daily Bruin article due friday'), '2026-10-02')
assert.equal(parse('Daily Bruin article due friday').title, 'Daily Bruin article')
assert.equal(parse('every friday').every.days[0], 4)

// 7. A space whose code has no ASCII letters or digits must not match the gap before a space.
assert.equal(parse('call mom ').courseId, null)
assert.equal(parse('call mom ').spans.length, 0)
assert.equal(parse('01-101 pset 4 ').courseId, '01-101')
// ...but the code itself still matches when it has no ASCII to fall back on.
assert.equal(parse('hello 演習 notes').courseId, 'odd')
assert.equal(parse('hello 演習 notes').title, 'hello notes')

// The original behaviour, unchanged.
assert.equal(due('01-101 pset 4 due friday'), '2026-10-02')
assert.equal(parse('01-101 pset 4 due friday').title, 'pset 4')
assert.equal(due('essay tomorrow 11:59pm'), '2026-10-01 23:59')
assert.equal(due('essay next friday'), '2026-10-09')
assert.equal(due('essay in 3 days'), '2026-10-03')
assert.equal(parse('email the TA').due, '')

// A date the parser refused never turns into "today at that time".
for (const t of ['essay 10/5-11:59pm', 'essay oct 5th-11:59pm', 'essay oct 5-11:59pm']) {
  assert.deepEqual([parse(t).due, parse(t).title], ['', t], t)
}
assert.deepEqual([due('Marketing call 5pm'), parse('Marketing call 5pm').title], ['2026-09-30 17:00', 'Marketing call'])
// A spaced range needs am/pm on its start; a bare number before a spaced dash stays in the title.
assert.deepEqual([due('meeting 3pm - 4pm'), parse('meeting 3pm - 4pm').title], ['2026-09-30 16:00', 'meeting'])
assert.deepEqual([due('pset 4 - 5pm friday'), parse('pset 4 - 5pm friday').title], ['2026-10-02 17:00', 'pset 4'])
// "12 noon" keeps its 12, but not when the 12 is the day of a date.
assert.deepEqual([due('essay oct 12 noon'), parse('essay oct 12 noon').title], ['2026-10-12 12:00', 'essay'])
assert.deepEqual([due('exam dec 12 midnight'), parse('exam dec 12 midnight').title], ['2026-12-12 23:59', 'exam'])

console.log('Parser: checks passed (month words, times, date spellings, rollover, kind context, explicit repeats only, empty and non-ASCII course codes).')
