import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
const source = readFileSync(new URL('../src/shared/grades.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm' })
const g = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const { score, byFormula, letterFor, neededFor, ungradedCount, normalizeScheme, withEarned, parseGrades, unreadable, unreadableReason, resolvable, STARTERS } = g

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`)
const graded = { project: false, assume: 0 }
const starter = (id) => STARTERS.find((s) => s.id === id).build()
/** Fills every item of a category with `earned` points out of its own possible. */
const fill = (scheme, catId, earned) => {
  const cat = scheme.categories.find((c) => c.id === catId)
  cat.items.forEach((it, i) => (it.earned = typeof earned === 'function' ? earned(it, i) : earned))
}

/* ---------------------------------------------------------------- scoring */

// 21-127: two formulas, best wins. HW perfect, midterms 100/100/70, final perfect.
const m = starter('21-127')
fill(m, 'hw', (it) => it.possible)
fill(m, 'mid', (it, i) => (i === 2 ? 70 : 100))
fill(m, 'final', 100)
const both = byFormula(m, graded)
near(both[0].value, 15 + 9 * 0.7 + 18 * 2 + 40, 'formula 1 demotes the lowest midterm')
near(both[1].value, 15 + 18 * 2.7 + 31, 'formula 2 weighs every midterm the same')
near(score(m, graded), Math.max(both[0].value, both[1].value), 'the best formula is the score')
assert.equal(letterFor(m, score(m, graded)), 'A')
assert.equal(ungradedCount(m), 0)
assert.equal(neededFor(m, 90), null, 'nothing left to need')

// 15-122: min(CH, PR + PG) + FI + AC, perfect on everything is 1000.
const p = starter('15-122')
for (const c of p.categories) fill(p, c.id, (it) => it.possible)
near(score(p, graded), 1000, '15-122 perfect')
assert.equal(letterFor(p, 1000), 'A')
// CH caps the programming side: checkins at half score cap min() at 390 even with PR + PG perfect.
fill(p, 'CH', (it) => it.possible / 2)
near(score(p, graded), 390 + 250 + 30, 'min() takes the smaller side')

// Ungraded work is projected at the assumed rate when projecting; banked is what is actually earned so far.
const one = {
  label: 't',
  outOf: 100,
  categories: [{ id: 'a', label: 'A', items: [{ id: 'a1', label: '1', possible: 50, earned: 40 }, { id: 'a2', label: '2', possible: 50, earned: null }] }],
  formulas: [{ label: 'f', expr: { term: { ref: 'a', weight: 100 } } }],
  cutoffs: [{ label: 'A', min: 90 }, { label: 'B', min: 70 }, { label: 'F', min: 0 }],
}
near(score(one, graded), 40, 'banked: ungraded work counts as nothing yet, so 40 of 100')
// A category with something graded projects at its own running rate (80%), not at the assumed one.
near(score(one, { project: true, assume: 0.5 }), 80, 'projected at the category rate')
const fresh = { ...one, categories: [{ ...one.categories[0], items: one.categories[0].items.map((i) => ({ ...i, earned: null })) }] }
near(score(fresh, { project: true, assume: 0.5 }), 50, 'nothing graded projects at the assumed rate')
// neededFor: 40 + 50x >= target over 100 points.
near(neededFor(one, 70), 0.6, 'need 60% on the last item for 70')
assert.equal(neededFor(one, 95), null, 'out of reach')
assert.equal(neededFor(one, 30), 0, 'already there')
assert.equal(letterFor(one, 75), 'B')
assert.equal(letterFor({ cutoffs: [] }, 75), '—', 'no cutoffs, no letter')

/* ------------------------------------------------------------ normaliser */

// A fixed point for everything the app ships, so normalising never changes a healthy scheme.
for (const s of STARTERS) {
  const out = normalizeScheme(s.build())
  assert.deepEqual(out.scheme, s.build(), `${s.id} survives normalising unchanged`)
  assert.deepEqual(out.problems, [], `${s.id} has no problems`)
}

// The weighted-categories starter works for any course: empty categories score 0 and do not throw.
const w = normalizeScheme(starter('weighted')).scheme
assert.deepEqual(w.categories.map((c) => c.label), ['Homework', 'Exams', 'Participation'])
assert.ok(w.categories.every((c) => c.items.length === 0))
near(score(w, { project: true, assume: 0.85 }), 0, 'no items, no score')
// Once items exist, the weights are percent of the course.
w.categories[0].items.push({ id: 'hw1', label: 'HW 1', possible: 10, earned: 9 })
w.categories[1].items.push({ id: 'e1', label: 'Exam', possible: 100, earned: 80 })
near(score(w, graded), 30 * 0.9 + 60 * 0.8, 'weighted categories')

// Things that used to crash the workspace: {}, no cutoffs, a category without items, not-objects.
assert.equal(normalizeScheme(null), null)
assert.equal(normalizeScheme(undefined), null)
assert.equal(normalizeScheme('TODO'), null)
assert.equal(normalizeScheme([]), null)
assert.equal(normalizeScheme(5), null)

const empty = normalizeScheme({})
assert.deepEqual(empty.scheme, { label: '', outOf: 100, categories: [], formulas: [], cutoffs: [] })
assert.ok(empty.problems.some((x) => /no formulas/.test(x)))
near(score(empty.scheme, graded), 0, '{} scores without throwing')
assert.equal(letterFor(empty.scheme, 0), '—')
assert.equal(neededFor(empty.scheme, 50), null)

const noCutoffs = normalizeScheme({ ...one, cutoffs: undefined }).scheme
assert.deepEqual(noCutoffs.cutoffs, [])
const noItems = normalizeScheme({ ...one, categories: [{ id: 'a', label: 'A' }] }).scheme
assert.deepEqual(noItems.categories[0].items, [])
near(score(noItems, graded), 0, 'a category without items scores 0')

// outOf 0 (and junk) must not divide by zero in the panel: it becomes 100 and says so.
for (const outOf of [0, -5, 'lots', NaN, null]) {
  const r = normalizeScheme({ ...one, outOf })
  assert.equal(r.scheme.outOf, 100, `outOf ${outOf} falls back to 100`)
  assert.ok(Number.isFinite((score(r.scheme, graded) / r.scheme.outOf) * 100))
  assert.ok(r.problems.some((x) => /outOf/.test(x)), `outOf ${outOf} is reported`)
}
assert.equal(normalizeScheme({ ...one, outOf: '1000' }).scheme.outOf, 1000, 'a numeric string is a number')
assert.deepEqual(normalizeScheme({ ...one, outOf: undefined }).problems, [], 'a missing outOf is just the default')

// Malformed formulas are skipped and reported, never guessed at; good ones still count.
const bad = normalizeScheme({
  ...one,
  formulas: [
    { label: 'ok', expr: { term: { ref: 'a', weight: 100 } } },
    { label: 'no expr' },
    { label: 'bad op', expr: { op: 'avg', of: [] } },
    { label: 'bad pick', expr: { term: { ref: 'a', weight: 1, pick: 'median' } } },
    { label: 'bad child', expr: { op: 'sum', of: [{ term: { ref: 'a', weight: 1 } }, null] } },
    { label: 'no of', expr: { op: 'sum' } },
    null,
  ],
})
assert.deepEqual(bad.scheme.formulas.map((f) => f.label), ['ok'])
assert.equal(bad.problems.length, 6)
near(score(bad.scheme, graded), 40, 'the readable formula still scores')

// A term whose category is misspelt is kept (it is worth 0) but called out.
const typo = normalizeScheme({ ...one, formulas: [{ label: 'f', expr: { term: { ref: 'A', weight: 100 } } }] })
assert.ok(typo.problems.some((x) => /"A".*does not exist/.test(x)))

// A scheme that cannot produce a grade is not scored: no formulas, or any formula naming a category
// that is not there (evalExpr reads that as 0, which the panel used to show as a real 0.0%).
assert.equal(resolvable(typo.scheme), false, 'a misspelt category cannot resolve')
assert.equal(resolvable(empty.scheme), false, 'no formulas cannot resolve')
assert.equal(resolvable(normalizeScheme({ ...one, formulas: [] }).scheme), false)
assert.equal(resolvable(normalizeScheme({ ...one, formulas: [{ label: 'f', expr: { term: { ref: 'a', weight: 100 } } }, { label: 'g', expr: { op: 'sum', of: [{ term: { ref: 'a', weight: 1 } }, { term: { ref: 'b', weight: 1 } }] } }] }).scheme), true, 'one stale formula beside a working one still scores')
assert.equal(resolvable(normalizeScheme({ ...one, formulas: [{ label: 'f', expr: { op: 'sum', of: [] } }] }).scheme), false, 'a formula with no terms cannot resolve')
assert.equal(resolvable(normalizeScheme(one).scheme), true)
for (const s of STARTERS) assert.equal(resolvable(s.build()), true, `${s.id} resolves`)

// A value that is present but unreadable is called out, never silently 0 or ungraded; null earned is just ungraded.
const numeric = (item) => normalizeScheme({ ...one, categories: [{ id: 'a', items: [item] }] })
const ten = numeric({ id: 'x', possible: 'ten', earned: '9/10' })
assert.equal(ten.problems.length, 2, 'both the possible and the earned are reported')
assert.ok(ten.problems.some((x) => /possible/.test(x)) && ten.problems.some((x) => /earned/.test(x)))
assert.deepEqual(ten.scheme.categories[0].items[0], { id: 'x', label: 'x', possible: 0, earned: null })
const neg = numeric({ id: 'x', possible: -5, earned: 3 })
assert.equal(neg.problems.length, 1, 'a negative possible is reported')
assert.match(neg.problems[0], /possible/)
assert.equal(neg.scheme.categories[0].items[0].possible, 0)
for (const earned of [null, undefined]) assert.deepEqual(numeric({ id: 'x', possible: 10, earned }).problems, [], 'not graded yet is not a problem')
assert.deepEqual(numeric({ id: 'x', possible: '10', earned: '0' }).problems, [], 'numeric strings and a real 0 are fine')
for (const possible of [undefined, null]) {
  const gap = numeric({ id: 'x', earned: 8, possible })
  assert.equal(gap.problems.length, 1, `an earned score with possible ${possible} is reported once`)
  assert.match(gap.problems[0], /"x".*earned.*no possible/)
}
assert.deepEqual(numeric({ id: 'x' }).problems, [], 'an item with neither score is just an empty row')
assert.equal(numeric({ id: 'x', possible: 'ten', earned: 8 }).problems.length, 1, 'an unreadable possible is not reported twice')

// Missing ids fall back to their position; numeric strings become numbers; junk earned is ungraded.
const loose = normalizeScheme({
  categories: [{ label: 'HW', items: [{ possible: '10', earned: '7' }, { id: 2, label: 'Two', possible: 5, earned: 'n/a' }, 'junk'] }, 7],
  formulas: [{ expr: { term: { ref: 'cat1', weight: '100' } } }],
  cutoffs: [{ label: 'A', min: '90' }, { label: 'B' }, 'x'],
})
assert.deepEqual(loose.scheme.categories, [
  { id: 'cat1', label: 'HW', items: [{ id: 'item1', label: 'item1', possible: 10, earned: 7 }, { id: '2', label: 'Two', possible: 5, earned: null }] },
])
assert.deepEqual(loose.scheme.formulas, [{ label: 'Formula 1', expr: { term: { ref: 'cat1', weight: 100 } } }])
assert.deepEqual(loose.scheme.cutoffs, [{ label: 'A', min: 90 }])
assert.equal(loose.problems.length, 5, 'junk earned, junk item, junk category, two junk cutoffs')
assert.ok(loose.problems.some((x) => /"2".*earned.*not a number/.test(x)), "earned 'n/a' is reported, not silently ungraded")
near(score(loose.scheme, { project: true, assume: 0.5 }), 70, 'the ungraded item projects at the rate of the graded one')

// Wrong container types are ignored with a message, not iterated.
const lists = normalizeScheme({ categories: { a: 1 }, formulas: 'x', cutoffs: 3 })
assert.equal(lists.problems.filter((x) => /should be a list/.test(x)).length, 3)

/* ------------------------------------------------------------ saving a score */

// A typed score goes into the file as loaded: the unreadable formula and unknown keys survive.
const raw = {
  note: 'mine',
  categories: [{ id: 'hw', extra: 1, items: [{ id: 'h1', earned: null, possible: 10 }, { label: 'no id', possible: 10 }] }, { id: 'x', items: [{ id: 'h1' }] }],
  formulas: [{ label: 'broken', expr: { op: 'avg' } }],
}
const saved = withEarned(raw, 'hw', 'h1', 9)
assert.equal(saved.categories[0].items[0].earned, 9)
assert.equal(saved.categories[0].extra, 1)
assert.equal(saved.note, 'mine')
assert.deepEqual(saved.formulas, raw.formulas, 'the formula the panel skipped is still in the file')
assert.equal(saved.categories[1].items[0].earned, undefined, 'the same item id in another category is untouched')
assert.equal(raw.categories[0].items[0].earned, null, 'the input is not mutated')
// An entry with no id is addressed by the id the panel showed for it.
const shown = normalizeScheme(raw).scheme.categories[0].items[1].id
assert.equal(shown, 'item2')
assert.equal(withEarned(raw, 'hw', shown, 4).categories[0].items[1].earned, 4)
assert.equal(withEarned(raw, 'hw', shown, null).categories[0].items[1].earned, null)
// Nothing to write into: hand the value back untouched.
assert.equal(withEarned(null, 'a', 'b', 1), null)
assert.deepEqual(withEarned({}, 'a', 'b', 1), {})
assert.deepEqual(withEarned({ categories: [{ id: 'a' }] }, 'a', 'b', 1), { categories: [{ id: 'a' }] })

/* ----------------------------------------------------------- reading the file */

assert.deepEqual(parseGrades('{"a":{"label":"x"}}'), { state: { a: { label: 'x' } } })
assert.deepEqual(parseGrades(''), { state: {} })
assert.deepEqual(parseGrades('  \r\n'), { state: {} }, 'an empty file holds nothing to lose')
assert.deepEqual(parseGrades('﻿{"a":1}'), { state: { a: 1 } }, 'a byte-order mark from Notepad is not a typo')
// The reported bug: a stray comma must be an error with a message, not an empty state.
for (const text of ['{"15-122": {"label": "x"},}', '{"a": ', '{', 'nope']) {
  const r = parseGrades(text)
  assert.ok(typeof r.error === 'string' && r.error.length > 0, `${text} is an error`)
  assert.equal(r.state, undefined)
}
for (const text of ['[]', 'null', '"x"', '5', 'true']) {
  assert.match(parseGrades(text).error, /one JSON object/, `${text} is not a grades file`)
}

// What getGrades hands the panel when the file is broken, and what a healthy state says.
assert.equal(unreadableReason(unreadable('boom')), 'boom')
assert.equal(unreadableReason({ '21-127': one }), null)
assert.equal(unreadableReason({}), null)
assert.equal(unreadable('boom')['21-127'], undefined, 'no course id can collide with the marker')
assert.ok(!/^[A-Za-z0-9]/.test(Object.keys(unreadable('boom'))[0]), 'renameCourse only accepts ids that start with a letter or digit')

console.log('grades: ok')
