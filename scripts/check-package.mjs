// Launches a packaged Tartan in a throwaway profile and data folder, checks that Today renders and
// the main-process bridge answers, then stops it. Used by the release workflow on every installer.
//   node scripts/check-package.mjs <path to the Tartan executable> [extra Electron flags...]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [exe, ...extra] = process.argv.slice(2)
if (!exe || !existsSync(exe)) {
  console.error(`No executable at ${exe}`)
  process.exit(2)
}
const port = 9333
const root = mkdtempSync(join(tmpdir(), 'tartan-package-'))
const profile = join(root, 'profile')
const data = join(root, 'data')
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ dataDir: data, window: { width: 1200, height: 800 } }))

const child = spawn(exe, ['--hidden', `--remote-debugging-port=${port}`, ...extra], {
  env: { ...process.env, TARTAN_USER_DATA: profile },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32', // its own process group, so the whole tree can be stopped
})
let output = ''
child.stdout.on('data', (d) => (output += d))
child.stderr.on('data', (d) => (output += d))
let exited = null
child.on('exit', (code) => (exited = code))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function stop() {
  if (exited !== null) return
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

const result = {}
let failure = ''
try {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    if (exited !== null) throw new Error(`Tartan exited early with code ${exited}`)
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && !t.url.includes('#capture'))
    } catch {
      // not listening yet
    }
  }
  if (!target) throw new Error('No window appeared on the debug port within 60 seconds')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('Could not connect to the window'))
  })
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    waiting.get(msg.id)?.resolve(msg)
    waiting.delete(msg.id)
  }
  // If the window or the app dies mid-check, fail now rather than hang until the job times out.
  ws.onclose = () => {
    for (const w of waiting.values()) w.reject(new Error('The window closed during the check'))
    waiting.clear()
  }
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const timer = setTimeout(() => {
        waiting.delete(n)
        reject(new Error(`No answer from the window within 10 seconds: ${expression}`))
      }, 10_000)
      waiting.set(n, {
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg.result?.result?.value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })

  for (let i = 0; i < 80 && !(await evaluate(`!!document.querySelector('.today-dashboard')`)); i++) {
    if (exited !== null) throw new Error(`Tartan exited with code ${exited} before Today rendered`)
    await sleep(250)
  }
  result.today = await evaluate(`!!document.querySelector('.today-dashboard')`)
  result.crashed = await evaluate(`document.body.innerText.includes('Something went wrong')`)
  result.spaces = await evaluate(`window.api.courses.get().then((c) => c.map((x) => x.code))`)
  result.dataDir = await evaluate(`window.api.app.dataDir()`)
  ws.close()
  result.seeded = existsSync(data) ? readdirSync(data).sort() : []

  if (!result.today) failure = 'Today never rendered'
  else if (result.crashed) failure = 'The window shows the error screen'
  else if (!Array.isArray(result.spaces) || !result.spaces.length) failure = 'The bridge to the main process did not answer'
  else if (result.dataDir !== data) failure = `It used ${result.dataDir}, not the throwaway data folder`
  else if (!result.seeded.includes('courses.json')) failure = 'The data folder was not created'
} catch (err) {
  failure = String(err?.message ?? err)
} finally {
  stop()
  await sleep(1000)
}

console.log(JSON.stringify({ exe, ...result }, null, 2))
if (failure) {
  console.error(`FAILED: ${failure}\n--- Tartan output ---\n${output.slice(-4000)}`)
  process.exit(1)
}
console.log('Package check passed.')
process.exit(0)
