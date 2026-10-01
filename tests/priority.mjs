import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
const source = readFileSync(new URL('../src/shared/priority.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm' })
const { priorityOf, byPriority, priorityNote } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const now = new Date('2026-09-30T14:00:00')
const row = (title, kind, due) => ({ id: title, title, kind, due, done: false, courseId: null, source: 'manual' })
const order = (rows) => [...rows].sort(byPriority(now)).map((r) => r.title)

const examFri = row('exam', 'exam', '2026-10-02T09:00:00')
const worksheetTonight = row('worksheet', 'other', '2026-09-30T23:59:00')
const psetTomorrow = row('pset', 'pset', '2026-10-01T18:00:00')
const readingTomorrow = row('reading', 'reading', '2026-10-01T09:00:00')
const essayTwoDaysLate = row('essay', 'pset', '2026-09-28T23:59:00')
const worksheetSixDaysLate = row('old worksheet', 'other', '2026-09-24T12:00:00')

// The whole point: a worksheet due tonight does not outrank an exam in two days.
assert.deepEqual(order([worksheetTonight, examFri]), ['exam', 'worksheet'])
// Recently late graded work is the most recoverable thing on the list.
assert.equal(order([essayTwoDaysLate, psetTomorrow, readingTomorrow])[0], 'essay')
// A reading and the pset it feeds, same day: the pset first.
assert.deepEqual(order([readingTomorrow, psetTomorrow]), ['pset', 'reading'])
// Late decays: six days late ranks below work that is actually due tomorrow.
assert.ok(priorityOf(worksheetSixDaysLate, now).score < priorityOf(psetTomorrow, now).score)
// ...but two days late still outranks the same kind due in two days.
assert.ok(priorityOf(essayTwoDaysLate, now).score > priorityOf(row('later pset', 'pset', '2026-10-02T18:00:00'), now).score)
// Same kind, same lateness: the clock breaks the tie, so equal work still reads in time order.
assert.deepEqual(order([row('b', 'pset', '2026-10-01T18:00:00'), row('a', 'pset', '2026-10-01T09:00:00')]), ['a', 'b'])
// Urgency halves each day out.
const near = priorityOf(row('n', 'pset', '2026-09-30T14:00:00'), now).score
const day = priorityOf(row('d', 'pset', '2026-10-01T14:00:00'), now).score
assert.ok(Math.abs(near / day - 2) < 0.01)
// An all-day due means the end of that day, not midnight at its start.
assert.ok(priorityOf(row('today', 'pset', '2026-09-30'), now).score > 0)
assert.equal(priorityOf(row('today', 'pset', '2026-09-30'), now).reason, 'due in 10h')
// Unknown kinds fall back rather than throwing, and a broken due never wins.
assert.ok(priorityOf(row('odd', 'nonsense', '2026-10-01T09:00:00'), now).score > 0)
assert.equal(priorityOf(row('bad', 'pset', 'not-a-date'), now).score, 0)
// The note reads like the row it describes.
assert.equal(priorityNote(examFri, now), 'exam · due in 2 days')
assert.equal(priorityNote(essayTwoDaysLate, now), 'pset · 2 days late')
assert.equal(priorityNote(row('x', 'reading', '2026-09-30T20:00:00'), now), 'reading · due in 6h')

console.log('Priority: 14 checks passed (kind beats clock, recent late wins, late decays, ties by time).')
