import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/**
 * The feed pipeline end to end, minus Electron: feeds.ts and store.ts are bundled with `electron`
 * swapped for a stub that points every path at a throwaway folder, then driven against a local
 * server. It is the only way to see the subscription import, the one-shot import and the removal
 * sweep agree with each other, because they only agree on real files.
 */
const root = mkdtempSync(path.join(tmpdir(), 'tartan-feeds-'))
const repo = fileURLToPath(new URL('..', import.meta.url))
const stub = path.join(root, 'electron-stub.mjs')
// Even a path the code forgets to override lands in the throwaway folder, never in Documents.
writeFileSync(stub, `export const app = { getPath: () => ${JSON.stringify(path.join(root, 'userData'))} }`)
mkdirSync(path.join(root, 'userData'), { recursive: true })
const bundled = await build({
  stdin: {
    contents: `
      export { refreshFeeds, feedStatus, importFeedDeadlines, forgetFeed, dismissUids, readEvents } from './src/main/feeds.ts'
      export { setDataDir, setCourses, setSubscriptions, getDeadlines, setDeadlines, importIcs } from './src/main/store.ts'`,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { electron: stub },
  logLevel: 'silent',
})
const bundle = path.join(root, 'bundle.mjs')
writeFileSync(bundle, bundled.outputFiles[0].text)
const api = await import(pathToFileURL(bundle).href)

let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const ok = (value, message) => {
  assert.ok(value, message)
  checks++
}

// --- A server with a Canvas-shaped feed, a second one, a big one, and some ways to fail ---------------

const DAY = 86400000
const stamp = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().replace(/[-:]|\.\d{3}/g, '')
const feed = (prefix, events) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...events.flatMap(([id, title, days, description]) => [
      'BEGIN:VEVENT',
      `UID:${prefix}-${id}`,
      `DTSTART:${stamp(days)}`,
      `DTEND:${stamp(days + 0.04)}`,
      `SUMMARY:${title}`,
      ...(description ? [`DESCRIPTION:${description}`] : []),
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n')
const canvas = feed('event-assignment', [
  ['1', 'HW 1 [01101]', 10],
  ['2', 'Midterm Exam [01101]', 20],
  ['3', 'Final Project Proposal', 25],
  ['4', 'Homework 3 [CS101-001 Fall 2026]', 12],
  ['5', 'Quiz [Week 2]', 5],
  ['6', 'Old thing [01101]', -90], // outside the window: a finished semester must not arrive overdue
])
const second = feed('other', [
  ['1', 'Lab 1', 8],
  ['2', 'Lab 2', 9],
])
const talks = feed('talks', [
  ['1', 'Tech Talk: Foo', 5, 'Please register here: https://x.org/r.'],
  ['2', 'Poster Session', 6],
  ['3', 'Tech Talk: Past', -1],
])
const crowd = feed('big', Array.from({ length: 5000 }, (_, i) => [i, `Event ${i}`, (i % 600) - 300]))
let canvasBody = canvas
const server = http.createServer((req, res) => {
  if (req.url === '/canvas.ics') return void res.end(canvasBody)
  if (req.url === '/second.ics') return void res.end(second)
  if (req.url === '/talks.ics') return void res.end(talks)
  if (req.url === '/big.ics') return void res.end(crowd)
  // Past ten times the cap the reader stops and can only say "at least".
  if (req.url === '/flood.ics') return void res.end(feed('flood', Array.from({ length: 25000 }, (_, i) => [i, `Event ${i}`, (i % 600) - 300])))
  if (req.url === '/page') return void res.end('<html>log in</html>')
  if (req.url === '/loop') return void res.writeHead(302, { Location: '/loop' }).end()
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

let n = 0
/** A fresh data folder per scenario, so none depends on what an earlier one left behind. */
async function fresh() {
  await api.setDataDir(path.join(root, `data-${++n}`))
  await api.setCourses([
    { id: 'old-101', code: '01-101', title: 'Renamed placeholder', color: '#e8613c', units: 9, links: [] },
    { id: 'cs-101', code: 'CS 101', title: 'Intro', color: '#3c7ae8', units: 9, links: [] },
  ])
}
const sub = (id, path, extra = {}) => ({ id, name: id, url: `${base}${path}`, mode: 'deadlines', courseId: null, color: '#5c9ea8', enabled: true, ...extra })
const sync = async (...subs) => {
  await api.setSubscriptions(subs)
  await api.refreshFeeds()
  return api.importFeedDeadlines()
}
const rows = async () => api.getDeadlines()
const byTitle = async () => Object.fromEntries((await rows()).map((d) => [d.title, d]))
const shape = (d) => ({ title: d.title, due: d.due, kind: d.kind, courseId: d.courseId, uid: d.uid })

try {
  // --- Subscription path ------------------------------------------------------------------------
  await fresh()
  const first = await sync(sub('f1', '/canvas.ics'))
  eq(first.added, 5, 'five rows: the one from last semester is outside the window')
  const t = await byTitle()
  eq([t['HW 1'].courseId, t['HW 1'].kind], ['old-101', 'pset'], 'a tag files under the space whose CODE matches, even though its id is old-101')
  eq(t['Midterm Exam'].kind, 'exam', 'an exam is an exam')
  eq(t['Final Project Proposal'].kind, 'pset', '"Final Project Proposal" is not an exam')
  eq([t['Homework 3'].courseId, t['Homework 3'].subscriptionId], ['cs-101', 'f1'], 'a non-CMU tag files under its space, and the row remembers which feed made it')
  eq([t['Quiz [Week 2]'].courseId, t['Quiz [Week 2]'].kind], [null, 'quiz'], 'a bracket that names no space stays in the title')
  ok((await rows()).every((d) => d.subscriptionId === 'f1'), 'every row carries its feed')
  const status = (await api.feedStatus())[0]
  eq([status.events, status.error, status.note], [5, null, undefined], 'a Work feed reports how many items it imported')

  // --- One-shot import agrees with it -------------------------------------------------------------
  const before = (await rows()).map(shape)
  const same = await api.importIcs(`${base}/canvas.ics`, null)
  eq([same.added, same.updated, same.skipped], [0, 0, 5], 'the one-shot import of a subscribed link changes nothing: no flip-flopping titles')
  eq((await rows()).map(shape), before, 'and the rows are exactly as they were')

  await fresh()
  const shot = await api.importIcs(`${base}/canvas.ics`, null)
  eq([shot.added, shot.updated, shot.error], [5, 0, undefined], 'the one-shot import windows the feed the same way')
  eq((await rows()).map(shape).sort((a, b) => a.uid.localeCompare(b.uid)), before.sort((a, b) => a.uid.localeCompare(b.uid)), 'and gives the same rows the subscription did')
  ok((await rows()).every((d) => d.subscriptionId === undefined), 'but its rows belong to no feed')

  // A deleted row stays deleted, for the one-shot path too.
  await api.dismissUids(['event-assignment-1'])
  await api.setDeadlines((await rows()).filter((d) => d.uid !== 'event-assignment-1'))
  const again = await api.importIcs(`${base}/canvas.ics`, null)
  eq([again.added, again.updated], [0, 0], 'a row you deleted is not brought back by importing again')
  ok(!(await rows()).some((d) => d.uid === 'event-assignment-1'), 'it is really gone')

  // A course picked in the box binds what the title does not.
  await fresh()
  await api.importIcs(`${base}/canvas.ics`, 'cs-101')
  const bound = await byTitle()
  eq([bound['Quiz [Week 2]'].courseId, bound['HW 1'].courseId], ['cs-101', 'cs-101'], 'a chosen course wins, as a feed bound to one does')

  // --- Removal -------------------------------------------------------------------------------------
  await fresh()
  await sync(sub('f1', '/canvas.ics'))
  await api.setDeadlines((await rows()).map((d) => (d.title === 'HW 1' ? { ...d, done: true } : d)))
  const off = await sync(sub('f1', '/canvas.ics', { enabled: false }))
  eq((await rows()).map((d) => d.title), ['HW 1'], 'switching a feed off removes its unticked rows and keeps what you finished')
  ok(off.updated > 0, 'and reports a change, so the phone hears about it')
  await sync(sub('f1', '/canvas.ics'))
  eq((await rows()).length, 5, 'switching it back on restores them, with no second copy of the one you ticked')
  ok((await rows()).find((d) => d.title === 'HW 1').done, 'and the tick survived')

  await sync(sub('f1', '/canvas.ics', { mode: 'events' }))
  eq((await rows()).map((d) => d.title), ['HW 1'], 'moving a Work feed to Events removes its unticked rows too')
  await api.setDeadlines([...(await rows()), { id: 'mine', courseId: null, title: 'My own thing', due: '2030-01-01', kind: 'other', done: false, source: 'manual' }])
  await sync(sub('f1', '/canvas.ics'))
  await api.setSubscriptions([])
  await api.forgetFeed('f1')
  eq((await rows()).map((d) => d.title).sort(), ['HW 1', 'My own thing'], 'deleting a feed removes its unticked rows and never touches anyone else\'s')

  // Two feeds deleted in one save: both must go, not just whichever finished last.
  await fresh()
  await sync(sub('f1', '/canvas.ics'), sub('f2', '/second.ics'))
  eq((await rows()).length, 7, 'two feeds, seven rows')
  await api.setSubscriptions([])
  await Promise.all([api.forgetFeed('f1'), api.forgetFeed('f2')])
  eq(await rows(), [], 'removing both at once leaves none of either behind')

  // A feed list that cannot be read looks empty, and must not be read as "every feed was deleted".
  await fresh()
  await sync(sub('f1', '/canvas.ics'))
  writeFileSync(path.join(root, `data-${n}`, 'subscriptions.json'), '[ {"id": "f1", oops')
  const broken = await api.importFeedDeadlines()
  eq([broken.added, (await rows()).length], [0, 5], 'a typo in subscriptions.json deletes nothing')

  // An old row with no feed recorded is given one the next time its feed lists it.
  await fresh()
  await sync(sub('f1', '/canvas.ics'))
  await api.setDeadlines((await rows()).map(({ subscriptionId, ...d }) => d))
  await sync(sub('f1', '/canvas.ics'))
  ok((await rows()).every((d) => d.subscriptionId === 'f1'), 'rows imported before feeds were remembered are claimed on the next pass')

  // --- Events feeds that promote a few events to rows ---------------------------------------------
  await fresh()
  const promo = sub('e1', '/talks.ics', { mode: 'events', promote: 'tech talk' })
  const promoted = await sync(promo)
  eq(promoted.added, 1, 'only the talk that is still to come becomes a row')
  const talk = (await rows())[0]
  eq([talk.title, talk.kind, talk.promoted, talk.subscriptionId], ['Tech Talk: Foo', 'admin', true, 'e1'], 'and it is an admin row that remembers its feed')
  ok(talk.notes.startsWith('SIGN UP -> https://x.org/r'), 'with the signup link first')
  eq((await api.readEvents()).map((e) => e.title).sort(), ['Poster Session', 'Tech Talk: Past'], 'the rest stay chips, and the promoted one is not shown twice')
  eq((await api.feedStatus())[0].events, 2, 'an events feed counts the chips it shows')
  await sync({ ...promo, promote: undefined })
  eq(await rows(), [], 'an events feed that stops promoting takes its rows away')
  await sync(promo)
  await api.setSubscriptions([])
  await api.forgetFeed('e1')
  eq(await rows(), [], 'and so does deleting it')

  // --- Status: what a failing or oversized feed says --------------------------------------------------
  await fresh()
  await sync(sub('f1', '/canvas.ics', { mode: 'events' }))
  canvasBody = '<html>gone</html>'
  await api.refreshFeeds()
  const failed = (await api.feedStatus())[0]
  ok(failed.error && failed.at, 'a failed refresh keeps when the copy on screen was fetched, beside the error')
  eq(failed.events, 6, 'and the events from the saved copy are still counted')
  canvasBody = canvas

  await fresh()
  await sync(sub('f1', '/big.ics', { mode: 'events' }))
  const large = (await api.feedStatus())[0]
  eq(large.events, 2000, 'a feed over the cap shows the cap')
  ok(/5000/.test(large.note) && /2000/.test(large.note), `and says so: ${large.note}`)
  ok(!/at least/.test(large.note), 'with an exact count, because the whole file was read')

  await fresh()
  await sync(sub('f1', '/flood.ics', { mode: 'events' }))
  ok(/^Too big to show whole: at least \d+ events/.test((await api.feedStatus())[0].note), 'a feed the reader gave up on says "at least"')

  await sync(sub('f1', '/big.ics'))
  eq((await rows()).length, 2000, 'a Work feed over the cap imports the cap, nearest today first')
  const dues = (await rows()).map((d) => Date.parse(d.due))
  ok(Math.min(...dues) < Date.now() && Math.max(...dues) > Date.now() + 100 * DAY, 'so what arrives spans both sides of today rather than the start of the file')

  // A hand-edited entry with no url must fail on its own, not take every other feed down with it.
  await fresh()
  const { url: _gone, ...noUrl } = sub('bad', '/canvas.ics')
  await api.setSubscriptions([noUrl, sub('f1', '/canvas.ics')])
  await api.refreshFeeds()
  await api.importFeedDeadlines()
  const both = Object.fromEntries((await api.feedStatus()).map((s) => [s.id, s]))
  ok(both.bad.error, 'the feed with no url says what is wrong with it')
  eq([both.f1.error, both.f1.events], [null, 5], 'and the valid feed beside it still refreshed and imported')

  // --- Errors, through both doors ---------------------------------------------------------------------
  await fresh()
  const closed = http.createServer()
  await new Promise((r) => closed.listen(0, '127.0.0.1', r))
  const deadPort = closed.address().port
  await new Promise((r) => closed.close(r))
  const errorOf = async (link) => (await api.importIcs(link, null)).error
  ok(/refused/.test(await errorOf(`http://127.0.0.1:${deadPort}/x.ics`)), 'a refused connection is called that')
  ok(/redirect/i.test(await errorOf(`${base}/loop`)), 'a redirect loop is called that')
  ok(/did not return a calendar/.test(await errorOf(`${base}/page`)), 'a web page is not a calendar')
  eq(await errorOf(`${base}/nothing.ics`), 'HTTP 404', 'a 404 is a 404')
  ok(/Only http/.test(await errorOf('ftp://example.org/c.ics')), 'another scheme is refused by name')
  ok(/does not look like a web address/.test(await errorOf('not a url')), 'text that is no address says so')
  ok(!/offline/.test(await errorOf(`http://127.0.0.1:${deadPort}/x.ics`)), 'and nothing blames the network for a server that said no')
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}

console.log(`Feed import: ${checks} checks passed (one pipeline for both imports, removal with its feed, unreadable lists, oversize feeds, errors).`)
process.exit(0)
