import type { Course } from '../shared/types'

/**
 * Course metadata from CMU, so a course number is enough to create a course.
 *
 * The problem this solves is not "look up a title". It is that pasting an SIO schedule silently
 * drops every block whose course is not already in courses.json — parseScheduleText matches the
 * five-digit anchor against known courses and `continue`s when it misses. So the real sequence was:
 * hand-type a row per course (code, title and units) first, with the units field defaulting to
 * 12, which is wrong for many of them, and only then paste. Get that order wrong and the paste reports
 * "No classes recognised" and tells you nothing about why.
 *
 * Deliberately does NOT fetch schedules. The API's schedule block carries no room and no
 * instructor for Fall 2026 — the upstream stopped publishing them — and its blank `location` field
 * cannot tell a Pittsburgh section from a Doha one. The SIO paste already has better data,
 * including the room, which is the one thing no public source has.
 */

// A student-run ScottyLabs service, not a CMU one — the UI and every error here name it as such.
const HOST = 'course.apis.scottylabs.org'
const BASE = `https://${HOST}/courses`
const TIMEOUT_MS = 10_000

export interface CatalogCourse {
  code: string
  title: string
  /** The API sends this as a string ("12.0"); callers get a number. */
  units: number
  department: string
}

interface ApiCourse {
  courseID?: string
  name?: string
  units?: string | number
  department?: string
}

/** "01101" and "01-101" both mean the same course; the API wants the hyphen. */
export function normaliseCourseCode(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '')
  return digits.length === 5 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : null
}

/**
 * Never throws. A lookup that fails leaves you exactly where you were — typing the course in by
 * hand — so it returns the reason as a string instead of taking the paste down with it.
 */
export async function lookupCourses(
  codes: string[],
): Promise<{ courses: CatalogCourse[]; error: string | null }> {
  const wanted = [...new Set(codes.map(normaliseCourseCode).filter((c): c is string => c !== null))]
  // The bare route 502s, so an empty list must never become a request.
  if (!wanted.length) return { courses: [], error: null }

  const url = `${BASE}?${wanted.map((c) => `courseID=${encodeURIComponent(c)}`).join('&')}`
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': 'Tartan/0.1 (personal student app)' },
    })
    if (!res.ok) return { courses: [], error: `${HOST} returned HTTP ${res.status}.` }

    // A maintenance page or a bare `null` is a failed lookup, not an empty one. Only the parse is
    // forgiven: a timeout while the body streams in still has to reach the catch below.
    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      // Falls through to the shape check.
    }
    // The batch route answers with a bare array, and with 200 [] for an unknown number — which is
    // why it is used even for a single course. The single-course route 502s on a miss.
    const rows = Array.isArray(body) ? body : (body as { courses?: unknown } | null)?.courses
    if (!Array.isArray(rows)) return { courses: [], error: `${HOST} sent back something that was not course data.` }

    const courses = (rows as ApiCourse[])
      .map((r) => {
        const code = normaliseCourseCode(String(r.courseID ?? ''))
        const units = Number(r.units)
        if (!code || !r.name) return null
        return {
          code,
          title: String(r.name).trim(),
          units: Number.isFinite(units) ? units : 0,
          department: String(r.department ?? '').trim(),
        }
      })
      .filter((c): c is CatalogCourse => c !== null)

    return { courses, error: null }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    if (e.name === 'TimeoutError') return { courses: [], error: `${HOST} did not answer in ${TIMEOUT_MS / 1000} seconds.` }
    if (e.message === 'fetch failed') {
      return { courses: [], error: `Could not reach ${HOST} (${e.cause?.code ?? 'offline?'}).` }
    }
    return { courses: [], error: e.message }
  }
}

/** A Course ready to save, keeping any colour/id the caller has already chosen. */
export function toCourse(c: CatalogCourse, color: string): Course {
  return { id: c.code, code: c.code, title: c.title, color, units: c.units, links: [] }
}
