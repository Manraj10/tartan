import { app } from 'electron'
import { promises as fs, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  KIND_LABELS,
  SCHEDULE_FILE,
  type Course,
  type Deadline,
  type ImportResult,
  type NoteMeta,
  type RecurringRule,
  type Subscription,
  type Todo,
} from '../shared/types'
import type { LeetcodeState } from '../shared/leetcode'
import { localDay } from '../shared/day-plan'
import { parseGrades, unreadable, type GradesState } from '../shared/grades'
// feeds.ts imports this module too. Safe: each side only calls the other from inside a function.
import { importFeedUrl } from './feeds'

/**
 * Everything lives as plain files under Documents/Semester so that Claude Code,
 * a text editor, or a sync client can read and write the same data this app does.
 * There is no database and no server on purpose.
 */
/**
 * Where the semester lives. Defaults to Documents/Semester, but can be pointed at a synced
 * folder (Google Drive for desktop, CMU Box) so the same files reach the phone. The override
 * is kept in userData, deliberately outside the data folder itself.
 */
const configFile = (): string => path.join(app.getPath('userData'), 'config.json')

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface Config {
  dataDir?: string
  window?: WindowState
  /** Google Calendar sync. See sync.ts — the /exec URL of the Apps Script web app. */
  syncUrl?: string
  syncSecret?: string
  /** Hash of the last payload Google accepted, so an unchanged semester costs no request. */
  syncHash?: string
  syncAt?: string
  /** YYYY-MM-DD. Bounds the recurring class events. */
  termStart?: string
  termEnd?: string
  /** Ids of phone actions already applied. The ack list AND the replay guard, in one array. */
  inboxDone?: string[]
  /** Outcome of the last sync attempt. Persisted so a failure survives a restart. */
  syncError?: string
  syncSummary?: string
}

export interface SyncConfig {
  url: string
  secret: string
  termStart: string
  termEnd: string
}

/**
 * A placeholder term until you set your own in Settings, which is where the real dates belong: the
 * Calendar clamps class series to these, so a wrong term paints lectures into months you are not in.
 * It is a 17-week term that started on the Monday four weeks ago, so a fresh install always lands
 * inside one. A brand-new data folder pins it (see ensureDataDir) so it stops sliding.
 */
export function defaultTerm(now = new Date()): { termStart: string; termEnd: string } {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 28)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  const termStart = localDay(d)
  d.setDate(d.getDate() + 17 * 7 - 1)
  return { termStart, termEnd: localDay(d) }
}

/**
 * One object and one writer. Three separate writers each rebuilding the payload from the keys
 * they happened to know about is how changing the data folder used to reset your window.
 */
let cfg: Config = {}

export function loadConfig(): void {
  try {
    const raw = parseJson(readFileSync(configFile(), 'utf8')) as Record<string, unknown>
    const w = raw.window as WindowState | undefined
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
    cfg = {
      dataDir: str(raw.dataDir),
      window: w && typeof w.width === 'number' && typeof w.height === 'number' ? w : undefined,
      syncUrl: str(raw.syncUrl),
      syncSecret: str(raw.syncSecret),
      syncHash: str(raw.syncHash),
      syncAt: str(raw.syncAt),
      termStart: str(raw.termStart),
      termEnd: str(raw.termEnd),
      inboxDone: Array.isArray(raw.inboxDone)
        ? (raw.inboxDone as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
      syncError: str(raw.syncError),
      syncSummary: str(raw.syncSummary),
    }
  } catch (err) {
    cfg = {}
    // A typo or an empty file is not "no config yet": the next persist() would overwrite it and take
    // the data folder, sync secret and term dates with it. Keep it beside the new one, newest wins.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        renameSync(configFile(), `${configFile()}.bad`)
      } catch {
        // Nothing more to do; startup must not fail over a config we could not set aside.
      }
    }
  }
}

