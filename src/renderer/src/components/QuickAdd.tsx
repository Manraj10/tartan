import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { WEEKDAY_LABELS, parseEntry, spanKey, type DeadlineKind } from '@shared/types'
import { useStore, dueDate, isAllDay } from '../store'

/**
 * One field instead of six.
 *
 * Today's quick-add was six tab stops and Todos was four, and having two forms meant deciding
 * "deadline or todo" before typing a character. Here the presence of a date decides: type a date
 * and it becomes a deadline, leave it out and it becomes a todo. Shift+Enter forces the other one.
 *
 * Every recognised word shows as a chip that can be dismissed, which is the non-optional half —
 * a parser without a visible, reversible result silently gives you wrong dates.
 *
 * The Options row is the other door into the same result: course, date, time and repeat as
 * clickable pickers for anyone who would rather point than type the syntax. A picker always beats
 * the parser where both have an opinion — a control someone deliberately set is not a guess.
 */

export interface QuickAddResult {
  title: string
  courseId: string | null
  kind: DeadlineKind
  due: string
  /** "every mon wed" was typed: this is a recurring rule, and `due` is empty. */
  every: { days: number[]; time?: string; from?: string } | null
}

type Repeat = 'none' | 'day' | 'week'

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The local calendar day a parsed due refers to, whether it carries a time or not. */
const dayOf = (due: string): string => (isAllDay(due) ? due : ymd(dueDate(due)))

