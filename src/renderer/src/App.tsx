import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { useStore, daysUntil, relativeDue, dueDate } from './store'
import { localDay } from '@shared/day-plan'
import Today from './views/Today'
import CalendarView from './views/CalendarView'
import Notes from './views/Notes'
import CourseWorkspace from './views/CourseWorkspace'
import Settings from './views/Settings'
import Schedule from './views/Schedule'
import Grind from './views/Grind'
import Shortcuts from './components/Shortcuts'
import ErrorBoundary from './ErrorBoundary'
import CommandPalette, { type Command } from './components/CommandPalette'
import SyllabusImport from './components/SyllabusImport'
import type { DeadlineKind } from '@shared/types'

type Route =
  | { kind: 'today' }
  /** `at` is a YYYY-MM-DD to open on, so a palette jump lands on the right month. */
  | { kind: 'calendar'; at?: string }
  | { kind: 'schedule' }
  | { kind: 'grind' }
  /** `note` opens a specific file — the palette needs to reach individual notes. */
  | { kind: 'notes'; note?: string }
  | { kind: 'settings' }
  | { kind: 'course'; id: string }

/** Chrome state lives in localStorage — it is not your data and does not belong in the folder. */
const COLLAPSED_KEY = 'tartan.collapsed'
const RECENT_KEY = 'tartan.recent'