/** JSON.stringify drops undefined keys, so an unset option simply is not in the file. */
function persist(): void {
  const tmp = `${configFile()}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, configFile())
}

export const getWindowState = (): WindowState | null => cfg.window ?? null

/** Fire-and-forget: called on window close, must never block quitting. */
export function saveWindowState(next: WindowState): void {
  cfg.window = next
  try {
    persist()
  } catch {
    // A lost window position is not worth an error dialog.
  }
}

export const dataDir = (): string => cfg.dataDir ?? path.join(app.getPath('documents'), 'Semester')

export async function setDataDir(dir: string): Promise<string> {
  const previous = cfg.dataDir
  cfg.dataDir = dir
  // Saved only once the folder is usable: a bad pick used to be remembered and fail every launch.
  try {
    await fs.mkdir(path.dirname(configFile()), { recursive: true })
    await ensureDataDir()
    persist()
  } catch (err) {
    cfg.dataDir = previous
    throw err
  }
  return dataDir()
}

export function getSyncConfig(): SyncConfig {
  const term = defaultTerm()
  return {
    url: cfg.syncUrl ?? '',
    secret: cfg.syncSecret ?? '',
    termStart: cfg.termStart ?? term.termStart,
    termEnd: cfg.termEnd ?? term.termEnd,
  }
}

export function setSyncConfig(patch: Partial<SyncConfig>): SyncConfig {
  if (patch.url !== undefined) cfg.syncUrl = patch.url.trim() || undefined
  if (patch.secret !== undefined) cfg.syncSecret = patch.secret.trim() || undefined
  if (patch.termStart !== undefined) cfg.termStart = patch.termStart.trim() || undefined
  if (patch.termEnd !== undefined) cfg.termEnd = patch.termEnd.trim() || undefined
  persist()
  return getSyncConfig()
}

/** What Google last accepted. An unchanged hash is how a no-op sync stays free. */
export const getSyncMark = (): { hash: string | null; at: string | null } => ({
  hash: cfg.syncHash ?? null,
  at: cfg.syncAt ?? null,
})

export function setSyncMark(hash: string, at: string): void {
  cfg.syncHash = hash
  cfg.syncAt = at
  persist()
}

/** Forces the next sync to send everything — used when the calendar has been edited behind us. */
export function clearSyncMark(): void {
  cfg.syncHash = undefined
  persist()
}

/**
 * How the last sync attempt went. Persisted because it used to be a module variable in sync.ts:
 * a sync that had been failing for days came back clean after a restart, while the timestamp beside
 * it still showed the last SUCCESS — so a broken sync read as a healthy one.
 */
export const getSyncOutcome = (): { error: string | null; summary: string | null } => ({
  error: cfg.syncError ?? null,
  summary: cfg.syncSummary ?? null,
})

export function setSyncOutcome(error: string | null, summary: string | null): void {
  if ((cfg.syncError ?? null) === error && (cfg.syncSummary ?? null) === summary) return
  cfg.syncError = error ?? undefined
  cfg.syncSummary = summary ?? undefined
  persist()
}

/**
 * Phone actions Tartan has already applied. Lives in userData, not the data folder: it is
 * bookkeeping about the sync, not something to hand-edit.
 *
 * Written the instant a change lands, because for `todo.add` this is load-bearing rather than
 * merely a fast path — a re-applied tick is a no-op, but a re-applied ADD after the todo has been
 * deleted puts it back, every launch, until an ack finally gets through. Capped so one file cannot
 * grow forever; 200 is far more than a poll cycle ever carries.
 */
const INBOX_KEEP = 200
export const getInboxDone = (): string[] => cfg.inboxDone ?? []

export function markInboxDone(ids: string[]): void {
  const seen = new Set(cfg.inboxDone ?? [])
  const add = ids.filter((id) => !seen.has(id))
  if (!add.length) return
  cfg.inboxDone = [...(cfg.inboxDone ?? []), ...add].slice(-INBOX_KEEP)
  persist()
}
const notesDir = (): string => path.join(dataDir(), 'notes')
const coursesFile = (): string => path.join(dataDir(), 'courses.json')
const deadlinesFile = (): string => path.join(dataDir(), 'deadlines.json')
const todosFile = (): string => path.join(dataDir(), 'todos.json')
const subscriptionsFile = (): string => path.join(dataDir(), 'subscriptions.json')
const leetcodeFile = (): string => path.join(dataDir(), 'leetcode.json')
const gradesFile = (): string => path.join(dataDir(), 'grades.json')
const recurringFile = (): string => path.join(dataDir(), 'recurring.json')

/** Notepad saves a leading byte-order mark that JSON.parse rejects; read and write must agree on it. */
const parseJson = (text: string): unknown => JSON.parse(text.replace(/^\uFEFF/, ''))

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return parseJson(await fs.readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

/**
 * Write to a temp file then rename, so a crash mid-write cannot truncate real data. Refuses to
 * replace a file that exists but does not parse, or parses to a different kind of thing than is being
 * written (an object where a list belongs): several readers turn either into "no rows", so the next
 * save would wipe a file you only had a typo in.
 */
async function writeJsonNow(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const existing = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return ''
    throw err
  })
  if (existing.trim()) {
    const refuse = (why: string): Error => new Error(`${path.basename(file)} could not be read, so nothing was saved: ${why}. Fix or delete the file.`)
    let found: unknown
    try {
      found = parseJson(existing)
    } catch (err) {
      throw refuse((err as Error).message)
    }
    const kind = (v: unknown): string => (Array.isArray(v) ? 'a list' : v === null ? 'null' : typeof v === 'object' ? 'an object' : `a ${typeof v}`)
    if (kind(found) !== kind(value)) throw refuse(`it holds ${kind(found)} where ${kind(value)} is expected`)
  }
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  // Windows refuses a rename for a moment while antivirus or a sync client looks at the new file.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
    }
  }
}

/**
 * One write at a time per file. The renderer and main both save deadlines.json, and two writes
 * sharing one temp file would interleave: one renames the temp out from under the other.
 */
const writing = new Map<string, Promise<void>>()
function writeJson(file: string, value: unknown): Promise<void> {
  const next = (writing.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => writeJsonNow(file, value))
  writing.set(file, next)
  void next.finally(() => {
    if (writing.get(file) === next) writing.delete(file)
  }).catch(() => undefined)
  return next
}

/** Creates the file only if it is missing, so picking a folder you already use never overwrites it. */
async function seed(file: string, body: string): Promise<boolean> {
  try {
    await fs.writeFile(file, body, { flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(notesDir(), { recursive: true })
  const fresh = await seed(coursesFile(), JSON.stringify(seedCourses(), null, 2))
  await seed(deadlinesFile(), '[]')
  await seed(
    path.join(dataDir(), 'README.md'),
    [
      '# Semester',
      '',
      'This folder is the entire database for the Tartan app.',
      '',
      '- `courses.json` — your courses and their links',
      '- `deadlines.json` — everything due',
      '- `notes/<course>/*.md` — your notes, plain markdown',
      '',
      'Edit any of it by hand or point Claude Code at it. The app reads the files on focus.',
      '',
    ].join('\n'),
  )
  // A brand-new semester gets today's default term written down, so it does not slide week to week.
  if (fresh && !cfg.termStart && !cfg.termEnd) {
    Object.assign(cfg, defaultTerm())
    try {
      await fs.mkdir(path.dirname(configFile()), { recursive: true })
      persist()
    } catch {
      // Unsaved is fine: getSyncConfig computes the same default on every read.
    }
  }
}

/**
 * Three obviously-fake spaces, so the first launch has something to look at and nothing to believe.
 * Rename them in Settings, or delete them and add your own — they are only rows in courses.json.
 */
function seedCourses(): Course[] {
  return [
    { id: '01-101', code: '01-101', title: 'Example Course', color: '#e8613c', units: 9, links: [] },
    { id: '02-202', code: '02-202', title: 'Another Course', color: '#3c7ae8', units: 9, links: [] },
    // Not plain 'WRITING': quick-add files any sentence containing that word under the course.
    { id: 'writ-101', code: 'WRIT 101', title: 'A Writing Class', color: '#2fa36b', units: 9, links: [] },
  ]
}

/** A hand-edited file can be valid JSON and still not a list; say so, so the window shows its banner. */
async function readRows<T extends object>(file: string): Promise<T[]> {
  const raw = await readJson<unknown>(file, [])
  if (!Array.isArray(raw)) throw new Error(`${path.basename(file)} must be a JSON array`)
  return raw.filter((r): r is T => !!r && typeof r === 'object')
}

export const getCourses = async (): Promise<Course[]> =>
  (await readRows<Course>(coursesFile())).map((c) => ({ ...c, code: String(c.code ?? c.id), links: c.links ?? [] }))
export const setCourses = (c: Course[]): Promise<void> => writeJson(coursesFile(), c)
export const getDeadlines = async (): Promise<Deadline[]> =>
  (await readRows<Deadline>(deadlinesFile())).map((d) => (Object.hasOwn(KIND_LABELS, d.kind) ? d : { ...d, kind: 'other' }))

/** Subscribed calendars. Read-only feeds; Tartan never writes back to them. */
export async function getSubscriptions(): Promise<Subscription[]> {
  try {
    const raw = await readJson<unknown>(subscriptionsFile(), [])
    return Array.isArray(raw) ? (raw as Subscription[]) : []
  } catch {
    return []
  }
}
export const setSubscriptions = (s: Subscription[]): Promise<void> => writeJson(subscriptionsFile(), s)

/** The ongoing todo list. Order is the file's order, so a drag is just a rewrite. */
export async function getTodos(): Promise<Todo[]> {
  try {
    const raw = await readJson<unknown>(todosFile(), [])
    return Array.isArray(raw) ? (raw as Todo[]) : []
  } catch {
    return []
  }
}
export const setTodos = (t: Todo[]): Promise<void> => writeJson(todosFile(), t)
export const setDeadlines = (d: Deadline[]): Promise<void> => writeJson(deadlinesFile(), d)

/**
 * Recurring rules. The rules are the source; recurring.ts derives the occurrences. Hand-editable,
 * so one stray null or bare string must not throw in every consumer — filter, never trust.
 */
export async function getRecurring(): Promise<RecurringRule[]> {
  try {
    const raw = await readJson<unknown>(recurringFile(), [])
    if (!Array.isArray(raw)) return []
    return raw.filter((r): r is RecurringRule => !!r && typeof r === 'object' && typeof (r as RecurringRule).id === 'string')
  } catch {
    return []
  }
}
export const setRecurring = (r: RecurringRule[]): Promise<void> => writeJson(recurringFile(), r)

/**
 * LeetCode progress: { done: { "two-sum": "2026-08-25", ... } }. Slug → the day it was solved.
 * The ladder itself ships with the app; only the progress is data, and like everything else in
 * the folder it is one small hand-editable JSON file. Malformed must never block startup.
 */
export async function getLeetcode(): Promise<LeetcodeState> {
  try {
    const raw = await readJson<unknown>(leetcodeFile(), { done: {} })
    const done = (raw as LeetcodeState | null)?.done
    if (!done || typeof done !== 'object') return { done: {} }
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(done)) if (typeof v === 'string') clean[k] = v
    return { done: clean }
  } catch {
    return { done: {} }
  }
}
export const setLeetcode = (s: LeetcodeState): Promise<void> => writeJson(leetcodeFile(), s)

