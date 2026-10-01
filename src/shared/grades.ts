// Shared between main, preload and renderer. Keep this dependency-free.

/**
 * A grading scheme is DATA, not code. Every syllabus states its own arithmetic, so the app ships
 * an evaluator and `grades.json` holds the formula — the same split as the LeetCode ladder, where
 * the curriculum ships and only progress is data. Real syllabi have to fit without touching this
 * file again; two of the starters below show the range:
 *
 *   21-127  max of two percentage formulas, one of which demotes the lowest midterm.
 *   15-122  min(CH, PR + PG) + FI + AC out of 1000 raw points.
 *
 * Both are an expression over category slices, which is all the machinery below is.
 */

export interface GradeItem {
  id: string
  label: string
  possible: number
  /** null means not graded yet. It gets projected — never counted as a zero. */
  earned: number | null
}

export interface GradeCategory {
  id: string
  label: string
  items: GradeItem[]
}

/**
 * Which slice of a category a term reads.
 *  all          one aggregate over every item (sum earned / sum possible)
 *  each         every item separately, so `weight` applies once per item ("18% each")
 *  lowest       the single worst item
 *  rest         every item except the worst, separately
 *  drop-lowest  one aggregate over everything except the worst
 */
export type Pick = 'all' | 'each' | 'lowest' | 'rest' | 'drop-lowest'

export interface Term {
  /** A category id. */
  ref: string
  /**
   * Multiplies each fraction the pick yields. In a percentage scheme it is percent-of-course
   * (15 for "HW 15%"); in a points scheme it is the category's point total (780 for 15-122's
   * checkins), so weight x fraction is that category's projected points.
   */
  weight: number
  pick?: Pick
}

export type Expr = { term: Term } | { op: 'sum' | 'min' | 'max'; of: Expr[] }

export interface Formula {
  label: string
  expr: Expr
}

export interface Cutoff {
  label: string
  /** On the same scale as `outOf`. Include a 0-minimum entry so every score gets a letter. */
  min: number
}

export interface GradeScheme {
  label: string
  /** The scale the formulas produce: 100 for a percentage scheme, 1000 for 15-122. */
  outOf: number
  categories: GradeCategory[]
  /** The student gets the BEST one. A single entry is the normal case. */
  formulas: Formula[]
  cutoffs: Cutoff[]
}

/** grades.json: one scheme per space, keyed by course id. */
export type GradesState = Record<string, GradeScheme>

export interface EvalOpts {
  /** false scores only work that is actually graded — what is banked right now. */
  project: boolean
  /** Fraction (0–1) used for a category with nothing graded yet to project from. */
  assume: number
  /** Forces EVERY ungraded item to this fraction. The solver uses it; the UI does not. */
  override?: number
}

/** A category's running rate over its graded items, or null when none are graded. */
function catRate(cat: GradeCategory): number | null {
  let earned = 0
  let possible = 0
  for (const it of cat.items) {
    if (it.earned != null) {
      earned += it.earned
      possible += it.possible
    }
  }
  return possible > 0 ? earned / possible : null
}

/** Each item as points, with ungraded ones filled in at the projection rate. */
function points(cat: GradeCategory, o: EvalOpts): { e: number; p: number }[] {
  const fill = o.override != null ? o.override : (catRate(cat) ?? o.assume)
  return cat.items.map((it) => ({
    e: it.earned != null ? it.earned : o.project ? fill * it.possible : 0,
    p: it.possible,
  }))
}

const ratio = (e: number, p: number): number => (p > 0 ? e / p : 0)

