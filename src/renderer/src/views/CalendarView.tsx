import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { Deadline, DeadlineKind, FeedEvent } from '@shared/types'
import { KIND_LABELS, meetsOn } from '@shared/types'
import { mirrorsClass, eventsOnDay, clock, isBanner } from '@shared/day-plan'
import { useStore, dueDate, isAllDay } from '../store'
import { SCHEDULE_FILE, parseFile, type Meeting } from './Schedule'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const KINDS = Object.keys(KIND_LABELS) as DeadlineKind[]

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

const firstOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1)

/** YYYY-MM-DD at local midnight. new Date('2026-08-24') would be UTC and land a day early. */
const dateOnly = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local calendar date as YYYY-MM-DD — never derived by slicing an ISO string. */
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** One rendered line inside a day cell: a single deadline, or a same-course pile collapsed. */
type CellRow = { type: 'one'; d: Deadline } | { type: 'many'; courseId: string | null; items: Deadline[] }

/**
 * Same-course pile-ups collapse to one chip. A course's modules due the same day are one fact
 * about that day, not a row each — rendered separately they shove every other course into
 * "+11 more" and make the whole screen read as noise.
 */
function rowsFor(items: Deadline[]): CellRow[] {
  const byCourse = new Map<string | null, Deadline[]>()
  for (const d of items) {
    const pile = byCourse.get(d.courseId)
    if (pile) pile.push(d)
    else byCourse.set(d.courseId, [d])
  }
  const out: CellRow[] = []
  const collapsed = new Set<string | null>()
  for (const d of items) {
    const pile = byCourse.get(d.courseId) ?? []
    if (d.courseId && pile.length >= 3) {
      if (!collapsed.has(d.courseId)) {
        collapsed.add(d.courseId)
        out.push({ type: 'many', courseId: d.courseId, items: pile })
      }
    } else {
      out.push({ type: 'one', d })
    }
  }
  return out
}