export default function QuickAdd({
  placeholder,
  onSubmit,
}: {
  placeholder: string
  onSubmit: (entry: QuickAddResult, asDeadline: boolean) => Promise<boolean>
}) {
  const { courses, announce } = useStore()
  const [saving, setSaving] = useState(false)
  const [text, setText] = useState('')
  const [ignored, setIgnored] = useState<string[]>([])
  const [showOpts, setShowOpts] = useState(false)
  const [optCourse, setOptCourse] = useState('')
  const [optDate, setOptDate] = useState('')
  const [optTime, setOptTime] = useState('')
  const [optRepeat, setOptRepeat] = useState<Repeat>('none')
  const [optDays, setOptDays] = useState<number[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const parsed = useMemo(() => parseEntry(text, courses, { ignore: ignored }), [text, courses, ignored])

  /**
   * Pickers over parser, parser over nothing — COMPONENT-WISE. An empty picker has no opinion,
   * so the typed half survives: moving "essay fri 11:59pm" with the date picker keeps 11:59 pm,
   * and Repeat=Weekly on "gym every mon wed" keeps Mon & Wed. Repeat with no chips and no typed
   * days follows the picked date's weekday ("weekly on this date"), falling back to today — and a
   * picked date (else the date typed into the line) also becomes the rule's `from`, so no
   * occurrence lands before the day you chose.
   */
  const merged = useMemo(() => {
    const courseId = optCourse || parsed.courseId
    const parsedTime =
      parsed.due && !isAllDay(parsed.due)
        ? `${pad(dueDate(parsed.due).getHours())}:${pad(dueDate(parsed.due).getMinutes())}`
        : ''
    const time = optTime || parsed.every?.time || parsedTime

    // Where a rule starts: the picked date, else the day typed into the line.
    const start = optDate || (parsed.due ? dayOf(parsed.due) : '')
    const from = start ? { from: start } : {}

    let every: QuickAddResult['every'] = null
    if (optRepeat === 'day') {
      every = { days: [0, 1, 2, 3, 4, 5, 6], ...(time ? { time } : {}), ...from }
    } else if (optRepeat === 'week') {
      const [y, m, d] = (start || ymd(new Date())).split('-').map(Number)
      const fallback = (new Date(y, m - 1, d).getDay() + 6) % 7
      const days = optDays.length ? optDays : parsed.every?.days?.length ? parsed.every.days : [fallback]
      every = { days, ...(time ? { time } : {}), ...from }
    } else if (parsed.every) {
      every = { ...parsed.every, ...(optTime ? { time: optTime } : {}), ...(optDate ? { from: optDate } : {}) }
    }
    if (every) return { courseId, due: '', every }

    let due = parsed.due
    const day = optDate || (due ? dayOf(due) : time ? ymd(new Date()) : '')
    if (day && (optDate || optTime)) due = time ? new Date(`${day}T${time}`).toISOString() : day
    return { courseId, due, every: null }
  }, [parsed, optCourse, optDate, optTime, optRepeat, optDays])

  /**
   * The date is the whole decision, on every screen. "01-101 pset 4 friday" is a deadline;
   * "email the TA" is a todo. Nothing to choose before typing, and the same line means the same
   * thing wherever it is typed.
   */
  const isDeadline = merged.due !== ''
  const optsActive = optCourse !== '' || optDate !== '' || optTime !== '' || optRepeat !== 'none'

  const resetOpts = (): void => {
    setOptCourse('')
    setOptDate('')
    setOptTime('')
    setOptRepeat('none')
    setOptDays([])
  }

  const submit = async (e: FormEvent, flip = false): Promise<void> => {
    e.preventDefault()
    const title = parsed.title.trim()
    if (!title || saving) return
    setSaving(true)
    try {
      const saved = await onSubmit(
        { title, courseId: merged.courseId, kind: parsed.kind, due: merged.due, every: merged.every },
        // A rule already knows what it materializes as; Shift+Enter has nothing to flip.
        merged.every ? isDeadline : flip ? !isDeadline : isDeadline,
      )
      if (!saved) return
      setText('')
      setIgnored([])
      resetOpts()
    } catch (err) {
      announce(`Could not save — ${(err as Error).message}`, { kind: 'error' })
    } finally {
      setSaving(false)
      inputRef.current?.focus({ preventScroll: true })
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && e.shiftKey) void submit(e, true)
  }

  const target = merged.every ? 'Recurring' : isDeadline ? 'Deadline' : 'Todo'
  const course = merged.courseId ? courses.find((c) => c.id === merged.courseId) : undefined

  return (
    <form className="quickadd" onSubmit={(e) => void submit(e)} aria-busy={saving}>
      <div className="row" style={{ gap: 6 }}>
        <input
          ref={inputRef}
          className="input"
          style={{ flex: 1 }}
          placeholder={placeholder}
          aria-label={placeholder}
          value={text}
          readOnly={saving}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className={`btn ghost sm${showOpts || optsActive ? ' on' : ''}`}
          aria-expanded={showOpts}
          title="Pick course, date, time and repeat instead of typing them"
          onClick={() => setShowOpts((v) => !v)}
          style={{ marginRight: -9 }}
        >
          Options
        </button>
        {text.trim() ? <button className="btn primary sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add'}</button> : null}
      </div>

      {showOpts ? (
        <div className="quickadd-opts">
          <select
            className="select sm"
            aria-label="Course"
            value={optCourse}
            onChange={(e) => setOptCourse(e.target.value)}
          >
            <option value="">Course…</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
          <input
            className="input sm"
            type="date"
            aria-label="Due date"
            value={optDate}
            onChange={(e) => setOptDate(e.target.value)}
          />
          <input
            className="input sm"
            type="time"
            aria-label="Due time"
            value={optTime}
            onChange={(e) => setOptTime(e.target.value)}
          />
          <select
            className="select sm"
            aria-label="Repeats"
            value={optRepeat}
            onChange={(e) => setOptRepeat(e.target.value as Repeat)}
          >
            <option value="none">Doesn’t repeat</option>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
          </select>
          {optRepeat === 'week' ? (
            <div className="row" style={{ gap: 4 }} role="group" aria-label="Repeat on">
              {WEEKDAY_LABELS.map((label, day) => (
                <button
                  key={label}
                  type="button"
                  className={`day-chip${optDays.includes(day) ? ' on' : ''}`}
                  aria-pressed={optDays.includes(day)}
                  aria-label={label}
                  title={label}
                  onClick={() =>
                    setOptDays((prev) => (prev.includes(day) ? prev.filter((x) => x !== day) : [...prev, day].sort()))
                  }
                >
                  {label[0]}
                </button>
              ))}
            </div>
          ) : null}
          {optsActive ? (
            <button type="button" className="btn ghost sm" onClick={resetOpts}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {text.trim() || optsActive ? (
        <div className="quickadd-hint">
          <span className="faint">
            → <strong>{target}</strong>
            {course ? ` · ${course.code}` : ''}
            {merged.every
              ? ` · every ${merged.every.days.length === 7 ? 'day' : merged.every.days.map((d) => WEEKDAY_LABELS[d]).join(' & ')}${merged.every.time ? ` at ${clock(merged.every.time)}` : ''}`
              : merged.due
                ? ` · ${formatParsed(merged.due)}`
                : ''}
          </span>
          {parsed.spans.map((s) => (
            <button
              key={`${s.type}-${s.start}`}
              type="button"
              className="chip"
              title={`Not a ${s.type} — put “${s.text}” back in the title`}
              onClick={() => setIgnored((prev) => [...prev, spanKey(s.type, s.text)])}
            >
              {s.label}
              <span aria-hidden="true" style={{ opacity: 0.6 }}>
                ×
              </span>
            </button>
          ))}
          {ignored.length ? (
            <button type="button" className="btn ghost sm" onClick={() => setIgnored([])}>
              Reset
            </button>
          ) : null}
          <span className="spacer" />
          <span className="faint">
            {parsed.title.trim() ? (
              <>
                <kbd>Enter</kbd> add
                {merged.every ? null : (
                  <>
                    {' '}
                    · <kbd>Shift Enter</kbd> as {isDeadline ? 'todo' : 'deadline'}
                  </>
                )}
              </>
            ) : (
              // Enter does nothing with no title, so say why instead of advertising it.
              'Needs a title'
            )}
          </span>
        </div>
      ) : null}
    </form>
  )
}

/** A rule's 'HH:MM' the way the time chip and formatParsed show a time: '15:00' → '3:00 PM'. */
function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatParsed(due: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T12:00:00` : due)
  if (Number.isNaN(d.getTime())) return due
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return /^\d{4}-\d{2}-\d{2}$/.test(due)
    ? date
    : `${date}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}
