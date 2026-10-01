import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/**
 * sync.ts against a local stand-in for the Apps Script web app, minus Electron: `electron` is a
 * stub whose paths are a throwaway folder and whose windows are plain objects, so nothing here can
 * reach the real config, data folder or a real window.
 */
const root = mkdtempSync(path.join(tmpdir(), 'tartan-sync-'))
const repo = fileURLToPath(new URL('..', import.meta.url))
const userData = path.join(root, 'userData')
mkdirSync(userData, { recursive: true })
writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ dataDir: path.join(root, 'data') }))
const stub = path.join(root, 'electron-stub.mjs')
writeFileSync(
  stub,
  `export const app = { getPath: () => ${JSON.stringify(userData)} }
   export const BrowserWindow = { getAllWindows: () => globalThis.__windows }`,
)
const bundled = await build({
  stdin: {
    contents: `
      export { mainWindow, pollInbox, syncNow, syncStatus } from './src/main/sync.ts'
      export { loadConfig, setSyncConfig, getSyncOutcome } from './src/main/store.ts'`,
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
api.loadConfig()

let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const ok = (value, message) => {
  assert.ok(value, message)
  checks++
}

// Windows as the code sees them: a URL, a destroyed flag, and a send() that records.
const win = (url) => {
  const w = { sent: [], isDestroyed: () => false, webContents: { getURL: () => url, send: (...a) => w.sent.push(a) } }
  return w
}

// --- which window is the real one ---------------------------------------------------------------------

const capture = win('file:///app/index.html#capture')
const main = win('file:///app/index.html')
globalThis.__windows = [capture, main]
ok(api.mainWindow() === main, 'quick capture is never taken for the main window, even when it is listed first')
globalThis.__windows = [capture]
ok(api.mainWindow() === undefined, 'with only quick capture open there is no main window')

// --- a stand-in Apps Script: old deployments answer GET with "Writing to:" ----------------------------

const requests = []
const mk = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        requests.push({ port: s.address().port, method: req.method, path: req.url, body })
        handler(req, res, body)
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
const json = (res, v) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
const script = (aliveText) =>
  mk((req, res, body) => {
    if (req.method === 'GET') return res.writeHead(200).end(aliveText)
    const b = JSON.parse(body)
    if (b.poll) return json(res, { ok: true, queue: [{ id: 'a1', kind: 'deadline.done', target: 'x' }] })
    json(res, { ok: true, created: 1 })
  })
const oldScript = await script('Tartan sync is alive. 2026-01-01. Writing to: me@example.com')
const newScript = await script('Tartan sync is alive. 2026-01-01.')
const page = await mk((_req, res) => res.writeHead(200).end('<html>sign in</html>'))
const at = (s, p = '/exec') => `http://127.0.0.1:${s.address().port}${p}`
const cfg = (url) => api.setSyncConfig({ url, secret: 's3cret' })
const posts = (s) => requests.filter((r) => r.port === s.address().port && r.method === 'POST').length

try {
  // --- an address that is not a web address is named, not shown as Node's "Invalid URL". This is also the
  // first sync of the process, before anything has read the status: its error must survive the lazy load.

  const BAD = 'That is not a web address. Paste the /exec URL from Apps Script → Deploy.'
  for (const bad of ['hello world', 'ftp://example.com/exec', 'script.google.com/macros/s/x/exec']) {
    cfg(bad)
    eq((await api.syncNow(true)).error, BAD, `${bad} is refused by name`)
  }

  // --- the inbox probe is per URL: fixing a wrong address revives the inbox -----------------------------

  globalThis.__windows = [capture, main]
  cfg(at(oldScript))
  await api.pollInbox(true)
  eq(posts(oldScript), 0, 'a deployment that predates the inbox is never sent a poll')
  cfg(at(newScript))
  await api.pollInbox(true)
  eq(posts(newScript), 1, 'pointing at a good script polls it straight away, without a relaunch')
  eq(main.sent.length, 1, 'the phone actions reach the main window')
  eq(main.sent[0][0], 'inbox', 'on the inbox channel')
  eq(capture.sent.length, 0, 'and never the quick-capture window that happens to be listed first')

  // --- a path that does not end in /exec is a soft warning ----------------------------------------------

  cfg(at(newScript, '/exec'))
  let st = await api.syncNow(true)
  eq(st.error, null, 'a normal /exec address syncs cleanly')
  ok(!/\/exec/.test(st.last), 'with no warning beside it')
  ok(/1 added/.test(st.last), 'and the script summary on the card')

  cfg(at(newScript, '/dev'))
  st = await api.syncNow(true)
  eq(st.error, null, 'an odd path still syncs when the script answers')
  ok(/does not end in \/exec/.test(st.last), 'but the card says the address looks wrong')

  cfg(at(page, '/dev'))
  st = await api.syncNow(true)
  ok(/web page instead of JSON/.test(st.error) && /does not end in \/exec/.test(st.error), 'a failure on an odd path names both problems')

  // --- clearing the address clears the card -------------------------------------------------------------

  cfg(at(newScript))
  await api.syncNow(true)
  ok(api.syncStatus().last, 'a synced semester has a summary line')
  api.setSyncConfig({ url: '' })
  st = api.syncStatus()
  eq([st.error, st.last], [null, null], 'with no address the card shows no old error or success line')
  cfg(at(page, '/dev'))
  await api.syncNow(true)
  ok(api.syncStatus().error, 'a failing address has an error')
  api.setSyncConfig({ url: '' })
  eq(api.syncStatus().error, null, 'which goes with the address')
  await api.syncNow()
  cfg(at(newScript))
  st = api.syncStatus()
  eq([st.error, st.last], [null, null], 'and does not come back when an address is typed again')
  eq(api.getSyncOutcome(), { error: null, summary: null }, 'the saved outcome is cleared too, so a restart agrees')
} finally {
  for (const s of [oldScript, newScript, page]) {
    s.closeAllConnections()
    s.close()
  }
  rmSync(root, { recursive: true, force: true })
}

console.log(`Sync: ${checks} checks passed (main-window pick, inbox probe per URL, bad-address message, /exec warning, cleared card).`)
process.exitCode = 0
