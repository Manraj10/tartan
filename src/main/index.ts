import { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, net, protocol, screen, shell } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  resolveAttachmentPath,
  writeAttachmentBytes,
  dataDir,
  deleteNote,
  ensureDataDir,
  exportIcs,
  loadConfig,
  setDataDir,
  getCourses,
  getDeadlines,
  getSubscriptions,
  setSubscriptions,
  getTodos,
  getLeetcode,
  getGrades,
  setGrades,
  getRecurring,
  setLeetcode,
  setTodos,
  getSyncConfig,
  setSyncConfig,
  getWindowState,
  importIcs,
  listNotes,
  listVersions,
  noteIndex,
  backlinks,
  readVersion,
  readNote,
  saveWindowState,
  searchNotes,
  tidyMarkdown,
  renameCourse,
  renameNote,
  setCourses,
  setDeadlines,
  writeNote,
} from './store'
import { navDecision } from './nav'
import {
  flushSync,
  forgetOutcome,
  inboxApplied,
  pollInbox,
  resyncEverything,
  scheduleSync,
  syncNow,
  syncPending,
  syncStatusFresh,
} from './sync'
import {
  dismissUids,
  feedStatus,
  forgetFeed,
  importFeedDeadlines,
  readEvents,
  refreshFeeds,
  refreshStaleFeeds,
} from './feeds'
import { addRule, materializeRecurring, removeRule } from './recurring'
import { lookupCourses } from './catalog'
import { localDay } from '../shared/day-plan'
import type { LeetcodeState } from '../shared/leetcode'
import type { GradesState } from '../shared/grades'
import {
  SCHEDULE_FILE,
  type Course,
  type Deadline,
  type RecurringRule,
  type Subscription,
  type SyncConfigPatch,
  type Todo,
} from '../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// A separate profile (config, login marker, browser sessions) for test runs and side-by-side builds.
// Set before anything reads userData, and before the single-instance lock, which lives there too.
if (process.env.TARTAN_USER_DATA) app.setPath('userData', path.resolve(process.env.TARTAN_USER_DATA))