function loadStrings(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

const loadCollapsed = (): string[] => loadStrings(COLLAPSED_KEY)
const loadRecent = (): string[] => loadStrings(RECENT_KEY)

export default function App() {
  const { courses, deadlines, loading, error, addDeadlines, refresh, notice, undoLast, dismissNotice, announce } =
    useStore()
  const [route, setRouteRaw] = useState<Route>({ kind: 'today' })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [syllabusOpen, setSyllabusOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsed)
  const [railHidden, setRailHidden] = useState(false)
  const [noteIdx, setNoteIdx] = useState<{ path: string; title: string; courseId: string | null; docUrl?: string }[]>([])
  const [recent, setRecent] = useState<string[]>(loadRecent)

  /**
   * A visit stack, so "jump somewhere, come back" is two keystrokes. Navigating from anywhere but
   * the back/forward keys truncates the forward branch, exactly like a browser.
   */
  const history = useRef<Route[]>([{ kind: 'today' }])
  const cursor = useRef(0)

  const go = useCallback((next: Route) => {
    history.current = [...history.current.slice(0, cursor.current + 1), next]
    cursor.current = history.current.length - 1
    setRouteRaw(next)
  }, [])

  const step = useCallback((delta: number) => {
    const target = cursor.current + delta
    if (target < 0 || target >= history.current.length) return
    cursor.current = target
    setRouteRaw(history.current[target])
  }, [])

  /** The palette's index is only needed once it is open, and must be fresh when it is. */
  useEffect(() => {
    if (!paletteOpen) return
    // The index has no URLs; the list does. A Google Doc has no markdown to open in the editor, so
    // the palette needs its address to send it to the browser the way the Notes list does.
    void Promise.all([window.api.notes.index(), window.api.notes.list()])
      .then(([idx, list]) => {
        const docs = new Map(list.map((n) => [n.path, n.docUrl]))
        setNoteIdx(idx.map((n) => ({ path: n.path, title: n.title, courseId: n.courseId, docUrl: docs.get(n.path) })))
      })
      .catch(() => setNoteIdx([]))
  }, [paletteOpen])

  const remember = useCallback((id: string) => {
    setRecent((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 5)
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        // Not worth an error.
      }
      return next
    })
  }, [])

  const isOpen = useCallback((id: string) => !collapsed.includes(id), [collapsed])
  const toggleGroup = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
      } catch {
        // A remembered collapse is not worth an error.
      }
      return next
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      // Undo must never fire inside the editor — it would eat native text undo and destroy writing.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        if (undoLast()) e.preventDefault()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault()
        setRailHidden((v) => !v)
      }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        step(e.key === 'ArrowLeft' ? -1 : 1)
      }
      // '?' is Shift+/ — never steal it mid-sentence.
      if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        setHelpOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoLast, step])

  // Ctrl+Shift+Q reaches whatever view is showing, but only an open note can take the quote (Notes
  // listens for it itself). Anywhere else it used to vanish without a word.
  useEffect(
    () =>
      window.api.onQuote(() => {
        if (!document.querySelector('#note-editor, .note-item.active')) announce('Open a note to paste the quote into')
      }),
    [announce],
  )

  const openCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of deadlines) {
      if (d.done || !d.courseId) continue
      // 7 days, not 14: during a normal semester week a 14-day window badges every course
      // at once and the numbers become wallpaper.
      const n = daysUntil(d.due)
      if (n < 0 || n > 7) continue
      counts.set(d.courseId, (counts.get(d.courseId) ?? 0) + 1)
    }
    return counts
  }, [deadlines])

  // The confirmation used to render inside the sidebar's flex column, so a successful export
  // grew the nav and shoved every row down for six seconds. Success must not move the UI.
  const exportIcs = useCallback(async () => {
    try {
      await window.api.ics.export()
      announce('Wrote tartan.ics to your data folder.')
    } catch (err) {
      announce(`Could not write tartan.ics — ${(err as Error).message}`, { kind: 'error' })
    }
  }, [announce])

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'go-today', group: 'Go to', label: 'Today', run: () => go({ kind: 'today' }) },
      { id: 'go-calendar', group: 'Go to', label: 'Calendar', run: () => go({ kind: 'calendar' }) },
      { id: 'go-schedule', group: 'Go to', label: 'Schedule', run: () => go({ kind: 'schedule' }) },
      { id: 'go-notes', group: 'Go to', label: 'All notes', run: () => go({ kind: 'notes' }) },
      { id: 'go-grind', group: 'Go to', label: 'LeetCode', hint: 'the whole ladder', run: () => go({ kind: 'grind' }) },
      // Todos are a section of Today now, not a view. The old name still has to find them.
      { id: 'go-todos', group: 'Go to', label: 'Todos', hint: 'on Today', run: () => go({ kind: 'today' }) },
      { id: 'go-settings', group: 'Go to', label: 'Settings', run: () => go({ kind: 'settings' }) },
    ]
    const courseCmds: Command[] = courses.map((c) => ({
      id: `go-${c.id}`,
      group: 'Spaces',
      label: `${c.code} — ${c.title}`,
      hint: openCount.get(c.id) ? `${openCount.get(c.id)} due` : undefined,
      run: () => go({ kind: 'course', id: c.id }),
    }))
    const actions: Command[] = [
      { id: 'import-syllabus', group: 'Actions', label: 'Import deadlines from a syllabus', run: () => setSyllabusOpen(true) },
      { id: 'export-ics', group: 'Actions', label: 'Export deadlines to a calendar file', hint: 'tartan.ics', run: () => void exportIcs() },
      { id: 'open-data', group: 'Actions', label: 'Open the data folder', run: () => void window.api.app.openDataDir() },
      { id: 'toggle-rail', group: 'Actions', label: railHidden ? 'Show the sidebar' : 'Hide the sidebar', hint: 'Ctrl \\', run: () => setRailHidden((v) => !v) },
      { id: 'help', group: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: () => setHelpOpen(true) },
    ]

    // The sidebar no longer grows with the semester, so the palette has to reach the content.
    const noteCmds: Command[] = noteIdx.map((n) => ({
      id: `note-${n.path}`,
      group: 'Notes',
      label: n.title,
      hint: n.courseId ?? undefined,
      run: () => (n.docUrl ? void window.api.app.openExternal(n.docUrl) : go({ kind: 'notes', note: n.path })),
    }))

    const deadlineCmds: Command[] = deadlines
      .filter((d) => !d.done)
      .map((d) => ({
        id: `deadline-${d.id}`,
        group: 'Deadlines',
        label: d.title,
        hint: relativeDue(d.due),
        run: () => go({ kind: 'calendar', at: localDay(dueDate(d.due)) }),
      }))

    const all = [...nav, ...courseCmds, ...actions, ...noteCmds, ...deadlineCmds]

    // An empty palette showing all thirty commands is a dump. Showing where you just were is not.
    const byId = new Map(all.map((c) => [c.id, c]))
    const recentCmds: Command[] = recent
      .map((id) => byId.get(id))
      .filter((c): c is Command => c !== undefined)
      .map((c) => ({ ...c, id: `recent-${c.id}`, group: 'Recent' }))

    return [...recentCmds, ...all].map((c) => ({
      ...c,
      run: () => {
        remember(c.id.replace(/^recent-/, ''))
        c.run()
      },
    }))
  }, [courses, openCount, exportIcs, noteIdx, deadlines, recent, go, remember, railHidden])

  const importSyllabus = useCallback(
    async (rows: { title: string; due: string; kind: DeadlineKind; courseId: string | null }[]) => {
      // One write, not one per row. See addDeadlines — the loop that used to be here imported
      // exactly one deadline no matter how many dates the syllabus held.
      const ok = await addDeadlines(rows.map((r) => ({ ...r, done: false })))
      await refresh()
      // False means the write failed and the store has already said so; the dialog must not say "Imported".
      return ok
    },
    [addDeadlines, refresh],
  )

  const active = route.kind === 'course' ? courses.find((c) => c.id === route.id) : undefined

  return (
    <div className={`shell${railHidden ? ' rail-hidden' : ''}`}>
      <nav className="sidebar" aria-label="Main navigation">

        {/* Today sits outside every group: nothing is ever filed into it, it is purely computed. */}
        <button className={navClass(route.kind === 'today')} aria-current={route.kind === 'today' ? 'page' : undefined} onClick={() => go({ kind: 'today' })}>
          <NavIcon name="today" />Today
          {(() => {
            const debt = deadlines.filter((d) => !d.done && dueDate(d.due).getTime() < Date.now()).length
            return debt > 0 ? <span className="count debt">{debt}</span> : null
          })()}
        </button>

        {/* Three destinations do not need to be filed under headings. */}
        <button className={navClass(route.kind === 'calendar')} aria-current={route.kind === 'calendar' ? 'page' : undefined} onClick={() => go({ kind: 'calendar' })}>
          <NavIcon name="calendar" />Calendar
        </button>
        <button className={navClass(route.kind === 'schedule')} aria-current={route.kind === 'schedule' ? 'page' : undefined} onClick={() => go({ kind: 'schedule' })}>
          <NavIcon name="schedule" />Schedule
        </button>
        <button className={navClass(route.kind === 'grind')} aria-current={route.kind === 'grind' ? 'page' : undefined} onClick={() => go({ kind: 'grind' })}>
          <NavIcon name="code" />LeetCode
        </button>
        <button className={navClass(route.kind === 'notes')} aria-current={route.kind === 'notes' ? 'page' : undefined} onClick={() => go({ kind: 'notes' })}>
          <NavIcon name="notes" />All notes
        </button>

        <NavGroup id="courses" label="Spaces" open={isOpen('courses')} onToggle={toggleGroup}>
          {courses.map((c) => (
            <button
              key={c.id}
              className={navClass(route.kind === 'course' && route.id === c.id)}
              aria-current={route.kind === 'course' && route.id === c.id ? 'page' : undefined}
              onClick={() => go({ kind: 'course', id: c.id })}
              title={c.title}
            >
              <span className="dot" style={{ '--cc': c.color } as CSSProperties} />
              <span className="space-name"><span>{c.code}</span><small>{c.title}</small></span>
              {openCount.get(c.id) ? <span className="count">{openCount.get(c.id)}</span> : null}
            </button>
          ))}
          {!courses.length && !loading ? (
            <button className="nav-item" onClick={() => go({ kind: 'settings' })}>
              No spaces yet: add one
            </button>
          ) : null}
        </NavGroup>

        <div style={{ flex: 1 }} />

        {/* Search is the entrance to everything the sidebar no longer lists. */}
        <button className="nav-item" onClick={() => setPaletteOpen(true)}>
          <NavIcon name="search" />Search
          <span className="count">Ctrl K</span>
        </button>
        <button className={navClass(route.kind === 'settings')} aria-current={route.kind === 'settings' ? 'page' : undefined} onClick={() => go({ kind: 'settings' })}>
          <NavIcon name="settings" />Settings
        </button>
      </nav>

      <main className="main">
        {/*
          A failed read is a strip, not a takeover. One malformed file used to throw away the
          calendar, schedule and notes that loaded perfectly well.
        */}
        {error ? (
          <div className="banner" role="alert">
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>Could not read part of your data.</strong>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', marginTop: 2, wordBreak: 'break-word' }}>
                {error}
              </div>
            </div>
            <button className="btn sm" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        ) : null}
        <ErrorBoundary where={route.kind}>
        {loading ? (
          // Three local JSON reads take single-digit milliseconds. The CSS delay means this
          // never paints unless something is genuinely wrong, so alt-tabbing cannot flash it.
          <div className="empty deferred">Loading…</div>
        ) : route.kind === 'today' ? (
          <Today
            onOpenCourse={(id) => go({ kind: 'course', id })}
            onOpenNote={(note) => go({ kind: 'notes', note })}
            onOpenCalendar={() => go({ kind: 'calendar', at: localDay(new Date()) })}
          />
        ) : route.kind === 'calendar' ? (
          <CalendarView onImportSyllabus={() => setSyllabusOpen(true)} initialMonth={route.at} />
        ) : route.kind === 'schedule' ? (
          <Schedule />
        ) : route.kind === 'grind' ? (
          <Grind />
        ) : route.kind === 'notes' ? (
          <Notes courseId={null} openNote={route.note} />
        ) : route.kind === 'settings' ? (
          <Settings />
        ) : active ? (
          <CourseWorkspace key={active.id} course={active} />
        ) : (
          <div className="empty">That course no longer exists.</div>
        )}
        </ErrorBoundary>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <Shortcuts open={helpOpen} onClose={() => setHelpOpen(false)} />
      {syllabusOpen ? (
        <SyllabusImport courses={courses} onImport={importSyllabus} onClose={() => setSyllabusOpen(false)} />
      ) : null}

      {/*
        Mounted permanently and empty at startup. Injecting a live region and its text in the same
        tick is the classic reason screen readers never announce a toast.
      */}
      <div className="status" role="status" aria-live="polite">
        {notice ? (
          <div className={`status-pill${notice.kind === 'error' ? ' error' : ''}`}>
            <span style={{ flex: 1, minWidth: 0 }}>{notice.text}</span>
            {notice.undo ? (
              <button className="btn ghost sm" onClick={undoLast}>
                Undo <kbd>Ctrl Z</kbd>
              </button>
            ) : null}
            <button className="btn ghost sm" aria-label="Dismiss" onClick={dismissNotice}>
              ×
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const navClass = (isActive: boolean): string => `nav-item${isActive ? ' active' : ''}`

function NavIcon({ name }: { name: 'today' | 'calendar' | 'schedule' | 'code' | 'notes' | 'search' | 'settings' }) {
  const paths = {
    today: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    calendar: 'M7 3v4m10-4v4M4 10h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1M8 14h2m4 0h2m-8 3h2',
    schedule: 'M8 4h12v4H8zM8 12h8v4H8zM4 3v18m4-1h12',
    code: 'm8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16',
    notes: 'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8m-8 4h6',
    search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  }
  return <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

/**
 * A labelled, collapsible run of nav rows. The wrapper animates on grid-template-rows so the
 * open height never has to be measured — pure CSS, no ResizeObserver, no dependency.
 */
function NavGroup({
  id,
  label,
  open,
  onToggle,
  children,
}: {
  id: string
  label: string
  open: boolean
  onToggle: (id: string) => void
  children: ReactNode
}) {
  return (
    <div className="nav-group">
      <button
        className="sidebar-label"
        aria-expanded={open}
        aria-controls={`group-${id}`}
        onClick={() => onToggle(id)}
      >
        {label}
      </button>
      <div className="nav-group-body" id={`group-${id}`}>
        {open ? <div>{children}</div> : null}
      </div>
    </div>
  )
}