/** The fractions a term reads, one per value its `weight` should multiply. */
function slice(cat: GradeCategory, pick: Pick, o: EvalOpts): number[] {
  const pts = points(cat, o)
  if (!pts.length) return []

  const agg = (rows: { e: number; p: number }[]): number[] => [
    ratio(
      rows.reduce((s, r) => s + r.e, 0),
      rows.reduce((s, r) => s + r.p, 0),
    ),
  ]

  if (pick === 'all') return agg(pts)
  if (pick === 'each') return pts.map((r) => ratio(r.e, r.p))

  // The remaining picks all turn on which item is worst, by fraction.
  let lo = 0
  for (let i = 1; i < pts.length; i++) if (ratio(pts[i].e, pts[i].p) < ratio(pts[lo].e, pts[lo].p)) lo = i
  if (pick === 'lowest') return [ratio(pts[lo].e, pts[lo].p)]

  // With a single item there is nothing to drop, or the average would be over an empty set.
  const kept = pts.length > 1 ? pts.filter((_, i) => i !== lo) : pts
  return pick === 'rest' ? kept.map((r) => ratio(r.e, r.p)) : agg(kept)
}

function evalExpr(x: Expr, cats: Map<string, GradeCategory>, o: EvalOpts): number {
  if ('term' in x) {
    const cat = cats.get(x.term.ref)
    if (!cat) return 0
    return slice(cat, x.term.pick ?? 'all', o).reduce((sum, f) => sum + x.term.weight * f, 0)
  }
  const vals = x.of.map((y) => evalExpr(y, cats, o))
  if (!vals.length) return 0
  if (x.op === 'sum') return vals.reduce((a, b) => a + b, 0)
  return x.op === 'min' ? Math.min(...vals) : Math.max(...vals)
}

/** The score on the scheme's own scale. Several formulas means the student gets the best. */
export function score(scheme: GradeScheme, o: EvalOpts): number {
  if (!scheme.formulas.length) return 0
  const cats = new Map(scheme.categories.map((c) => [c.id, c]))
  return Math.max(...scheme.formulas.map((f) => evalExpr(f.expr, cats, o)))
}

/** Every formula's value, so the panel can show which one is carrying the grade. */
export function byFormula(scheme: GradeScheme, o: EvalOpts): { label: string; value: number }[] {
  const cats = new Map(scheme.categories.map((c) => [c.id, c]))
  return scheme.formulas.map((f) => ({ label: f.label, value: evalExpr(f.expr, cats, o) }))
}

export function letterFor(scheme: GradeScheme, value: number): string {
  const ranked = [...scheme.cutoffs].sort((a, b) => b.min - a.min)
  for (const c of ranked) if (value >= c.min) return c.label
  return '—'
}

export const ungradedCount = (scheme: GradeScheme): number =>
  scheme.categories.reduce((n, c) => n + c.items.filter((i) => i.earned == null).length, 0)

/**
 * The uniform score (0–1) needed on everything still ungraded to reach `target`.
 * The score only ever rises as that fraction rises — true even through min() and max() — so a
 * bisection is exact here and, unlike solving algebraically, cannot be wrong for a new scheme.
 * Returns null when the target is already met or is out of reach.
 */
export function neededFor(scheme: GradeScheme, target: number): number | null {
  if (!ungradedCount(scheme)) return null
  const at = (x: number): number => score(scheme, { project: true, assume: x, override: x })
  if (at(0) >= target) return 0
  if (at(1) < target) return null
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (at(mid) >= target) hi = mid
    else lo = mid
  }
  return hi
}

/* ------------------------------------------------------------ hand-edited data */

/**
 * grades.json is edited by hand, so nothing in it can be trusted to be there. Everything in this
 * section exists so one typo costs a message on screen — never a crash, and never a lost file.
 */

/**
 * getGrades cannot reject: renameCourse calls it too, and a throw there would fail a rename after
 * it had already moved the notes. So a file that will not parse comes back as { [UNREADABLE]: why }
 * — a key no space id can take, since ids start with a letter or a digit.
 */
