import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build, transformSync } from 'esbuild'
import { fileURLToPath } from 'node:url'
const source = readFileSync(new URL('../src/shared/day-plan.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm' })
const { buildDayPlan, mirrorsClass, moveDueToDay, moveOverdueToDay, eventsOnDay, isBanner, clock, localDay } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const day = '2026-09-09'
const cls = { courseId: '01-101', day: 2, start: '10:00', end: '11:00', location: 'Hall 5' }
const event = (title, start, end) => ({ title, start, end, uid: title, subscriptionId: 'test', allDay: false, location: '' })
const at = time => `${day}T${time}:00`
assert.deepEqual(buildDayPlan([cls], [], day, 8 * 60).gaps, [{ start: 480, end: 600 }, { start: 660, end: 1380 }])
assert.equal(buildDayPlan([], [], day, 9 * 60).freeMinutes, 14 * 60)
assert.equal(buildDayPlan([], [], day, 23 * 60 + 1).freeMinutes, 0)
assert.equal(buildDayPlan([cls], [], day, 10 * 60 + 30).gaps[0].start, 660)
const interview = event('Interview', at('10:00'), at('11:30'))
assert.equal(mirrorsClass(interview, [cls]), false)
assert.equal(mirrorsClass(event('01-101 Lecture 1', at('10:00'), at('11:00')), [cls]), true)
assert.equal(mirrorsClass(event('01-101 Lecture 1', at('10:00'), at('12:00')), [cls]), false)
const nested = buildDayPlan([cls], [interview, event('Call', at('10:15'), at('10:45'))], day, 9 * 60)
assert.equal(nested.conflicts.length, 3)
assert.equal(nested.gaps[1].start, 690)
assert.equal(buildDayPlan([cls], [event('Next class', at('11:00'), at('12:00'))], day, 600).conflicts.length, 0)
assert.equal(buildDayPlan([], [event('Overnight', '2026-09-08T23:00:00', at('09:30'))], day, 480).gaps[0].start, 570)
assert.equal(buildDayPlan([], [event('Late', at('22:00'), '2026-09-10T02:00:00')], day, 21 * 60).freeMinutes, 60)
assert.equal(buildDayPlan([], [interview, { ...interview, subscriptionId: 'copy' }], day, 480).blocks.length, 1)
assert.equal(buildDayPlan([], [event('Bad', 'invalid', 'invalid'), { ...interview, allDay: true }], day, 480).blocks.length, 0)
assert.equal(buildDayPlan([{ ...cls, end: '09:00' }], [], day, 480).blocks.length, 0)
assert.equal(buildDayPlan([], [event('Tiny gap', at('08:30'), at('23:00'))], day, 480).freeMinutes, 0)
assert.equal(buildDayPlan([], [event('Instant', at('17:00'), at('17:00'))], day, 480).blocks.length, 1)
assert.equal(buildDayPlan([], [event('Instant', at('17:00'), at('17:00'))], day, 480).freeMinutes, 900)
assert.equal(moveDueToDay('2026-09-09', '2026-09-10'), '2026-09-10')
assert.equal(new Date(moveDueToDay(at('17:30'), '2026-09-10')).getHours(), 17)
assert.equal(new Date(moveDueToDay(at('17:30'), '2026-09-10')).getMinutes(), 30)
const multi = { ...event('Conference', '2026-09-08', '2026-09-10'), allDay: true }
assert.equal(eventsOnDay([multi], day).length, 1)
assert.equal(eventsOnDay([multi], '2026-09-10').length, 0)
assert.equal(eventsOnDay([event('Overnight', '2026-09-08T23:00:00', at('09:30'))], day).length, 1)
assert.equal(buildDayPlan([], [event('Midnight end', '2026-09-08T23:00:00', at('00:00'))], day, 0).blocks.length, 0)
// A real public feed exports SCS TechNights as ONE timed event from Sep 24 to Oct 29. It is
// informational on every day it touches: no busy time, no "happening now", no invented overlaps.
const technights = event('SCS TechNights', '2026-09-08T18:00:00', '2026-10-13T19:30:00')
for (const d of ['2026-09-08', day, '2026-10-13']) {
  const plan = buildDayPlan([cls], [technights, event('Call', `${d}T10:15:00`, `${d}T10:45:00`)], d, 480)
  assert.equal(plan.blocks.filter(b => b.title === 'SCS TechNights').length, 0)
  assert.equal(plan.freeMinutes, buildDayPlan([cls], [event('Call', `${d}T10:15:00`, `${d}T10:45:00`)], d, 480).freeMinutes)
}
assert.equal(buildDayPlan([], [technights], day, 480).freeMinutes, 15 * 60)
assert.equal(buildDayPlan([cls], [technights], day, 480).conflicts.length, 0)
assert.equal(eventsOnDay([technights], day).filter(isBanner).length, 1)
// Only long AND midnight-crossing events are banners; a real overnight commitment still blocks time.
assert.equal(isBanner({ ...technights, allDay: true }), true)
assert.equal(isBanner(event('Overnight', '2026-09-08T23:00:00', at('09:30'))), false)
assert.equal(isBanner(event('Exactly 12h', '2026-09-08T20:00:00', at('08:00'))), false)
assert.equal(isBanner(event('Just over 12h', '2026-09-08T20:00:00', at('08:01'))), true)
assert.equal(isBanner(event('Long, one day', at('08:00'), at('21:00'))), false)
assert.equal(isBanner(event('Bad', 'invalid', 'invalid')), false)
assert.equal(buildDayPlan([{ ...cls, start: '09:00', end: '10:00' }], [event('Overnight', '2026-09-08T23:00:00', at('09:30'))], day, 0).conflicts.length, 1)
assert.equal(clock(1440), '12:00 am')
assert.equal(clock(0), '12:00 am')
assert.equal(clock(12 * 60), '12:00 pm')
assert.equal(clock(13 * 60 + 5), '1:05 pm')
assert.equal(clock(1439), '11:59 pm')
// "→ Today" on an overdue timed item: a clock still ahead is kept, one already past goes all-day so the row leaves Overdue.
const yesterday9 = new Date(2026, 8, 8, 9, 0).toISOString()
assert.equal(moveOverdueToDay(yesterday9, day, new Date(2026, 8, 9, 17, 0)), day)
assert.equal(new Date(moveOverdueToDay(yesterday9, day, new Date(2026, 8, 9, 8, 0))).getHours(), 9)
assert.equal(moveOverdueToDay('2026-09-01', day, new Date(2026, 8, 9, 17, 0)), day)
assert.equal(new Date(moveDueToDay(yesterday9, day)).getHours(), 9)
// relativeDue lives in the renderer store: bundle it the way notes.mjs bundles its views.
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/renderer/src/store.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', tsconfig: fileURLToPath(new URL('../tsconfig.web.json', import.meta.url)), logLevel: 'silent' })
const { relativeDue } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const ahead = n => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d) }
assert.equal(relativeDue(ahead(0)), 'today')
assert.equal(relativeDue(ahead(6)), 'in 6 days')
assert.equal(relativeDue(ahead(7)), 'in 7 days')
assert.equal(relativeDue(ahead(13)), 'in 13 days')
assert.equal(relativeDue(ahead(14)), 'in 2 weeks')
assert.equal(relativeDue(ahead(-3)), '3 days ago')
for (const bad of ['banana', '', '0', '2026-09-09T25:99:00']) assert.equal(relativeDue(bad), bad)
console.log('Day planning: 52 checks passed (openings, conflicts, duplicates, multi-day events, overnight blocks, clock, rescheduling and relative dates).')
