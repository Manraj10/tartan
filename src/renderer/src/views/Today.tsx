import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { KIND_LABELS, LEAD_DAYS, everyLabel, meetsOn, parseEntry, type Deadline, type FeedEvent, type RecurringRule } from '@shared/types'
import { useStore, daysUntil, dueDate, dueTime, formatDue, isAllDay, relativeDue } from '../store'
import { SCHEDULE_FILE, parseFile, type Meeting } from './Schedule'
import { buildDayPlan, clock, DAY_START, DAY_END, moveDueToDay, moveOverdueToDay, localDay, eventsOnDay, isBanner } from '@shared/day-plan'
import { byPriority, priorityNote } from '@shared/priority'
import QuickAdd, { type QuickAddResult } from '../components/QuickAdd'
import LeetCode from '../components/LeetCode'
import EmptyState from '../components/EmptyState'

/** Lives in styles.css now: urgency is a palette decision, not a constant stranded in a view. */
const OVERDUE_INK = 'var(--overdue)'

/* ---------- time + date helpers ---------- */

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Mon=0 … Sun=6, matching Meeting.day. */
const weekdayOf = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number)
  return (new Date(y, m - 1, d).getDay() + 6) % 7
}

/* ---------- the day rail ---------- */

/**
 * The day as one vertical rail: classes, timed deadlines and free-time gaps in time order —
 * Structured's signature, and the pattern the redesign deliberately deferred. The gaps are the
 * point: "2h 10m free" between classes is the honest answer to "when do I do the pset", where a
 * horizontal strip only ever answered "am I in class right now".
 */

interface RailItem {
  key: string
  start: number
  /** null for an instant — a due time. */
  end: number | null
  kind: 'class' | 'gap' | 'due' | 'event'
  meeting?: Meeting
  deadline?: Deadline
  /** A timed calendar event from a subscribed feed — a club meeting, a linked CMU calendar. */
  event?: { title: string; location: string; color: string }
}

const minutesOf = (d: Date): number => d.getHours() * 60 + d.getMinutes()