// Electron only loads an .ico on Windows; macOS and Linux need the .png.
const iconFile = path.join(__dirname, '../../build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

/** Set only by the tray's Quit (and before-quit's flush) — every other close just hides. */
let reallyQuit = false
/**
 * Whether this launch came from the login item. Windows passes --hidden; a macOS login item
 * cannot carry arguments, so there the system says whether it opened us at login.
 */
let launchHidden = false
let tray: Tray | null = null

function createWindow(): void {
  const saved = getWindowState()
  // A saved position on a monitor that is no longer attached would put the window
  // somewhere unreachable, so only honour it if it still intersects a display.
  const onScreen =
    saved?.x !== undefined &&
    saved.y !== undefined &&
    screen.getAllDisplays().some((d) => {
      const b = d.workArea
      return saved.x! < b.x + b.width && saved.x! + saved.width > b.x && saved.y! < b.y + b.height && saved.y! + saved.height > b.y
    })

  const win = new BrowserWindow({
    ...(onScreen ? { x: saved!.x, y: saved!.y } : {}),
    width: saved?.width ?? 1400,
    height: saved?.height ?? 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    title: 'Tartan',
    icon: iconFile,
    webPreferences: {
      // electron-vite emits ESM (.mjs) because package.json is type:module,
      // and Electron only loads an ESM preload with the sandbox off.
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Required so course sites that refuse to be iframed (Canvas sends
      // X-Frame-Options) can still be embedded in a tab.
      webviewTag: true,
    },
  })

  // A login start stays alive for the sync loop with no window in the face. Only the first window
  // of a login start is hidden; one opened later (from the tray, say) is meant to be seen.
  win.on('ready-to-show', () => {
    const hidden = launchHidden
    launchHidden = false
    // maximize() also SHOWS a hidden window, so a --hidden start waits for the first real show.
    if (saved?.maximized) {
      if (hidden) win.once('show', () => win.maximize())
      else win.maximize()
    }
    if (!hidden) win.show()
  })

  /**
   * Closing the window parks the app in the tray instead of killing it. The phone queue and the
   * Google calendar are only ever serviced by THIS process's 15-minute loop — quit on close meant
   * "phone didn't sync" every time the window was closed, which is most of every day.
   */
  win.on('close', (e) => {
    if (reallyQuit) return
    // Many Linux desktops (stock GNOME among them) show no tray icons, so a hidden window there
    // would leave an invisible process with no way to quit it. Closing quits instead.
    if (process.platform === 'linux') {
      reallyQuit = true
      app.quit()
      return
    }
    e.preventDefault()
    win.hide()
  })

  /**
   * Canvas is now where the deadlines come from, and the feed pipeline used to run exactly once at
   * launch — so an app left open for a week, which is how a desktop app is actually used, silently
   * stopped seeing new assignments. Coming back to the window is the moment you want it current.
   * `refreshStaleFeeds` self-throttles on a 6-hour mark, so this costs one small JSON read on a
   * normal alt-tab and only reaches the network when something is genuinely stale.
   */
  win.on('focus', () => {
    void refreshStaleFeeds()
      .then((fetched) => (fetched ? importFeedDeadlines() : null))
      .then(async (merged) => {
        // A day boundary may have passed since the last look, so the recurring window moves even
        // when no feed did. With no rules this is one ENOENT.
        const materialized = await materializeRecurring()
        if ((merged && (merged.added || merged.updated)) || materialized.changed) {
          scheduleSync()
          notifyDataChanged()
        }
      })
      .catch(() => undefined)
    // Anything ticked on the phone since last time. Throttled to a minute inside pollInbox;
    // focus is the low-latency path, the 15-minute interval is the only other caller.
    void pollInbox()
  })

  win.on('close', () => {
    const b = win.getNormalBounds()
    saveWindowState({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() })
  })

  // Anything that tries to open a new window goes to the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  /**
   * The window may only ever show the app's own page. A link, a form or a <meta refresh> in a note
   * used to navigate it straight to a website, and the preload bridge (window.api: notes,
   * deadlines, sync config) stays attached to whatever the window lands on. Real web links go to
   * the browser instead. Course tabs are <webview>s — separate webContents — so none of this
   * touches them. Hash-only changes never reach here; a same-page reload is let through.
   */
  const stayHome = (e: { preventDefault: () => void; url: string }): void => {
    const verdict = navDecision(e.url, win.webContents.getURL())
    if (verdict === 'allow') return
    e.preventDefault()
    if (verdict === 'external') void shell.openExternal(e.url)
  }
  win.webContents.on('will-navigate', stayHome)
  win.webContents.on('will-redirect', stayHome)

  // Embedded course sites get no preload and no node access.
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    if (!/^https?:\/\//.test(params.src ?? '')) params.src = 'about:blank'
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Quick capture: a one-line window on a global hotkey. The point is that a thought reaches the
 * app without you leaving what you were doing — if capture costs a context switch, it does not happen.
 */
let captureWin: BrowserWindow | null = null

/** Not getAllWindows()[0]: once quick capture has been opened it is a window too. */
const mainWin = (): BrowserWindow | undefined => BrowserWindow.getAllWindows().find((w) => w !== captureWin)

/**
 * Main wrote a data file the window renders from — a feed import, a recurring materialization.
 * Without this the window learns on its NEXT focus, and until then any whole-array save it makes
 * is built from a list that predates the write.
 */
function notifyDataChanged(): void {
  mainWin()?.webContents.send('data-changed')
}

/** Set once startup has created the first window. */
let started = false

/** Brings the real window out of wherever it is: parked in the tray, minimised, behind others. */
function showMain(): BrowserWindow | undefined {
  const win = mainWin()
  if (!win) {
    // Before startup has made the first window (a second launch while the data-folder error box is
    // up), making one here would leave two.
    if (started) createWindow()
    return undefined
  }
  win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
  return win
}

function toggleCapture(): void {
  if (captureWin && !captureWin.isDestroyed()) {
    if (captureWin.isVisible()) {
      captureWin.hide()
    } else {
      captureWin.show()
      captureWin.focus()
    }
    return
  }

  captureWin = new BrowserWindow({
    width: 560,
    height: 92,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1b1e24',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void captureWin.loadURL(`${devUrl}#capture`)
  } else {
    void captureWin.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'capture' })
  }

  captureWin.once('ready-to-show', () => captureWin?.show())
  // Dismiss on focus loss, so it never sits forgotten on top of everything.
  captureWin.on('blur', () => captureWin?.hide())
}

function registerIpc(): void {
  ipcMain.handle('capture:save', async (_e, text: string) => {
    const line = text.trim()
    if (!line) return
    // Local time, like the clock the capture was made by: toISOString() is UTC, which dates an
    // evening capture tomorrow and puts every stamp hours off.
    const now = new Date()
    const stamp = `${localDay(now)} ${now.toTimeString().slice(0, 5)}`
    const prev = await readNote('inbox.md')
    await writeNote('inbox.md', `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}- ${stamp} ${line}\n`)
  })
  ipcMain.handle('capture:close', () => captureWin?.hide())

  /** Wraps a write that Google is holding a copy of, so the calendar re-syncs after it lands. */
  const changed = async <T,>(work: Promise<T>): Promise<T> => {
    const result = await work
    scheduleSync()
    return result
  }

  ipcMain.handle('courses:get', () => getCourses())
  ipcMain.handle('courses:set', (_e, courses: Course[]) => changed(setCourses(courses)))
  ipcMain.handle('courses:rename', (_e, oldId: string, newId: string) => changed(renameCourse(oldId, newId)))
  ipcMain.handle('deadlines:get', () => getDeadlines())
  /**
   * `removed` is the uids the user DELIBERATELY deleted in this write — named by the renderer,
   * never inferred by diffing against disk. Inference read "a row this renderer had not heard
   * about yet" (materialized or imported by main moments ago) as a deletion and tombstoned it
   * forever; an explicit list cannot.
   */
  ipcMain.handle('deadlines:set', async (_e, deadlines: Deadline[], removed: string[] = []) => {
    await dismissUids(removed.filter((u) => typeof u === 'string' && u))
    return changed(setDeadlines(deadlines))
  })
  ipcMain.handle('todos:get', () => getTodos())
  ipcMain.handle('leetcode:get', () => getLeetcode())
  ipcMain.handle('leetcode:set', (_e, s: LeetcodeState) => setLeetcode(s))
  // Not wrapped in changed(): grades reach no calendar and nothing to sync depends on them.
  ipcMain.handle('grades:get', () => getGrades())
  ipcMain.handle('grades:set', (_e, g: GradesState) => setGrades(g))
  ipcMain.handle('todos:set', async (_e, t: Todo[], removed: string[] = []) => {
    // Same contract as deadlines:set. Only rec- ids matter: nothing else re-materializes.
    await dismissUids(removed.filter((id) => typeof id === 'string' && id.startsWith('rec-')))
    return changed(setTodos(t))
  })

  /** Recurring rules. Adding one materializes immediately, so the rows exist before the reply. */
  ipcMain.handle('recurring:list', () => getRecurring())
  ipcMain.handle('recurring:add', (_e, rule: RecurringRule) => changed(addRule(rule)))
  ipcMain.handle('recurring:remove', (_e, id: string) => changed(removeRule(id)))
  ipcMain.handle('notes:list', () => listNotes())
  ipcMain.handle('notes:index', () => noteIndex())
  ipcMain.handle('notes:backlinks', (_e, title: string) => backlinks(title))
  ipcMain.handle('notes:versions', (_e, rel: string) => listVersions(rel))
  ipcMain.handle('notes:version', (_e, rel: string, stamp: string) => readVersion(rel, stamp))
  ipcMain.handle('notes:search', (_e, q: string) => searchNotes(q))
  ipcMain.handle('notes:read', (_e, rel: string) => readNote(rel))
  ipcMain.handle('notes:tidy', (_e, text: string) => tidyMarkdown(text))
  ipcMain.handle('notes:write', async (_e, rel: string, content: string, force?: boolean) => {
    await writeNote(rel, content, force === true)
    // Notes autosave every 600ms while you type; only the schedule is on the calendar.
    if (rel === SCHEDULE_FILE) scheduleSync()
  })
  ipcMain.handle('notes:rename', (_e, rel: string, title: string) => renameNote(rel, title))
  ipcMain.handle('notes:delete', (_e, rel: string) => deleteNote(rel))
  ipcMain.handle('ics:import', (_e, url: string, courseId: string | null) => changed(importIcs(url, courseId)))
  ipcMain.handle('ics:export', () => exportIcs())

  /**
   * Subscribed calendars. Fetch, cache and display only — Tartan never writes to a feed.
   * Saving the list refreshes it, because the reason you edited it was to see the result.
   */
  // A lookup writes nothing, so it is deliberately not wrapped in changed().
  ipcMain.handle('catalog:lookup', (_e, codes: string[]) => lookupCourses(codes))

  ipcMain.handle('feeds:list', () => getSubscriptions())
  ipcMain.handle('feeds:save', async (_e, subs: Subscription[]) => {
    const before = await getSubscriptions()
    await setSubscriptions(subs)
    // Drop the cache of anything removed, so a stale .ics cannot resurrect its events.
    const kept = new Set(subs.map((s) => s.id))
    await Promise.all(before.filter((s) => !kept.has(s.id)).map((s) => forgetFeed(s.id)))
    await refreshFeeds()
    await importFeedDeadlines()
    scheduleSync()
    return feedStatus()
  })
  ipcMain.handle('feeds:refresh', async (_e, id?: string) => {
    const status = await refreshFeeds(id)
    const merged = await importFeedDeadlines()
    if (merged.added || merged.updated) scheduleSync()
    return status
  })
  ipcMain.handle('feeds:status', () => feedStatus())
  ipcMain.handle('feeds:events', () => readEvents())

  ipcMain.handle('sync:status', () => syncStatusFresh())
  ipcMain.handle('sync:config', (_e, patch: SyncConfigPatch) => {
    const before = getSyncConfig().url
    setSyncConfig(patch)
    if (getSyncConfig().url !== before) forgetOutcome()
    offerLoginItem()
    return syncStatusFresh()
  })
  ipcMain.handle('sync:now', () => syncNow(false))
  /** Re-sends everything, for when the calendar has been edited behind Tartan's back. */
  ipcMain.handle('sync:all', () => resyncEverything())
  /**
   * The window reporting which phone actions it actually wrote to disk. Recorded here, before the
   * next poll can ask, so an ack lost at quit costs nothing: the ledger re-acks it next time.
   */
  ipcMain.handle('inbox:applied', (_e, ids: string[]) => inboxApplied(ids))
  ipcMain.handle('files:writeBytes', (_e, courseId: string, name: string, bytes: Uint8Array) =>
    writeAttachmentBytes(courseId, name, bytes),
  )
  ipcMain.handle('app:dataDir', () => dataDir())
  ipcMain.handle('app:openDataDir', () => shell.openPath(dataDir()))
  ipcMain.handle('app:chooseDataDir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: dataDir() })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: dataDir() })
    if (res.canceled || !res.filePaths[0]) return dataDir()
    const dir = await setDataDir(res.filePaths[0])
    // The window still holds the old folder's rows, and its next save would write them into this one.
    notifyDataChanged()
    return dir
  })
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })
}

