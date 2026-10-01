import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/**
 * Rules → rows, end to end minus Electron: recurring.ts and store.ts bundled with `electron`
 * stubbed to a throwaway folder, same harness shape as feeds-import.mjs. Nothing here can reach a
 * real data folder.
 */
const root = mkdtempSync(path.join(tmpdir(), 'tartan-recurring-'))
const repo = fileURLToPath(new URL('..', import.meta.url))
const stub = path.join(root, 'electron-stub.mjs')
writeFileSync(stub, `export const app = { getPath: () => ${JSON.stringify(path.join(root, 'userData'))} }`)
mkdirSync(path.join(root, 'userData'), { recursive: true })
const bundled = await build({
  stdin: {
    contents: `
      export { materializeRecurring, addRule, removeRule } from './src/main/recurring.ts'
      export { setDataDir, setRecurring, getRecurring, getDeadlines, setDeadlines, getTodos, setTodos } from './src/main/store.ts'`,
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

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const inDays = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}
const everyDay = [0, 1, 2, 3, 4, 5, 6]
let n = 0
const fresh = () => api.setDataDir(path.join(root, `data-${++n}`))

try {
  // --- A moved occurrence is still the rule's ----------------------------------------------------
  // T, D, → Today and a Calendar drag change `due` and leave the id. Pruning by the current due
  // used to delete the moved row on the next pass, so the move silently undid itself.
  await fresh()
  await api.setRecurring([
    { id: 'gym', text: 'Gym', courseId: null, kind: 'other', days: everyDay },
    { id: 'quiz', text: 'Quiz', courseId: null, kind: 'quiz', days: everyDay },
  ])
  await api.materializeRecurring()
  const target = ymd(inDays(3))
  const moved = ymd(inDays(5))
  await api.setTodos((await api.getTodos()).map((t) => (t.id === `rec-gym-${target}` ? { ...t, due: moved } : t)))
  await api.setDeadlines((await api.getDeadlines()).map((d) => (d.uid === `rec-quiz-${target}` ? { ...d, due: moved } : d)))
  const todosBefore = (await api.getTodos()).length
  const deadlinesBefore = (await api.getDeadlines()).length
  eq((await api.materializeRecurring()).changed, 0, 'nothing to change after a move')
  const todos = await api.getTodos()
  const deadlines = await api.getDeadlines()
  eq(todos.filter((t) => t.id === `rec-gym-${target}`).map((t) => t.due), [moved], 'the moved todo stays, on the day it was moved to')
  eq(deadlines.filter((d) => d.uid === `rec-quiz-${target}`).map((d) => d.due), [moved], 'the moved deadline stays, on the day it was moved to')
  eq([todos.length, deadlines.length], [todosBefore, deadlinesBefore], 'and neither is duplicated')

  // The real casualty: an overdue occurrence (made for yesterday, so outside the wanted window) moved
  // to today. Its new due looked like a future row nobody wants, and it was deleted.
  const yesterday = ymd(inDays(-1))
  await api.setTodos([...(await api.getTodos()), { id: `rec-gym-${yesterday}`, text: 'Gym', courseId: null, done: false, due: ymd(new Date()), created: '' }])
  await api.setDeadlines([...(await api.getDeadlines()), { id: `rec-quiz-${yesterday}`, courseId: null, title: 'Quiz', due: ymd(new Date()), kind: 'quiz', done: false, source: 'recurring', uid: `rec-quiz-${yesterday}` }])
  await api.materializeRecurring()
  eq((await api.getTodos()).filter((t) => t.id === `rec-gym-${yesterday}`).length, 1, 'a moved overdue todo is not pruned')
  eq((await api.getDeadlines()).filter((d) => d.uid === `rec-quiz-${yesterday}`).length, 1, 'a moved overdue deadline is not pruned')

  // Reconciliation still works: a dropped weekday takes its occurrence with it, moved or not.
  const weekday = (inDays(3).getDay() + 6) % 7
  await api.setRecurring([{ id: 'gym', text: 'Gym', courseId: null, kind: 'other', days: everyDay.filter((d) => d !== weekday) }])
  await api.materializeRecurring()
  eq((await api.getTodos()).some((t) => t.id === `rec-gym-${target}`), false, 'a weekday the rule dropped is pruned even after the row was moved')
  eq((await api.getDeadlines()).some((d) => d.uid?.startsWith('rec-quiz-') && !d.uid.endsWith(yesterday)), false, 'a rule that no longer exists takes its future deadlines with it')

  // --- A new timed occurrence whose time has passed is not created --------------------------------
  await fresh()
  await api.setRecurring([{ id: 'early', text: 'Standup', courseId: null, kind: 'other', days: everyDay, time: '00:00' }])
  await api.materializeRecurring()
  let due = (await api.getDeadlines()).map((d) => d.uid)
  eq(due.includes(`rec-early-${ymd(new Date())}`), false, 'today 12:00 am has passed, so no row arrives already overdue')
  eq(due.includes(`rec-early-${ymd(inDays(1))}`), true, 'tomorrow still materializes')
  // A row that already exists is never pruned for having passed.
  await api.setDeadlines([
    { id: 'rec-early-' + ymd(new Date()), courseId: null, title: 'Standup', due: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(), kind: 'other', done: false, source: 'recurring', uid: 'rec-early-' + ymd(new Date()) },
  ])
  await api.materializeRecurring()
  due = (await api.getDeadlines()).map((d) => d.uid)
  eq(due.includes(`rec-early-${ymd(new Date())}`), true, 'an existing occurrence that has since passed is kept')
  if (new Date().getHours() < 23) {
    await fresh()
    await api.setRecurring([{ id: 'late', text: 'Wrap up', courseId: null, kind: 'other', days: everyDay, time: '23:59' }])
    await api.materializeRecurring()
    eq((await api.getDeadlines()).some((d) => d.uid === `rec-late-${ymd(new Date())}`), true, 'a time later today is still created')
  }

  // --- Hand-written rows and rules never crash it ---------------------------------------------------
  await fresh()
  await api.setRecurring([
    { id: 'ok', text: 'Fine', courseId: null, kind: 'other', days: everyDay },
    { id: 'big', text: 'Out of range', courseId: null, kind: 'other', days: [7] },
    { id: 'frac', text: 'Fractional', courseId: null, kind: 'other', days: [1.5] },
    { id: 'str', text: 'Strings', courseId: null, kind: 'other', days: ['1'] },
    { id: 'bare', text: 'Not a list', courseId: null, kind: 'other', days: 3 },
    { id: 'mixed', text: 'One stray day', courseId: null, kind: 'other', days: [0, 1, 2, 3, 4, 5, 6, 7] },
    { id: 'time', text: 'Numeric time', courseId: null, kind: 'pset', days: everyDay, time: 900 },
  ])
  await api.setDeadlines([null, { id: 'x', title: 'Numeric uid', due: ymd(new Date()), kind: 'other', done: false, uid: 42 }, { title: 'No ids', due: ymd(new Date()), kind: 'other', done: false }])
  await api.setTodos([null, { text: 'No id', done: false, courseId: null, created: '' }, { id: 7, text: 'Numeric id', done: false, courseId: null, created: '' }])
  await api.materializeRecurring()
  const after = await api.getTodos()
  eq(after.some((t) => String(t?.id).startsWith('rec-ok-')), true, 'the valid rule still materializes beside the broken ones')
  eq(after.some((t) => /^rec-(big|frac|str|bare)-/.test(String(t?.id))), false, 'a rule whose days are not integers 0-6 is ignored')
  eq(after.some((t) => String(t?.id).startsWith('rec-mixed-')), true, 'one stray day does not drop the rest of the rule')
  eq((await api.getDeadlines()).filter((d) => d?.title === 'Numeric uid' || d?.title === 'No ids').length, 2, 'rows with no string uid are left alone')

  // A hand-written rec- id that does not end in a date is not an occurrence: 'rec-legacy' >= '2026-…'
  // as strings, so it used to be pruned as "a future row nobody wants".
  await fresh()
  await api.setRecurring([{ id: 'ok', text: 'Fine', courseId: null, kind: 'other', days: everyDay }])
  const legacy = ['rec-legacy', 'rec-legacy-gym']
  await api.setDeadlines(legacy.map((id) => ({ id, courseId: null, title: id, due: ymd(inDays(2)), kind: 'other', done: false, source: 'recurring', uid: id })))
  await api.setTodos(legacy.map((id) => ({ id, text: id, courseId: null, done: false, due: ymd(inDays(2)), created: '' })))
  await api.materializeRecurring()
  eq((await api.getDeadlines()).filter((d) => legacy.includes(d.uid)).length, 2, 'an unticked deadline whose uid is not made for a date is not pruned')
  eq((await api.getTodos()).filter((t) => legacy.includes(t.id)).length, 2, 'an unticked todo whose id is not made for a date is not pruned')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`Recurring rules: ${checks} checks passed (moved occurrences survive, passed times are not created, malformed rows and rules are skipped).`)
process.exit(0)
