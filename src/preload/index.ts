import { contextBridge, ipcRenderer } from 'electron'
import type { CatalogCourse } from '../main/catalog'
import type { LeetcodeState } from '../shared/leetcode'
import type { GradesState } from '../shared/grades'
import type {
  Course,
  Deadline,
  ImportResult,
  InboxItem,
  NoteMeta,
  FeedEvent,
  FeedStatus,
  RecurringRule,
  Subscription,
  SyncConfigPatch,
  SyncStatus,
  Todo,
} from '../shared/types'

export interface NoteIndexEntry {
  path: string
  courseId: string | null
  title: string
  props: Record<string, string>
  links: string[]
  tags: string[]
  updated: string
}

export interface NoteVersion {
  stamp: string
  iso: string
  bytes: number
}

export interface SearchHit {
  path: string
  courseId: string | null
  title: string
  score: number
  snippet: string
}

const api = {
  courses: {
    get: (): Promise<Course[]> => ipcRenderer.invoke('courses:get'),
    set: (courses: Course[]): Promise<void> => ipcRenderer.invoke('courses:set', courses),
    /** Moves the notes folder and re-points deadlines. Rejects on a name clash. */
    rename: (oldId: string, newId: string): Promise<void> => ipcRenderer.invoke('courses:rename', oldId, newId),
  },
  deadlines: {
    get: (): Promise<Deadline[]> => ipcRenderer.invoke('deadlines:get'),
    /** `removed`: uids the user deliberately deleted in this write — they tombstone so no re-import resurrects them. */
    set: (deadlines: Deadline[], removed: string[] = []): Promise<void> =>
      ipcRenderer.invoke('deadlines:set', deadlines, removed),
  },
  /** CMU's course catalog: turn a course number into a title and a unit count. */
  catalog: {
    lookup: (codes: string[]): Promise<{ courses: CatalogCourse[]; error: string | null }> =>
      ipcRenderer.invoke('catalog:lookup', codes),
  },
  /**
   * Subscribed calendars — CMU's academic calendar, a Canvas feed, a club's .ics. Read-only:
   * Tartan fetches, caches and shows them, and never writes back.
   */
  feeds: {
    list: (): Promise<Subscription[]> => ipcRenderer.invoke('feeds:list'),
    save: (subs: Subscription[]): Promise<FeedStatus[]> => ipcRenderer.invoke('feeds:save', subs),
    /** Omit the id to refresh every enabled feed. */
    refresh: (id?: string): Promise<FeedStatus[]> => ipcRenderer.invoke('feeds:refresh', id),
    status: (): Promise<FeedStatus[]> => ipcRenderer.invoke('feeds:status'),
    events: (): Promise<FeedEvent[]> => ipcRenderer.invoke('feeds:events'),
  },
  /** The ongoing list. Order is the array's order. */
  todos: {
    get: (): Promise<Todo[]> => ipcRenderer.invoke('todos:get'),
    /** `removed`: ids the user deliberately deleted — only rec- ids matter, main filters the rest. */
    set: (todos: Todo[], removed: string[] = []): Promise<void> => ipcRenderer.invoke('todos:set', todos, removed),
  },
  /** Recurring rules — "gym every mon wed". Rules live in recurring.json; occurrences are rows. */
  recurring: {
    list: (): Promise<RecurringRule[]> => ipcRenderer.invoke('recurring:list'),
    /** Upserts by id and materializes occurrences before replying. Returns the full list. */
    add: (rule: RecurringRule): Promise<RecurringRule[]> => ipcRenderer.invoke('recurring:add', rule),
    /** Also removes the rule's future unticked occurrences. */
    remove: (id: string): Promise<RecurringRule[]> => ipcRenderer.invoke('recurring:remove', id),
  },
  /** Daily problem ladder progress: slug -> the day it was solved. */
  leetcode: {
    get: (): Promise<LeetcodeState> => ipcRenderer.invoke('leetcode:get'),
    set: (s: LeetcodeState): Promise<void> => ipcRenderer.invoke('leetcode:set', s),
  },
  /** Per-space grading schemes and scores, keyed by course id. */
  grades: {
    get: (): Promise<GradesState> => ipcRenderer.invoke('grades:get'),
    set: (g: GradesState): Promise<void> => ipcRenderer.invoke('grades:set', g),
  },
  notes: {
    list: (): Promise<NoteMeta[]> => ipcRenderer.invoke('notes:list'),
    /** Ranked full-text search across every note. Title matches outrank body matches. */
    search: (q: string): Promise<SearchHit[]> => ipcRenderer.invoke('notes:search', q),
    /** Every note with its frontmatter properties, [[links]] and #tags. */
    index: (): Promise<NoteIndexEntry[]> => ipcRenderer.invoke('notes:index'),
    /** Each hit carries the line it appears on and the nearest heading above it. */
    backlinks: (title: string): Promise<(NoteIndexEntry & { line: string; heading: string; offset: number })[]> =>
      ipcRenderer.invoke('notes:backlinks', title),
    versions: (rel: string): Promise<NoteVersion[]> => ipcRenderer.invoke('notes:versions', rel),
    version: (rel: string, stamp: string): Promise<string> => ipcRenderer.invoke('notes:version', rel, stamp),
    read: (rel: string): Promise<string> => ipcRenderer.invoke('notes:read', rel),
    /** `force` snapshots what this write replaces even inside the five-minute history window (restore). */
    write: (rel: string, content: string, force?: boolean): Promise<void> =>
      ipcRenderer.invoke('notes:write', rel, content, force),
    /** Deterministic markdown formatter. No model, no network — it cannot invent content. */
    tidy: (text: string): Promise<string> => ipcRenderer.invoke('notes:tidy', text),
    remove: (rel: string): Promise<void> => ipcRenderer.invoke('notes:delete', rel),
    /** Renames the file, moves its history, and rewrites [[links]] elsewhere. Returns the new path. */
    rename: (rel: string, title: string): Promise<string> => ipcRenderer.invoke('notes:rename', rel, title),
  },
  files: {
    /** Saves pasted bytes into a course folder. Returns the path relative to files/. */
    writeBytes: (courseId: string, name: string, bytes: Uint8Array): Promise<{ rel: string }> =>
      ipcRenderer.invoke('files:writeBytes', courseId, name, bytes),
  },
  ics: {
    import: (url: string, courseId: string | null): Promise<ImportResult> =>
      ipcRenderer.invoke('ics:import', url, courseId),
    /** Writes Semester/tartan.ics and returns its path. */
    export: (): Promise<string> => ipcRenderer.invoke('ics:export'),
  },
  /**
   * Google Calendar. Google is the thing that stays awake, so it holds the reminders; Tartan
   * only pushes when the semester actually changed.
   */
  sync: {
    status: (): Promise<SyncStatus> => ipcRenderer.invoke('sync:status'),
    config: (patch: SyncConfigPatch): Promise<SyncStatus> => ipcRenderer.invoke('sync:config', patch),
    now: (): Promise<SyncStatus> => ipcRenderer.invoke('sync:now'),
    /** Re-sends everything, for when the calendar has been edited behind Tartan's back. */
    all: (): Promise<SyncStatus> => ipcRenderer.invoke('sync:all'),
  },
  /** Fires when Ctrl+Shift+Q is pressed with text on the clipboard. */
  onQuote: (cb: (text: string) => void): (() => void) => {
    const h = (_e: unknown, t: string) => cb(t)
    ipcRenderer.on('quote', h)
    return () => ipcRenderer.removeListener('quote', h)
  },
  /** Main wrote a data file (feed import, recurring materialization) — re-read before writing. */
  onDataChanged: (cb: () => void): (() => void) => {
    const h = () => cb()
    ipcRenderer.on('data-changed', h)
    return () => ipcRenderer.removeListener('data-changed', h)
  },
  /**
   * Things ticked off on the phone. Main resolves each one to a local id and hands them over; the
   * window applies them, because it is the only writer deadlines.json and todos.json have.
   */
  inbox: {
    on: (cb: (items: InboxItem[]) => void): (() => void) => {
      const h = (_e: unknown, items: InboxItem[]) => cb(items)
      ipcRenderer.on('inbox', h)
      return () => ipcRenderer.removeListener('inbox', h)
    },
    /** Report back only what actually reached disk. Anything omitted simply arrives again. */
    applied: (ids: string[]): Promise<void> => ipcRenderer.invoke('inbox:applied', ids),
  },
  capture: {
    save: (text: string): Promise<void> => ipcRenderer.invoke('capture:save', text),
    close: (): Promise<void> => ipcRenderer.invoke('capture:close'),
  },
  app: {
    dataDir: (): Promise<string> => ipcRenderer.invoke('app:dataDir'),
    openDataDir: (): Promise<string> => ipcRenderer.invoke('app:openDataDir'),
    /** Opens a folder picker; returns the data dir in use (unchanged if cancelled). */
    chooseDataDir: (): Promise<string> => ipcRenderer.invoke('app:chooseDataDir'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