/**
 * Grading schemes: { "01-101": { ...formula, categories, cutoffs } }. The syllabus's arithmetic is
 * data, hand-editable like recurring.json, so a weight change is an edit and not a release.
 *
 * Unlike the other files this one holds scores that exist nowhere else, so a typo must not read as
 * "no schemes": the next save would replace the whole file. An unreadable file comes back marked
 * (see UNREADABLE) for the panel to show, never throws (that would block startup), and setGrades
 * refuses to write until the file parses.
 */
async function readGrades(): Promise<{ state: GradesState } | { error: string }> {
  try {
    return parseGrades(await fs.readFile(gradesFile(), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: {} }
    return { error: (err as Error).message }
  }
}

export async function getGrades(): Promise<GradesState> {
  const read = await readGrades()
  return 'state' in read ? read.state : unreadable(read.error)
}

export async function setGrades(g: GradesState): Promise<void> {
  const read = await readGrades()
  if ('error' in read) throw new Error(`grades.json could not be read, so nothing was saved: ${read.error}`)
  await writeJson(gradesFile(), g)
}

/**
 * A course id doubles as its notes folder name, so changing it has to move the folder and
 * re-point every deadline. Doing this by hand is how people end up with orphaned notes.
 */
export async function renameCourse(oldId: string, newId: string): Promise<void> {
  if (oldId === newId) return
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(newId)) {
    throw new Error(`"${newId}" is not a valid folder name — use letters, digits, dot, dash or underscore.`)
  }
  const courses = await getCourses()
  if (!courses.some((c) => c.id === oldId)) throw new Error(`No course with id "${oldId}".`)
  if (courses.some((c) => c.id === newId)) throw new Error(`A course with id "${newId}" already exists.`)

  const from = path.join(notesDir(), oldId)
  const to = path.join(notesDir(), newId)
  try {
    await fs.rename(from, to)
  } catch (err) {
    // No notes folder yet is fine; anything else means we should not half-apply the rename.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  // Note history is filed under the same folder name; losing it would make Restore come up empty.
  // But it is a convenience: the notes folder has already moved, so a history folder that cannot
  // follow (a leftover .versions/<newId>, a locked file) must never stop or half-apply the rename.
  try {
    await fs.rename(path.join(versionsDir(), oldId), path.join(versionsDir(), newId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Could not move the note history of ${oldId} to ${newId}:`, err)
  }

  await setCourses(courses.map((c) => (c.id === oldId ? { ...c, id: newId } : c)))
  const deadlines = await getDeadlines()
  await setDeadlines(deadlines.map((d) => (d.courseId === oldId ? { ...d, courseId: newId } : d)))

  // Everything else that names a course by id. Written only when a row actually changes, so a file
  // that reads as empty (unparseable, say) is never rewritten as a side effect of a rename.
  const repoint = <T extends { courseId: string | null }>(rows: T[]): T[] | null =>
    // A hand-edited file can hold a stray null row; skip it rather than throw half-way through a rename.
    rows.some((r) => r?.courseId === oldId) ? rows.map((r) => (r?.courseId === oldId ? { ...r, courseId: newId } : r)) : null
  const todos = repoint(await getTodos())
  if (todos) await setTodos(todos)
  const recurring = repoint(await getRecurring())
  if (recurring) await setRecurring(recurring)
  const subs = repoint(await getSubscriptions())
  if (subs) await setSubscriptions(subs)

  // _schedule.md: rewrite only the first field of a line, never the room or dates that follow it.
  const schedule = await readNote(SCHEDULE_FILE)
  // A file saved by Notepad can start with a byte-order mark; it sits in front of the first field.
  const moved = schedule.replace(/^(﻿?[ \t]*)([^|\r\n]*?)([ \t]*)\|/gm, (m, a: string, id: string, b: string) =>
    id === oldId ? `${a}${newId}${b}|` : m,
  )
  if (moved !== schedule) await writeNote(SCHEDULE_FILE, moved)

  // grades.json is keyed by course id too, so a rename orphans a whole semester of scores
  // unless it moves with everything else.
  const grades = await getGrades()
  if (grades[oldId]) {
    const { [oldId]: moved, ...rest } = grades
    await setGrades({ ...rest, [newId]: moved })
  }
}

/** Reject anything that escapes the notes root — a note path comes from the renderer. */
function resolveNote(rel: string): string {
  const root = notesDir()
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path outside notes root: ${rel}`)
  if (path.extname(full) !== '.md') throw new Error(`Not a markdown file: ${rel}`)
  return full
}

/**
 * The document URL from a Drive `.gdoc` stub, or null if it is not one. The stub is JSON with a
 * `doc_id`; it says in its own first field never to edit it, and Tartan never does — it reads the
 * id and opens the browser. Anything unparseable is simply not a note.
 */
async function gdocUrl(abs: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(abs, 'utf8')) as { doc_id?: unknown }
    const id = typeof raw.doc_id === 'string' ? raw.doc_id : null
    return id && /^[\w-]+$/.test(id) ? `https://docs.google.com/document/d/${id}/edit` : null
  } catch {
    return null
  }
}

export async function listNotes(): Promise<NoteMeta[]> {
  const root = notesDir()
  await fs.mkdir(root, { recursive: true })
  const out: NoteMeta[] = []
  const entries = await fs.readdir(root, { withFileTypes: true, recursive: true })
  for (const e of entries) {
    if (!e.isFile()) continue
    if (e.name.endsWith('.gdoc')) {
      const abs = path.join(e.parentPath ?? root, e.name)
      const url = await gdocUrl(abs)
      if (!url) continue
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const stat = await fs.stat(abs)
      out.push({
        path: rel,
        courseId: rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : null,
        title: e.name.replace(/\.gdoc$/, ''),
        updated: stat.mtime.toISOString(),
        docUrl: url,
      })
      continue
    }
    if (!e.name.endsWith('.md')) continue
    // A leading underscore means the file belongs to the app, not to you. _schedule.md is the class
    // timetable that the Schedule screen owns; listing it here puts a note you never wrote at the
    // top of your notes, your search results and your properties table.
    if (e.name.startsWith('_')) continue
    const abs = path.join(e.parentPath ?? root, e.name)
    const rel = path.relative(root, abs).split(path.sep).join('/')
    const stat = await fs.stat(abs)
    const dir = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : null
    out.push({
      path: rel,
      courseId: dir,
      title: e.name.replace(/\.md$/, ''),
      updated: stat.mtime.toISOString(),
    })
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated))
}

