import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// store.ts bundled against a stub `electron` whose every path is a throwaway folder, so nothing
// here can reach a real data folder or the real config.
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const electron = {
  name: 'electron',
  setup: (b) => {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const app = { getPath: (n) => n === 'userData' ? globalThis.__userData : globalThis.__userData + '/docs' }`,
    }))
  },
}
const { outputFiles } = await build({
  entryPoints: [here('../src/main/store.ts')],
  bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: here('../tsconfig.node.json'), logLevel: 'silent', plugins: [electron],
})
const s = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

const roots = []
/** A fresh userData + data folder, with config.json (when given) loaded the way the app would. */
const scene = (config = {}, raw) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'tartan-store-'))
  roots.push(userData)
  const data = path.join(userData, 'data')
  globalThis.__userData = userData
  mkdirSync(data, { recursive: true })
  if (config) writeFileSync(path.join(userData, 'config.json'), raw ?? JSON.stringify({ dataDir: data, ...config }))
  s.loadConfig()
  return { userData, data, file: (n) => path.join(data, n), cfgFile: path.join(userData, 'config.json') }
}
const read = (f) => readFileSync(f, 'utf8')
const json = (f) => JSON.parse(read(f))

// --- a file with a typo is never replaced by a save ---
{
  const { file } = scene()
  writeFileSync(file('todos.json'), '[{"id": "t1", "text": "oops"')
  assert.deepEqual(await s.getTodos(), [], 'an unreadable list still reads as empty')
  await assert.rejects(
    s.setTodos([{ id: 'n', text: 'new', done: false, courseId: null, created: '' }]),
    /^Error: todos\.json could not be read, so nothing was saved: .+\. Fix or delete the file\.$/,
  )
  assert.equal(read(file('todos.json')), '[{"id": "t1", "text": "oops"', 'the typo file is untouched')
  // Empty and missing files are fine to write over.
  writeFileSync(file('todos.json'), '  \n')
  await s.setTodos([])
  assert.deepEqual(json(file('todos.json')), [])
  rmSync(file('recurring.json'), { force: true })
  await s.setRecurring([])
  assert.deepEqual(json(file('recurring.json')), [])
  // grades.json keeps its own refusal.
  writeFileSync(file('grades.json'), '{ nope')
  await assert.rejects(s.setGrades({}), /^Error: grades\.json could not be read, so nothing was saved: /)
  assert.equal(read(file('grades.json')), '{ nope')
}

// --- valid JSON that is not a list, and hand-written rows ---
{
  const { file } = scene()
  for (const body of ['{}', 'null', '"x"']) {
    writeFileSync(file('courses.json'), body)
    await assert.rejects(s.getCourses(), /^Error: courses\.json must be a JSON array$/)
    writeFileSync(file('deadlines.json'), body)
    await assert.rejects(s.getDeadlines(), /^Error: deadlines\.json must be a JSON array$/)
  }
  writeFileSync(file('courses.json'), JSON.stringify([{ id: 'x-1', title: 'T' }, { id: 'y', code: 101, title: 'U', links: [{ id: 'l' }] }, null]))
  const [a, b, ...rest] = await s.getCourses()
  assert.equal(rest.length, 0, 'a stray null row is dropped, not thrown on')
  assert.equal(a.code, 'x-1')
  assert.deepEqual(a.links, [])
  assert.equal(b.code, '101')
  assert.equal(b.links.length, 1)
  writeFileSync(file('deadlines.json'), JSON.stringify([{ id: '1', kind: 'pset' }, { id: '2', kind: 'homework' }, { id: '3' }, { id: '4', kind: 'constructor' }]))
  assert.deepEqual((await s.getDeadlines()).map((d) => d.kind), ['pset', 'other', 'other', 'other'])
}

// --- seeding: each file on its own, never over something already there ---
{
  const { data, file } = scene()
  await s.ensureDataDir()
  assert.deepEqual(json(file('courses.json')).map((c) => [c.id, c.code]), [['01-101', '01-101'], ['02-202', '02-202'], ['writ-101', 'WRIT 101']])
  assert.deepEqual(json(file('deadlines.json')), [])
  assert.match(read(path.join(data, 'README.md')), /^# Semester/)
}
{
  const { data, file } = scene()
  writeFileSync(file('deadlines.json'), '[{"id":"d1","title":"keep me"}]')
  writeFileSync(path.join(data, 'README.md'), 'mine')
  await s.ensureDataDir()
  assert.equal(json(file('deadlines.json'))[0].title, 'keep me', 'a folder without courses.json keeps its deadlines')
  assert.equal(read(path.join(data, 'README.md')), 'mine')
  assert.equal(json(file('courses.json')).length, 3)
  writeFileSync(file('courses.json'), '[]')
  await s.ensureDataDir()
  assert.deepEqual(json(file('courses.json')), [], 'an existing courses.json is never reseeded')
}

// --- choosing a folder: remembered only once it works ---
{
  const { userData, data, cfgFile } = scene()
  const blocker = path.join(userData, 'blocker')
  writeFileSync(blocker, 'a file, not a folder')
  await assert.rejects(s.setDataDir(path.join(blocker, 'sub')))
  assert.equal(s.dataDir(), data, 'the previous folder is still in use')
  assert.equal(json(cfgFile).dataDir, data, 'and is still what is on disk')
  const good = path.join(userData, 'elsewhere')
  assert.equal(await s.setDataDir(good), good)
  assert.equal(json(cfgFile).dataDir, good)
  assert.ok(existsSync(path.join(good, 'courses.json')))
  assert.equal(existsSync(`${cfgFile}.tmp`), false, 'the config is written by rename, no temp file left')
}

// --- a config that will not parse is set aside, not overwritten ---
{
  const { cfgFile } = scene(null)
  s.loadConfig()
  assert.equal(existsSync(`${cfgFile}.bad`), false, 'no config yet is not a bad config')
  writeFileSync(`${cfgFile}.bad`, 'older')
  writeFileSync(cfgFile, '{"dataDir": "D:/mine", "syncSecret": "s3")')
  s.loadConfig()
  assert.equal(read(`${cfgFile}.bad`), '{"dataDir": "D:/mine", "syncSecret": "s3")', 'the newest bad config wins')
  assert.equal(existsSync(cfgFile), false)
  s.setSyncConfig({ url: 'https://x' })
  assert.equal(json(cfgFile).syncUrl, 'https://x')
  assert.match(read(`${cfgFile}.bad`), /s3/, 'saving afterwards leaves the set-aside copy alone')
  writeFileSync(cfgFile, '')
  s.loadConfig()
  assert.equal(read(`${cfgFile}.bad`), '', 'an empty config is set aside too')
  writeFileSync(cfgFile, '﻿' + JSON.stringify({ syncUrl: 'https://notepad', termStart: '2027-01-11' }))
  s.loadConfig()
  assert.equal(s.getSyncConfig().termStart, '2027-01-11', 'a config saved by Notepad (with a byte-order mark) still reads')
}

// --- the default term follows the calendar, and a new folder pins it ---
{
  const mondayOn = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 1
  const days = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
  assert.deepEqual(s.defaultTerm(new Date(2026, 8, 30)), { termStart: '2026-08-31', termEnd: '2026-12-27' })
  assert.deepEqual(s.defaultTerm(new Date(2026, 9, 5)), { termStart: '2026-09-07', termEnd: '2027-01-03' }, 'a Monday today still lands on a Monday')
  assert.deepEqual(s.defaultTerm(new Date(2026, 10, 15)), { termStart: '2026-10-12', termEnd: '2027-02-07' }, 'across the clocks changing')
  for (let i = 0; i < 400; i += 3) {
    const now = new Date(2026, 0, 1 + i)
    const { termStart, termEnd } = s.defaultTerm(now)
    assert.ok(mondayOn(termStart), termStart)
    assert.equal(days(termStart, termEnd), 17 * 7 - 1)
    const back = days(termStart, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
    assert.ok(back >= 28 && back < 35, `${termStart} is 4 weeks back from ${now.toDateString()}`)
  }

  const a = scene()
  await s.ensureDataDir()
  const want = s.defaultTerm()
  assert.equal(json(a.cfgFile).termStart, want.termStart, 'a brand-new folder writes the term down')
  assert.equal(json(a.cfgFile).termEnd, want.termEnd)
  assert.equal(json(a.cfgFile).dataDir, a.data, 'and keeps the rest of the config')

  const b = scene({ termStart: '2026-01-05', termEnd: '2026-05-01' })
  await s.ensureDataDir()
  assert.equal(json(b.cfgFile).termStart, '2026-01-05', 'existing term dates are left alone')
  assert.equal(json(b.cfgFile).termEnd, '2026-05-01')

  const c = scene()
  writeFileSync(c.file('courses.json'), '[]')
  await s.ensureDataDir()
  assert.equal(json(c.cfgFile).termStart, undefined, 'an existing folder pins nothing')
  assert.deepEqual({ ...s.getSyncConfig(), url: '', secret: '' }, { url: '', secret: '', ...want }, 'and reads the computed default')
}

// --- renaming a course moves everything that names it ---
{
  const { data, file } = scene()
  const course = (id) => ({ id, code: id, title: id, color: '#000', units: 9, links: [] })
  writeFileSync(file('courses.json'), JSON.stringify([course('a-1'), course('b-2')]))
  writeFileSync(file('deadlines.json'), JSON.stringify([{ id: 'd', courseId: 'a-1', title: 'x', due: '2026-10-01', kind: 'pset', done: false, source: 'manual' }]))
  writeFileSync(file('todos.json'), JSON.stringify([{ id: 't', text: 'x', done: false, courseId: 'a-1', created: '' }, { id: 'u', text: 'y', done: false, courseId: 'b-2', created: '' }]))
  writeFileSync(file('recurring.json'), JSON.stringify([{ id: 'r', text: 'x', courseId: 'a-1', kind: 'quiz', days: [4] }]))
  writeFileSync(file('subscriptions.json'), JSON.stringify([{ id: 's', name: 'n', url: 'u', mode: 'deadlines', courseId: 'a-1', color: '#000', enabled: true, error: null, events: 0 }]))
  writeFileSync(file('grades.json'), JSON.stringify({ 'a-1': { id: 'a-1', name: 'g', categories: [] } }))
  mkdirSync(path.join(data, 'notes', 'a-1'), { recursive: true })
  writeFileSync(path.join(data, 'notes', 'a-1', 'n.md'), 'note')
  mkdirSync(path.join(data, '.versions', 'a-1', 'n.md'), { recursive: true })
  writeFileSync(path.join(data, '.versions', 'a-1', 'n.md', '2026-01-01T00-00-00.000Z.md'), 'old')
  const schedule = ['# a-1 is how a class is written', 'a-1|0|10:00|10:50|Room a-1', '  a-1 | 2 | 10:00 | 10:50 | Hall', 'a-10|1|09:00|09:50|Near', 'b-2|3|11:00|11:50|a-1 Annex', ''].join('\r\n')
  writeFileSync(path.join(data, 'notes', '_schedule.md'), schedule)

  await s.renameCourse('a-1', 'c-3')
  assert.deepEqual(json(file('courses.json')).map((c) => c.id), ['c-3', 'b-2'])
  assert.equal(json(file('deadlines.json'))[0].courseId, 'c-3')
  assert.deepEqual(json(file('todos.json')).map((t) => t.courseId), ['c-3', 'b-2'])
  assert.equal(json(file('recurring.json'))[0].courseId, 'c-3')
  assert.equal(json(file('subscriptions.json'))[0].courseId, 'c-3')
  assert.deepEqual(Object.keys(json(file('grades.json'))), ['c-3'])
  assert.equal(read(path.join(data, 'notes', 'c-3', 'n.md')), 'note')
  assert.equal(read(path.join(data, '.versions', 'c-3', 'n.md', '2026-01-01T00-00-00.000Z.md')), 'old')
  assert.equal(existsSync(path.join(data, '.versions', 'a-1')), false)
  assert.equal(
    read(path.join(data, 'notes', '_schedule.md')),
    schedule.replace('\r\na-1|', '\r\nc-3|').replace('  a-1 |', '  c-3 |'),
    'only lines that start with the old id change, in the same line endings',
  )

  // No notes, no history, no schedule lines and an unreadable todos.json: still renames, and leaves the typo alone.
  writeFileSync(file('todos.json'), '[{ broken')
  await s.renameCourse('b-2', 'd-4')
  assert.deepEqual(json(file('courses.json')).map((c) => c.id), ['c-3', 'd-4'])
  assert.equal(read(file('todos.json')), '[{ broken')
}

// --- a rename never half-applies: history that cannot move does not block it ---
{
  const { data, file } = scene()
  const course = (id) => ({ id, code: id, title: id, color: '#000', units: 9, links: [] })
  writeFileSync(file('courses.json'), JSON.stringify([course('a-1')]))
  mkdirSync(path.join(data, 'notes', 'a-1'), { recursive: true })
  writeFileSync(path.join(data, 'notes', 'a-1', 'n.md'), 'note')
  mkdirSync(path.join(data, '.versions', 'a-1'), { recursive: true })
  writeFileSync(path.join(data, '.versions', 'a-1', 'v.md'), 'old')
  mkdirSync(path.join(data, '.versions', 'c-3'), { recursive: true })
  writeFileSync(path.join(data, '.versions', 'c-3', 'keep.md'), 'already here')
  const warn = console.warn
  const warned = []
  console.warn = (...a) => warned.push(a)
  try {
    await s.renameCourse('a-1', 'c-3')
  } finally {
    console.warn = warn
  }
  assert.deepEqual(json(file('courses.json')).map((c) => c.id), ['c-3'], 'the course id follows the notes folder')
  assert.equal(read(path.join(data, 'notes', 'c-3', 'n.md')), 'note')
  assert.equal(read(path.join(data, '.versions', 'c-3', 'keep.md')), 'already here', 'the folder that was in the way is untouched')
  assert.equal(read(path.join(data, '.versions', 'a-1', 'v.md')), 'old', 'the old history stays where it was')
  assert.equal(warned.length, 1, 'and the problem is logged, not thrown')
}

// --- a file that parses but holds the wrong kind of thing is kept, not saved over ---
{
  const { file } = scene()
  const row = { id: 'n', text: 'new', done: false, courseId: null, created: '' }
  const wrongShape = /^Error: (todos|recurring|subscriptions|leetcode)\.json could not be read, so nothing was saved: it holds (an object where a list|a list where an object) is expected\. Fix or delete the file\.$/
  const cases = [
    ['todos.json', '{"todos":[{"id":"t1"}]}', () => s.setTodos([row])],
    ['recurring.json', '{"rules":[]}', () => s.setRecurring([])],
    ['subscriptions.json', '{"subscriptions":[]}', () => s.setSubscriptions([])],
    ['leetcode.json', '["two-sum"]', () => s.setLeetcode({ done: {} })],
  ]
  for (const [name, body, save] of cases) {
    writeFileSync(file(name), body)
    await assert.rejects(save(), wrongShape, name)
    assert.equal(read(file(name)), body, `${name} is untouched`)
  }
  assert.deepEqual(await s.getTodos(), [], 'such a file still reads as empty')
  // The right shape, and an empty file, still save.
  writeFileSync(file('todos.json'), '[]')
  await s.setTodos([row])
  assert.equal(json(file('todos.json'))[0].id, 'n')
  writeFileSync(file('leetcode.json'), '{"done":{"two-sum":"2026-08-25"}}')
  await s.setLeetcode({ done: {} })
  assert.deepEqual(json(file('leetcode.json')), { done: {} })
}

// --- a byte-order mark does not hide the first line of _schedule.md ---
{
  const { data, file } = scene()
  const course = (id) => ({ id, code: id, title: id, color: '#000', units: 9, links: [] })
  writeFileSync(file('courses.json'), JSON.stringify([course('a-1')]))
  const schedule = ['﻿a-1|0|10:00|10:50|Room', 'a-10|1|09:00|09:50|Near', ''].join('\r\n')
  mkdirSync(path.join(data, 'notes'), { recursive: true })
  writeFileSync(path.join(data, 'notes', '_schedule.md'), schedule)
  await s.renameCourse('a-1', 'c-3')
  assert.equal(read(path.join(data, 'notes', '_schedule.md')), schedule.replace('a-1|', 'c-3|'), 'the first line moves too, and the mark stays')
}

// --- a data file saved by Notepad (leading byte-order mark) reads, renames and saves like any other ---
{
  const { data, file } = scene()
  const BOM = '\uFEFF'
  const course = (id) => ({ id, code: id, title: id, color: '#000', units: 9, links: [] })
  const scheme = { id: 'a-1', name: 'g', categories: [] }
  writeFileSync(file('courses.json'), BOM + JSON.stringify([course('a-1')]))
  writeFileSync(file('grades.json'), BOM + JSON.stringify({ 'a-1': scheme }))
  writeFileSync(file('todos.json'), BOM + JSON.stringify([{ id: 't', text: 'x', done: false, courseId: 'a-1', created: '' }]))
  mkdirSync(path.join(data, 'notes', 'a-1'), { recursive: true })
  assert.deepEqual(Object.keys(await s.getGrades()), ['a-1'])
  assert.deepEqual((await s.getTodos()).map((t) => t.id), ['t'], 'a marked todos.json reads as its list, not as empty')

  await s.renameCourse('a-1', 'c-3')
  assert.deepEqual(json(file('courses.json')).map((c) => c.id), ['c-3'])
  assert.deepEqual(Object.keys(json(file('grades.json'))), ['c-3'], 'the scores moved with the course')
  assert.deepEqual(json(file('todos.json')).map((t) => t.courseId), ['c-3'])
  assert.equal(existsSync(path.join(data, 'notes', 'c-3')), true)

  writeFileSync(file('grades.json'), BOM + JSON.stringify({ 'c-3': scheme }))
  await s.setGrades({ x: scheme })
  assert.deepEqual(Object.keys(json(file('grades.json'))), ['x'], 'a marked grades.json can be saved over')
}

// --- a stray null row in a hand-edited list does not stop a rename half-way ---
{
  const { file } = scene()
  writeFileSync(file('courses.json'), JSON.stringify([{ id: 'a-1', code: 'a-1', title: 'A', color: '#000', units: 9, links: [] }]))
  writeFileSync(file('deadlines.json'), '[]')
  writeFileSync(file('todos.json'), JSON.stringify([{ id: 't', text: 'x', courseId: 'a-1' }, null]))
  await s.renameCourse('a-1', 'c-3')
  assert.deepEqual(json(file('courses.json')).map((c) => c.id), ['c-3'])
  assert.deepEqual(json(file('todos.json')), [{ id: 't', text: 'x', courseId: 'c-3' }, null])
}

// --- saves to one file queue up instead of renaming one temp file out from under another ---
{
  const { file } = scene()
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.setTodos([{ id: String(i), text: `t${i}`, done: false, courseId: null, created: '' }])))
  assert.deepEqual(json(file('todos.json')).map((t) => t.id), ['24'], 'every concurrent save lands, and the last one wins')
  assert.equal(existsSync(`${file('todos.json')}.tmp`), false)
}

for (const r of roots) rmSync(r, { recursive: true, force: true })
console.log('Store: typo files kept on save, non-list files refused, seeding, data folder choice, bad config set aside, default term, course rename checks (including history that cannot move and a schedule with a byte-order mark), wrong-shaped files kept on save, byte-order-marked data files read and save passed.')