const spanLabel = (mins: number): string => {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`
}

/**
 * Dates that cost money or a grade, as opposed to the couple of hundred institutional dates the
 * academic calendar also carries. Mini deadlines are kept, not filtered out: a mini course has its
 * own drop dates, and they fall weeks away from the semester dates.
 */
const MONEY_DATE = /\b(?:drop|withdrawal|pass\/no pass|tuition|registration)\b/i

/** Past its day, or past its time today: the row belongs in Overdue, not in "Due today". */
const isLate = (d: Deadline, now: Date): boolean =>
  daysUntil(d.due) < 0 || (!isAllDay(d.due) && dueDate(d.due).getTime() < now.getTime())

/** The "o" shortcut must not fire while the quick-add form is being typed into. */
function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return /^(input|textarea|select)$/.test(t.tagName.toLowerCase()) || t.isContentEditable
}

/* ---------- component ---------- */

export default function Today({
  onOpenCourse,
  onOpenNote,
  onOpenCalendar,
}: {
  onOpenCourse: (id: string) => void
  onOpenNote: (path: string) => void
  onOpenCalendar: () => void
}) {
  const { courses, deadlines, addDeadline, addTodo, updateDeadline, courseById, refresh, announce } = useStore()
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [now, setNow] = useState(() => new Date())
  const todayStr = ymd(now)
  const [space, setSpace] = useState('all')
  const [showEarlier, setShowEarlier] = useState(false)
  const [term, setTerm] = useState<{ start: string; end: string } | null>(null)
  /** The top Overdue section starts OPEN — the debt is the first thing the morning shows. */
  const [showOverdue, setShowOverdue] = useState(true)
  /** Ticked in this sitting: the row stays put so the list does not jump out from under you. */
  const [justDone, setJustDone] = useState<Set<string>>(() => new Set())

  const markDone = useCallback((id: string, done: boolean) => {
    setJustDone((prev) => {
      const next = new Set(prev)
      if (done) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const { overdue, stale, today, startNow, week, later } = useMemo(() => {
    const open = [...deadlines]
      .filter((d) => (!d.done || justDone.has(d.id)) && (space === 'all' || (d.courseId ?? 'unfiled') === space))
      .sort((a, b) => dueDate(a.due).getTime() - dueDate(b.due).getTime())
    const between = (lo: number, hi: number): Deadline[] =>
      open.filter((d) => daysUntil(d.due) >= lo && daysUntil(d.due) <= hi)
    // An exam five days out belongs in your face, not buried in "this week" behind a form.
    // Due tomorrow ALWAYS qualifies, whatever the kind: a reading for tomorrow's 9 am is started
    // tonight or not at all — lead 0 was read as "never surface it", which buried exactly those.
    const needsStarting = (d: Deadline): boolean => {
      const n = daysUntil(d.due)
      return n === 1 || (n > 0 && n <= LEAD_DAYS[d.kind])
    }
    const late = open.filter((d) => isLate(d, now))
    const soon = between(1, 7)
    return {
      // A week of rolling over is not urgent, it is dead. It stays one click away, not in the face.
      overdue: late.filter((d) => daysUntil(d.due) >= -7),
      stale: late.filter((d) => daysUntil(d.due) < -7),
      today: between(0, 0).filter((d) => !isLate(d, now)),
      // Everything past today is ordered by what to do FIRST, not by which clock runs out first:
      // an exam on Friday outranks a worksheet due tomorrow night. "Due today" stays on the clock,
      // because today you are working to the clock.
      startNow: soon.filter(needsStarting).sort(byPriority(now)),
      week: soon.filter((d) => !needsStarting(d)).sort(byPriority(now)),
      later: between(8, 14).sort(byPriority(now)),
    }
  }, [deadlines, justDone, space, now])

  const upcoming = today.length + startNow.length + week.length + later.length

  /** Finished work due this week — the half of "12 this week" that says you are actually moving. */
  const doneWeek = useMemo(
    () => deadlines.filter((d) => d.done && daysUntil(d.due) >= 0 && daysUntil(d.due) <= 7).length,
    [deadlines, todayStr],
  )

  useEffect(() => {
    const load = (): void => {
      void window.api.notes.read(SCHEDULE_FILE).then(text => setMeetings(parseFile(text)))
        .catch(() => announce('Could not read the class schedule. Reopen Today to retry.', { kind: 'error' }))
      void window.api.sync.status().then(status => setTerm({ start: status.termStart, end: status.termEnd }))
        .catch(() => undefined)
      setNow(new Date())
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [announce])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  /**
   * The four dates that cost money, from the CMU academic calendar already subscribed and already
   * cached on disk. Nothing to fetch, nothing to type. Until now these were a chip in a month grid
   * capped at two per day — findable only by clicking into October and noticing.
   */
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([])
  const [feedColors, setFeedColors] = useState<Map<string, string>>(() => new Map())
  useEffect(() => {
    const load = (): void => {
      void window.api.feeds.events().then(setFeedEvents).catch(() => undefined)
      void window.api.feeds
        .list()
        .then((subs) => setFeedColors(new Map(subs.map((s) => [s.id, s.color]))))
        .catch(() => undefined)
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  const moneyDates = useMemo(() => {
    const titles = new Set<string>()
    const days = new Map<string, string>()
    return feedEvents
      .filter((e) => MONEY_DATE.test(e.title))
      // A timed event's UTC ISO string can name the wrong day; all-day starts are already a local date.
      .map((e) => ({ title: e.title, day: e.allDay ? e.start : localDay(new Date(e.start)), sub: e.subscriptionId }))
      .filter((e) => {
        const n = daysUntil(e.day)
        // A fortnight is long enough to act and short enough that the line is not wallpaper.
        if (n < 0 || n > 14) return false
        // Registration spans five consecutive days as five events; one line is enough. And two
        // feeds title the same drop date differently, so a date already told by another feed is
        // skipped, while two different notices from one feed on the same date both stay.
        if (titles.has(e.title) || (days.has(e.day) && days.get(e.day) !== e.sub)) return false
        titles.add(e.title)
        days.set(e.day, e.sub)
        return true
      })
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(0, 2)
  }, [feedEvents, todayStr])


  /**
   * Clearing eight overdue items was eight mouse trips to a per-row button. Focus advances after
   * each action, so eight items now clear in eight keystrokes.
   */
  const triage = useCallback(
    (id: string, key: string, el: HTMLElement) => {
      const move = (days: number): void => {
        const d = new Date()
        d.setDate(d.getDate() + days)
        const deadline = deadlines.find(item => item.id === id)
        // Today drops a clock that has already passed (it would stay overdue); tomorrow keeps it.
        if (deadline) void updateDeadline(id, { due: (days === 0 ? moveOverdueToDay : moveDueToDay)(deadline.due, ymd(d)) })
      }
      if (key === 't') move(0)
      else if (key === 'd') move(1)
      else if (key === 'x') {
        markDone(id, true)
        void updateDeadline(id, { done: true })
      } else if (key === 'j' || key === 'k') {
        const sib = key === 'j' ? el.nextElementSibling : el.previousElementSibling
        ;(sib as HTMLElement | null)?.focus()
        return
      } else return
      // The row it moves to is the one that slides into this position.
      ;(el.nextElementSibling as HTMLElement | null)?.focus()
    },
    [deadlines, updateDeadline, markDone],
  )
  const nowMin = now.getHours() * 60 + now.getMinutes()

  const todayMeetings = useMemo(() => {
    const day = weekdayOf(todayStr)
    // meetsOn is what stops two mini courses sharing one slot from both appearing at 10am.
    if (term && (todayStr < term.start || todayStr > term.end)) return []
    return meetings
      .filter((m) => m.day === day && meetsOn(m, todayStr))
      .sort((a, b) => a.start.localeCompare(b.start))
  }, [meetings, todayStr, term])

  /**
   * Classes, today's timed deadlines (ticked ones included — the rail is the day's shape, not a
   * task list), and the usable gaps between classes. Gaps already spent are not shown, and a gap
   * you are inside counts only what is left of it.
   */
  const plan = useMemo(() => buildDayPlan(todayMeetings, feedEvents, todayStr, nowMin),
    [todayMeetings, feedEvents, todayStr, nowMin])
  const rail = useMemo(() => {
    const busy: RailItem[] = plan.blocks.map(block => ({
      key: block.key, start: block.start, end: block.end, kind: block.kind,
      meeting: block.meeting,
      ...(block.event ? { event: { title: block.title, location: block.event.location,
        color: feedColors.get(block.event.subscriptionId) ?? '#8c94a0' } } : {}),
    }))
    const dues: RailItem[] = deadlines
      .filter(d => !d.done && !isAllDay(d.due) && ymd(dueDate(d.due)) === todayStr)
      .map(d => ({ key: `d-${d.id}`, start: minutesOf(dueDate(d.due)), end: null, kind: 'due', deadline: d }))
    const gaps: RailItem[] = plan.gaps.map(gap => ({ ...gap, key: `g-${gap.start}`, kind: 'gap' }))
    return [...busy, ...dues, ...gaps].sort((a, b) => a.start - b.start)
  }, [plan, deadlines, feedColors, todayStr])
  const visibleRail = rail.filter(r => showEarlier || (r.end ?? r.start) > nowMin || (r.kind === 'gap' && r.start === nowMin))
  const nowIdx = visibleRail.findIndex(r => r.start >= nowMin)
  const earlierCount = rail.length - rail.filter(r => (r.end ?? r.start) > nowMin).length
  const nextBlock = plan.blocks.find(block => block.end > nowMin)
  const opening = plan.gaps[0]
  const freeToday = plan.freeMinutes
  const allDayEvents = eventsOnDay(feedEvents, todayStr).filter(isBanner)
  // Both overview stats are global, whatever space is picked. Rows already late sit in Overdue, so they are not counted as due today too.
  const openToday = deadlines.filter(d => !d.done && daysUntil(d.due) === 0 && !isLate(d, now)).length
  const workSoon = deadlines.filter(d => !d.done && daysUntil(d.due) > 0 && daysUntil(d.due) <= 7).length
  const blockTitle = (block: typeof nextBlock): string => block?.meeting
    ? courseById(block.meeting.courseId)?.code ?? block.title : block?.title ?? ''

  /**
   * Open today's lecture note for a course, creating it pre-titled if it is not there yet.
   * Notes used to end up called `untitled` because naming was a separate step — so the name is
   * decided here and never asked for.
   */
  const openLecture = useCallback(
    async (courseId: string) => {
      const path = `${courseId}/${todayStr} ${courseId}.md`
      const existing = await window.api.notes.list()
      if (!existing.some((n) => n.path === path)) {
        const day = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
        await window.api.notes.write(path, `# ${courseId} — ${day}\n\n`)
      }
      onOpenNote(path)
    },
    [todayStr, now, onOpenNote],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[role="dialog"]')) return
      if (e.key === 'o' || e.key === 'O') setShowOverdue((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const add = async (entry: QuickAddResult, asDeadline: boolean): Promise<boolean> => {
    if (entry.every) {
      // A rule, not a row. Main writes recurring.json, materializes the occurrences, and only
      // then replies — so the refresh below already sees the new rows.
      const rule: RecurringRule = {
        id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text: entry.title,
        courseId: entry.courseId,
        kind: entry.kind,
        days: entry.every.days,
        ...(entry.every.time ? { time: entry.every.time } : {}),
        // A date picked alongside Repeat bounds the rule: no occurrence before the chosen day.
        ...(entry.every.from ? { from: entry.every.from } : {}),
      }
      return window.api.recurring
        .add(rule)
        .then(() => refresh())
        .then(() => {
          announce(`“${rule.text}” repeats ${everyLabel(rule.days)}`, {
            undo: () => void window.api.recurring.remove(rule.id).then(() => refresh()),
          })
          return true
        })
        .catch((err: Error) => { announce(`Could not save the rule — ${err.message}`, { kind: 'error' }); return false })
    }
    // A row the filter or a collapsed section hides would seem to have vanished: say where it went.
    const inSpace = space === 'all' || (entry.courseId ?? 'unfiled') === space
    const told = (title: string, due: string | undefined, shown: boolean) => (ok: boolean): boolean => {
      if (ok && !shown) announce(`Added “${title}”${due ? ` · ${relativeDue(due)}` : ''}`)
      return ok
    }
    if (asDeadline) {
      // Shift+Enter can force a deadline with no date typed; it lands today rather than nowhere.
      const due = entry.due || ymd(new Date())
      const n = daysUntil(due)
      const late = n < 0 || (!isAllDay(due) && dueDate(due).getTime() < now.getTime())
      // Mirrors the sections above: Overdue (while open, and not the week-old pile), Due today,
      // Start now, or Coming up — which only shows its rows while it is open and inside two weeks.
      const shown = inSpace && (late ? showOverdue && n >= -7
        : n === 0 || n === 1 || (n > 0 && n <= LEAD_DAYS[entry.kind]) || (n <= 14 && today.length + startNow.length === 0))
      return addDeadline({ title: entry.title, courseId: entry.courseId, due, kind: entry.kind, done: false })
        .then(told(entry.title, due, shown))
    } else {
      // Local calendar day, never an ISO slice — a 10 pm due sliced in UTC lands on tomorrow.
      const due = entry.due ? ymd(dueDate(entry.due)) : undefined
      return addTodo({ text: entry.title, courseId: entry.courseId, due }).then(told(entry.title, due, inSpace))
    }
  }

  return (
    <>
      <header className="topbar today-topbar">
        <div>
          <div className="today-eyebrow">Your day, in focus</div>
          <h1>{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
        </div>
        <button className="btn sm" onClick={onOpenCalendar}>Open calendar <span aria-hidden>↗</span></button>
      </header>

      <div className="content today-dashboard">
        <section className="day-overview" aria-label="Today at a glance">
          <div className="day-brief">
            <button className="day-next" onClick={onOpenCalendar} title="Open today’s full agenda">
              <span className="section-title">{nextBlock && nextBlock.start <= nowMin ? 'Happening now' : 'Up next'}</span>
              <strong>{nextBlock ? blockTitle(nextBlock) : 'No more timed events today'}</strong>
              <span className="muted">{nextBlock ? `${clock(nextBlock.start)}${nextBlock.end > nextBlock.start ? '–' + clock(nextBlock.end) : ' · no end time'}${nextBlock.meeting?.location || nextBlock.event?.location ? ' · ' + (nextBlock.meeting?.location || nextBlock.event?.location) : ''}` : 'Your remaining time is yours to plan.'}</span>
            </button>
            <div className="day-stat"><strong>{openToday}</strong><span>due today</span></div>
            <div className="day-stat"><strong>{workSoon}</strong><span>next 7 days</span></div>
            <div className="day-stat"><strong>{spanLabel(freeToday)}</strong><span>calendar openings</span></div>
          </div>
          <div className="day-ribbon" aria-label="Scheduled time from 8 am to 11 pm">
            {plan.blocks.filter(b => b.end > DAY_START && b.start < DAY_END).map(b => (
              <button key={b.key} className="day-ribbon-block" onClick={onOpenCalendar} aria-label={`View ${blockTitle(b)} in today's agenda`} title={`${blockTitle(b)} · ${clock(b.start)}–${clock(b.end)}`}
                style={{ left: `${(Math.max(b.start, DAY_START) - DAY_START) / (DAY_END - DAY_START) * 100}%`,
                  width: `${(Math.min(b.end, DAY_END) - Math.max(b.start, DAY_START)) / (DAY_END - DAY_START) * 100}%`,
                  '--cc': b.meeting ? courseById(b.meeting.courseId)?.color : feedColors.get(b.event!.subscriptionId) } as CSSProperties} />
            ))}
            {nowMin >= DAY_START && nowMin <= DAY_END ? <span className="day-ribbon-now" style={{ left: `${(nowMin - DAY_START) / (DAY_END - DAY_START) * 100}%` }} /> : null}
          </div>
          <div className="day-ribbon-labels"><span>8 am</span><span style={{ left: '26.67%' }}>Noon</span><span style={{ left: '53.33%' }}>4 pm</span><span style={{ left: '80%' }}>8 pm</span><span>11 pm</span></div>
        </section>

        <div className="today-workspace">
          <div className="today-main">
            <div className="work-heading"><h2>What needs your attention</h2>
              <select className="select" aria-label="Filter work by space" value={space} onChange={e => setSpace(e.target.value)}>
                <option value="all">All spaces</option><option value="unfiled">Unfiled</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}
              </select>
            </div>
            <div className="capture-card"><QuickAdd placeholder={`Add a task… try ‘${courses[0] ? `${courses[0].code} ` : ''}pset Friday 5pm’`} onSubmit={add} /></div>
            {moneyDates.map(m => <div key={m.title} className="academic-notice"><span>{m.title}</span><strong>{relativeDue(m.day)}</strong></div>)}
            <div className="work-card">
              {upcoming === 0 ? <EmptyState kind="done" headline={space === 'all' ? 'Nothing upcoming in the next two weeks.' : 'No upcoming deadlines in this space.'} detail="Add a task above, or look ahead in Calendar." /> : <>
                <Section title="Due today" items={today} onOpenCourse={onOpenCourse} onDone={markDone} />
                <Section title="Start now" items={startNow} onOpenCourse={onOpenCourse} onDone={markDone} />
                {today.length === 0 && startNow.length === 0 ? <p className="muted">No upcoming work needs a start today.</p> : null}
              </>}
              <TodoStrip space={space} />
            </div>
            {week.length + later.length > 0 ? <details className="work-card lookahead" open={today.length + startNow.length === 0}>
              <summary>Coming up <span className="faint">{week.length + later.length} items · next two weeks</span></summary>
              <Section title="This week" items={week} onOpenCourse={onOpenCourse} onDone={markDone} />
              <Section title="Next 7–14 days" items={later} onOpenCourse={onOpenCourse} onDone={markDone} />
            </details> : null}
            <LeetCode />
            {doneWeek > 0 ? <p className="weekly-done">✓ {doneWeek} deadlines due this week completed</p> : null}
          </div>

          <aside className="today-side" aria-label="Schedule and overdue work">
            <section className="card day-agenda">
              <div className="work-heading"><h2>Your schedule</h2><span className="faint">{clock(nowMin)}</span></div>
              <div className="focus-opening">
                <span className="section-title">{opening ? 'Next focus window' : 'Calendar is full'}</span>
                <strong>{opening ? `${spanLabel(opening.end - opening.start)} ${opening.start === nowMin ? 'available now' : 'at ' + clock(opening.start)}` : 'No 45-minute opening left today'}</strong>
                <span>{opening ? `Until ${clock(opening.end)} · based on timed calendar events` : 'Look ahead in Calendar for a longer work session.'}</span>
              </div>
              {plan.conflicts.length > 0 ? <details className="schedule-conflicts">
                <summary>{plan.conflicts.length} calendar overlap{plan.conflicts.length === 1 ? '' : 's'} to check</summary>
                {plan.conflicts.map(({ a, b }) => <p key={a.key + b.key}><strong>{clock(Math.max(a.start, b.start))}</strong> · {blockTitle(a)} overlaps {blockTitle(b)}</p>)}
              </details> : null}
              {allDayEvents.length > 0 ? <div className="all-day-events"><span className="section-title">All day</span>{allDayEvents.map(event => <p key={`${event.subscriptionId}-${event.uid}`}>{event.title}</p>)}</div> : null}
              {earlierCount > 0 ? <button className="btn ghost sm earlier-toggle" aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>{showEarlier ? 'Hide earlier events' : `Show ${earlierCount} earlier events`}</button> : null}
              <div className="rail">
                {visibleRail.map((r, i) => <span key={r.key} style={{ display: 'contents' }}>
                  {i === nowIdx ? <NowMark min={nowMin} /> : null}
                  <RailRow item={r} nowMin={nowMin} courseById={courseById}
                    onOpenLecture={id => { void openLecture(id).catch((err: Error) => announce(`Could not open the lecture note — ${err.message}`, { kind: 'error' })) }} />
                </span>)}
                {nowIdx === -1 ? <NowMark min={nowMin} /> : null}
              </div>
            </section>
            <OverduePanel overdue={overdue} stale={stale} open={showOverdue} onToggle={() => setShowOverdue(v => !v)}
              onOpenCourse={onOpenCourse} onDone={markDone} onTriage={triage} />
          </aside>
        </div>
      </div>
    </>
  )
}

/**
 * The debt, in its own right-hand column — Sunsama/Akiflow's pattern: the
 * unfinished sits BESIDE the day, always in sight, never interleaved with it. Overdue used to
 * hide behind a count at the BOTTOM of the screen — acknowledged, never seen, which is how items
 * pile up. The anti-guilt-wall is not hiding: the same-rule and same-course folds
 * compress spam to one row each, week-old items collapse behind "older", and "Not doing" lets a
 * dead item die with dignity (the existing tombstoned delete, relabeled). Red is spent ONLY on
 * the count and the date chips; rows stay graphite. At zero the whole column unmounts — that is
 * the earned empty state.
 */
function OverduePanel({
  overdue,
  stale,
  open,
  onToggle,
  onOpenCourse,
  onDone,
  onTriage,
}: {
  overdue: Deadline[]
  stale: Deadline[]
  open: boolean
  onToggle: () => void
  onOpenCourse: (id: string) => void
  onDone: (id: string, done: boolean) => void
  onTriage: (id: string, key: string, el: HTMLElement) => void
}) {
  const { deadlines, courseById, updateDeadline, saveDeadlines, announce } = useStore()
  const [showStale, setShowStale] = useState(false)
  const [openPiles, setOpenPiles] = useState<Set<string>>(() => new Set())
  const total = overdue.length + stale.length
  if (total === 0) return null

  const toToday = (d: Deadline): void => {
    void updateDeadline(d.id, { due: moveOverdueToDay(d.due, ymd(new Date())) })
  }
  /** One write for the whole batch — looping removeDeadline would race its own state closure. */
  const dismiss = (items: Deadline[]): void => {
    const ids = new Set(items.map((d) => d.id))
    const uids = items.map((d) => d.uid).filter((u): u is string => !!u)
    void saveDeadlines(deadlines.filter((d) => !ids.has(d.id)), uids).then((ok) => {
      if (ok)
        announce(items.length === 1 ? `Not doing “${items[0].title}”` : `Not doing ${items.length} items`, {
          undo: () => { void window.api.deadlines.get().then(fresh =>
            saveDeadlines([...fresh, ...items.filter(item => !fresh.some(d => d.id === item.id))])
          ).catch((err: Error) => announce(`Could not undo — ${err.message}`, { kind: 'error' })) },
        })
    })
  }

  /* Two-line compact rows: the column is 320px, so the wide 5-column grid stays in the main list. */
  const odRow = (d: Deadline) => {
    const course = courseById(d.courseId)
    return (
      <div
        key={d.id}
        className={`od-row${d.done ? ' done' : ''}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
          const k = e.key.toLowerCase()
          if (!'tdxjk'.includes(k)) return
          e.preventDefault()
          onTriage(d.id, k, e.currentTarget)
        }}
      >
        <input
          type="checkbox"
          aria-label={`Done: ${d.title}`}
          checked={d.done}
          onChange={(e) => {
            onDone(d.id, e.target.checked)
            void updateDeadline(d.id, { done: e.target.checked })
          }}
        />
        <div className="od-body">
          <div className="od-title" title={formatDue(d.due)}>
            {d.title}
          </div>
          <div className="od-meta">
            {course ? (
              <button
                type="button"
                className="chip course-chip"
                style={{ '--cc': course.color } as CSSProperties}
                onClick={() => onOpenCourse(course.id)}
              >
                {course.code}
              </button>
            ) : null}
            <span className="od-when">
              {daysUntil(d.due) === 0 ? 'past due' : relativeDue(d.due)}
              {dueTime(d.due) ? ` · ${dueTime(d.due)}` : ''}
            </span>
            <span className="od-verbs">
              <button type="button" className="btn ghost sm lrow-act" onClick={() => toToday(d)}>
                → Today
              </button>
              <button type="button" className="btn ghost sm lrow-act" onClick={() => dismiss([d])}>
                Not doing
              </button>
            </span>
          </div>
        </div>
      </div>
    )
  }

  const rows = foldSection(overdue)
  return (
    <section className="card overdue-card">
      <button type="button" className="overdue-head" aria-expanded={open} onClick={onToggle} title="Toggle (O)">
        <span className={`chev${open ? ' open' : ''}`} aria-hidden>
          ›
        </span>
        <span className="section-title" style={{ margin: 0 }}>
          Overdue
        </span>
        <span className="overdue-count">{total}</span>
        {!open ? <span className="faint">oldest {relativeDue((stale[0] ?? overdue[0]).due)}</span> : null}
      </button>

      {open ? (
        <>
          <div className="stack" style={{ gap: 2, marginTop: 6 }}>
            {rows.map((r) => {
              if (r.type === 'one') return odRow(r.d)
              const course = courseById(r.items[0].courseId)
              const rec = r.items[0].source === 'recurring'
              const pileOpen = openPiles.has(r.key)
              return (
                <div key={r.key}>
                  <div className="od-pile">
                    <button
                      type="button"
                      className="pile-toggle"
                      aria-expanded={pileOpen}
                      onClick={() =>
                        setOpenPiles((prev) => {
                          const next = new Set(prev)
                          if (next.has(r.key)) next.delete(r.key)
                          else next.add(r.key)
                          return next
                        })
                      }
                    >
                      <span className={`chev${pileOpen ? ' open' : ''}`} aria-hidden>
                        ›
                      </span>
                      {course ? (
                        <span className="chip course-chip" style={{ '--cc': course.color } as CSSProperties}>
                          {course.code}
                        </span>
                      ) : null}
                      <span className="t">{rec ? `${r.items[0].title} × ${r.items.length}` : `${r.items.length} items`}</span>
                      <span className="od-when">{relativeDue(r.items[0].due)}</span>
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm lrow-act"
                      title={`Not doing — all ${r.items.length}`}
                      onClick={() => dismiss(r.items)}
                    >
                      ×{r.items.length}
                    </button>
                  </div>
                  {pileOpen ? <div className="stack od-pile-items">{r.items.map(odRow)}</div> : null}
                </div>
              )
            })}
          </div>

          {stale.length > 0 ? (
            <div style={{ marginTop: 4 }}>
              <button
                type="button"
                className="btn ghost sm"
                aria-expanded={showStale}
                onClick={() => setShowStale((v) => !v)}
              >
                {stale.length} older · {showStale ? 'hide' : 'show'}
              </button>
              {showStale ? <div className="stack" style={{ gap: 2, marginTop: 4 }}>{stale.map(odRow)}</div> : null}
            </div>
          ) : null}

          <p className="faint od-hint">
            <kbd>T</kbd> today · <kbd>D</kbd> tmrw · <kbd>X</kbd> done · <kbd>O</kbd> hide
          </p>
        </>
      ) : null}
    </section>
  )
}

/** The red line of the rail: where you are in the day, in time order like everything else. */
function NowMark({ min }: { min: number }) {
  return (
    <div className="rail-now" aria-hidden>
      <span className="rail-time">{clock(min)}</span>
      <span className="rail-now-line" />
    </div>
  )
}

function RailRow({
  item,
  nowMin,
  courseById,
  onOpenLecture,
}: {
  item: RailItem
  nowMin: number
  courseById: (id: string | null) => { code: string; color: string } | undefined
  onOpenLecture: (courseId: string) => void
}) {
  if (item.kind === 'gap') {
    const left = (item.end ?? 0) - Math.max(item.start, nowMin)
    const evening = item.end === DAY_END
    return (
      <div className="rail-row gap">
        <span className="rail-time" />
        <span className="rail-spine" />
        <span className="rail-body faint">
          {spanLabel(left)} free{evening ? ' this evening' : ''}
        </span>
      </div>
    )
  }

  if (item.kind === 'due') {
    const d = item.deadline as Deadline
    const course = courseById(d.courseId)
    const late = !d.done && item.start <= nowMin
    return (
      <div className={`rail-row due${d.done ? ' done' : ''}${late ? ' overdue' : ''}`}>
        <span className="rail-time">{clock(item.start)}</span>
        <span className="rail-spine" />
        <span className="rail-body">
          {course ? (
            <span className="chip course-chip" style={{ '--cc': course.color } as CSSProperties}>
              {course.code}
            </span>
          ) : null}
          <span className="rail-due-title">{d.title}</span>
          <span className="faint" style={{ flex: 'none' }}>
            due
          </span>
        </span>
      </div>
    )
  }

  if (item.kind === 'event') {
    const e = item.event as { title: string; location: string; color: string }
    const current = item.start <= nowMin && nowMin < (item.end ?? 0)
    const past = (item.end ?? 0) <= nowMin
    return (
      <div
        className={`rail-row event${current ? ' current' : ''}${past ? ' past' : ''}`}
        style={{ '--cc': e.color } as CSSProperties}
      >
        <span className="rail-time">{clock(item.start)}</span>
        <span className="rail-spine" />
        <span className="rail-body">
          <span className="rail-event-title">{e.title}</span>
          {e.location ? <span className="faint">{e.location}</span> : null}
          {current ? <span className="rail-until">until {clock(item.end ?? 0)}</span> : null}
        </span>
      </div>
    )
  }

  const m = item.meeting as Meeting
  const course = courseById(m.courseId)
  const current = item.start <= nowMin && nowMin < (item.end ?? 0)
  const past = (item.end ?? 0) <= nowMin
  return (
    <button
      type="button"
      className={`rail-row class${current ? ' current' : ''}${past ? ' past' : ''}`}
      style={(course ? { '--cc': course.color } : {}) as CSSProperties}
      title={`${m.start}–${m.end}${m.location ? ` · ${m.location}` : ''} — open today's ${course?.code ?? m.courseId} note`}
      onClick={() => onOpenLecture(m.courseId)}
    >
      <span className="rail-time">{clock(item.start)}</span>
      <span className="rail-spine" />
      <span className="rail-body">
        <span className="rail-code">{course?.code ?? m.courseId}</span>
        {m.location ? <span className="faint">{m.location}</span> : null}
        {current ? <span className="rail-until">until {clock(item.end ?? 0)}</span> : null}
        <span className="rail-note faint">note ↗</span>
      </span>
    </button>
  )
}

/**
 * The ongoing list — a section of Today rather than a view of its own. It was a whole screen for
 * eighteen days and never held a single row: the capture was good, the destination was the
 * problem. Deliberately quieter than the deadlines above it, so a chore is never mistaken at a
 * glance for something that carries a grade.
 */
function TodoStrip({ space }: { space: string }) {
  const { todos, updateTodo, removeTodo, courseById } = useStore()
  /**
   * Ticked in this sitting: the row stays, struck through, instead of vanishing under the cursor.
   * Same rule the deadline rows above follow — the confirmation is the row itself, and Ctrl+Z can
   * still put it back while you are looking at it.
   */
  const [justDone, setJustDone] = useState<Set<string>>(() => new Set())
  /**
   * Priority is the due date: overdue first (they are the ones going wrong), then dated work
   * soonest-first, then the undated pool in the order it was captured. A todo with a date was
   * given one on purpose — it must not queue behind three weeks of "someday".
   */
  const open = todos
    .filter((t) => (!t.done || justDone.has(t.id)) && (space === 'all' || (t.courseId ?? 'unfiled') === space))
    .sort((a, b) => {
      if (!a.due && !b.due) return 0
      if (!a.due) return 1
      if (!b.due) return -1
      // Real dates, not string compare: a hand-edited timed due must not order by its UTC day.
      return dueDate(a.due).getTime() - dueDate(b.due).getTime()
    })

  const tick = (id: string, done: boolean): void => {
    setJustDone((prev) => {
      const next = new Set(prev)
      if (done) next.add(id)
      else next.delete(id)
      return next
    })
    void updateTodo(id, done ? { done: true, completedAt: new Date().toISOString() } : { done: false })
  }

  /**
   * The heading stays even at zero. Hiding an empty list is tidier and completely wrong here: with
   * nothing to show there was no evidence anywhere on this screen that todos existed at all, so the
   * only people who could find the feature were the ones who already knew about it. The prompt
   * below teaches the one thing you need and then disappears the moment you use it.
   */
  if (open.length === 0) {
    return (
      <section style={{ marginBottom: 'var(--sp-4)' }}>
        <h2 className="section-title">Todos</h2>
        <p className="faint" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
          Anything with no date lands here. Type <em>email the course TA</em> above and press <kbd>Enter</kbd>.
        </p>
      </section>
    )
  }

  return (
    <section style={{ marginBottom: 'var(--sp-4)' }}>
      <h2 className="section-title">Todos</h2>
      <div className="stack" style={{ gap: 0 }}>
        {open.map((t) => {
          const course = courseById(t.courseId)
          const boxId = `today-todo-${t.id}`
          return (
            <div key={t.id} className="todo" style={t.done ? { opacity: 0.45 } : undefined}>
              <input
                id={boxId}
                type="checkbox"
                checked={!!t.done}
                onChange={(e) => tick(t.id, e.target.checked)}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <label
                  className="title"
                  htmlFor={boxId}
                  style={{ display: 'block', cursor: 'pointer', textDecoration: t.done ? 'line-through' : undefined }}
                >
                  {t.text}
                </label>
                {course || t.due ? (
                  <div className="meta">
                    {course ? (
                      <span className="chip course-chip" style={{ '--cc': course.color } as CSSProperties}>
                        {course.code}
                      </span>
                    ) : null}
                    {t.due ? (
                      <span style={!t.done && daysUntil(t.due) < 0 ? { color: OVERDUE_INK } : undefined}>
                        {formatDue(t.due)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                className="btn ghost sm"
                aria-label={`Remove ${t.text}`}
                title="Remove"
                onClick={() => void removeTodo(t.id)}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * A run of ≥3 same-course items due the same day folds into one row. Eleven module
 * checkboxes from one course all reading "in 6 days" made a two-minute survey indistinguishable from a pset and
 * turned this screen into a wall — the pile is one fact, and the expansion is one click when the
 * pile is actually today's work.
 */
type SectionRow = { type: 'one'; d: Deadline } | { type: 'pile'; key: string; items: Deadline[] }

function foldSection(items: Deadline[]): SectionRow[] {
  // Recurring occurrences fold by RULE, across days — five "gym" rows in "This week" are one fact
  // about the week, exactly as a pile of same-day modules is one fact about the day.
  const keyOf = (d: Deadline): string =>
    d.source === 'recurring'
      ? `rec|${d.id.replace(/-\d{4}-\d{2}-\d{2}$/, '')}`
      : !d.courseId || d.kind === 'exam' ? d.id : `${d.courseId}|${localDay(dueDate(d.due))}`
  const byPile = new Map<string, Deadline[]>()
  for (const d of items) {
    const k = keyOf(d)
    const pile = byPile.get(k)
    if (pile) pile.push(d)
    else byPile.set(k, [d])
  }
  const out: SectionRow[] = []
  const folded = new Set<string>()
  for (const d of items) {
    const k = keyOf(d)
    const pile = byPile.get(k) ?? []
    if (pile.length >= 3) {
      if (!folded.has(k)) {
        folded.add(k)
        out.push({ type: 'pile', key: k, items: pile })
      }
    } else {
      out.push({ type: 'one', d })
    }
  }
  return out
}

function Section({
  title,
  items,
  onOpenCourse,
  onDone,
}: {
  title: string
  items: Deadline[]
  onOpenCourse: (id: string) => void
  onDone: (id: string, done: boolean) => void
}) {
  const { courseById } = useStore()
  const [openPiles, setOpenPiles] = useState<Set<string>>(() => new Set())
  if (items.length === 0) return null
  const rows = foldSection(items)
  return (
    <section style={{ marginBottom: 'var(--sp-4)' }}>
      <h2 className="section-title">{title}<span className="section-count">{items.filter(d => !d.done).length}</span></h2>
      <div className="stack" style={{ gap: 6 }}>
        {rows.map((r) => {
          if (r.type === 'one') return <Row key={r.d.id} deadline={r.d} onOpenCourse={onOpenCourse} onDone={onDone} />
          const course = courseById(r.items[0].courseId)
          const open = openPiles.has(r.key)
          return (
            <div key={r.key}>
              <button
                type="button"
                className="pile-row"
                aria-expanded={open}
                onClick={() =>
                  setOpenPiles((prev) => {
                    const next = new Set(prev)
                    if (next.has(r.key)) next.delete(r.key)
                    else next.add(r.key)
                    return next
                  })
                }
              >
                <span className={`chev${open ? ' open' : ''}`} aria-hidden>
                  ›
                </span>
                {course ? (
                  <span className="chip course-chip" style={{ '--cc': course.color } as CSSProperties}>
                    {course.code}
                  </span>
                ) : null}
                <span className="t">
                  {r.items[0].source === 'recurring'
                    ? `${r.items[0].title} × ${r.items.length}`
                    : `${r.items.length} items`}
                </span>
                <span className="faint">
                  {(() => {
                    const a = relativeDue(r.items[0].due)
                    const b = relativeDue(r.items[r.items.length - 1].due)
                    return r.items[0].source === 'recurring' && a !== b ? `${a} – ${b}` : a
                  })()}
                </span>
              </button>
              {open ? (
                <div className="stack" style={{ gap: 6, marginTop: 6, marginLeft: 22 }}>
                  {r.items.map((d) => (
                    <Row key={d.id} deadline={d} onOpenCourse={onOpenCourse} onDone={onDone} />
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Row({
  deadline,
  onOpenCourse,
  onDone,
  onTriage,
}: {
  deadline: Deadline
  onOpenCourse: (id: string) => void
  onDone: (id: string, done: boolean) => void
  /** Present on overdue rows, which is where single-key triage earns its keep. */
  onTriage?: (id: string, key: string, el: HTMLElement) => void
}) {
  const { courses, courseById, updateDeadline, removeDeadline } = useStore()
  const [editing, setEditing] = useState(false)
  const course = courseById(deadline.courseId)
  const isOverdue = !deadline.done && dueDate(deadline.due).getTime() < Date.now()
  const boxId = `done-${deadline.id}`

  /**
   * Fixing a typo used to mean delete-and-retype. The same parser the capture field uses runs over
   * the committed text, so a date or course typed into the title moves the deadline too.
   */
  const commit = (raw: string): void => {
    setEditing(false)
    const value = raw.trim()
    if (!value || value === deadline.title) return
    const parsed = parseEntry(value, courses)
    // An "every …" typed into a RENAME is kept as plain words. Editing one row must not spawn a
    // rule, and without chips there is no way to show — or take back — a recurrence claim, so
    // silently stripping the phrase from the title is the one thing this must never do.
    if (parsed.every) {
      void updateDeadline(deadline.id, { title: value })
      return
    }
    void updateDeadline(deadline.id, {
      title: parsed.title || value,
      ...(parsed.due ? { due: parsed.due } : {}),
      ...(parsed.courseId ? { courseId: parsed.courseId } : {}),
    })
  }

  return (
    <div
      className={`lrow${isOverdue ? ' overdue' : ''}${deadline.done ? ' done' : ''}`}
      /* Why this row sits where it does, on hover. Nothing new on screen. */
      title={priorityNote(deadline)}
      tabIndex={onTriage ? 0 : undefined}
      onKeyDown={
        onTriage
          ? (e) => {
              // Single letters must never fire into a field — the capture input is right above.
              if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
              const k = e.key.toLowerCase()
              if (!'tdxjk'.includes(k)) return
              e.preventDefault()
              onTriage(deadline.id, k, e.currentTarget)
            }
          : undefined
      }
    >
      <input
        id={boxId}
        type="checkbox"
        aria-label={`Complete ${deadline.title}`}
        checked={deadline.done}
        onChange={(e) => {
          onDone(deadline.id, e.target.checked)
          void updateDeadline(deadline.id, { done: e.target.checked })
        }}
      />

      {editing ? (
        // Re-parsed on commit, so retyping "Pset 4 fri 5pm" moves the date in the same gesture.
        <input
          className="input lrow-edit"
          defaultValue={deadline.title}
          autoFocus
          aria-label="Rename this deadline"
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value)
            if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          className="title lrow-title"
          title={`${deadline.title} — click to edit`}
          onClick={() => setEditing(true)}
        >
          {deadline.title}
        </button>
      )}

      {course ? (
        <button
          className="chip course-chip lrow-course"
          style={{ '--cc': course.color } as CSSProperties}
          title={`${course.title} · ${KIND_LABELS[deadline.kind]}`}
          onClick={() => onOpenCourse(course.id)}
        >
          {course.code}
        </button>
      ) : (
        <span />
      )}

      {/* Fixed column: the due date sits at the same x on every row, so the list is scannable
          rather than readable. Absolute date on hover; the clock is shown, not hidden — "today"
          alone reads as midnight when the cutoff is 9 am. */}
      <span className="lrow-due" title={formatDue(deadline.due)}>
        {relativeDue(deadline.due)}
        {dueTime(deadline.due) ? <span className="lrow-at">{dueTime(deadline.due)}</span> : null}
      </span>

      {/* No confirm dance: undo is the safety net, and it costs nothing on the common path. */}
      <button
        className="btn ghost sm lrow-del"
        aria-label={`Delete ${deadline.title}`}
        onClick={() => void removeDeadline(deadline.id)}
      >
        ×
      </button>
    </div>
  )
}