/**
 * Attachments: readings, slide decks, and phone photos of handwritten pages. They are ordinary
 * files in the data folder so Drive syncs them and Explorer can open them; Chromium renders
 * PDFs and images natively, so viewing them needs no library.
 */
const filesDir = (): string => path.join(dataDir(), 'files')

function resolveAttachment(rel: string): string {
  const root = filesDir()
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path outside files root: ${rel}`)
  return full
}

/** Absolute path for the tartan:// protocol handler. Traversal-guarded like every other path. */
export const resolveAttachmentPath = (rel: string): string => resolveAttachment(rel)

/** Writes raw bytes (a pasted screenshot) into a course folder, never overwriting. */
export async function writeAttachmentBytes(
  courseId: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ rel: string }> {
  const safe = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '-')
  const dir = path.join(filesDir(), courseId)
  await fs.mkdir(dir, { recursive: true })
  const stem = path.basename(safe, path.extname(safe))
  const ext = path.extname(safe)
  let target = path.join(dir, safe)
  for (let i = 2; ; i++) {
    try {
      await fs.access(target)
      target = path.join(dir, `${stem}-${i}${ext}`)
    } catch {
      break
    }
  }
  await fs.writeFile(target, bytes)
  return { rel: path.relative(filesDir(), target).split(path.sep).join('/') }
}

/**
 * Deterministic markdown tidy. No model, no network, no cost — and crucially it cannot invent
 * content, so running it on lecture notes is safe wherever a model is not allowed.
 * Code fences, math and frontmatter are lifted out first and put back untouched.
 */
export function tidyMarkdown(input: string): string {
  const { props, body } = parseFrontmatter(input)

  const vault: string[] = []
  const keep = (s: string): string => `@@TIDY${vault.push(s) - 1}@@`

  let text = body
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, keep)
    .replace(/~~~[\s\S]*?~~~/g, keep)
    .replace(/\$\$[\s\S]*?\$\$/g, keep)
    .replace(/\$[^$\n]+\$/g, keep)
    .replace(/`[^`\n]+`/g, keep)

  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  const out: string[] = []
  let counter = 0
  /** Two adjacent lists of different kinds merge into one unless a blank line separates them. */
  let listKind: 'ul' | 'ol' | null = null

  const isBlank = (s: string | undefined): boolean => s === undefined || s.trim() === ''
  const pushBlankBefore = () => {
    if (out.length && !isBlank(out[out.length - 1])) out.push('')
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Headings: exactly one space after the hashes, blank line either side.
    const h = /^(#{1,6})\s*(.+?)\s*#*$/.exec(line)
    if (h) {
      counter = 0
      pushBlankBefore()
      out.push(`${h[1]} ${h[2]}`)
      if (!isBlank(lines[i + 1])) out.push('')
      continue
    }

    // Setext headings become ATX, which is what the rest of the file uses.
    if (/^(=+|-{3,})$/.test(line) && !isBlank(lines[i - 1]) && out.length) {
      const prev = out.pop() as string
      if (prev.trim() && !/^[-*+]\s/.test(prev)) {
        pushBlankBefore()
        out.push(`${line.startsWith('=') ? '#' : '##'} ${prev.trim()}`)
        if (!isBlank(lines[i + 1])) out.push('')
        continue
      }
      out.push(prev)
    }

    // Horizontal rules, normalised.
    if (/^\s*(\*\s*){3,}$/.test(line) || /^\s*(-\s*){3,}$/.test(line) || /^\s*(_\s*){3,}$/.test(line)) {
      counter = 0
      pushBlankBefore()
      out.push('---')
      if (!isBlank(lines[i + 1])) out.push('')
      continue
    }

    // Bullets: one marker for the whole file, indentation preserved in 2-space steps.
    const b = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (b) {
      counter = 0
      if (listKind === 'ol') pushBlankBefore()
      listKind = 'ul'
      const depth = Math.floor(b[1].replace(/\t/g, '  ').length / 2)
      const box = b[2] ? b[2].replace(/\[[xX]\]/, '[x]').replace(/\s+$/, ' ') : ''
      out.push(`${'  '.repeat(depth)}- ${box}${b[3].trim()}`)
      continue
    }

    // Ordered lists renumbered from 1 so inserting an item never leaves 1. 1. 1.
    const o = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (o) {
      if (listKind === 'ul') pushBlankBefore()
      listKind = 'ol'
      const depth = Math.floor(o[1].replace(/\t/g, '  ').length / 2)
      if (depth === 0) counter++
      out.push(`${'  '.repeat(depth)}${depth === 0 ? counter : 1}. ${o[3].trim()}`)
      continue
    }

    if (line.trim() === '') {
      counter = 0
      listKind = null
      out.push('')
      continue
    }

    counter = 0
    listKind = null
    out.push(line.replace(/\s{2,}/g, (m) => (m.length === 2 && line.endsWith(m) ? m : ' ')))
  }

  text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/@@TIDY(\d+)@@/g, (_m, i: string) => vault[Number(i)])
    .trim()

  text = alignTables(text)

  const front = Object.keys(props).length
    ? `---\n${Object.entries(props)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')}\n---\n\n`
    : ''
  return `${front}${text}\n`
}

