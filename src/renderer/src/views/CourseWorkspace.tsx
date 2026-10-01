import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { KIND_LABELS, type Course, type CourseLink, type Deadline, type DeadlineKind, type NoteMeta } from '@shared/types'
import { daysUntil, dueDate, formatDue, relativeDue, useStore } from '../store'
import Notes from './Notes'
import GradesPanel from '../components/GradesPanel'

type Tab =
  | { kind: 'notes' }
  | { kind: 'deadlines' }
  | { kind: 'grades' }
  | { kind: 'add' }
  | { kind: 'link'; id: string }
  | { kind: 'doc'; path: string }

/**
 * One shared browser profile for every embedded Google Doc. `persist:` makes it a real profile on
 * disk under userData/Partitions, so signing in to Google once survives quitting the app — the same
 * way a browser tab does. Sharing one partition across all courses means one sign-in, not one per course.
 */
const GOOGLE_PARTITION = 'persist:google'

const KINDS: DeadlineKind[] = ['pset', 'exam', 'quiz', 'reading', 'admin', 'other']

const tabClass = (active: boolean): string => `tab${active ? ' active' : ''}`

/**
 * A tiny progress ring, the Things 3 pie: no percentage label, just the arc filling in the
 * course's own colour as the semester's work gets done. Ambient, not a metric to chase.
 */
function ProgressRing({ done, total, color }: { done: number; total: number; color: string }) {
  const R = 7
  const C = 2 * Math.PI * R
  const frac = total > 0 ? done / total : 0
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 18 18"
      role="img"
      aria-label={`${done} of ${total} done`}
    >
      <title>{`${done} of ${total} done`}</title>
      <circle cx={9} cy={9} r={R} fill="none" stroke="var(--border-strong)" strokeWidth={2.5} />
      <circle
        cx={9}
        cy={9}
        r={R}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - frac)}
        transform="rotate(-90 9 9)"
        style={{ transition: 'stroke-dashoffset 300ms ease' }}
      />
    </svg>
  )
}

