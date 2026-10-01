import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react'
import { KIND_LABELS, type Course, type DeadlineKind } from '@shared/types'
import { useStore } from '../store'

export interface ParsedRow {
  title: string
  due: string
  kind: DeadlineKind
}

const KINDS = Object.keys(KIND_LABELS) as DeadlineKind[]
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MAX_ROWS = 200

const WEEKDAY = String.raw`(?:\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\.?\s*,?\s*)?`
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`
const ORDINAL = String.raw`(?:st|nd|rd|th)?`
/** "Sep 14-16" is one deadline, not two: swallow the tail so it never becomes its own row. */
const RANGE_TAIL = String.raw`(?:\s*[-–—]\s*\d{1,2}${ORDINAL})?`

/**
 * Five ways to write a date, in capture groups 1-3 (2026-09-14), 4-6 (Sep 14, 2026), 7-9
 * (14 September 2026), 10-12 (9/14 or 14/09/2026) and 13-15 (14.09.2026). Order matters at one
 * position only; the leftmost match wins, so each form has to refuse the text its neighbours own.
 */
const DATE_RE = new RegExp(
  WEEKDAY +
    String.raw`(?:(\d{4})-(\d{1,2})-(\d{1,2})` +
    // The day must not run into a year: without (?!\d), "September 2026" reads as September 20.
    `|${MONTH}\\.?\\s*(\\d{1,2})(?!\\d)${ORDINAL}(?:\\s*,?\\s*(\\d{4}))?` +
    // Day first. "Problem set 2 Oct 5" must stay Oct 5, so a bare day number after the month means
    // this is not the day — unless that number is a clock time ("14 Sep 5pm").
    `|(?<!\\d)(\\d{1,2})${ORDINAL}\\s*(?:of\\s+)?${MONTH}\\b\\.?(?:\\s*,?\\s*(\\d{4}))?(?!\\s*\\d{1,2}(?!\\d|\\s*[ap]\\.?m|:\\d))` +
    String.raw`|(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?` +
    String.raw`|(\d{1,2})\.(\d{1,2})\.(\d{4}))` +
    RANGE_TAIL,
  'gi',
)

// "pages 10-12" and "3-4pm" are not dates, but the bare M-D form cannot tell on its own.
const RANGE_NOISE = /(?:pages?|pp|chapters?|ch|sections?|problems?|questions?|exercises?|weeks?|nos?|#)\.?\s*$/i
const CLOCK_TAIL = /^\s*(?:[ap]\.?m\.?|:\d)/i

/**
 * The words that introduce a date and mean nothing once it is lifted out: "Assigned Oct 5 | Due
 * Oct 12" would otherwise leave "Assigned |" in the title, and "by 10/2 at 5pm" a stranded "by".
 * "deadline", "opens", "starts" and "posted" are part of the phrase in "Drop deadline Oct 20" or
 * "Grades posted Nov 5", so they only count as labels when a colon or dash follows ("Deadline: Oct 12").
 */
const DATE_LABEL = /(?:(?:\b(?:assigned|released|given|out|due(?:\s+date)?|by|on|before|until|till|through|thru)\b|\b(?:deadline|opens?|starts?|posted)\b(?=\s*[:\-–—]))[\s:\-–—]*)+$/i
/** The label that says THIS date is the one the work is handed in. */
const DUE_LABEL = /\b(?:due|deadline)(?:\s+(?:by|on|date))?[\s:\-–—]*$/i
/** Only a connector sits between the two dates of "Sep 14 to Sep 18": part of the span, not the title. */
const RANGE_JOIN = /^\s*(?:to|through|thru|until|till|[-–—])\s*$/i

/**
 * Order matters: the first pattern to match wins. `pset` sits above `exam` because "final" appears
 * in "Final project", "Final paper" and "Final draft" far more often than a syllabus line means an
 * actual exam — and nothing regresses, because "Midterm Exam" and "Final exam" contain no pset word.
 */
const KIND_PATTERNS: [DeadlineKind, RegExp][] = [
  ['pset', /\b(?:pset|problems?(?:\s+set)?|homework|hw|assignment|lab|project|paper|draft|essay)/i],
  ['exam', /\b(?:exam|midterm|final)/i],
  ['quiz', /\bquiz/i],
  ['reading', /\b(?:reading|read|chapter|ch\.)/i],
  ['admin', /\b(?:drop|add|deadline|register|withdraw)/i],
]

/** A CMU course number opens a line far more often than February 25th does. */
const COURSE_CODE_LINE = /^\s*\d{2}-\d{3}\b/

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  // Rejects Feb 30 and friends, which Date would silently roll into the next month.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** What a match says, and whether its year was written down or filled in from the Year field. */
function toParts(m: RegExpMatchArray, year: number): { y: number; mo: number; d: number; guessed: boolean } | null {
  const month = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1
  if (m[1] !== undefined) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), guessed: false }
  if (m[4] !== undefined) {
    return { y: m[6] !== undefined ? Number(m[6]) : year, mo: month(m[4]), d: Number(m[5]), guessed: m[6] === undefined }
  }
  if (m[8] !== undefined) {
    return { y: m[9] !== undefined ? Number(m[9]) : year, mo: month(m[8]), d: Number(m[7]), guessed: m[9] === undefined }
  }
  if (m[10] !== undefined) {
    let mo = Number(m[10])
    let d = Number(m[11])
    // 14/09/2026 cannot be month 14, so it is day-first. 03/10/2026 stays month-first: a guess either way.
    if (mo > 12 && d <= 12) [mo, d] = [d, mo]
    const raw = m[12]
    const y = raw === undefined ? year : Number(raw) < 100 ? 2000 + Number(raw) : Number(raw)
    return { y, mo, d, guessed: raw === undefined }
  }
  // A dotted date is European, so day first.
  if (m[13] !== undefined) return { y: Number(m[15]), mo: Number(m[14]), d: Number(m[13]), guessed: false }
  return null
}

function isNoise(line: string, m: RegExpMatchArray, start: number): boolean {
  const dayFirst = m[7] !== undefined
  const bare = m[10] !== undefined && !m[0].includes('/')
  // "Unit 2 may be skipped" is a verb. Day-first reads lowercase "may" as a month only with an
  // ordinal ("2nd may"), an "of", or a year; "14 May" with a capital is still May.
  if (dayFirst && m[8] === 'may' && m[9] === undefined) {
    if (!/\d(?:st|nd|rd|th)|\bof\b/i.test(m[0].slice(0, m[0].search(/may/i)))) return true
  }
  if (!dayFirst && !bare) return false
  // "02-251 Great Ideas…" is a course, not February 25th. Only the bare M-D form reaches here, and
  // on a line that opens with a CMU number that form is a course code every time.
  if (bare && COURSE_CODE_LINE.test(line) && start === line.length - line.trimStart().length) return true
  return RANGE_NOISE.test(line.slice(0, start)) || (bare && CLOCK_TAIL.test(line.slice(start + m[0].length)))
}

function cleanTitle(raw: string): string {
  let t = raw
    // Brackets emptied by the same lift: "(assigned Oct 5, due Oct 12)" leaves "( , )".
    .replace(/\([\s\p{P}\p{S}]*\)|\[[\s\p{P}\p{S}]*\]/gu, ' ')
    .replace(/\s+/g, ' ')
    // A date lifted out of the middle leaves "| |", "- -" or ": :" behind.
    .replace(/([|\-–—:])(?:\s+[|\-–—:])+/g, '$1')
    .trim()
  t = t.replace(/^[\s\-–—*•|>#.,:;]+/, '')
  t = t.replace(/^week\s*\d+\s*[:.\-–—]*\s*/i, '')
  t = t.replace(/^\d+\s*[.)]\s*/, '')
  t = t.replace(/^[\s\-–—*•|>#.,:;]+/, '')
  t = t.replace(/[\s\-–—*•|.,:;]+$/, '')
  // Lifting the date out of "Problem Set 1 due Sep 4" leaves the preposition stranded on the end.
  t = t.replace(/\s+(?:due|on|at|by|is|for)$/i, '')
  return t.trim()
}

function inferKind(line: string): DeadlineKind {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(line)) return kind
  return 'other'
}

/**
 * `year` fills in dates that do not carry one. A yearless month that falls back by more than half a
 * year from the yearless date before it belongs to the year after, and every later one with it — a
 * fall syllabus that runs "Sep 14 … Dec 9 … Jan 20" ends in January, not in the January before it
 * started. Comparing against the previous date rather than the first keeps a key-dates line at the
 * top ("Final Dec 10") from pushing the weekly table under it a year ahead.
 */
export function parseSyllabus(text: string, year: number): ParsedRow[] {
  const rows: ParsedRow[] = []
  const seen = new Set<string>()
  let prevMonth = 0
  let bump = 0

  for (const line of text.split(/\r?\n/)) {
    const hits: { start: number; end: number; due: string }[] = []
    for (const m of line.matchAll(DATE_RE)) {
      const start = m.index
      if (start === undefined || isNoise(line, m, start)) continue
      const p = toParts(m, year)
      let due = p && ymd(p.y, p.mo, p.d)
      if (!p || !due) continue
      if (p.guessed) {
        if (prevMonth - p.mo > 6) bump++
        // A stray early-month row ("Jan 5 Spring registration" between Nov and Dec) rolled the year
        // on its own; the month rising back up undoes that one roll.
        else if (bump && p.mo - prevMonth > 6) bump--
        prevMonth = p.mo
        if (bump) due = ymd(p.y + bump, p.mo, p.d)
      }
      if (due) hits.push({ start, end: start + m[0].length, due })
    }
    if (hits.length === 0) continue

    let stripped = ''
    let cursor = 0
    for (const [i, h] of hits.entries()) {
      const gap = line.slice(cursor, h.start)
      const label = DATE_LABEL.exec(gap)
      stripped += `${i > 0 && RANGE_JOIN.test(gap) ? '' : line.slice(cursor, label ? cursor + label.index : h.start)} `
      cursor = h.end
    }
    stripped += line.slice(cursor)

    const title = cleanTitle(stripped)
    if (title.length < 3) continue

    // "Assigned Oct 5 | Due Oct 12" is due on the 12th. With no label, the last date is the one the
    // row is working toward.
    const due = (hits.find((h) => DUE_LABEL.test(line.slice(0, h.start))) ?? hits[hits.length - 1]).due
    const key = JSON.stringify([title, due])
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ title, due, kind: inferKind(line) })
    if (rows.length >= MAX_ROWS) break
  }

  return rows.sort((a, b) => a.due.localeCompare(b.due))
}

interface Row extends ParsedRow {
  id: number
  on: boolean
}

const SR: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}
const AUTO: CSSProperties = { width: 'auto' }

export default function SyllabusImport({
  courses,
  onImport,
  onClose,
}: {
  courses: Course[]
  onImport: (rows: { title: string; due: string; kind: DeadlineKind; courseId: string | null }[]) => Promise<boolean>
  onClose: () => void
}) {
  const { deadlines, announce } = useStore()
  const [text, setText] = useState('')
  const [courseId, setCourseId] = useState('')
  const [year, setYear] = useState(() => String(new Date().getFullYear()))
  const [rows, setRows] = useState<Row[] | null>(null)
  /** Rows that arrived unticked, so the footer can say why the count does not match. */
  const [held, setHeld] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmBack, setConfirmBack] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const selected = useMemo(() => (rows ?? []).filter((r) => r.on && r.title.trim() && r.due), [rows])

  const patch = (id: number, p: Partial<Row>): void =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...p } : r)))

  const find = (): void => {
    setError('')
    const y = Number.parseInt(year, 10)
    const parsed = parseSyllabus(text, Number.isFinite(y) ? y : new Date().getFullYear())
    // en-CA prints a local date as YYYY-MM-DD, which is the form a due date is stored in.
    const today = new Date().toLocaleDateString('en-CA')
    // A timed deadline is stored in UTC, so its first ten characters can be tomorrow in New York.
    const dayOf = (due: string): string => (due.length > 10 ? new Date(due).toLocaleDateString('en-CA') : due)
    const have = new Set(deadlines.map((d) => `${d.title.trim().toLowerCase()}|${dayOf(d.due)}`))
    // A week-by-week table lists lectures that already happened, and importing the same page twice
    // is easy. Both arrive unticked rather than as a pile of overdue duplicates.
    const next = parsed.map((r, i) => ({
      ...r,
      id: i,
      on: r.due >= today && !have.has(`${r.title.toLowerCase()}|${r.due}`),
    }))
    setHeld(next.filter((r) => !r.on).length)
    setRows(next)
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const ok = await onImport(
        selected.map((r) => ({
          title: r.title.trim(),
          due: r.due,
          kind: r.kind,
          courseId: courseId || null,
        })),
      )
      // A failed write has already put its error in the status pill, but the pill sits under this
      // dialog's scrim, so say it here too. Announcing "Imported" would replace that pill, so stay
      // open with the rows still ticked for another try.
      if (!ok) {
        setError('Could not save the deadlines, so nothing was imported.')
        setBusy(false)
        return
      }
      // The dialog closes on success, so this is the only place the count is ever seen.
      announce(`Imported ${selected.length} deadline${selected.length === 1 ? '' : 's'} from the syllabus.`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.')
      setBusy(false)
    }
  }

  const onBackdrop = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      onMouseDown={onBackdrop}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        // Above the fixed status pill (z 60) — a modal a pill can paint over is not modal.
        zIndex: 100,
      }}
    >
      <div
        className="card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sy-heading"
        style={{
          width: 760,
          maxWidth: '100%',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflow: 'hidden',
        }}
      >
        <div className="row">
          <h2 id="sy-heading" style={{ margin: 0, fontSize: 'var(--fs-md)' }}>
            Import from syllabus
          </h2>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </div>

        {rows === null ? (
          <>
            <div className="stack" style={{ flex: 1, overflowY: 'auto', gap: 10 }}>
              <label className="faint" htmlFor="sy-text">
                Paste the schedule section of a syllabus or course page
              </label>
              <textarea
                id="sy-text"
                className="textarea"
                autoFocus
                rows={14}
                spellCheck={false}
                style={{ fontFamily: 'var(--mono)', resize: 'vertical' }}
                placeholder={'Week 1 | Sep 14 | Pset 1 due\nOct 3 - Midterm 1\n10/28 Reading: chapter 7'}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>

            <div className="row" style={{ flexWrap: 'wrap' }}>
              <label className="faint" htmlFor="sy-course">
                Course
              </label>
              <select
                id="sy-course"
                className="select"
                style={AUTO}
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
              >
                <option value="">No course</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}
                  </option>
                ))}
              </select>

              <label className="faint" htmlFor="sy-year">
                Year
              </label>
              <input
                id="sy-year"
                className="input"
                type="number"
                min={2000}
                max={2100}
                style={{ width: 90 }}
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />

              <div className="spacer" style={{ flex: 1 }} />
              <button className="btn primary" onClick={find} disabled={text.trim() === ''}>
                Find dates
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="stack" style={{ flex: 1, overflowY: 'auto', gap: 6 }}>
              {rows.length === 0 ? (
                <div className="empty">
                  No dates found. Check the year field, or paste a section that actually lists dates —
                  a week-by-week schedule or an assignment table.
                </div>
              ) : (
                rows.map((r) => (
                  <div key={r.id} className="row" style={{ gap: 8 }}>
                    <input
                      id={`sy-on-${r.id}`}
                      type="checkbox"
                      checked={r.on}
                      onChange={(e) => patch(r.id, { on: e.target.checked })}
                    />
                    <label htmlFor={`sy-on-${r.id}`} style={SR}>
                      Import this row
                    </label>

                    <label htmlFor={`sy-title-${r.id}`} style={SR}>
                      Title
                    </label>
                    <input
                      id={`sy-title-${r.id}`}
                      className="input"
                      style={{ flex: 1, minWidth: 0, width: 'auto' }}
                      value={r.title}
                      onChange={(e) => patch(r.id, { title: e.target.value })}
                    />

                    <label htmlFor={`sy-due-${r.id}`} style={SR}>
                      Due date
                    </label>
                    <input
                      id={`sy-due-${r.id}`}
                      className="input"
                      type="date"
                      style={AUTO}
                      value={r.due}
                      onChange={(e) => patch(r.id, { due: e.target.value })}
                    />

                    <label htmlFor={`sy-kind-${r.id}`} style={SR}>
                      Kind
                    </label>
                    <select
                      id={`sy-kind-${r.id}`}
                      className="select"
                      style={AUTO}
                      value={r.kind}
                      onChange={(e) => patch(r.id, { kind: e.target.value as DeadlineKind })}
                    >
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))
              )}
            </div>

            <div className="row">
              <button
                className="btn"
                onClick={() => (confirmBack ? setRows(null) : setConfirmBack(true))}
                onBlur={() => setConfirmBack(false)}
              >
                {confirmBack ? 'Discard edits?' : 'Back'}
              </button>
              {error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : null}
              <div className="spacer" style={{ flex: 1 }} />
              <span className="faint">
                {rows.length} found
                {held ? `, ${held} unticked (already past or already in your list)` : ''}
              </span>
              <button className="btn primary" onClick={() => void submit()} disabled={busy || selected.length === 0}>
                {busy ? 'Importing…' : `Import ${selected.length} selected`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