/** Pad every cell so the pipes line up — the single biggest visual win in a markdown file. */
function alignTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      out.push(lines[i])
      continue
    }
    if (out.length && out[out.length - 1].trim() !== '') out.push('')
    const block: string[] = []
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++])
    i--

    const rows = block.map((r) =>
      r
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    )
    const cols = Math.max(...rows.map((r) => r.length))
    const aligns = rows[1].map((c) => (/^:-+:$/.test(c) ? 'c' : /-+:$/.test(c) ? 'r' : 'l'))
    const width: number[] = []
    for (let c = 0; c < cols; c++) {
      width[c] = Math.max(3, ...rows.filter((_, ri) => ri !== 1).map((r) => (r[c] ?? '').length))
    }

    out.push(
      ...rows.map((r, ri) => {
        const cells = Array.from({ length: cols }, (_, c) => {
          const v = r[c] ?? ''
          if (ri === 1) {
            const a = aligns[c] ?? 'l'
            const dashes = '-'.repeat(Math.max(1, width[c] - (a === 'c' ? 2 : a === 'r' ? 1 : 0)))
            return a === 'c' ? `:${dashes}:` : a === 'r' ? `${dashes}:` : dashes
          }
          return v.padEnd(width[c])
        })
        return `| ${cells.join(' | ')} |`
      }),
    )
  }
  return out.join('\n')
}