/**
 * Images live in the data folder, but the renderer runs on http://localhost in dev and the CSP
 * forbids file://, so a local image cannot be shown directly. A custom scheme fixes both, and
 * unlike a baked-in absolute path it keeps working after the data folder moves.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'tartan', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

function registerAttachmentProtocol(): void {
  protocol.handle('tartan', (req) => {
    try {
      const u = new URL(req.url)
      // tartan://<courseId>/<file> — the host carries the folder.
      const rel = decodeURIComponent(u.host + u.pathname)
      return net.fetch(pathToFileURL(resolveAttachmentPath(rel)).href)
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// Windows groups taskbar entries and routes notifications by this id; without it an
// unpackaged Electron app shows up as "electron.exe".
if (process.platform === 'win32') app.setAppUserModelId('com.manraj.tartan')

// The data folder can live on Drive; two instances writing the same JSON would race.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // The shortcut was double-clicked while we sat in the tray: that means "open the window".
  app.on('second-instance', showMain)
}

/**
 * The tray is what makes sync AUTOMATIC. Phone adds sit in the Google-side queue until this
 * process polls; with quit-on-close, "most of the day" meant "never". Parked in the tray, the
 * 15-minute loop in whenReady services the queue and the calendar all day, and Start at login
 * covers reboots. Quit lives in the tray menu — the only path that really exits.
 */
