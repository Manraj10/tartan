import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseEntry, type Course, type Deadline, type RecurringRule, type Todo } from '@shared/types'

/**
 * One line of feedback at a time. A single slot rather than a stack: in a single-user semester app
 * the second message always means the first one is stale.
 */
export interface Notice {
  text: string
  kind: 'info' | 'error'
  /** Present when the action is reversible. Ctrl+Z runs it. */
  undo?: () => void
}

interface StoreValue {
  courses: Course[]
  deadlines: Deadline[]
  todos: Todo[]
  loading: boolean
  error: string | null
  /** Resolve to whether the write reached disk, so callers can skip follow-up on failure. */
  saveCourses: (next: Course[]) => Promise<boolean>
  saveDeadlines: (next: Deadline[], removed?: string[]) => Promise<boolean>
  addDeadline: (d: Omit<Deadline, 'id' | 'source'>) => Promise<boolean>
  addDeadlines: (rows: Omit<Deadline, 'id' | 'source'>[]) => Promise<boolean>
  updateDeadline: (id: string, patch: Partial<Deadline>) => Promise<boolean>
  removeDeadline: (id: string) => Promise<void>
  saveTodos: (next: Todo[]) => Promise<boolean>
  addTodo: (t: Pick<Todo, 'text' | 'courseId'> & { due?: string }) => Promise<boolean>
  updateTodo: (id: string, patch: Partial<Todo>) => Promise<void>
  removeTodo: (id: string) => Promise<void>
  courseById: (id: string | null) => Course | undefined
  refresh: () => Promise<void>
  notice: Notice | null
  announce: (text: string, opts?: { kind?: Notice['kind']; undo?: () => void }) => void
  dismissNotice: () => void
  /** Runs the pending undo, if there is one. Returns whether anything happened. */
  undoLast: () => boolean
}

/** Long enough to read and reach, short enough that the undo cannot clobber later work. */
const NOTICE_MS = 8000