export interface NoteIndexEntry {
  path: string
  courseId: string | null
  title: string
  /** YAML-ish frontmatter, the Notion "properties" of a page. */
  props: Record<string, string>
  /** [[wikilink]] targets, by note title. */
  links: string[]
  /** #tags found in the body. */
  tags: string[]
  updated: string
}

/**
 * Frontmatter is a leading `---` block of `key: value` lines. Deliberately not a YAML parser:
 * flat string values are what a properties table needs, and a real parser is a dependency plus
 * a class of failures on hand-edited files.
 */
export function parseFrontmatter(text: string): { props: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { props: {}, body: text }
  const props: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key) props[key] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '')
  }
  return { props, body: text.slice(m[0].length) }
}

const LINK_RE = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g
/**
 * Tags must follow whitespace or a line start, so `#` inside a URL or a heading is not a tag.
 * Same shape as the chip regex in Notes.tsx (renderBody) — `/` included, so #course/topic is one
 * tag — because the chip sets the search query and this is what has to find it.
 */
const TAG_RE = /(?:^|\s)#([A-Za-z][\w/-]*)/g
/** Code is not prose: `#include` in a fence is a C directive. renderBody lifts these out the same way. */
const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g

export async function noteIndex(): Promise<NoteIndexEntry[]> {
  await refreshCorpus()
  const notes = await listNotes()
  const byPath = new Map(notes.map((n) => [n.path, n]))
  const out: NoteIndexEntry[] = []
  for (const [rel, entry] of corpus) {
    const meta = byPath.get(rel)
    const { props, body } = parseFrontmatter(entry.text)
    const links = [...body.matchAll(LINK_RE)].map((m) => m[1].trim())
    // '@' rather than a space, so `code`#x stays a non-tag exactly as it does when rendered.
    const tags = [...body.replace(CODE_RE, '@').matchAll(TAG_RE)].map((m) => m[1])
    out.push({
      path: rel,
      courseId: entry.courseId,
      title: props.title ?? entry.title,
      props,
      links: [...new Set(links)],
      tags: [...new Set(tags)],
      updated: meta?.updated ?? new Date(0).toISOString(),
    })
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated))
}

export interface Backlink extends NoteIndexEntry {
  /** The line the link sits on. */
  line: string
  /** Nearest heading above it, so a hit in a long note says where in the note it is. */
  heading: string
  /** Character offset of the link, for putting the caret there on open. */
  offset: number
}

/**
 * Which notes point at this one. Matched on title, the way a wikilink is written.
 *
 * Returns the surrounding sentence, not just the title: a chip reading "01-101 Week 4" tells you
 * nothing about WHY it points here, so every backlink used to cost a round trip to find out.
 */