// Unpackaged, the exe is electron.exe and the app is an argument — the login item must carry
// both or Windows boots a bare Electron shell. Installed, the exe IS Tartan. --hidden keeps the
// login launch out of the face.
const loginArgs = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
/** Its existence is the record that start-at-login has been decided, by us or by the tray checkbox. */
const loginMarker = (): string => path.join(app.getPath('userData'), 'login-item.json')
function markLoginAsked(): boolean {
  try {
    writeFileSync(loginMarker(), JSON.stringify({ loginItemAsked: true }), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Start at login is switched on automatically at most once, and only when there is a Google URL
 * for the background sync to serve. Never from the dev server: that login item would point at a
 * checkout with no built renderer. After this the tray checkbox is the only switch — the old
 * per-launch "first run" check had no marker and forced it back on every time.
 */
function offerLoginItem(): void {
  if (process.env.ELECTRON_RENDERER_URL || !getSyncConfig().url || existsSync(loginMarker()) || !markLoginAsked()) return
  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: loginArgs })
  tray?.setContextMenu(buildTrayMenu())
}

const buildTrayMenu = (): Menu =>
  Menu.buildFromTemplate([
    { label: 'Open Tartan', click: showMain },
    {
      label: 'Sync now',
      click: () => {
        void syncNow().finally(() => void pollInbox(true))
      },
    },
    { type: 'separator' },
    {
      label: process.platform === 'win32' ? 'Start with Windows' : 'Start at login',
      // Electron has no login items on Linux; a checkbox that does nothing is worse than none.
      visible: process.platform !== 'linux',
      type: 'checkbox',
      checked: app.getLoginItemSettings({ path: process.execPath, args: loginArgs }).openAtLogin,
      click: (item) => {
        // The user's own choice: a Google URL added later must not turn it back on.
        markLoginAsked()
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: loginArgs })
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Tartan',
      click: () => {
        reallyQuit = true
        app.quit()
      },
    },
  ])