export default function CourseWorkspace({ course }: { course: Course }) {
  const { courses, saveCourses, deadlines } = useStore()
  const [tab, setTab] = useState<Tab>({ kind: 'notes' })
  const [opened, setOpened] = useState<string[]>([])
  const [confirmLink, setConfirmLink] = useState<string | null>(null)

  const openLink = (id: string) => {
    setOpened((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setTab({ kind: 'link', id })
  }

  /**
   * This course's Google Docs, from the `.gdoc` stubs Drive leaves in notes/<course>/. The tab
   * appears only when there is something behind it — an empty tab is the thing this app was just
   * cut in half for.
   */
  const [docs, setDocs] = useState<NoteMeta[]>([])
  const [openedDocs, setOpenedDocs] = useState<string[]>([])

  useEffect(() => {
    const load = (): void => {
      void window.api.notes
        .list()
        .then((list) => setDocs(list.filter((n) => n.courseId === course.id && n.docUrl)))
        .catch(() => setDocs([]))
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [course.id])

  const openDoc = useCallback((path: string) => {
    setOpenedDocs((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setTab({ kind: 'doc', path })
  }, [])

  const activeLink = tab.kind === 'link' ? course.links.find((l) => l.id === tab.id) : undefined
  const activeDoc = tab.kind === 'doc' ? docs.find((d) => d.path === tab.path) : undefined
  /** Whatever the "Open in browser" button should act on — a link tab or a Doc tab. */
  const externalUrl = activeLink?.url ?? activeDoc?.docUrl

  const removeActiveLink = async (id: string) => {
    if (confirmLink !== id) {
      setConfirmLink(id)
      return
    }
    setConfirmLink(null)
    setTab({ kind: 'notes' })
    await saveCourses(courses.map((c) => (c.id === course.id ? { ...c, links: c.links.filter((l) => l.id !== id) } : c)))
  }

  // --cc-mark was removed from the palette; painting it left an invisible 9px spacer indenting
  // the h1. The nav-dot recipe (lightness-pinned course colour via --cc) is the real thing.
  const dot: CSSProperties = { width: 9, height: 9, borderRadius: '50%', flex: 'none', ['--cc' as string]: course.color }

  return (
    <>
      <div className="topbar">
        <span aria-hidden="true" className="course-dot" style={dot} />
        <h1>{course.code}</h1>
        <span className="muted">{course.title}</span>
        {(() => {
          const mine = deadlines.filter((d) => d.courseId === course.id)
          const done = mine.filter((d) => d.done).length
          return mine.length > 0 ? (
            <span className="row" style={{ gap: 6, alignItems: 'center' }} title={`${done} of ${mine.length} done`}>
              <ProgressRing done={done} total={mine.length} color={course.color} />
              <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
                {done}/{mine.length}
              </span>
            </span>
          ) : null
        })()}
        <div className="spacer" />
        {activeLink ? (
          <button
            className="btn ghost sm"
            onClick={() => void removeActiveLink(activeLink.id)}
            onBlur={() => setConfirmLink(null)}
          >
            {confirmLink === activeLink.id ? 'Sure?' : 'Remove this tab'}
          </button>
        ) : null}
        <button
          className="btn ghost"
          disabled={!externalUrl}
          onClick={() => {
            if (externalUrl) void window.api.app.openExternal(externalUrl)
          }}
        >
          Open in browser
        </button>
      </div>

      <div className="tabbar">
        <button className={tabClass(tab.kind === 'notes')} onClick={() => setTab({ kind: 'notes' })}>
          Notes
        </button>
        <button className={tabClass(tab.kind === 'deadlines')} onClick={() => setTab({ kind: 'deadlines' })}>
          Deadlines
        </button>
        <button className={tabClass(tab.kind === 'grades')} onClick={() => setTab({ kind: 'grades' })}>
          Grades
        </button>
        {docs.length ? (
          <button
            className={tabClass(tab.kind === 'doc')}
            title={docs.length === 1 ? docs[0].title : `${docs.length} Google Docs in this course`}
            onClick={() => openDoc(tab.kind === 'doc' ? tab.path : docs[0].path)}
          >
            Docs{docs.length > 1 ? ` ${docs.length}` : ''}
          </button>
        ) : null}
        {course.links.map((l) => (
          <button key={l.id} className={tabClass(tab.kind === 'link' && tab.id === l.id)} onClick={() => openLink(l.id)}>
            {l.label}
          </button>
        ))}
        <button
          className={tabClass(tab.kind === 'add')}
          onClick={() => setTab({ kind: 'add' })}
          aria-label="Add a link tab"
          title="Add a link tab"
        >
          +
        </button>
      </div>

      <div className="content flush" style={{ position: 'relative' }}>
        {tab.kind === 'notes' ? <Notes courseId={course.id} /> : null}
        {tab.kind === 'deadlines' ? <DeadlinesPanel course={course} /> : null}
        {tab.kind === 'grades' ? <GradesPanel course={course} /> : null}
        {tab.kind === 'add' ? <AddLinkPanel course={course} onAdded={openLink} /> : null}
        {course.links
          .filter((l) => opened.includes(l.id))
          .map((l) => (
            <LinkPane key={l.id} link={l} visible={tab.kind === 'link' && tab.id === l.id} />
          ))}
        {/* More than one Doc in a course needs a way to choose; one does not. */}
        {tab.kind === 'doc' && docs.length > 1 ? (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 2,
              display: 'flex',
              gap: 4,
              flexWrap: 'wrap',
              padding: '6px 10px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg)',
            }}
          >
            {docs.map((d) => (
              <button
                key={d.path}
                className={`btn sm${tab.path === d.path ? ' primary' : ' ghost'}`}
                onClick={() => openDoc(d.path)}
              >
                {d.title}
              </button>
            ))}
          </div>
        ) : null}
        {docs
          .filter((d) => openedDocs.includes(d.path))
          .map((d) => (
            <DocPane
              key={d.path}
              doc={d}
              visible={tab.kind === 'doc' && tab.path === d.path}
              inset={docs.length > 1 ? 38 : 0}
            />
          ))}
      </div>
    </>
  )
}

/**
 * Load state of one <webview>. A failed load (bad host, offline) still fires dom-ready — on
 * Chromium's own error page, which a guest this plain renders as a blank white pane — so the
 * loading bar vanished and nothing said the page never came. Retry remounts the webview (the
 * `attempt` key), because reloading a failed entry is not something every Chromium version does.
 * It remounts on the address that failed (`retryUrl`), not the tab's home, so a page the user had
 * clicked through to is not thrown away; and a later load that succeeds lifts the overlay by itself.
 */
function useGuest() {
  const ref = useRef<HTMLElement>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState('')
  const [failedUrl, setFailedUrl] = useState('')
  const [retryUrl, setRetryUrl] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // True from the start of a main-frame navigation until it fails. Chromium's error page may
    // also report a finished load, so only a navigation that did not fail may lift the overlay.
    let clean = false
    const onReady = () => setReady(true)
    const onStart = (e: Event) => {
      const n = e as Event & { isMainFrame: boolean; isInPlace: boolean }
      if (n.isMainFrame && !n.isInPlace) clean = true
    }
    const onFail = (e: Event) => {
      const f = e as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean; validatedURL: string }
      // -3 is a load superseded by another one (a redirect, a click mid-load), not a failure; and
      // a broken image or frame inside a page that did load is not this pane's problem.
      if (f.isMainFrame && f.errorCode !== -3) {
        clean = false
        setFailed(f.errorDescription || 'the page did not load')
        setFailedUrl(/^https?:\/\//.test(f.validatedURL) ? f.validatedURL : '')
      }
    }
    const onLoaded = () => {
      if (clean) setFailed('')
    }
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-start-navigation', onStart)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('did-finish-load', onLoaded)
    return () => {
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-start-navigation', onStart)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('did-finish-load', onLoaded)
    }
  }, [attempt])

  const retry = () => {
    setRetryUrl(failedUrl)
    setFailed('')
    setReady(false)
    setAttempt((n) => n + 1)
  }
  return { ref, ready, failed, failedUrl, retryUrl, attempt, retry }
}

function LoadFailed({ url, reason, onRetry }: { url: string; reason: string; onRetry: () => void }) {
  return (
    <div className="empty" role="alert" style={{ position: 'absolute', inset: 0, zIndex: 3, background: 'var(--bg)' }}>
      <p style={{ margin: 0 }}>Could not load this page ({reason}).</p>
      <p className="faint" style={{ wordBreak: 'break-all', margin: '6px 0 14px' }}>
        {url}
      </p>
      <button className="btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

function LinkPane({ link, visible }: { link: CourseLink; visible: boolean }) {
  const { ref, ready, failed, failedUrl, retryUrl, attempt, retry } = useGuest()

  return (
    <div
      className="webview-host"
      style={{ position: 'absolute', inset: 0, visibility: visible ? 'visible' : 'hidden', zIndex: visible ? 1 : 0 }}
    >
      {ready || failed ? null : (
        <div
          role="progressbar"
          aria-label={`Loading ${link.label}`}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'var(--accent)', zIndex: 2 }}
        />
      )}
      {failed ? <LoadFailed url={failedUrl || link.url} reason={failed} onRetry={retry} /> : null}
      <webview key={attempt} ref={ref} src={retryUrl || link.url} />
    </div>
  )
}

/**
 * A Google Doc, embedded. This is the real Docs editor rather than a copy of its text: comments,
 * suggestion mode and formatting all work, and there is no two-way sync to get wrong because
 * Google remains the only owner of the document.
 *
 * The first load will show Google's sign-in page. Signing in once writes cookies into the
 * `persist:google` profile on disk, and every Doc in every course is signed in from then on.
 */
function DocPane({ doc, visible, inset }: { doc: NoteMeta; visible: boolean; inset: number }) {
  const { ref, ready, failed, failedUrl, retryUrl, attempt, retry } = useGuest()

  return (
    <div
      className="webview-host"
      style={{
        position: 'absolute',
        top: inset,
        left: 0,
        right: 0,
        bottom: 0,
        visibility: visible ? 'visible' : 'hidden',
        zIndex: visible ? 1 : 0,
      }}
    >
      {ready || failed ? null : (
        <div
          role="progressbar"
          aria-label={`Loading ${doc.title}`}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'var(--accent)', zIndex: 2 }}
        />
      )}
      {failed ? <LoadFailed url={failedUrl || doc.docUrl || ''} reason={failed} onRetry={retry} /> : null}
      <webview key={attempt} ref={ref} src={retryUrl || doc.docUrl} partition={GOOGLE_PARTITION} />
    </div>
  )
}