const timeOf = (due: string): string => {
  if (isAllDay(due)) return ''
  const d = dueDate(due)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Combine a local day with an optional HH:MM. Empty time stays all-day. */
function makeDue(day: Date, time: string): string {
  if (!time) return ymd(day)
  return new Date(`${ymd(day)}T${time}`).toISOString()
}

interface Composer {
  day: Date
  editing: Deadline | null
  title: string
  courseId: string
  kind: DeadlineKind
  time: string
  done: boolean
}

export default function CalendarView({
  onImportSyllabus,
  initialMonth,
}: {
  onImportSyllabus: () => void
  /** YYYY-MM-DD to open on, from a palette command. Absent means this month. */
  initialMonth?: string
}) {
  const { courses, deadlines, courseById, addDeadline, updateDeadline, removeDeadline } = useStore()
  const [month, setMonth] = useState<Date>(() => firstOfMonth(new Date()))
  const [selectedDay, setSelectedDay] = useState(() => new Date())
  const [showCompleted, setShowCompleted] = useState(false)
  const [space, setSpace] = useState('all')
  const [saving, setSaving] = useState(false)

  // Jumping to a December deadline from the palette used to land on the current month, because the
  // command carried no date. Runs on every arrival, so picking two deadlines in a row both work.
  useEffect(() => {
    if (initialMonth) { setMonth(firstOfMonth(dateOnly(initialMonth))); setSelectedDay(dateOnly(initialMonth)) }
  }, [initialMonth])
  const [composer, setComposer] = useState<Composer | null>(null)

  /**
   * Subscribed feed events. Read-only and deliberately not merged into `byDay`: they are not
   * yours to drag, tick or edit, and the moment they share a bucket with deadlines someone will
   * write code that treats them as one.
   */
  const [feed, setFeed] = useState<FeedEvent[]>([])
  const [feedNames, setFeedNames] = useState<Map<string, { name: string; color: string }>>(new Map())

  useEffect(() => {
    const load = (): void => {
      void window.api.feeds.events().then(setFeed).catch(() => setFeed([]))
      void window.api.feeds
        .list()
        .then((subs) => setFeedNames(new Map(subs.map((x) => [x.id, { name: x.name, color: x.color }]))))
        .catch(() => undefined)
    }
    load()
    // The cache is refreshed in main on a schedule, so re-read whenever the window comes back.
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  /**
   * Classes. A calendar that knows every deadline and none of your lectures is not a calendar of
   * your week — the meetings in _schedule.md used to be visible only on the Schedule
   * screen, which left this one not worth opening.
   */
  const [meetings, setMeetings] = useState<Meeting[]>([])
  /**
   * Only mini courses carry from/until, so meetsOn alone calls a full-term Monday class
   * infinite and paints lectures across July and next summer. The term is the outer bound every
   * meeting shares; without it, scrolling back one month shows a week of classes that never ran.
   */
  const [term, setTerm] = useState<{ start: string; end: string } | null>(null)

  useEffect(() => {
    const load = (): void => {
      void window.api.notes
        .read(SCHEDULE_FILE)
        .then((text) => setMeetings(parseFile(text)))
        .catch(() => setMeetings([]))
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  useEffect(() => {
    void window.api.sync
      .status()
      .then((s) => setTerm(s.termStart && s.termEnd ? { start: s.termStart, end: s.termEnd } : null))
      .catch(() => setTerm(null))
  }, [])

  /** Meetings running on a given day, in time order. meetsOn is what keeps the two minis apart. */
  const meetingsOn = useCallback(
    (day: Date): Meeting[] => {
      const iso = ymd(day)
      if (term && (iso < term.start || iso > term.end)) return []
      const weekday = (day.getDay() + 6) % 7
      return meetings
        .filter((m) => m.day === weekday && meetsOn(m, iso))
        .sort((a, b) => a.start.localeCompare(b.start))
    },
    [meetings, term],
  )


  const byDay = useMemo(() => {
    const map = new Map<string, Deadline[]>()
    const sorted = deadlines.filter(d => (showCompleted || !d.done) && (space === 'all' || (d.courseId ?? 'unfiled') === space)).sort((a, b) => dueDate(a.due).getTime() - dueDate(b.due).getTime())
    for (const d of sorted) {
      const key = dayKey(dueDate(d.due))
      const list = map.get(key)
      if (list) list.push(d)
      else map.set(key, [d])
    }
    return map
  }, [deadlines, space, showCompleted])

  const cells = useMemo(() => {
    const year = month.getFullYear()
    const m = month.getMonth()
    const lead = (month.getDay() + 6) % 7
    const daysInMonth = new Date(year, m + 1, 0).getDate()
    const count = Math.ceil((lead + daysInMonth) / 7) * 7
    return Array.from({ length: count }, (_, i) => new Date(year, m, 1 - lead + i))
  }, [month])

  /** The grid shows one feed chip per day: a long timed banner (a five-week series) goes last so it cannot hide Fall Break; feed order is kept otherwise. */
  const feedByDay = useMemo(() => {
    const demoted = (e: FeedEvent): number => Number(isBanner(e) && !e.allDay)
    return new Map(cells.map(day => [dayKey(day), eventsOnDay(feed, ymd(day)).sort((a, b) => demoted(a) - demoted(b))]))
  }, [cells, feed])

  const todayKey = dayKey(new Date())
  const selectDay = (day: Date): void => {
    setSelectedDay(day)
    setComposer(null)
    if (window.matchMedia('(max-width: 1200px)').matches) {
      requestAnimationFrame(() => document.querySelector('.calendar-agenda')?.scrollIntoView({ block: 'start' }))
    }
  }
  const shift = (n: number): void => { const next = new Date(month.getFullYear(), month.getMonth() + n, 1); setMonth(next); selectDay(next) }

  /**
   * The keyboard spine: T for this month, arrows for the neighbours. Silent while the composer is
   * open or anything is being typed — a month jump under a half-written deadline is worse than no
   * shortcut at all.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (composer || e.ctrlKey || e.metaKey || e.altKey) return
      // An open dialog owns the keyboard wherever its focus sits — it can fall to body mid-flow
      // (SyllabusImport swaps its buttons out), and a month silently changing behind a modal is
      // exactly the kind of ghost action this guard exists to prevent.
      if (document.querySelector('[role="dialog"]')) return
      const t = e.target
      // Interactive targets keep their keys: an arrow inside a focused event chip is navigation
      // within the grid, not a request to unmount the chip under the user's focus.
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.closest('input, textarea, select, button, a, [role="button"]'))
      )
        return
      if (e.key === 't' || e.key === 'T') { setMonth(firstOfMonth(new Date())); selectDay(new Date()) }
      else if (e.key === 'ArrowLeft') shift(-1)
      else if (e.key === 'ArrowRight') shift(1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [composer, month])

  const openAdd = (day: Date): void =>
    setComposer({
      day,
      editing: null,
      title: '',
      courseId: '',
      kind: 'pset',
      time: '',
      done: false,
    })

  const openEdit = (day: Date, d: Deadline): void =>
    setComposer({
      day,
      editing: d,
      title: d.title,
      courseId: d.courseId ?? '',
      kind: d.kind,
      time: timeOf(d.due),
      done: d.done,
    })

  const close = (): void => setComposer(null)

  const submit = async (c: Composer): Promise<void> => {
    const title = c.title.trim()
    if (!title) return
    const courseId = c.courseId === '' ? null : c.courseId
    const due = makeDue(c.day, c.time)
    setSaving(true)
    const ok = c.editing
      ? await updateDeadline(c.editing.id, { title, courseId, kind: c.kind, due, done: c.done })
      : await addDeadline({ title, courseId, kind: c.kind, due, done: false })
    setSaving(false)
    if (ok) { setSelectedDay(c.day); setMonth(firstOfMonth(c.day)); close() }
  }

  const drop = (day: Date, id: string): void => {
    const d = deadlines.find((x) => x.id === id)
    if (!d) return
    updateDeadline(d.id, { due: makeDue(day, timeOf(d.due)) })
    // Dragging some other row must not throw away what is typed in an editor that is open on this one.
    if (composer?.editing?.id === id) close()
  }

  return (
    <>
      <header className="topbar calendar-topbar">
        <div><div className="today-eyebrow">Calendar</div><h1>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1></div>
        <div className="calendar-controls">
          <button className="btn sm ghost" onClick={onImportSyllabus}>Import syllabus</button>
          <button className="btn sm" aria-label="Previous month" onClick={() => shift(-1)}>←</button>
          <button className="btn sm" onClick={() => { setMonth(firstOfMonth(new Date())); selectDay(new Date()) }}>Today</button>
          <button className="btn sm" aria-label="Next month" onClick={() => shift(1)}>→</button>
        </div>
      </header>
      <div className="calendar-toolbar">
        <span className="calendar-key"><i className="calendar-key-work" />Deadlines</span>
        <span className="calendar-key"><i className="calendar-key-event" />Calendar events</span>
        <span className="spacer" />
        <label><input type="checkbox" checked={showCompleted} onChange={e => setShowCompleted(e.target.checked)} />Show completed</label>
        <select className="select sm" aria-label="Filter calendar by space" title="Filter deadlines by space; calendar events stay visible" value={space} onChange={e => setSpace(e.target.value)}>
          <option value="all">All spaces</option><option value="unfiled">Unfiled work</option>
          {courses.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
      </div>
      <div className="content calendar-layout">
        <div className="calendar-month">
          <div className="cal-grid">
            {WEEKDAYS.map(w => <div className="cal-head" key={w}>{w}</div>)}
            {cells.map((day, i) => {
              const key = dayKey(day)
              const items = byDay.get(key) ?? []
              const cls = meetingsOn(day)
              const dayFeed = (feedByDay.get(key) ?? []).filter(e => !mirrorsClass(e, cls))
              const rows = rowsFor(items)
              const label = day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
              const selected = key === dayKey(selectedDay)
              return <div key={key} className={`cal-cell${day.getMonth() !== month.getMonth() ? ' dim' : ''}${i % 7 >= 5 ? ' weekend' : ''}${key === todayKey ? ' today' : ''}${selected ? ' selected' : ''}`}
                onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); drop(day, e.dataTransfer.getData('text/plain')) }}>
                <button type="button" className="cal-day-target" aria-label={`View ${label}`} aria-pressed={selected} onClick={() => selectDay(day)} />
                <div className="cal-date-row"><span className="num">{day.getDate()}</span><span>{items.filter(d => !d.done).length ? `${items.filter(d => !d.done).length} due` : ''}</span></div>
                {cls.length ? <div className="cal-classline">{cls.map(m => <span key={`${m.courseId}-${m.start}`} className="dot" style={{ background: courseById(m.courseId)?.color ?? 'var(--text-faint)' }} />)}<span>{`${cls.length} class${cls.length === 1 ? '' : 'es'}`}</span></div> : null}
                {rows.slice(0, 2).map(r => {
                  const d = r.type === 'one' ? r.d : r.items[0]
                  const done = r.type === 'one' ? d.done : r.items.every(item => item.done)
                  const title = r.type === 'one' ? d.title : `${r.items.length} × ${courseById(d.courseId)?.code ?? 'items'}`
                  return <button type="button" className={`cal-event${d.kind === 'exam' ? ' exam' : ''}${done ? ' completed' : ''}`} key={d.id}
                    title={title} draggable={r.type === 'one'} onDragStart={e => { e.dataTransfer.setData('text/plain', d.id); e.dataTransfer.effectAllowed = 'move' }}
                    onClick={() => { selectDay(day); if (r.type === 'one') openEdit(day, d) }}
                    style={{ '--cc': courseById(d.courseId)?.color ?? '#9ba7ba' } as CSSProperties}>
                    {title}
                  </button>
                })}
                {dayFeed.slice(0, 1).map(e => <button type="button" className="cal-event feed" key={`${e.subscriptionId}-${e.uid}-${e.start}`} title={`${e.title}${e.location ? ` · ${e.location}` : ''}`} onClick={() => selectDay(day)} style={{ '--cc': feedNames.get(e.subscriptionId)?.color ?? '#9ba7ba' } as CSSProperties}>{e.title}</button>)}
                {rows.length > 2 || dayFeed.length > 1 ? <button type="button" className="cal-more" onClick={() => selectDay(day)}>+{Math.max(0, rows.length - 2) + Math.max(0, dayFeed.length - 1)} more</button> : null}
              </div>
            })}
          </div>
          <p className="calendar-help">Select a day for its full agenda. Drag a deadline to reschedule it.</p>
        </div>
        <aside className="calendar-agenda" aria-label="Selected day agenda">
          <header className="calendar-agenda-header">
            <div><span className="section-title">{dayKey(selectedDay) === todayKey ? 'Today' : selectedDay.toLocaleDateString(undefined, { weekday: 'long' })}</span><h2>{selectedDay.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</h2></div>
            <button className="btn primary sm" onClick={() => openAdd(selectedDay)}>+ Add</button>
          </header>
          {composer ? (
            <form className="calendar-editor stack" onSubmit={e => { e.preventDefault(); void submit(composer) }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
              <div className="work-heading"><h3>{composer.editing ? 'Edit deadline' : 'New deadline'}</h3><button className="btn ghost sm" type="button" aria-label="Close deadline editor" onClick={close}>×</button></div>
              <label htmlFor="cal-title">Title</label><input id="cal-title" className="input" autoFocus required value={composer.title} placeholder="What's due?" onChange={e => setComposer({ ...composer, title: e.target.value })} />
              <div className="calendar-editor-fields">
                <label>Space<select className="select" value={composer.courseId} onChange={e => setComposer({ ...composer, courseId: e.target.value })}><option value="">Unfiled</option>{courses.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}</select></label>
                <label>Kind<select className="select" value={composer.kind} onChange={e => setComposer({ ...composer, kind: e.target.value as DeadlineKind })}>{KINDS.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></label>
                <label>Date<input className="input" type="date" required value={ymd(composer.day)} onChange={e => { if (e.target.value) setComposer({ ...composer, day: dateOnly(e.target.value) }) }} /></label>
                <label>Time (optional)<input className="input" type="time" value={composer.time} onChange={e => setComposer({ ...composer, time: e.target.value })} /></label>
              </div>
              {composer.editing ? <label className="row"><input type="checkbox" checked={composer.done} onChange={e => setComposer({ ...composer, done: e.target.checked })} />Completed</label> : null}
              <div className="row"><button className="btn primary sm" type="submit" disabled={saving || !composer.title.trim()}>{saving ? 'Saving…' : composer.editing ? 'Save changes' : 'Add deadline'}</button><button className="btn ghost sm" type="button" onClick={close}>Cancel</button>
                {composer.editing ? <button className="btn ghost sm" type="button" onClick={() => { void removeDeadline(composer.editing!.id); close() }}>Delete</button> : null}
              </div>
            </form>
          ) : null}
          <DayAgenda day={ymd(selectedDay)} deadlines={byDay.get(dayKey(selectedDay)) ?? []} classes={meetingsOn(selectedDay)}
            events={(feedByDay.get(dayKey(selectedDay)) ?? []).filter(e => !mirrorsClass(e, meetingsOn(selectedDay)))} courseById={courseById} feedNames={feedNames}
            onEdit={d => openEdit(selectedDay, d)} />
        </aside>
      </div>
    </>
  )
}

/**
 * One day, whole, in time order: all-day things first, then classes, subscribed events and timed
 * deadlines interleaved by the clock. Deadlines are buttons into their editor; classes and feed
 * events are facts — not yours to edit here, so they do not pretend to be.
 */
function DayAgenda({
  day,
  deadlines,
  classes,
  events,
  courseById,
  feedNames,
  onEdit,
}: {
  day: string
  deadlines: Deadline[]
  classes: Meeting[]
  events: FeedEvent[]
  courseById: (id: string | null) => { code: string; color: string } | undefined
  feedNames: Map<string, { name: string; color: string }>
  onEdit: (d: Deadline) => void
}) {
  const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

  type AgendaRow = {
    key: string
    min: number | null
    when: string
    title: string
    sub?: string
    color: string
    /* Hollow dot — a subscribed event, same glyph the Today rail uses for them. */
    ring?: boolean
    d?: Deadline
  }
  const rows: AgendaRow[] = []
  for (const m of classes) {
    const c = courseById(m.courseId)
    rows.push({
      key: `c-${m.courseId}-${m.start}`,
      min: toMin(m.start),
      when: clock(toMin(m.start)),
      title: c?.code ?? m.courseId,
      sub: `Class · until ${clock(toMin(m.end))}${m.location ? ' · ' + m.location : ''}`,
      color: c?.color ?? 'var(--text-faint)',
    })
  }
  for (const e of events) {
    const timed = !e.allDay && !/^\d{4}-\d{2}-\d{2}$/.test(e.start)
    const at = new Date(e.start)
    // On a later day of a multi-day event its first day's clock time is wrong: a long series is
    // simply on ("all day"), an overnight event is under way from midnight.
    const min = !timed ? null : ymd(at) < day ? (isBanner(e) ? null : 0) : at.getHours() * 60 + at.getMinutes()
    const meta = feedNames.get(e.subscriptionId)
    rows.push({
      key: `e-${e.subscriptionId}-${e.uid}-${e.start}`,
      min,
      when: min === null ? 'all day' : clock(min),
      title: e.title,
      sub: e.location || meta?.name,
      color: meta?.color ?? 'var(--text-faint)',
      ring: true,
    })
  }
  for (const d of deadlines) {
    const min = isAllDay(d.due) ? null : ((at) => at.getHours() * 60 + at.getMinutes())(dueDate(d.due))
    rows.push({
      key: d.id,
      min,
      when: min === null ? 'due' : clock(min),
      title: d.title,
      sub: `Deadline${courseById(d.courseId) ? ' · ' + courseById(d.courseId)!.code : ''}`,
      color: courseById(d.courseId)?.color ?? 'var(--text-faint)',
      d,
    })
  }
  rows.sort((a, b) => (a.min ?? -1) - (b.min ?? -1))

  if (rows.length === 0) {
    return (
      <p className="faint" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
        Nothing on this day yet.
      </p>
    )
  }
  return (
    <div className="stack cal-daylist" style={{ gap: 1 }}>
      {rows.map((r) =>
        r.d ? (
          <button type="button" key={r.key} className="cal-daylist-row" onClick={() => onEdit(r.d as Deadline)}>
            <span className="when">{r.when}</span>
            <span className="dot" style={{ background: r.color }} />
            <span className="t">{r.d.done ? <s>{r.title}</s> : r.title}<small>{r.sub}</small></span>
          </button>
        ) : (
          <div key={r.key} className="cal-daylist-row still" title={r.title + (r.sub ? ` · ${r.sub}` : '')}>
            <span className="when">{r.when}</span>
            <span
              className={r.ring ? 'dot ring' : 'dot'}
              style={r.ring ? ({ ['--cc' as string]: r.color } as CSSProperties) : { background: r.color }}
            />
            <span className="t">{r.title}{r.sub ? <small>{r.sub}</small> : null}</span>
          </div>
        ),
      )}
    </div>
  )
}
