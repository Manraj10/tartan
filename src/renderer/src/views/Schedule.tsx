import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { SCHEDULE_FILE, meetsOn, normTime, parseSchedule, type Course, type Meeting } from '@shared/types'
import { useStore } from '../store'
import EmptyState from '../components/EmptyState'

// Both live in shared/ because main renders the same schedule onto the phone page.
export { SCHEDULE_FILE, parseSchedule as parseFile }
export type { Meeting }

const FILE = SCHEDULE_FILE
const HEADER = [
  '# Tartan class schedule. One meeting per line, edit it by hand whenever you like.',
  '# courseId|day (0=Mon, 1=Tue, ... 6=Sun)|start HH:MM|end HH:MM|location|from|until',
  '# from and until are optional YYYY-MM-DD — use them for mini courses that share a slot.',
  '# Blank lines and lines starting with # are ignored.',
  '',
].join('\n')

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const HOUR_PX = 48
const CONTROL: CSSProperties = { width: 'auto' }

/* ---------- time helpers ---------- */

const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

const pad = (n: number): string => String(n).padStart(2, '0')

const minToHHMM = (m: number): string => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`

function clockTime(m: number): string {
  const h = Math.floor(m / 60)
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${pad(m % 60)}${h < 12 ? 'am' : 'pm'}`
}

function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${h < 12 ? 'am' : 'pm'}`
}

function duration(mins: number): string {
  const h = Math.floor(mins / 60)
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`
}

/* ---------- file format ---------- */

const serialize = (ms: Meeting[]): string =>
  HEADER +
  ms
    .map((m) => {
      // Only write the date columns when they exist, so an unbounded meeting stays a
      // five-field line and the file does not fill up with trailing pipes.
      const base = `${m.courseId}|${m.day}|${m.start}|${m.end}|${m.location}`
      return m.from || m.until ? `${base}|${m.from ?? ''}|${m.until ?? ''}` : base
    })
    .join('\n') +
  '\n'

const sortMeetings = (ms: Meeting[]): Meeting[] =>
  [...ms].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start))

/* ---------- SIO paste parsing ---------- */

// "TH" and "TU" are two letters but one day: "TTh" is Tuesday and Thursday, "TuTh" the same.
const DAY_LETTERS: Record<string, number> = { M: 0, T: 1, W: 2, R: 3, F: 4, TU: 1, TH: 3 }
const DAY_WORDS: Record<string, number> = {
  mon: 0, monday: 0,
  // SIO writes Thursday as "Th" and Tuesday as "Tu"; without these, "Th" parses as
  // T + H, the H fails, and the entire day line is discarded.
  tu: 1, tue: 1, tues: 1, tuesday: 1,
  wed: 2, weds: 2, wednesday: 2,
  th: 3, thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sa: 5, sat: 5, saturday: 5,
  su: 6, sun: 6, sunday: 6,
}
// A clock time has minutes ("9:30") or am/pm ("9am"). A bare number is a room or a course code.
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?m(?![a-z])\.?)?/gi

/** A token is a day token only if it is a word like Mon or a pure run of M T W R F. */
function dayTokens(token: string): number[] {
  const letters = token.replace(/[^A-Za-z]/g, '')
  if (!letters) return []
  const word = DAY_WORDS[letters.toLowerCase()]
  if (word !== undefined) return [word]
  const days: number[] = []
  for (const [part] of letters.toUpperCase().matchAll(/TH|TU|./g)) {
    const d = DAY_LETTERS[part]
    if (d === undefined) return []
    days.push(d)
  }
  return days
}

interface TimeHit {
  min: number
  at: number
  after: number
}

interface Clock {
  h: number
  min: number
  pm: boolean | null
  at: number
  after: number
}