const StoreContext = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [courses, setCourses] = useState<Course[]>([])
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [notice, setNotice] = useState<Notice | null>(null)
  const noticeTimer = useRef<number | null>(null)

  /**
   * Undo runs up to eight seconds after the notice appears, so it must not replay the array as it
   * stood when the notice was made: anything that landed in between — a Canvas import, or a tick
   * arriving from the phone — would be erased by undoing an unrelated delete. Rebuild from what is
   * current at the moment it is actually pressed.
   */
  const deadlinesRef = useRef<Deadline[]>([])
  const todosRef = useRef<Todo[]>([])

  const announce = useCallback((text: string, opts?: { kind?: Notice['kind']; undo?: () => void }) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    setNotice({ text, kind: opts?.kind ?? 'info', undo: opts?.undo })
    // An error stays until dismissed. Something you may need to act on must not disappear
    // while you are still reading it.
    if (opts?.kind === 'error') return
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])

  const dismissNotice = useCallback(() => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    setNotice(null)
  }, [])

  /**
   * Three separate files. One of them being malformed must not blank the other two — a stray comma
   * in todos.json used to take the whole semester with it.
   */
  const refresh = useCallback(async () => {
    if (!window.api) {
      setError('Preload bridge did not load — window.api is undefined.')
      setLoading(false)
      return
    }
    const [c, d, t] = await Promise.allSettled([
      window.api.courses.get(),
      window.api.deadlines.get(),
      window.api.todos.get(),
    ])
    const failures: string[] = []
    if (c.status === 'fulfilled') setCourses(c.value)
    else failures.push(`courses.json: ${(c.reason as Error).message}`)
    if (d.status === 'fulfilled') setDeadlines(d.value)
    else failures.push(`deadlines.json: ${(d.reason as Error).message}`)
    if (t.status === 'fulfilled') setTodos(t.value)
    else failures.push(`todos.json: ${(t.reason as Error).message}`)
    setError(failures.length ? failures.join(' · ') : null)
    setLoading(false)
  }, [])

  // Kept in step every render, so undo always reads the live arrays rather than a stale closure.
  deadlinesRef.current = deadlines
  todosRef.current = todos

  useEffect(() => {
    void refresh()
    // The files are editable outside the app, so re-read whenever we regain focus.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Main writes the same files (feed imports, recurring materialization) and says so. Without
  // this, a save made from here before the next focus would be built from a pre-write list.
  useEffect(() => window.api.onDataChanged(() => void refresh()), [refresh])

  /**
   * Every write is optimistic and every write can fail. Before this, a failed disk write threw
   * into an unhandled rejection, the row stayed ticked, and the next focus-refresh quietly put it
   * back — work appeared to undo itself with no explanation. Roll back AND say why, in one frame.
   * Never retry: a loop against a locked JSON file thrashes the folder you hand-edit.
   */
  const saveCourses = useCallback(
    async (next: Course[]) => {
      const prev = courses
      setCourses(next)
      try {
        await window.api.courses.set(next)
        return true
      } catch (err) {
        setCourses(prev)
        announce(`Could not save courses — ${(err as Error).message}`, { kind: 'error' })
        return false
      }
    },
    [courses, announce],
  )

  /**
   * `removed` names the uids the user deliberately deleted in this write, so main can tombstone
   * exactly those — and nothing else. Main must never infer deletions by diffing: a row it
   * materialized or imported moments ago is missing from this (possibly stale) array without
   * anyone having deleted it, and an inferred tombstone would make that loss permanent.
   */
  const saveDeadlines = useCallback(
    async (next: Deadline[], removed: string[] = []) => {
      const prev = deadlines
      setDeadlines(next)
      try {
        await window.api.deadlines.set(next, removed)
        return true
      } catch (err) {
        setDeadlines(prev)
        announce(`Could not save deadlines — ${(err as Error).message}`, { kind: 'error' })
        return false
      }
    },
    [deadlines, announce],
  )

  const newRow = (d: Omit<Deadline, 'id' | 'source'>, i = 0): Deadline => ({
    ...d,
    id: `m-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    source: 'manual',
  })

  const addDeadline = useCallback(
    async (d: Omit<Deadline, 'id' | 'source'>) => {
      return saveDeadlines([...deadlines, newRow(d)])
    },
    [deadlines, saveDeadlines],
  )

  /**
   * Add many at once. Looping over `addDeadline` looks equivalent and is not: every call rebuilds
   * the array from the `deadlines` captured in this render, which does not change between awaits,
   * so each write overwrites the last and only the final row survives. A syllabus of twelve dates
   * imported as one. That is why this exists and why the loop must not come back.
   */
  const addDeadlines = useCallback(
    async (rows: Omit<Deadline, 'id' | 'source'>[]) => {
      if (!rows.length) return true
      return saveDeadlines([...deadlines, ...rows.map(newRow)])
    },
    [deadlines, saveDeadlines],
  )

  const updateDeadline = useCallback(
    async (id: string, patch: Partial<Deadline>) => {
      return saveDeadlines(deadlines.map((d) => (d.id === id ? { ...d, ...patch } : d)))
    },
    [deadlines, saveDeadlines],
  )

  const removeDeadline = useCallback(
    async (id: string) => {
      const prev = deadlines
      const gone = prev.find((d) => d.id === id)
      // Undo taxes the rare mistake instead of taxing every delete with a confirm click. The
      // tombstone outlives an undo, which is fine: it only gates re-CREATION, and the undone row
      // exists again.
      if ((await saveDeadlines(prev.filter((d) => d.id !== id), gone?.uid ? [gone.uid] : [])) && gone) {
        announce(`Deleted “${gone.title}”`, {
          undo: () => void saveDeadlines([...deadlinesRef.current, gone]),
        })
      }
    },
    [deadlines, saveDeadlines, announce],
  )

  /** Same `removed` contract as saveDeadlines; a todo's id doubles as its occurrence uid. */
  const saveTodos = useCallback(
    async (next: Todo[], removed: string[] = []) => {
      const prev = todos
      setTodos(next)
      try {
        await window.api.todos.set(next, removed)
        return true
      } catch (err) {
        setTodos(prev)
        announce(`Could not save todos — ${(err as Error).message}`, { kind: 'error' })
        return false
      }
    },
    [todos, announce],
  )

  /**
   * Things done on the phone. Applied HERE, not in main, because this component is the only writer
   * of deadlines.json and todos.json — a second writer doing read-modify-write on the same file
   * overwrites whichever tick lost the race, and the ack would then tell Google to forget it.
   *
   * ONE write per file. Looping over updateDeadline would rebuild the array from this render's
   * `deadlines` each time and only the last action would survive — the same trap addDeadlines
   * exists to avoid.
   *
   * Never creates a deadline row. A tick carries only an id, so a target that is gone cannot be
   * resurrected even in principle, which is what the tombstone in dismissed.json guarantees —
   * obtained here by never inserting rather than by consulting the file.
   */
  useEffect(
    () =>
      window.api.inbox.on(async (items) => {
        if (!items.length) return
        // From DISK, not from this component's state. Main resolved the targets against disk, and
        // state can trail it — a row materialized or imported since the last focus is real and
        // tickable even though React has not heard of it. Judging by state acked such ticks away
        // as "no longer here" while the row sat unticked in the file. If the read itself fails,
        // ack nothing; everything arrives again next poll.
        let freshDeadlines: Deadline[]
        let freshTodos: Todo[]
        try {
          ;[freshDeadlines, freshTodos] = await Promise.all([window.api.deadlines.get(), window.api.todos.get()])
        } catch {
          return
        }
        const here = new Set([...freshDeadlines.map((d) => d.id), ...freshTodos.map((t) => t.id)])
        const tick = new Set(items.filter((a) => a.localId && here.has(a.localId)).map((a) => a.localId as string))
        const at = new Map(items.filter((a) => a.localId).map((a) => [a.localId as string, a.at]))
        const ignored = items.filter((a) => a.kind !== 'todo.add' && (!a.localId || !here.has(a.localId)))

        // The id is derived from the action id, so applying the same add twice hits the same row
        // and does nothing. Never dedupe by text: that would swallow a genuine second "email the
        // TA", destroying a real action to prevent a visible, deletable duplicate.
        //
        // Every add runs through the SAME parser as the desktop capture fields, with the same
        // outcomes: "every …" is a rule, a date is a deadline (which then reaches the calendar,
        // with reminders, on the next sync), anything else is a todo. The phone typing "01-101
        // pset friday 5pm" and getting an untagged todo was the one place a line meant less than
        // it said.
        const todoAdds: Todo[] = []
        const deadlineAdds: Deadline[] = []
        const deadlineAddIds = new Set<string>()
        const rules: { actionId: string; rule: RecurringRule }[] = []
        for (const a of items) {
          if (a.kind !== 'todo.add') continue
          const parsed = parseEntry(a.text ?? '', courses)
          const title = parsed.title.trim()
          if (parsed.every && title) {
            rules.push({
              actionId: a.id,
              // Deterministic from the action id, so a redelivered add upserts the same rule.
              rule: {
                id: `r-p-${a.id}`,
                text: title,
                courseId: parsed.courseId,
                kind: parsed.kind,
                days: parsed.every.days,
                ...(parsed.every.time ? { time: parsed.every.time } : {}),
              },
            })
          } else if (parsed.due && title) {
            deadlineAddIds.add(a.id)
            if (!freshDeadlines.some((d) => d.id === `p-${a.id}`)) {
              deadlineAdds.push({
                id: `p-${a.id}`,
                courseId: parsed.courseId,
                title: title,
                due: parsed.due,
                kind: parsed.kind,
                done: false,
                source: 'manual',
              })
            }
          } else if (!freshTodos.some((t) => t.id === `p-${a.id}`)) {
            todoAdds.push({
              id: `p-${a.id}`,
              text: title || (a.text ?? ''),
              courseId: parsed.courseId,
              done: false,
              // The server's stamp, taken when the phone actually acted — not when this ran.
              created: a.at,
            })
          }
        }

        const hitDeadlines = freshDeadlines.some((d) => tick.has(d.id) && !d.done)
        const hitTodos = freshTodos.some((t) => tick.has(t.id) && !t.done)

        const okD =
          !(hitDeadlines || deadlineAdds.length) ||
          (await saveDeadlines([
            ...freshDeadlines.map((d) => (tick.has(d.id) && !d.done ? { ...d, done: true } : d)),
            ...deadlineAdds,
          ]))
        const okT =
          !(hitTodos || todoAdds.length) ||
          (await saveTodos([
            ...todoAdds,
            ...freshTodos.map((t) =>
              tick.has(t.id) && !t.done ? { ...t, done: true, completedAt: at.get(t.id) } : t,
            ),
          ]))

        // Rules go through main one at a time: recurring.json has no uid-merge discipline to lean
        // on, and two interleaved upserts would lose one.
        const ruleOk = new Set<string>()
        for (const r of rules) {
          try {
            await window.api.recurring.add(r.rule)
            ruleOk.add(r.actionId)
          } catch {
            // Not acked, so it simply arrives again next poll.
          }
        }
        // The materialized occurrences were written by main; this state has not heard about them.
        if (ruleOk.size) void refresh()

        // A file that failed to write is a file whose actions are NOT acked — they arrive again on
        // the next poll. Per file, so a failed deadlines write does not throw away the todos that
        // landed. An action for a row that is gone is acked too, or it is re-served forever.
        const isRule = new Set(rules.map((r) => r.actionId))
        const ack = items
          .filter((a) =>
            a.kind === 'deadline.done'
              ? okD
              : isRule.has(a.id)
                ? ruleOk.has(a.id)
                : deadlineAddIds.has(a.id)
                  ? okD
                  : okT,
          )
          .map((a) => a.id)
        if (ack.length) await window.api.inbox.applied(ack)

        // Never silently. And deliberately no undo button: the one thing undo would do here is
        // un-tick, which is the failure this whole design exists to prevent.
        const applied = items.length - ignored.length
        announce(
          [
            applied ? `${applied} from your phone` : '',
            ignored.length ? `${ignored.length} ignored — no longer here` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )
      }),
    [courses, saveDeadlines, saveTodos, announce, refresh],
  )

  /** New todos go on top: the thing you just thought of is the thing you are still holding. */
  const addTodo = useCallback(
    async (t: Pick<Todo, 'text' | 'courseId'> & { due?: string }) => {
      const todo: Todo = {
        id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text: t.text,
        courseId: t.courseId,
        done: false,
        created: new Date().toISOString(),
        ...(t.due ? { due: t.due } : {}),
      }
      return saveTodos([todo, ...todos])
    },
    [todos, saveTodos],
  )

  const updateTodo = useCallback(
    async (id: string, patch: Partial<Todo>) => {
      await saveTodos(todos.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    },
    [todos, saveTodos],
  )

  const removeTodo = useCallback(
    async (id: string) => {
      const prev = todos
      const gone = prev.find((t) => t.id === id)
      // Order is meaningful for todos, so put it back where it was rather than on the end.
      const where = prev.findIndex((t) => t.id === id)
      if ((await saveTodos(prev.filter((t) => t.id !== id), [id])) && gone) {
        announce(`Deleted “${gone.text}”`, {
          undo: () => {
            const next = [...todosRef.current]
            next.splice(Math.min(where, next.length), 0, gone)
            void saveTodos(next)
          },
        })
      }
    },
    [todos, saveTodos, announce],
  )

  const undoLast = useCallback((): boolean => {
    if (!notice?.undo) return false
    notice.undo()
    dismissNotice()
    return true
  }, [notice, dismissNotice])

  const courseById = useCallback((id: string | null) => courses.find((c) => c.id === id), [courses])

  const value = useMemo(
    () => ({
      courses,
      deadlines,
      todos,
      loading,
      error,
      saveCourses,
      saveDeadlines,
      addDeadline,
      addDeadlines,
      updateDeadline,
      removeDeadline,
      saveTodos,
      addTodo,
      updateTodo,
      removeTodo,
      courseById,
      refresh,
      notice,
      announce,
      dismissNotice,
      undoLast,
    }),
    [courses, deadlines, todos, loading, error, saveCourses, saveDeadlines, addDeadline, addDeadlines, updateDeadline, removeDeadline, saveTodos, addTodo, updateTodo, removeTodo, courseById, refresh, notice, announce, dismissNotice, undoLast],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside StoreProvider')
  return ctx
}

/** Local date helpers. Deadlines are either YYYY-MM-DD (all-day) or a full ISO timestamp. */
export const isAllDay = (due: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(due)

export function dueDate(due: string): Date {
  if (isAllDay(due)) {
    const [y, m, d] = due.split('-').map(Number)
    return new Date(y, m - 1, d, 23, 59, 59)
  }
  return new Date(due)
}

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

export function daysUntil(due: string): number {
  const today = startOfDay(new Date()).getTime()
  const target = startOfDay(dueDate(due)).getTime()
  return Math.round((target - today) / 86_400_000)
}

export function formatDue(due: string): string {
  const d = dueDate(due)
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  if (isAllDay(due)) return date
  return `${date}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

export function relativeDue(due: string): string {
  const n = daysUntil(due)
  // A hand-edited due the app cannot read prints as written, not "in NaN week" or "9126 days ago"
  // (Date happily parses "0" as the year 2000, so the shape is checked too).
  if (!/^\d{4}-\d{2}-\d{2}/.test(due) || Number.isNaN(n)) return due
  if (n < 0) return n === -1 ? 'yesterday' : `${Math.abs(n)} days ago`
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n < 14) return `in ${n} days`
  return `in ${Math.floor(n / 7)} weeks`
}

/** Just the clock — "9:00 pm" — or '' for an all-day date. "today" alone hides a 9am cutoff. */
export function dueTime(due: string): string {
  if (isAllDay(due)) return ''
  return dueDate(due).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