void app.whenReady().then(async () => {
  // Read first, before anything else can disturb the launch state macOS reports.
  launchHidden =
    process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true)
  loadConfig()
  try {
    await ensureDataDir()
  } catch (err) {
    // A saved folder on an unplugged drive, or one we may not write to. Without this catch the
    // whole startup stopped here: no window, no tray, no sync, and a process nobody could quit.
    // Carry on so Settings opens and another folder can be picked; the data banner shows the reads.
    dialog.showErrorBox(
      'Tartan cannot open its data folder',
      `${dataDir()}\n\n${(err as Error).message}\n\nPick another folder in Settings → Your data.`,
    )
  }
  registerAttachmentProtocol()
  registerIpc()
  createWindow()
  started = true
  // Catch-up: the data folder is hand-editable, so a launch is the moment to notice that
  // deadlines.json changed while Tartan was closed. The payload hash makes this free when
  // nothing did.
  void refreshStaleFeeds()
    .then(importFeedDeadlines)
    // Recurring occurrences next, so a rule added yesterday has rows before the sync below.
    .then(async (merged) => {
      const materialized = await materializeRecurring()
      // The window's mount refresh raced this whole chain; anything it landed must be told.
      if (merged.added || merged.updated || materialized.changed) notifyDataChanged()
    })
    .catch(() => undefined)
    // The catch-up sync runs after, so a freshly pulled Canvas assignment reaches Google too.
    .finally(() => void syncNow())
    // And only THEN the phone inbox. A tick that arrives before the Canvas import has restored
    // its row would find nothing to tick and be acked away as "no longer here".
    .finally(() => void pollInbox(true))

  /**
   * The hands-off tier. Launch covers opening the app and focus covers coming back to it, but an
   * app left open-and-unfocused for a day saw nothing: no new Canvas work, no day-boundary
   * recurring rows, no phone ticks, and hand-edits never reached Google. One interval, in main,
   * running the exact focus chain — deliberately no other timers anywhere. The sync is
   * unconditional because the payload hash already makes an unchanged semester free, and an
   * unconditional call is what picks up hand-edited files.
   */
  setInterval(() => {
    void refreshStaleFeeds()
      // Every tick, not only after a refetch: a promoted event ticks itself done at import time, and
      // the refetch mark is six hours. The import reads cached files and writes only on a change.
      .then(() => importFeedDeadlines())
      .then(async (merged) => {
        const materialized = await materializeRecurring()
        if ((merged && (merged.added || merged.updated)) || materialized.changed) notifyDataChanged()
      })
      .catch(() => undefined)
      // AFTER the catch, like the launch chain above. Sitting in a .then() before it, one rejected
      // link — an unreadable deadlines.json mid-write, a feed status write that fails — skipped the
      // sync on that tick, and on every tick after it while the cause persisted. Google then stops
      // updating with nothing on screen to say so: the semester went days stale and only a restart
      // fixed it, because the launch path is the one that gets this right.
      .finally(() => scheduleSync())
      .finally(() => void pollInbox())
  }, 15 * 60_000)
  // macOS and Linux draw a tray image at its pixel size, and the .png is 1024px. On macOS a 32px
  // bitmap marked as 2x stays sharp on Retina menu bars.
  const png = nativeImage.createFromPath(iconFile)
  tray = new Tray(
    process.platform === 'win32'
      ? iconFile
      : process.platform === 'darwin'
        ? nativeImage.createFromBuffer(png.resize({ width: 32, height: 32 }).toPNG(), { scaleFactor: 2 })
        : png.resize({ width: 16, height: 16 }),
  )
  tray.setToolTip('Tartan — syncing in the background')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', showMain)
  offerLoginItem()

  // Registration fails if another app already owns the combo; Tartan works without it.
  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggleCapture)) {
    console.warn('Quick capture shortcut (Ctrl/Cmd+Shift+Space) is taken by another app')
  }
  // Control on every system: Cmd+Shift+Q is the macOS Log Out shortcut.
  const quoted = globalShortcut.register('Control+Shift+Q', async () => {
    // Awaited: Electron 44 made readText asynchronous (on 43 the await is a no-op).
    const text = await clipboard.readText()
    if (!text.trim()) return
    // Not getAllWindows()[0]: once quick capture has been opened it is a window too, and it has
    // no 'quote' listener — so the first use of Ctrl+Shift+Space silently killed Ctrl+Shift+Q
    // for the rest of the session. showMain, not focus(): that does not bring a window out of the
    // tray, and the quote would land in a window nobody can see.
    showMain()?.webContents.send('quote', text)
  })
  if (!quoted) console.warn('Quote shortcut (Ctrl+Shift+Q) is taken by another app')
  // The Dock icon: the window is usually parked in the tray, not closed.
  app.on('activate', showMain)
})

/**
 * Send anything the 5-second debounce is still holding before the process dies. Without this,
 * ticking a deadline and immediately shutting the laptop dropped the sync — Google never heard,
 * and the phone kept showing work that was already done.
 *
 * `quitting` stops the re-entry loop: app.quit() fires before-quit again.
 */
let quitting = false
app.on('before-quit', (event) => {
  // Window close never quits any more, so a quit — tray, updater, OS shutdown — is always meant:
  // the close-to-tray guard must stand aside or it deadlocks a Windows session end.
  reallyQuit = true
  if (quitting || !syncPending()) return
  event.preventDefault()
  quitting = true
  void flushSync().finally(() => app.quit())
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