/** The start and end time on a line, or [] when it does not hold a range. */
function findTimes(line: string): TimeHit[] {
  const found: Clock[] = []
  for (const m of line.matchAll(TIME_RE)) {
    if (m[2] === undefined && !m[3]) continue
    const h = Number(m[1])
    const min = Number(m[2] ?? 0)
    if (min > 59 || h > (m[3] ? 12 : 23)) continue
    const at = m.index ?? 0
    found.push({ h, min, pm: m[3] ? m[3].toLowerCase() === 'p' : null, at, after: at + m[0].length })
  }
  if (found.length < 2) return []
  const [a, b] = found

  const at12 = (c: Clock, pm: boolean): number => ((c.h % 12) + (pm ? 12 : 0)) * 60 + c.min
  // No am/pm anywhere reads as a 24-hour clock ("14:00 15:15").
  const read = (c: Clock): number => (c.pm === null ? c.h * 60 + c.min : at12(c, c.pm))
  let start = read(a)
  let end = read(b)
  // "1:00-2:15pm" puts am/pm on one side only. Borrow it, and flip it when borrowing would run
  // the class backwards: "11:00-12:15pm" is 11am to 12:15pm, not 11pm.
  if (a.pm === null && b.pm !== null && a.h >= 1 && a.h <= 12) {
    start = at12(a, b.pm)
    if (start >= end) start = at12(a, !b.pm)
  } else if (b.pm === null && a.pm !== null && b.h >= 1 && b.h <= 12) {
    end = at12(b, a.pm)
    if (end <= start) end = at12(b, !a.pm)
  }
  return [
    { min: start, at: a.at, after: a.after },
    { min: end, at: b.at, after: b.after },
  ]
}

/** "01101" and "01-101" and "01101 C" all mean the same course. */
const normaliseCode = (s: string): string => s.replace(/[^0-9]/g, '')

const ANCHOR = /^\d{5}\s+\S+$/

/** What follows the end time on its line is the room, minus the dash or colon that joined them. */
const roomAfter = (line: string, from: number): string => line.slice(from).replace(/^[\s\-–—,:]+/, '').trim()

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The course a one-line meeting names. The code has to stand on its own — "CS 1010" is not "CS 101"
 * — and the longest code wins when one is a prefix of another. Hyphens and spaces inside a code are
 * optional, so "01101" finds "01-101".
 */
function courseIn(line: string, courses: Course[]): { course: Course; at: number; length: number } | null {
  let best: { course: Course; at: number; length: number } | null = null
  for (const course of courses) {
    const parts = course.code.split(/[\s-]+/).filter(Boolean)
    if (!parts.length) continue
    const m = new RegExp(`(?<!\\w)${parts.map(escapeRe).join('[\\s-]*')}(?!\\w)`, 'i').exec(line)
    if (m && (!best || course.code.length > best.course.code.length)) {
      best = { course, at: m.index, length: m[0].length }
    }
  }
  return best
}

/** "01-101 Lecture MWF 10:00AM 10:50AM Hall 5": one line, one course, any number of days. */
function parseLine(raw: string, courses: Course[]): Meeting[] {
  const hit = courseIn(raw, courses)
  if (!hit) return []
  // Lift the code out first, or a line that ends in it reads the code as the room.
  const line = `${raw.slice(0, hit.at)} ${raw.slice(hit.at + hit.length)}`
  const times = findTimes(line)
  if (times.length < 2 || times[1].min <= times[0].min) return []
  const days = new Set<number>()
  for (const token of line.slice(0, times[0].at).split(/[\s,/]+/)) {
    for (const d of dayTokens(token)) days.add(d)
  }
  const location = roomAfter(line, times[1].after)
  return [...days].map((day) => ({
    courseId: hit.course.id,
    day,
    start: minToHHMM(times[0].min),
    end: minToHHMM(times[1].min),
    location,
  }))
}

interface Pattern {
  days: number[]
  start: number
  end: number
  location: string
}