export async function backlinks(title: string): Promise<Backlink[]> {
  const idx = await noteIndex()
  const t = title.toLowerCase()
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const linkRe = new RegExp(`\\[\\[${escaped}(?:\\|[^\\]]*)?\\]\\]`, 'i')

  const out: Backlink[] = []
  for (const n of idx) {
    if (!n.links.some((l) => l.toLowerCase() === t)) continue
    const text = corpus.get(n.path)?.text ?? ''
    const m = linkRe.exec(text)
    const offset = m?.index ?? 0

    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
    const lineEnd = text.indexOf('\n', offset)
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim()

    let heading = ''
    for (const h of text.slice(0, offset).matchAll(/^#{1,6}\s+(.+)$/gm)) heading = h[1].trim()

    out.push({ ...n, line, heading, offset })
  }
  return out
}

export interface SearchHit {
  path: string
  courseId: string | null
  title: string
  score: number
  snippet: string
}

/**
 * Search corpus held in memory. A few hundred markdown files is a couple of megabytes, so a
 * parallel stat pass and re-reading only what changed is faster than maintaining an index —
 * and an index is a second source of truth that can go stale against hand-edited files.
 */
const corpus = new Map<string, { mtimeMs: number; text: string; lower: string; title: string; courseId: string | null }>()

async function refreshCorpus(): Promise<void> {
  const notes = await listNotes()
  const seen = new Set<string>()
  await Promise.all(
    notes.map(async (n) => {
      seen.add(n.path)
      const abs = path.join(notesDir(), n.path)
      const stat = await fs.stat(abs)
      const cached = corpus.get(n.path)
      if (cached && cached.mtimeMs === stat.mtimeMs) return
      // A Drive .gdoc is a JSON stub (document id, the account's email), not writing. Reading it
      // made every stub match "edit" or "gmail" and put the email in the snippet; the title is
      // all there is to search.
      const text = n.docUrl ? '' : await fs.readFile(abs, 'utf8')
      corpus.set(n.path, {
        mtimeMs: stat.mtimeMs,
        text,
        lower: text.toLowerCase(),
        title: n.title,
        courseId: n.courseId,
      })
    }),
  )
  for (const key of corpus.keys()) if (!seen.has(key)) corpus.delete(key)
}

export async function searchNotes(query: string): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  await refreshCorpus()

  const hits: SearchHit[] = []
  for (const [rel, entry] of corpus) {
    const inTitle = entry.title.toLowerCase().includes(q)
    const at = entry.lower.indexOf(q)
    if (!inTitle && at === -1) continue

    // Count occurrences without a regex, so query metacharacters are literal.
    let count = 0
    for (let i = entry.lower.indexOf(q); i !== -1; i = entry.lower.indexOf(q, i + q.length)) count++

    const start = Math.max(0, at - 40)
    const raw = at === -1 ? entry.text.slice(0, 140) : entry.text.slice(start, start + 160)
    hits.push({
      path: rel,
      courseId: entry.courseId,
      title: entry.title,
      // Title matches outrank body matches; more occurrences break the tie.
      score: (inTitle ? 1000 : 0) + count,
      // A title-only hit (an empty note, a Google Doc) has no text to quote.
      snippet: raw ? (start > 0 ? '…' : '') + raw.replace(/\s+/g, ' ').trim() + '…' : '',
    })
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, 50)
}

export async function readNote(rel: string): Promise<string> {
  try {
    return await fs.readFile(resolveNote(rel), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

const versionsDir = (): string => path.join(dataDir(), '.versions')
const SNAPSHOT_EVERY_MS = 5 * 60_000
const KEEP_VERSIONS = 20

/**
 * Keep a local history of each note. Drive and Box sync deletions in seconds, so a synced
 * folder is not a backup; this is the cheap insurance against an accidental select-all-delete
 * or a bad sync merge. Throttled, because autosave fires every 600ms while typing — except when
 * `force` is set, for a write that destroys what it replaces (a restore, a big cut).
 */
async function snapshot(rel: string, previous: string, force: boolean): Promise<void> {
  const dir = path.join(versionsDir(), rel)
  await fs.mkdir(dir, { recursive: true })
  let existing: string[] = []
  try {
    existing = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    existing = []
  }
  const newest = existing[existing.length - 1]
  if (newest && !force) {
    // The name is an ISO stamp with ':' swapped for '-' (2026-09-30T19-36-50.961Z); undo that swap
    // in the time part only. The old pattern expected a dash before the milliseconds, never
    // matched, parsed to NaN and so skipped the throttle on every save — 20 autosaves pruned
    // the whole history.
    const at = Date.parse(newest.replace(/\.md$/, '').replace(/T(\d{2})-(\d{2})-(\d{2})\./, 'T$1:$2:$3.'))
    if (Number.isFinite(at) && Date.now() - at < SNAPSHOT_EVERY_MS) return
  }
  // Repeated cut-and-retype cycles would otherwise push real history out at KEEP_VERSIONS with copies.
  if (newest && (await fs.readFile(path.join(dir, newest), 'utf8').catch(() => null)) === previous) return
  await fs.writeFile(path.join(dir, `${new Date().toISOString().replace(/:/g, '-')}.md`), previous, 'utf8')
  for (const stale of existing.slice(0, Math.max(0, existing.length + 1 - KEEP_VERSIONS))) {
    await fs.rm(path.join(dir, stale), { force: true })
  }
}

export async function writeNote(rel: string, content: string, force = false): Promise<void> {
  const full = resolveNote(rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  let previous: string | null = null
  try {
    previous = await fs.readFile(full, 'utf8')
  } catch {
    previous = null
  }
  if (previous !== null && previous !== content) {
    // History is a convenience; never let it block the save that matters. Cutting the note to under
    // half its length (select-all-delete) is as destructive as a restore, so it is never throttled —
    // unless the note is under 20 characters, where a cut costs nothing worth a history slot.
    await snapshot(rel, previous, force || (previous.length >= 20 && content.length * 2 < previous.length)).catch(() => undefined)
  }
  await fs.writeFile(full, content, 'utf8')
}

export interface NoteVersion {
  stamp: string
  iso: string
  bytes: number
}

export async function listVersions(rel: string): Promise<NoteVersion[]> {
  resolveNote(rel)
  const dir = path.join(versionsDir(), rel)
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out: NoteVersion[] = []
  for (const f of files) {
    const stat = await fs.stat(path.join(dir, f))
    out.push({ stamp: f, iso: stat.mtime.toISOString(), bytes: stat.size })
  }
  return out.sort((a, b) => b.stamp.localeCompare(a.stamp))
}

export async function readVersion(rel: string, stamp: string): Promise<string> {
  resolveNote(rel)
  if (stamp.includes('/') || stamp.includes('\\') || !stamp.endsWith('.md')) throw new Error('Bad version name')
  return fs.readFile(path.join(versionsDir(), rel, stamp), 'utf8')
}

/**
 * Rename a note. The filename IS the title, so this moves the file, carries its version history
 * across, and rewrites [[wikilinks]] in every other note so nothing dangles.
 */
export async function renameNote(rel: string, newTitle: string): Promise<string> {
  const clean = newTitle.trim().replace(/[\\/:*?"<>|]/g, '-')
  if (!clean) throw new Error('A note needs a name.')

  const from = resolveNote(rel)
  const dir = path.dirname(rel).replace(/\\/g, '/')
  const target = `${dir === '.' ? '' : `${dir}/`}${clean}.md`
  if (target === rel) return rel
  const to = resolveNote(target)

  try {
    await fs.access(to)
    throw new Error(`"${clean}" already exists here.`)
  } catch (err) {
    if ((err as Error).message.includes('already exists')) throw err
  }

  await fs.rename(from, to)

  // Carry the history across, or "restore" would silently resurrect the old name's snapshots.
  const vFrom = path.join(versionsDir(), rel)
  const vTo = path.join(versionsDir(), target)
  try {
    await fs.mkdir(path.dirname(vTo), { recursive: true })
    await fs.rename(vFrom, vTo)
  } catch {
    // No history yet is fine.
  }

  const oldTitle = path.basename(rel, '.md')
  if (oldTitle !== clean) {
    const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const linkRe = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, 'gi')
    // The file has already moved. Nothing below may throw past this point: a rejection here
    // reaches the renderer as a failed rename, so the editor keeps the old path and autosaves
    // the old filename back into existence — one note becomes two.
    try {
      for (const n of await listNotes()) {
        // listNotes also returns Drive's .gdoc stubs, which are not notes and which readNote
        // refuses outright. This loop threw on the first one it met.
        if (n.path === target || path.extname(n.path) !== '.md') continue
        const body = await readNote(n.path)
        if (!linkRe.test(body)) continue
        linkRe.lastIndex = 0
        await writeNote(n.path, body.replace(linkRe, (_m, label: string | undefined) => `[[${clean}${label ?? ''}]]`))
      }
    } catch {
      // A missed backlink is a cosmetic loss; unwinding a completed rename is not worth it.
    }
  }

  corpus.delete(rel)
  return target
}

export async function deleteNote(rel: string): Promise<void> {
  await fs.rm(resolveNote(rel), { force: true })
}

/** RFC 5545 requires CRLF and folding at 75 octets; Google rejects long unfolded lines. */
function icsLine(name: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
  const line = `${name}:${escaped}`
  if (line.length <= 75) return line
  const parts: string[] = [line.slice(0, 75)]
  for (let i = 75; i < line.length; i += 74) parts.push(' ' + line.slice(i, i + 74))
  return parts.join('\r\n')
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/**
 * Write every deadline out as a calendar file. UIDs are derived from the deadline id and stay
 * stable, so re-importing into Google Calendar updates the existing event instead of duplicating it.
 */
export async function exportIcs(): Promise<string> {
  const deadlines = await getDeadlines()
  const courses = await getCourses()
  const codeOf = new Map(courses.map((c) => [c.id, c.code]))
  const now = stamp(new Date())

  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tartan//Semester//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', icsLine('X-WR-CALNAME', 'Tartan')]

  for (const d of deadlines) {
    const code = d.courseId ? codeOf.get(d.courseId) : undefined
    const summary = code ? `${code}: ${d.title}` : d.title
    lines.push('BEGIN:VEVENT')
    lines.push(icsLine('UID', `${d.id}@tartan.local`))
    lines.push(`DTSTAMP:${now}`)
    if (/^\d{4}-\d{2}-\d{2}$/.test(d.due)) {
      const compact = d.due.replace(/-/g, '')
      const next = new Date(`${d.due}T00:00:00Z`)
      next.setUTCDate(next.getUTCDate() + 1)
      lines.push(`DTSTART;VALUE=DATE:${compact}`)
      lines.push(`DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`)
    } else {
      const start = new Date(d.due)
      if (Number.isNaN(start.getTime())) {
        lines.length -= 3
        continue
      }
      lines.push(`DTSTART:${stamp(start)}`)
      lines.push(`DTEND:${stamp(new Date(start.getTime() + 30 * 60_000))}`)
    }
    lines.push(icsLine('SUMMARY', d.done ? `[done] ${summary}` : summary))
    if (d.notes) lines.push(icsLine('DESCRIPTION', d.notes))
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')

  const file = path.join(dataDir(), 'tartan.ics')
  await fs.writeFile(file, lines.join('\r\n') + '\r\n', 'utf8')
  return file
}

/**
 * The one-shot "Import a calendar feed" box. The work lives in feeds.ts, next to the subscription
 * import it must agree with: two copies of "turn a Canvas feed into rows" is how the same link came
 * to give different titles, kinds and course bindings depending on which box it was pasted into.
 */
export const importIcs = (url: string, courseId: string | null): Promise<ImportResult> => importFeedUrl(url, courseId)