function DeadlinesPanel({ course }: { course: Course }) {
  const { deadlines, addDeadline, updateDeadline, removeDeadline } = useStore()
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [kind, setKind] = useState<DeadlineKind>('pset')

  const [upcoming, done] = useMemo(() => {
    const mine = deadlines
      .filter((d) => d.courseId === course.id)
      .sort((a, b) => dueDate(a.due).getTime() - dueDate(b.due).getTime())
    return [mine.filter((d) => !d.done), mine.filter((d) => d.done)]
  }, [deadlines, course.id])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !date) return
    // A failed save keeps what was typed; the store has already said why.
    const saved = await addDeadline({
      courseId: course.id,
      title: title.trim(),
      due: time ? `${date}T${time}` : date,
      kind,
      done: false,
    })
    if (!saved) return
    setTitle('')
    setTime('')
  }

  // The click-again-to-confirm dance is gone here too — undo covers it, and it stopped charging
  // every delete for the rare one you regret.

  // Same grid as Today, so a deadline looks and scans the same wherever you meet it. The course
  // is redundant here, so that column carries the kind instead.
  const row = (d: Deadline) => (
    <div key={d.id} className={`lrow${d.done ? ' done' : ''}${!d.done && daysUntil(d.due) < 0 ? ' overdue' : ''}`}>
      <input
        type="checkbox"
        id={`cw-${d.id}`}
        checked={d.done}
        onChange={() => void updateDeadline(d.id, { done: !d.done })}
      />
      <label className="title lrow-title" htmlFor={`cw-${d.id}`} title={d.title}>
        {d.title}
      </label>
      <span className="chip">{KIND_LABELS[d.kind]}</span>
      <span className="lrow-due" title={formatDue(d.due)}>
        {relativeDue(d.due)}
      </span>
      <button className="btn ghost sm lrow-del" aria-label={`Delete ${d.title}`} onClick={() => void removeDeadline(d.id)}>
        ×
      </button>
    </div>
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      <form className="card stack" onSubmit={(e) => void submit(e)} style={{ marginBottom: 18 }}>
        <div>
          <label className="section-title" htmlFor="cw-new-title">
            New deadline
          </label>
          <input
            className="input"
            id="cw-new-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Written 4"
          />
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label className="section-title" htmlFor="cw-new-date">
              Due
            </label>
            <input className="input" id="cw-new-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="section-title" htmlFor="cw-new-time">
              Time (optional)
            </label>
            <input className="input" id="cw-new-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="section-title" htmlFor="cw-new-kind">
              Kind
            </label>
            <select
              className="select"
              id="cw-new-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as DeadlineKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" type="submit" disabled={!title.trim() || !date} style={{ alignSelf: 'flex-end' }}>
            Add
          </button>
        </div>
      </form>

      <h2 className="section-title">Upcoming</h2>
      {upcoming.length ? (
        <div className="stack">{upcoming.map(row)}</div>
      ) : (
        <div className="empty">Nothing open for {course.code}. Add one above when the syllabus says so.</div>
      )}

      {done.length ? (
        <>
          <h2 className="section-title" style={{ marginTop: 22 }}>
            Done
          </h2>
          <div className="stack">{done.map(row)}</div>
        </>
      ) : null}
    </div>
  )
}