/**
 * SIO pastes as a BLOCK per section, not one line:
 *
 *   INTRO TO COMPUTING
 *   01101 A1
 *   Jane Faculty
 *   jfaculty@example.edu
 *   M W F
 *   09:00AM to 09:50AM
 *   Hall 5
 *   Click for more info
 *
 * The anchor is the "<5 digits> <section>" line; everything up to the next anchor belongs to it.
 * Instructor blocks are variable-length — a section can list two instructors — so the scan is
 * bounded by the next anchor rather than by a line count.
 *
 * The room is its own line AFTER the time, which is the one thing that cannot be read positionally:
 * when a section has no room, that slot is occupied by the next section's course title instead.
 * A title is always the line directly above an anchor, and that is how the two are told apart.
 *
 * Some sections carry no time at all (an unscheduled one reads "TBA / DNM DNM"), and a lecture and
 * its recitation appear as two separate blocks under the same course number. A lab can also meet
 * in two patterns inside ONE block — "M W / 10:00AM to 10:50AM / Room 210 / T / 03:00PM to 04:50PM /
 * Room 118" — so each time line closes a pattern of its own, with the days above it and the room
 * below it. A pattern that closes with no days stays open: days that only turn up after the room
 * belong to it.
 *
 * Plain lines ("CS 101 TTh 2:00PM-3:15PM Hall 5") work too, alone or after a block: a one-line
 * meeting ends a block the same way the next anchor does.
 */
