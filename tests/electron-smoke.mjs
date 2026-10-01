import { app, BrowserWindow, ipcMain, session } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(resolve(root, 'output'), { recursive: true })
const profile = mkdtempSync(resolve(root, 'output/smoke-'))
const data = resolve(profile, 'data')
mkdirSync(resolve(data, 'notes'), { recursive: true })
const now = new Date()
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const json = (name, value) => writeFileSync(resolve(data, name), JSON.stringify(value, null, 2))
json('courses.json', [{ id: '01-101', code: '01-101', title: 'Intro to Computing', color: '#ed825e', units: 12, links: [] }])
json('deadlines.json', [{ id: 'seed', title: 'Smoke seed deadline', due: day, courseId: '01-101', kind: 'pset', done: false, source: 'manual' }])
json('todos.json', [])
json('subscriptions.json', [])
json('recurring.json', [])
writeFileSync(resolve(data, 'notes/_schedule.md'), `01-101|${(now.getDay() + 6) % 7}|17:00|18:00|Hall 5\n`)
writeFileSync(resolve(profile, 'config.json'), JSON.stringify({ dataDir: data, termStart: `${now.getFullYear()}-01-01`, termEnd: `${now.getFullYear()}-12-31`, window: { width: 1400, height: 900 } }))
app.setPath('userData', profile)
// Main switches "start with Windows" on the first time it runs, keyed on the app id and whatever
// path launched it. From here that rewrites the real login item to point at this test
// folder, so Windows boots a bare Electron shell at the next login instead of Tartan. Measured: the
// Run key really does change without this line.
app.setLoginItemSettings = () => {}
process.argv.push('--hidden')
// Without a handler, Electron shows a main-process crash as a modal error box on whoever's screen
// this runs on. Fail the run instead, and never let a hang outlive the test.
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
setTimeout(() => { console.error('Smoke test timed out'); app.exit(1) }, 120_000).unref()
const errors = []
app.on('web-contents-created', (_, contents) => contents.on('console-message', event => {
  // Electron 43 hands over one object; the old positional (level, message) form is deprecated.
  if (event.level === 'error') errors.push(event.message)
}))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`)
async function waitFor(fn, ...args) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(fn, ...args)) return
    await sleep(100)
  }
  throw new Error(`Timed out: ${fn}`)
}
const click = async (selector) => { await evaluate(s => { const el = document.querySelector(s); if (!el) throw new Error(`Missing ${s}`); el.click() }, selector); await sleep(100) }
const fill = async (selector, value) => { await evaluate((s, value) => { const el = document.querySelector(s); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) }, selector, value); await sleep(100) }
const select = async (selector, value) => { await evaluate((s, value) => { const el = document.querySelector(s); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) }, selector, value); await sleep(100) }
const checks = []
async function run() {
try {
  await import(new URL('../out/main/index.js', import.meta.url))
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }))
  for (let i = 0; i < 80; i++) {
    win = BrowserWindow.getAllWindows()[0]
    if (win && !win.webContents.isLoading()) break
    await sleep(100)
  }
  await waitFor(() => !!document.querySelector('.today-dashboard'))
  assert.equal(await evaluate(() => !!document.querySelector('.sidebar-brand')), false)
  checks.push('Today renders without branding')
  await fill('.quickadd input', 'Smoke quick capture tomorrow 5pm')
  await evaluate(() => document.querySelector('.quickadd').requestSubmit())
  await waitFor(async () => (await window.api.deadlines.get()).some(d => d.title === 'Smoke quick capture'))
  checks.push('Natural-language capture persists through IPC')
  await click('.day-next')
  await waitFor(() => !!document.querySelector('.calendar-agenda'))
  assert.equal(await evaluate(() => document.querySelector('.calendar-agenda-header .section-title').textContent), 'Today')
  checks.push('Top summary opens today’s full calendar agenda')
  await click('.calendar-agenda-header .btn')
  await fill('#cal-title', 'Smoke calendar create')
  await evaluate(() => document.querySelector('.calendar-editor').requestSubmit())
  await waitFor(async () => (await window.api.deadlines.get()).some(d => d.title === 'Smoke calendar create'))
  assert.equal(await evaluate(() => !!document.querySelector('.calendar-editor')), false)
  await evaluate(() => [...document.querySelectorAll('.cal-daylist-row')].find(el => el.textContent.includes('Smoke calendar create')).click())
  await fill('#cal-title', 'Smoke calendar edited')
  await click('.calendar-editor input[type="checkbox"]')
  await evaluate(() => document.querySelector('.calendar-editor').requestSubmit())
  await waitFor(async () => (await window.api.deadlines.get()).some(d => d.title === 'Smoke calendar edited' && d.done))
  await win.webContents.reload()
  await waitFor(() => !!document.querySelector('.today-dashboard'))
  assert.equal(await evaluate(async () => (await window.api.deadlines.get()).find(d => d.title === 'Smoke calendar edited').done), true)
  checks.push('Calendar create, edit and completion survive reload')
  await click('.day-next')
  await waitFor(() => !!document.querySelector('.calendar-agenda'))
  assert.equal(await evaluate(() => document.querySelector('.calendar-agenda').textContent.includes('Smoke calendar edited')), false)
  await click('.calendar-toolbar input[type="checkbox"]')
  await waitFor(() => document.querySelector('.calendar-agenda').textContent.includes('Smoke calendar edited'))
  await select('[aria-label="Filter calendar by space"]', '01-101')
  assert.equal(await evaluate(() => document.querySelector('.calendar-agenda').textContent.includes('Smoke calendar edited')), false)
  checks.push('Completed visibility and space filtering work')
  await select('[aria-label="Filter calendar by space"]', 'all')
  for (const label of ['Schedule', 'LeetCode', 'All notes', 'Settings']) {
    await evaluate(label => [...document.querySelectorAll('.sidebar > .nav-item')].find(el => el.textContent.trim() === label).click(), label)
    await sleep(350)
    assert.equal(await evaluate(() => document.querySelector('.main').textContent.includes('Something went wrong')), false)
    checks.push(`${label} renders`)
  }
  await click('.sidebar .nav-group .nav-item')
  await sleep(350)
  assert.ok(await evaluate(() => document.querySelector('.main').textContent.includes('01-101')))
  checks.push('Space workspace renders')
  await click('.sidebar > .nav-item')
  await waitFor(() => !!document.querySelector('.today-dashboard'))
  for (const width of [1440, 1100, 940]) {
    win.setSize(width, 900)
    await sleep(200)
    assert.ok(await evaluate(() => document.querySelector('.today-dashboard').scrollWidth <= document.querySelector('.today-dashboard').clientWidth + 1))
  }
  checks.push('Today fits 1440, 1100 and 940px windows')
  await click('.day-next')
  await waitFor(() => !!document.querySelector('.calendar-agenda'))
  assert.ok(await evaluate(() => document.querySelector('.calendar-layout').scrollWidth <= document.querySelector('.calendar-layout').clientWidth + 1))
  await click('.calendar-agenda-header .btn')
  await fill('#cal-title', 'Smoke failed save stays editable')
  ipcMain.removeHandler('deadlines:set')
  ipcMain.handle('deadlines:set', () => { throw new Error('Simulated write failure') })
  await evaluate(() => document.querySelector('.calendar-editor').requestSubmit())
  await waitFor(() => document.querySelector('.status').textContent.includes('Could not save'))
  assert.equal(await evaluate(() => document.querySelector('#cal-title').value), 'Smoke failed save stays editable')
  assert.equal(JSON.parse(readFileSync(resolve(data, 'deadlines.json'), 'utf8')).some(d => d.title === 'Smoke failed save stays editable'), false)
  checks.push('Failed save keeps the draft and reports the error without writing')
  await click('.sidebar > .nav-item')
  await waitFor(() => !!document.querySelector('.today-dashboard'))
  await fill('.quickadd input', 'Smoke capture failure tomorrow 5pm')
  await evaluate(() => document.querySelector('.quickadd').requestSubmit())
  await waitFor(() => document.querySelector('.quickadd').getAttribute('aria-busy') === 'false')
  assert.equal(await evaluate(() => document.querySelector('.quickadd input').value), 'Smoke capture failure tomorrow 5pm')
  checks.push('Quick capture also preserves failed drafts')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: checks, rendererErrors: errors, isolatedData: data }, null, 2))
  app.exit(0)
} catch (error) {
  console.error(error)
  console.error('Renderer errors:', errors)
  app.exit(1)
}
}
void run()