function AddLinkPanel({ course, onAdded }: { course: Course; onAdded: (id: string) => void }) {
  const { courses, saveCourses } = useStore()
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedLabel = label.trim()
    const trimmedUrl = url.trim()
    if (!trimmedLabel || !trimmedUrl) return
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError('The URL has to start with http:// or https://')
      return
    }
    const link: CourseLink = { id: `l-${Date.now().toString(36)}`, label: trimmedLabel, url: trimmedUrl }
    await saveCourses(courses.map((c) => (c.id === course.id ? { ...c, links: [...c.links, link] } : c)))
    setLabel('')
    setUrl('')
    setError('')
    onAdded(link.id)
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      {course.links.length ? null : (
        <div className="empty">
          {course.code} has no link tabs yet — just Notes and Deadlines. Canvas is the usual first one: paste its course
          URL below.
        </div>
      )}
      <form className="card stack" onSubmit={(e) => void submit(e)} style={{ maxWidth: 520, margin: '0 auto' }}>
        <div>
          <label className="section-title" htmlFor="cw-link-label">
            Tab name
          </label>
          <input
            className="input"
            id="cw-link-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Canvas"
          />
        </div>
        <div>
          <label className="section-title" htmlFor="cw-link-url">
            URL
          </label>
          <input
            className="input"
            id="cw-link-url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError('')
            }}
            placeholder="https://canvas.example.edu/courses/123"
          />
        </div>
        {error ? <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>{error}</div> : null}
        <div className="row">
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn primary" type="submit" disabled={!label.trim() || !url.trim()}>
            Add tab
          </button>
        </div>
      </form>
    </div>
  )
}