export function parseScheduleText(text: string, courses: Course[]): Meeting[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const byNumber = new Map(courses.filter((c) => c.code).map((c) => [normaliseCode(c.code), c]))

  const out: Meeting[] = []
  const seen = new Set<string>()
  const add = (m: Meeting): void => {
    const key = `${m.courseId}|${m.day}|${m.start}|${m.end}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(m)
  }

  for (let i = 0; i < lines.length; i++) {
    const anchor = /^(\d{5})\s+(\S+)$/.exec(lines[i])
    if (!anchor) continue
    const course = byNumber.get(anchor[1])
    if (!course) continue

    // Scan forward to the next anchor, closing one pattern per time line.
    const patterns: Pattern[] = []
    let days = new Set<number>()
    // A day line right after a time line opens the next pattern instead of joining the last one.
    let afterTime = false
    let needsRoom: Pattern | null = null

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line) continue
      if (ANCHOR.test(line) || parseLine(line, courses).length) break
      if (/^registered$/i.test(line) || /^[\d.]+$/.test(line)) continue
      if (/^click for more info$/i.test(line)) continue
      if (line.includes('@')) continue // instructor email

      const times = findTimes(line)
      if (times.length >= 2 && times[1].min > times[0].min) {
        // Some pastes put the room on the time line instead; take it if it is there.
        const tail = roomAfter(line, times[1].after)
        const p: Pattern = {
          days: [...days],
          start: times[0].min,
          end: times[1].min,
          location: /^to$/i.test(tail) ? '' : tail,
        }
        patterns.push(p)
        needsRoom = p.location ? null : p
        afterTime = true
        continue
      }

      // A pure day line: every token must parse as a day, or it is a course title.
      const tokens = line.split(/[\s,/]+/).filter(Boolean)
      if (tokens.length && tokens.every((t) => dayTokens(t).length > 0)) {
        // "time / room / days": a pattern that closed with no days is still open, and these are its.
        const open = patterns.filter((p) => p.days.length === 0)
        if (open.length) {
          for (const p of open) p.days = [...new Set(tokens.flatMap(dayTokens))]
          continue
        }
        if (afterTime) days = new Set()
        afterTime = false
        for (const t of tokens) for (const d of dayTokens(t)) days.add(d)
        needsRoom = null // the pattern above had no room line
        continue
      }

      if (needsRoom) {
        // The line after the time is the room — unless this section had none, in which case it is
        // already the next section's course title. A title always sits directly above an anchor.
        if (!ANCHOR.test(lines[j + 1] ?? '')) needsRoom.location = line
        needsRoom = null
      }
    }

    // No time means an asynchronous section — real, but nothing to put on a grid.
    for (const p of patterns) {
      for (const day of p.days) {
        add({ courseId: course.id, day, start: minToHHMM(p.start), end: minToHHMM(p.end), location: p.location })
      }
    }
  }

  for (const line of lines) {
    if (!line.startsWith('#')) parseLine(line, courses).forEach(add)
  }
  return out
}

/**
 * Re-pasting has to REFRESH what it matches, not skip it. Otherwise a paste that now carries rooms
 * silently changes nothing, because every time already lined up. The from/until columns stay: no
 * paste can carry them, so they are always the user's, and replacing the whole meeting is what
 * used to turn a mini course back into a full-term class.
 */
export function mergeMeetings(existing: Meeting[], found: Meeting[]): Meeting[] {
  const key = (m: Meeting): string => `${m.courseId}|${m.day}|${m.start}`
  const incoming = new Map(found.map((m) => [key(m), m]))
  const have = new Set(existing.map(key))
  return [
    ...existing.map((m) => {
      const fresh = incoming.get(key(m))
      // A paste with no room must not erase one typed in by hand.
      return fresh ? { ...m, end: fresh.end, location: fresh.location || m.location } : m
    }),
    ...found.filter((m) => !have.has(key(m))),
  ]
}

/* ---------- now line ---------- */

export function nowLine(meetings: Meeting[], label: (id: string) => string, at: Date): string {
  const today = (at.getDay() + 6) % 7
  const mins = at.getHours() * 60 + at.getMinutes()
  // Each scanned day filters by ITS OWN date, not just the weekday: two mini courses can share one
  // weekly slot in different halves of the term, and without meetsOn the label named whichever
  // sorted first — "In class: CS 101" all term, while the rail highlighted CS 102.
  const iso = (offset: number): string => {
    const d = new Date(at.getFullYear(), at.getMonth(), at.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const onDay = (d: number, offset: number): Meeting[] =>
    sortMeetings(meetings.filter((m) => m.day === d && meetsOn(m, iso(offset))))

  const todays = onDay(today, 0)
  const current = todays.find((m) => toMin(m.start) <= mins && mins < toMin(m.end))
  if (current) return `In class: ${label(current.courseId)} until ${clockTime(toMin(current.end))}`

  const next = todays.find((m) => toMin(m.start) > mins)
  if (next) {
    const t = toMin(next.start)
    return `Next: ${label(next.courseId)} at ${clockTime(t)}, in ${duration(t - mins)}`
  }

  for (let i = 1; i <= 7; i++) {
    const day = (today + i) % 7
    const first = onDay(day, i)[0]
    if (first) {
      const when = i === 1 ? 'Tomorrow' : DAY_LONG[day]
      return `${when}: ${label(first.courseId)} at ${clockTime(toMin(first.start))}`
    }
  }
  return 'Nothing scheduled this week.'
}

/* ---------- component ---------- */

export default function Schedule() {
  const { courses, courseById, saveCourses, announce } = useStore()
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [ready, setReady] = useState(false)
  const [panel, setPanel] = useState<'none' | 'add' | 'paste'>('none')
  const [confirming, setConfirming] = useState<number | null>(null)
  const [now, setNow] = useState(() => new Date())
  /** Minutes since midnight, for the now-line. The 30s tick below keeps it honest. */
  const nowMin = now.getHours() * 60 + now.getMinutes()

  const [fCourse, setFCourse] = useState('')
  const [fDay, setFDay] = useState(String((new Date().getDay() + 6) % 7))
  const [fStart, setFStart] = useState('')
  const [fEnd, setFEnd] = useState('')
  const [fWhere, setFWhere] = useState('')
  const [fFrom, setFFrom] = useState('')
  const [fUntil, setFUntil] = useState('')

  const [pasteText, setPasteText] = useState('')
  const [pasteMsg, setPasteMsg] = useState('')
  /** True while the catalog lookup runs, so a second click cannot start a second paste. */
  const [looking, setLooking] = useState(false)

  useEffect(() => {
    void window.api.notes.read(FILE).then((text) => {
      setMeetings(sortMeetings(parseSchedule(text)))
      setReady(true)
    })
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (panel === 'none') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPanel('none')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel])

  const save = useCallback(async (next: Meeting[]) => {
    const sorted = sortMeetings(next)
    setMeetings(sorted)
    await window.api.notes.write(FILE, serialize(sorted))
  }, [])

  const label = useCallback((id: string) => courseById(id)?.code ?? id, [courseById])

  const todayIso = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }, [now])

  /**
   * Mini courses share a time slot with another course for half the term. Drawn together they
   * land on the same pixels and one silently covers the other, so the grid shows what is running
   * now and lists the rest underneath rather than pretending they do not exist.
   */
  /** Which slice of the cell this meeting gets, when others share its day and time. */
  const laneOf = useCallback(
    (m: Meeting, day: number): { index: number; count: number } => {
      const overlapping = meetings
        .filter(
          (o) =>
            o.day === day && toMin(o.start) < toMin(m.end) && toMin(o.end) > toMin(m.start),
        )
        .sort((a, b) => a.start.localeCompare(b.start) || a.courseId.localeCompare(b.courseId))
      const index = overlapping.findIndex(
        (o) => o.courseId === m.courseId && o.start === m.start && o.end === m.end,
      )
      return { index: Math.max(0, index), count: Math.max(1, overlapping.length) }
    },
    [meetings],
  )

  const dormant = useMemo(
    () => meetings.filter((m) => !meetsOn(m, todayIso)),
    [meetings, todayIso],
  )

  const days = useMemo(() => {
    const cols = [0, 1, 2, 3, 4]
    if (meetings.some((m) => m.day === 5)) cols.push(5)
    if (meetings.some((m) => m.day === 6)) cols.push(6)
    return cols
  }, [meetings])

  const { startHour, endHour } = useMemo(() => {
    const starts = meetings.map((m) => toMin(m.start))
    const ends = meetings.map((m) => toMin(m.end))
    return {
      startHour: Math.floor(Math.min(8 * 60, ...starts) / 60),
      endHour: Math.min(24, Math.ceil(Math.max(22 * 60, ...ends) / 60)),
    }
  }, [meetings])

  const gridHeight = (endHour - startHour) * HOUR_PX

  const addClass = (e: FormEvent): void => {
    e.preventDefault()
    const start = normTime(fStart)
    const end = normTime(fEnd)
    if (!fCourse || !start || !end || toMin(end) <= toMin(start)) return
    void save([
      ...meetings,
      {
        courseId: fCourse,
        day: Number(fDay),
        start,
        end,
        location: fWhere.trim(),
        // Only set when filled in, so a full-term class stays a five-field line in the file.
        ...(fFrom ? { from: fFrom } : {}),
        ...(fUntil ? { until: fUntil } : {}),
      },
    ])
    setFStart('')
    setFEnd('')
    setFWhere('')
    setFFrom('')
    setFUntil('')
    setPanel('none')
  }

  /**
   * parseScheduleText matches each five-digit anchor against courses.json and skips the block when
   * it misses, so pasting SIO before the courses exist reported "No classes recognised" and said
   * nothing about why. Look the unknown numbers up first, and the paste becomes self-sufficient:
   * one paste gets you the courses, the meetings and the rooms.
   *
   * Whatever it could not do is said out loud. The panel closes on success, so the outcome goes
   * to the status pill — a message set on a panel that is about to unmount is never read.
   */
  const parsePaste = async (): Promise<void> => {
    const known = new Set(courses.map((c) => normaliseCode(c.code)))
    // Unique numbers: a lecture and its recitation share one, and the request sends it once.
    const numbers = [...new Set([...pasteText.matchAll(/^\s*(\d{5})\s+\S+\s*$/gm)].map((m) => m[1]))]
    const missing = numbers.filter((n) => !known.has(n))

    let roster = courses
    let added: Course[] = []
    let lookupError = ''
    if (missing.length) {
      setLooking(true)
      setPasteMsg(
        `Looking up ${missing.length} course${missing.length === 1 ? '' : 's'} on course.apis.scottylabs.org (a student-run catalog)…`,
      )
      try {
        const { courses: found, error } = await window.api.catalog.lookup(missing)
        lookupError = error ?? ''
        if (found.length) {
          // Colours cycle through the palette already in use so a new course is not born grey.
          const palette = ['#e8613c', '#3c7ae8', '#2fa36b', '#9a5ce8', '#d4a017', '#e8407a', '#5c9ea8', '#c98a10']
          added = found.map((c, i) => ({
            id: c.code,
            code: c.code,
            title: c.title,
            units: c.units,
            color: palette[(courses.length + i) % palette.length],
            links: [],
          }))
          roster = [...courses, ...added]
          // A failed save has already said why and rolled the courses back. Going on would write
          // meetings for courses that no longer exist and then announce success over the error.
          if (!(await saveCourses(roster))) {
            setPasteMsg('')
            return
          }
        }
      } catch (e) {
        setPasteMsg(`Could not look up the courses — ${e instanceof Error ? e.message : String(e)}`)
        return
      } finally {
        setLooking(false)
      }
    }

    const addedText = added.length ? `Added ${added.map((a) => `${a.code} (${a.units}u)`).join(', ')}. ` : ''
    const courseOf = (n: string): Course | undefined => roster.find((c) => normaliseCode(c.code) === n)
    // A failed lookup must not block the paste — the known courses still parse — but the numbers it
    // could not resolve are named, with the real reason, whether or not anything else came out.
    const skipped = numbers.filter((n) => !courseOf(n))
    const skippedText = skipped.length
      ? `Skipped ${skipped.join(', ')}: ${lookupError || 'the catalog has no such course.'} Add ${skipped.length === 1 ? 'it' : 'them'} in Settings and paste again.`
      : ''

    const found = parseScheduleText(pasteText, roster)
    if (found.length === 0) {
      setPasteMsg(
        addedText +
          (skippedText ||
            (numbers.length
              ? `No class times found for ${numbers.join(', ')}. Paste the whole SIO block, course numbers and all.`
              : 'No classes recognised. Each line needs a course you have added, its days and a time range, like CS 101 MWF 10:00AM-10:50AM Hall 5.')),
      )
      return
    }

    // Awaited, or a rejected write is unhandled and the success notice below has already fired.
    try {
      await save(mergeMeetings(meetings, found))
    } catch (e) {
      setMeetings(meetings)
      setPasteMsg('')
      announce(`Could not save the schedule — ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' })
      return
    }

    const timed = new Set(found.map((m) => m.courseId))
    const untimed = numbers.filter((n) => {
      const c = courseOf(n)
      return c && !timed.has(c.id)
    })
    announce(
      [
        addedText.trim(),
        `Read ${found.length} class time${found.length === 1 ? '' : 's'}.`,
        skippedText,
        untimed.length ? `No meeting time for ${untimed.join(', ')} (online or TBA).` : '',
      ]
        .filter(Boolean)
        .join(' '),
      { kind: skipped.length ? 'error' : 'info' },
    )
    setPasteText('')
    setPasteMsg('')
    setPanel('none')
  }

  return (
    <>
      <div className="topbar">
        <h1>Schedule</h1>
        <div className="spacer" />
        <button className="btn" onClick={() => setPanel(panel === 'paste' ? 'none' : 'paste')}>
          Paste schedule
        </button>
        <button className="btn primary" onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}>
          Add class
        </button>
      </div>

      {/* A seven-day grid is not a reading column — it wants the whole window. */}
      <div className="content wide">
        {/* A one-sentence status hugs its content — a full-width card spent the whole recipe on
            a desert of empty surface to the sentence's right. */}
        <div
          className="status-pill"
          style={{ display: 'inline-flex', marginBottom: 'var(--sp-4)', pointerEvents: 'none' }}
        >
          {nowLine(meetings, label, now)}
        </div>

        {panel === 'add' ? (
          <form className="card" onSubmit={addClass} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <label className="faint" htmlFor="sc-course">
              Course
            </label>
            <select id="sc-course" className="select" style={CONTROL} value={fCourse} onChange={(e) => setFCourse(e.target.value)} required>
              <option value="">Pick one</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </select>

            <label className="faint" htmlFor="sc-day">
              Day
            </label>
            <select id="sc-day" className="select" style={CONTROL} value={fDay} onChange={(e) => setFDay(e.target.value)}>
              {DAY_LONG.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>

            <label className="faint" htmlFor="sc-start">
              Start
            </label>
            <input id="sc-start" className="input" style={CONTROL} type="time" value={fStart} onChange={(e) => setFStart(e.target.value)} required />

            <label className="faint" htmlFor="sc-end">
              End
            </label>
            <input id="sc-end" className="input" style={CONTROL} type="time" value={fEnd} onChange={(e) => setFEnd(e.target.value)} required />

            <label className="faint" htmlFor="sc-from">
              From
            </label>
            <input
              id="sc-from"
              className="input"
              style={CONTROL}
              type="date"
              title="Optional. First day this class meets, for a mini course that only runs part of the term."
              value={fFrom}
              onChange={(e) => setFFrom(e.target.value)}
            />

            <label className="faint" htmlFor="sc-until">
              Until
            </label>
            <input
              id="sc-until"
              className="input"
              style={CONTROL}
              type="date"
              title="Optional. Last day this class meets."
              min={fFrom || undefined}
              value={fUntil}
              onChange={(e) => setFUntil(e.target.value)}
            />

            <label className="faint" htmlFor="sc-where">
              Where
            </label>
            <input
              id="sc-where"
              className="input"
              style={{ flex: '1 1 140px', width: 'auto' }}
              placeholder="Hall 5"
              value={fWhere}
              onChange={(e) => setFWhere(e.target.value)}
            />

            {courses.length === 0 ? <span className="faint">Add a space in Settings first</span> : null}
            <button className="btn primary" type="submit" disabled={courses.length === 0}>
              Add
            </button>
          </form>
        ) : null}

        {panel === 'paste' ? (
          <div className="card" style={{ marginBottom: 14 }}>
            <label className="faint" htmlFor="sc-paste" style={{ display: 'block', marginBottom: 6 }}>
              Paste your schedule — the whole block from SIO (CMU's student information system), or one meeting per line, e.g. CS 101 Lecture MWF 10:00AM 10:50AM Hall 5. The one-line format works for any school.
            </label>
            <textarea
              id="sc-paste"
              className="textarea"
              rows={7}
              style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)' }}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={() => void parsePaste()} disabled={pasteText.trim() === '' || looking}>
                Parse
              </button>
              <button className="btn ghost" onClick={() => setPanel('none')}>
                Cancel
              </button>
              {pasteMsg ? <span className="faint">{pasteMsg}</span> : null}
            </div>
          </div>
        ) : null}

        {!ready ? null : meetings.length === 0 ? (
          <EmptyState
            headline="No classes yet."
            detail="Paste the whole block from SIO, or one line per class, and Tartan reads the days, times and rooms out of it."
            action={{ label: 'Paste schedule', run: () => setPanel('paste') }}
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: `46px repeat(${days.length}, minmax(0, 1fr))`, minWidth: 640 }}>
            <div className="cal-head" />
            {days.map((d) => (
              <div key={`h${d}`} className="cal-head">
                {DAY_SHORT[d]}
              </div>
            ))}

            <div
              style={{
                position: 'relative',
                height: gridHeight,
                borderBottom: '1px solid var(--border)',
                // Without this the first day column's left rule dead-ended at the header row.
                borderRight: '1px solid var(--border)',
              }}
            >
              {Array.from({ length: endHour - startHour }, (_, i) => (
                <div
                  key={i}
                  className="faint"
                  style={{ position: 'absolute', top: i * HOUR_PX - 6, right: 6, fontSize: 'var(--fs-micro)' }}
                >
                  {hourLabel(startHour + i)}
                </div>
              ))}
            </div>

            {days.map((d) => (
              <div
                key={`c${d}`}
                style={{
                  position: 'relative',
                  height: gridHeight,
                  borderRight: '1px solid var(--border)',
                  borderBottom: '1px solid var(--border)',
                  backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${HOUR_PX}px)`,
                }}
              >
                {/* The "you are here" mark every real calendar has: an accent line across today's
                    column at the current time. Its absence is the fastest tell of an amateur grid. */}
                {d === (new Date().getDay() + 6) % 7 &&
                nowMin >= startHour * 60 &&
                nowMin <= endHour * 60 ? (
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: (nowMin - startHour * 60) * (HOUR_PX / 60),
                      height: 0,
                      borderTop: '2px solid var(--accent-text)',
                      zIndex: 3,
                      pointerEvents: 'none',
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        left: -3,
                        top: -4,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: 'var(--accent-text)',
                      }}
                    />
                  </div>
                ) : null}
                {meetings.map((m, i) => {
                  if (m.day !== d) return null
                  // Two meetings in one slot are laid out side by side rather than stacked,
                  // which is what made one mini invisible behind the other.
                  const lane = laneOf(m, d)
                  const course = courseById(m.courseId)
                  const top = (toMin(m.start) - startHour * 60) * (HOUR_PX / 60)
                  const height = Math.max(18, (toMin(m.end) - toMin(m.start)) * (HOUR_PX / 60) - 2)
                  return (
                    <div
                      key={`${m.courseId}-${m.day}-${m.start}-${i}`}
                      className="sched-block"
                      title={[
                        course?.code ?? m.courseId,
                        course?.title,
                        `${clockTime(toMin(m.start))}–${clockTime(toMin(m.end))}`,
                        m.location,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      style={{
                        top,
                        height,
                        left: `calc(${(lane.index * 100) / lane.count}% + 2px)`,
                        width: `calc(${100 / lane.count}% - 4px)`,
                        // A meeting outside its date window still belongs on a term grid, but it
                        // must not read as something you are due at.
                        opacity: meetsOn(m, todayIso) ? 1 : 0.42,
                        // The Notion-block recipe now lives in .sched-block CSS, sharing the
                        // calendar chips' oklab mix and oklch rail normalisation — the hand-rolled
                        // hex tint() this replaces mixed in srgb and skipped the normalisation.
                        ...(course ? { ['--cc' as string]: course.color } : {}),
                      }}
                    >
                      <div style={{ fontWeight: 600, paddingRight: 16 }}>{course?.code ?? m.courseId}</div>
                      {m.location ? <div className="faint">{m.location}</div> : null}
                      {/*
                        A 50-minute block is 38px and a line is ~15px, so three lines clip and the
                        room — the line you actually came here to read — is the one that vanishes.
                        The grid position already encodes the time, so it is what gives way.
                      */}
                      {!m.location || height >= 46 ? (
                        <div className="faint">
                          {clockTime(toMin(m.start))}–{clockTime(toMin(m.end))}
                        </div>
                      ) : null}
                      <button
                        className="btn ghost sm sched-del"
                        style={{ position: 'absolute', top: 0, right: 0, padding: '0 4px', lineHeight: 1.4 }}
                        title={`Remove ${course?.code ?? m.courseId}`}
                        onBlur={() => setConfirming(null)}
                        onClick={() =>
                          confirming === i
                            ? void save(meetings.filter((_, j) => j !== i))
                            : setConfirming(i)
                        }
                      >
                        {confirming === i ? 'Sure?' : '×'}
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {dormant.length ? (
          <p className="faint" style={{ marginTop: 12, fontSize: 'var(--fs-sm)' }}>
            Not running today:{' '}
            {/* "from Oct 19", never a raw ISO date — the one line of machine formatting in an app
                whose date voice is "Fri, Sep 4" everywhere else. */}
            {[
              ...new Set(
                dormant.map((m) => {
                  const nice = (iso: string): string => {
                    const [y, mo, d] = iso.split('-').map(Number)
                    return new Date(y, mo - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                  }
                  return `${label(m.courseId)} ${m.from ? `from ${nice(m.from)}` : ''}${m.until && !m.from ? `until ${nice(m.until)}` : ''}`
                }),
              ),
            ].join(' · ')}
          </p>
        ) : null}
      </div>
    </>
  )
}