export const UNREADABLE = '$unreadable'
export const unreadable = (why: string): GradesState => ({ [UNREADABLE]: why }) as unknown as GradesState
export function unreadableReason(state: GradesState): string | null {
  const why = (state as Record<string, unknown>)[UNREADABLE]
  return typeof why === 'string' ? why : null
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * The file's text as one scheme per space, or why it cannot be used. An empty file holds nothing
 * to lose, so it reads as no schemes; anything else that is not an object is reported, not reset.
 */
export function parseGrades(text: string): { state: GradesState } | { error: string } {
  const body = text.replace(/^﻿/, '')
  if (!body.trim()) return { state: {} }
  try {
    const raw: unknown = JSON.parse(body)
    if (isObj(raw)) return { state: raw as GradesState }
    return { error: 'The file must hold one JSON object with a grading scheme for each space id.' }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** A finite number, also from a numeric string ("25"), else null. */
const num = (x: unknown): number | null => {
  const n = typeof x === 'string' && x.trim() ? Number(x) : x
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const str = (x: unknown, fallback: string): string => (typeof x === 'string' && x ? x : typeof x === 'number' ? String(x) : fallback)

/**
 * A category or item is addressed by its id. One with no id falls back to its position in the
 * ORIGINAL list, so withEarned finds the same entry normalizeScheme showed.
 */
const idOf = (x: Record<string, unknown>, i: number, prefix: string): string => str(x.id, `${prefix}${i + 1}`)

const PICKS: Pick[] = ['all', 'each', 'lowest', 'rest', 'drop-lowest']

/** null for anything evalExpr could not read — a half-valid formula is skipped, not guessed at. */
function normExpr(x: unknown): Expr | null {
  if (!isObj(x)) return null
  if (isObj(x.term)) {
    const { ref, pick } = x.term
    const weight = num(x.term.weight)
    if (typeof ref !== 'string' || weight === null) return null
    if (pick === undefined) return { term: { ref, weight } }
    return PICKS.includes(pick as Pick) ? { term: { ref, weight, pick: pick as Pick } } : null
  }
  const op = x.op
  if ((op !== 'sum' && op !== 'min' && op !== 'max') || !Array.isArray(x.of)) return null
  const of = x.of.map(normExpr)
  return of.every((e) => e !== null) ? { op, of: of as Expr[] } : null
}

const refsOf = (e: Expr): string[] => ('term' in e ? [e.term.ref] : e.of.flatMap(refsOf))

/**
 * Whether the scheme can produce a grade at all: at least one formula with a term, all of whose
 * terms name categories that exist. evalExpr reads a missing category as 0, so a scheme with no
 * working formula would show "0.0% R, this is your actual grade". One stale formula beside a working
 * one does not blank the grade: the best formula counts, and the stale one is listed as a problem.
 */
export const resolvable = (scheme: GradeScheme): boolean => {
  const known = new Set(scheme.categories.map((c) => c.id))
  return scheme.formulas.some((f) => {
    const refs = refsOf(f.expr)
    return refs.length > 0 && refs.every((r) => known.has(r))
  })
}

/**
 * Any parsed JSON value as a scheme the evaluator cannot crash on: a missing list is empty, an
 * outOf that is not above 0 becomes 100 (so a score is never divided by zero), and a formula that
 * cannot be read is dropped. `problems` says what was dropped or guessed, because a silently wrong
 * grade is worse than a visible one. null means the value is not a scheme at all.
 *
 * This is for DISPLAY. Saves go through withEarned on the raw value, so a formula that was
 * skipped here is still in the file for the user to fix.
 */
export function normalizeScheme(raw: unknown): { scheme: GradeScheme; problems: string[] } | null {
  if (!isObj(raw)) return null
  const problems: string[] = []
  const list = (x: unknown, what: string): unknown[] => {
    if (x != null && !Array.isArray(x)) problems.push(`${what} should be a list, so it was ignored.`)
    return Array.isArray(x) ? x : []
  }

  const categories: GradeCategory[] = []
  list(raw.categories, 'categories').forEach((c, ci) => {
    if (!isObj(c)) {
      problems.push(`Category ${ci + 1} is not an object, so it was skipped.`)
      return
    }
    const id = idOf(c, ci, 'cat')
    const items: GradeItem[] = []
    list(c.items, `The items of "${id}"`).forEach((it, ii) => {
      if (!isObj(it)) {
        problems.push(`Item ${ii + 1} of "${id}" is not an object, so it was skipped.`)
        return
      }
      const iid = idOf(it, ii, 'item')
      // A value that is there but unreadable is reported, not quietly turned into 0 or ungraded;
      // null or missing earned is just "not graded yet".
      const possible = num(it.possible)
      const earned = num(it.earned)
      if (it.possible != null && (possible === null || possible < 0)) {
        problems.push(`Item "${iid}" of "${id}" needs a possible of 0 or more as a number, so it is scored out of 0.`)
      }
      if (it.possible == null && earned !== null) {
        problems.push(`Item "${iid}" of "${id}" has an earned score but no possible, so it is scored out of 0.`)
      }
      if (it.earned != null && earned === null) {
        problems.push(`Item "${iid}" of "${id}" has an earned score that is not a number, so it counts as ungraded.`)
      }
      items.push({ id: iid, label: str(it.label, iid), possible: Math.max(0, possible ?? 0), earned })
    })
    categories.push({ id, label: str(c.label, id), items })
  })

  const known = new Set(categories.map((c) => c.id))
  const formulas: Formula[] = []
  list(raw.formulas, 'formulas').forEach((f, fi) => {
    const label = isObj(f) ? str(f.label, `Formula ${fi + 1}`) : `Formula ${fi + 1}`
    const expr = isObj(f) ? normExpr(f.expr) : null
    if (!expr) {
      problems.push(`Formula "${label}" was skipped: its expr is not a valid term, or a sum, min or max of them.`)
      return
    }
    for (const ref of new Set(refsOf(expr))) {
      if (!known.has(ref)) problems.push(`Formula "${label}" uses the category "${ref}", which does not exist (ids are case-sensitive).`)
    }
    formulas.push({ label, expr })
  })
  if (!formulas.length) problems.push('This scheme has no formulas yet, so nothing is scored.')

  const cutoffs: Cutoff[] = []
  list(raw.cutoffs, 'cutoffs').forEach((c, i) => {
    const min = isObj(c) ? num(c.min) : null
    if (!isObj(c) || min === null) problems.push(`Cutoff ${i + 1} needs a label and a numeric min, so it was skipped.`)
    else cutoffs.push({ label: str(c.label, String(min)), min })
  })

  const outOf = num(raw.outOf)
  if (raw.outOf !== undefined && (outOf === null || outOf <= 0)) problems.push('outOf must be a number above 0, so 100 was used.')

  return {
    scheme: { label: str(raw.label, ''), outOf: outOf !== null && outOf > 0 ? outOf : 100, categories, formulas, cutoffs },
    problems,
  }
}

/**
 * One typed score written into the scheme exactly as it was loaded, touching nothing else. Saving
 * a normalised copy instead would delete whatever normalizeScheme could not read.
 */
export function withEarned(raw: unknown, catId: string, itemId: string, earned: number | null): unknown {
  if (!isObj(raw) || !Array.isArray(raw.categories)) return raw
  const inCat = (c: unknown, ci: number): unknown => {
    if (!isObj(c) || idOf(c, ci, 'cat') !== catId || !Array.isArray(c.items)) return c
    return { ...c, items: c.items.map((it, ii) => (isObj(it) && idOf(it, ii, 'item') === itemId ? { ...it, earned } : it)) }
  }
  return { ...raw, categories: raw.categories.map(inCat) }
}

/* ------------------------------------------------------------------ starters */

const items = (prefix: string, n: number, possible: number, labels?: string[]): GradeItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    label: labels?.[i] ?? `${prefix} ${i + 1}`,
    possible,
    earned: null,
  }))

const GRADE_BANDS = (a: number, b: number, c: number, d: number, fail = 'R'): Cutoff[] => [
  { label: 'A', min: a },
  { label: 'B', min: b },
  { label: 'C', min: c },
  { label: 'D', min: d },
  { label: fail, min: 0 },
]

/**
 * A generic weighted-categories scheme first, for any course anywhere, then two real syllabi, so
 * the tab is usable the moment it opens instead of asking for hand-written JSON first. Everything
 * here is ordinary data — edit grades.json and the app follows.
 */
export const STARTERS: { id: string; label: string; build: () => GradeScheme }[] = [
  {
    id: 'weighted',
    label: 'Weighted categories (any course)',
    // No items: only the student knows how many assignments there are. The weights are a common
    // split to edit, not a claim about any syllabus, and each one is percent of the course.
    build: (): GradeScheme => ({
      label: 'Weighted categories',
      outOf: 100,
      categories: [
        { id: 'hw', label: 'Homework', items: [] },
        { id: 'exams', label: 'Exams', items: [] },
        { id: 'part', label: 'Participation', items: [] },
      ],
      formulas: [
        {
          label: 'Weighted categories',
          expr: {
            op: 'sum',
            of: [
              { term: { ref: 'hw', weight: 30 } },
              { term: { ref: 'exams', weight: 60 } },
              { term: { ref: 'part', weight: 10 } },
            ],
          },
        },
      ],
      cutoffs: GRADE_BANDS(90, 80, 70, 60, 'F'),
    }),
  },
  {
    id: '21-127',
    label: '21-127 (two formulas, best wins)',
    build: (): GradeScheme => ({
      label: 'Concepts of Mathematics',
      outOf: 100,
      categories: [
        { id: 'hw', label: 'Homework', items: items('HW', 12, 25) },
        { id: 'mid', label: 'Midterms', items: items('Midterm', 3, 100) },
        { id: 'final', label: 'Final exam', items: items('Final', 1, 100, ['Final']) },
      ],
      formulas: [
        {
          label: 'Formula 1',
          expr: {
            op: 'sum',
            of: [
              { term: { ref: 'hw', weight: 15, pick: 'drop-lowest' } },
              { term: { ref: 'mid', weight: 9, pick: 'lowest' } },
              { term: { ref: 'mid', weight: 18, pick: 'rest' } },
              { term: { ref: 'final', weight: 40 } },
            ],
          },
        },
        {
          label: 'Formula 2',
          expr: {
            op: 'sum',
            of: [
              { term: { ref: 'hw', weight: 15, pick: 'drop-lowest' } },
              { term: { ref: 'mid', weight: 18, pick: 'each' } },
              { term: { ref: 'final', weight: 31 } },
            ],
          },
        },
      ],
      cutoffs: GRADE_BANDS(90, 80, 70, 60),
    }),
  },
  {
    id: '15-122',
    label: '15-122 (min(CH, PR+PG) + FI + AC)',
    build: (): GradeScheme => ({
      label: 'Principles of Imperative Computation',
      outOf: 1000,
      categories: [
        { id: 'CH', label: 'Checkins', items: items('CH', 13, 60) },
        { id: 'PR', label: 'Practice problems', items: items('PR', 12, 10) },
        {
          id: 'PG',
          label: 'Programming',
          items: items('PG', 12, 50, [
            'scavhunt', 'pixels', 'images', 'speller', 'clac', 'editor (chk)',
            'editor (final)', 'peg', 'queues', 'huffman', 'c0vm (chk)', 'c0vm (final)',
          ]),
        },
        { id: 'FI', label: 'Final exam', items: items('Final', 1, 250, ['Final']) },
        {
          id: 'AC',
          label: 'Recitations and activities',
          items: [
            { id: 'AC1', label: 'Activities', possible: 8, earned: null },
            { id: 'AC2', label: 'Remaining activities', possible: 22, earned: null },
          ],
        },
      ],
      formulas: [
        {
          label: 'min(CH, PR + PG) + FI + AC',
          expr: {
            op: 'sum',
            of: [
              {
                op: 'min',
                of: [
                  { term: { ref: 'CH', weight: 780 } },
                  { op: 'sum', of: [{ term: { ref: 'PR', weight: 120 } }, { term: { ref: 'PG', weight: 600 } }] },
                ],
              },
              { term: { ref: 'FI', weight: 250 } },
              { term: { ref: 'AC', weight: 30 } },
            ],
          },
        },
      ],
      cutoffs: GRADE_BANDS(900, 800, 700, 600),
    }),
  },
]
