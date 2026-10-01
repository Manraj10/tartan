import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Course } from '@shared/types'
import {
  STARTERS,
  byFormula,
  letterFor,
  neededFor,
  normalizeScheme,
  resolvable,
  score,
  ungradedCount,
  unreadableReason,
  withEarned,
  type GradeCategory,
  type GradesState,
} from '@shared/grades'

/** Electron prefixes every rejected invoke with "Error invoking remote method '...': Error: ". */
const reason = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

/**
 * A space's grade, computed from the scheme in grades.json. The scheme is hand-editable data —
 * this panel never writes weights or cutoffs, only the scores you type. Layout is inline and
 * everything visual reuses existing classes, so the panel adds no CSS of its own.
 */
export default function GradesPanel({ course }: { course: Course }) {
  const [all, setAll] = useState<GradesState | null>(null)
  /** Why grades.json cannot be used. While set the panel shows it and writes nothing. */
  const [unreadable, setUnreadable] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [assume, setAssume] = useState(85)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<GradesState | null>(null)

  /**
   * A renderer reload picks up new UI while the old main process keeps running, so this tab can
   * load in an app whose preload has no `grades` bridge yet. Say so instead of throwing.
   */
  const bridge = window.api.grades
  useEffect(() => {
    if (!bridge) return
    void bridge.get().then(
      (state) => {
        const why = unreadableReason(state)
        setUnreadable(why)
        if (!why) setAll(state)
      },
      // A failed read is not an empty file: treating it as one is how a save wipes the real data.
      (err) => setUnreadable(reason(err)),
    )
  }, [bridge, attempt])

  const parsed = useMemo(() => normalizeScheme(all?.[course.id]), [all, course.id])
  const scheme = parsed?.scheme ?? null

  const write = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const next = pending.current
    pending.current = null
    if (next) void bridge?.set(next).then(() => setSaveError(null), (err) => setSaveError(reason(err)))
  }

  /** Debounced so typing a score is not one file write per keystroke. */
  const save = (next: unknown): void => {
    const merged = { ...all, [course.id]: next } as GradesState
    setAll(merged)
    pending.current = merged
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(write, 400)
  }

  // Leaving the tab within the debounce window must write the pending score, not drop it.
  useEffect(() => write, [])

  const setEarned = (catId: string, itemId: string, value: number | null): void =>
    save(withEarned(all?.[course.id], catId, itemId, value))

  const view = useMemo(() => {
    if (!scheme) return null
    const opts = { project: true, assume: assume / 100 }
    const projected = score(scheme, opts)
    const banked = score(scheme, { project: false, assume: 0 })
    const pct = (projected / scheme.outOf) * 100
    const left = ungradedCount(scheme)
    const total = scheme.categories.reduce((n, c) => n + c.items.length, 0)
    const needs = scheme.cutoffs
      .filter((c) => c.min > 0)
      .sort((a, b) => b.min - a.min)
      .map((c) => ({ label: c.label, min: c.min, need: neededFor(scheme, c.min) }))
    // With nothing graded, pct and letter would only echo the assumed rate (or 0 for no items). With no
    // formula, or one naming a category that is not there, evalExpr reads 0: a real-looking 0.0% R.
    const ok = resolvable(scheme)
    return { projected, banked, pct, left, total, ok, scored: ok && total > left, needs, formulas: byFormula(scheme, opts) }
  }, [scheme, assume])

  if (!bridge) {
    return (
      <div className="empty">
        Quit Tartan from the tray and start it again — the Grades tab needs the rebuilt main process.
      </div>
    )
  }

  if (unreadable !== null) {
    return (
      <Blocked
        title="grades.json could not be read"
        why={unreadable}
        onRetry={() => setAttempt((n) => n + 1)}
      >
        Your schemes and scores are still in the file. Tartan will not write to it until it parses, so fix the
        error below in a text editor, then check again.
      </Blocked>
    )
  }

  if (all === null) return <div className="empty">Loading…</div>

  // A present entry that is not an object (a stray string, a number) is not "no scheme": a starter
  // would silently replace whatever the user put there.
  if (all[course.id] != null && !parsed) {
    return (
      <Blocked
        title={`The ${course.id} entry in grades.json is not a scheme`}
        onRetry={() => setAttempt((n) => n + 1)}
      >
        A scheme is a JSON object. Tartan will not overwrite this entry, so fix or delete it in a text editor,
        then check again.
      </Blocked>
    )
  }

  if (!scheme || !view) {
    return (
      <div className="card stack" style={{ maxWidth: 560 }}>
        <div className="section-title">No grading scheme for {course.code} yet</div>
        <p className="muted" style={{ margin: 0 }}>
          A scheme lives in <code>grades.json</code> in your data folder, keyed by space id. Start from a
          template below and edit the file by hand whenever the weights change — the app reads whatever is there.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          A scheme has a <code>label</code>, an <code>outOf</code> (the scale its formulas produce: 100 for
          percentages), <code>categories</code>, <code>formulas</code> and <code>cutoffs</code>. A category has an{' '}
          <code>id</code>, a <code>label</code> and <code>items</code>; an item has an <code>id</code>, a{' '}
          <code>label</code>, <code>possible</code> points and <code>earned</code> (null until graded). A formula
          has a <code>label</code> and an <code>expr</code>: a term (<code>ref</code> is a category id,{' '}
          <code>weight</code> multiplies it, <code>pick</code> is optional) or an <code>op</code> of{' '}
          <code>sum</code>, <code>min</code> or <code>max</code> over a list called <code>of</code>. With several
          formulas the best one counts. A cutoff is a <code>label</code> and a <code>min</code> on the{' '}
          <code>outOf</code> scale.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {STARTERS.map((s) => (
            <button key={s.id} className="btn" onClick={() => save(s.build())}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const isPoints = scheme.outOf !== 100

  return (
    <div className="stack" style={{ padding: 16, gap: 16, overflowY: 'auto' }}>
      <div className="card stack" style={{ gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 40, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
            {view.scored ? `${view.pct.toFixed(1)}%` : '—'}
          </span>
          <span className="chip" style={{ fontSize: 20, padding: '2px 12px' }}>
            {view.scored ? letterFor(scheme, view.projected) : '—'}
          </span>
          {isPoints && view.scored ? (
            <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {view.projected.toFixed(1)} of {scheme.outOf} pt
            </span>
          ) : null}
        </div>

        <div className="muted">
          {!view.ok
            ? 'Nothing is scored until the formulas below work.'
            : view.total === 0
              ? 'No items yet, so nothing is scored.'
              : view.left === 0
                ? 'Everything is graded — this is your actual grade.'
                : `Projected, with ${view.left} item${view.left === 1 ? '' : 's'} still ungraded. ` +
                  `Banked so far: ${view.banked.toFixed(1)}${isPoints ? ' pt' : '%'}.`}
        </div>

        {parsed?.problems.map((p) => (
          <div key={p} style={{ color: 'var(--danger)' }}>
            {p}
          </div>
        ))}
        {saveError ? <div style={{ color: 'var(--danger)' }}>Not saved: {saveError}</div> : null}

        {view.formulas.length > 1 && view.scored ? (
          <div style={{ display: 'grid', gap: 6 }}>
            {view.formulas.map((f) => {
              const best = f.value >= Math.max(...view.formulas.map((g) => g.value)) - 1e-9
              return (
                <div
                  key={f.label}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'var(--surface-2, transparent)',
                    border: best ? '1px solid var(--accent, currentColor)' : '1px solid transparent',
                  }}
                >
                  <span>
                    {f.label}
                    {best ? ' · carrying you' : ''}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{f.value.toFixed(1)}</span>
                </div>
              )
            })}
          </div>
        ) : null}

        {view.left > 0 ? (
          <label className="muted" style={{ display: 'grid', gap: 6 }}>
            <span>
              Assume anything with no grade scores <b>{assume}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={assume}
              onChange={(e) => setAssume(Number(e.target.value))}
            />
          </label>
        ) : null}
      </div>

      {view.ok && view.left > 0 && view.needs.length > 0 ? (
        <div className="card stack" style={{ gap: 8 }}>
          <div className="section-title">What you need on everything left</div>
          {view.needs.map((n) => (
            <div key={n.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span>
                {n.label} <span className="muted">({n.min}{isPoints ? ' pt' : '%'})</span>
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {n.need === null ? (
                  <span className="muted">out of reach</span>
                ) : n.need === 0 ? (
                  <span className="muted">already there</span>
                ) : (
                  `${(n.need * 100).toFixed(1)}%`
                )}
              </span>
            </div>
          ))}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            One score applied to every ungraded item. Trade between them freely — this is the flat line
            through the middle, not the only way there.
          </p>
        </div>
      ) : null}

      {scheme.categories.map((cat) => (
        <CategoryCard key={cat.id} cat={cat} onSet={(itemId, v) => setEarned(cat.id, itemId, v)} />
      ))}
    </div>
  )
}

function CategoryCard({
  cat,
  onSet,
}: {
  cat: GradeCategory
  onSet: (itemId: string, value: number | null) => void
}) {
  const graded = cat.items.filter((i) => i.earned != null)
  const earned = graded.reduce((s, i) => s + (i.earned ?? 0), 0)
  const possible = graded.reduce((s, i) => s + i.possible, 0)

  return (
    <div className="card stack" style={{ gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
        <span className="section-title">{cat.label}</span>
        <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {possible > 0 ? `${((earned / possible) * 100).toFixed(1)}% · ${graded.length}/${cat.items.length} graded` : 'nothing graded'}
        </span>
      </div>
      {cat.items.length === 0 ? (
        <span className="muted">
          No items yet. Add them to this category's <code>items</code> in grades.json, each like{' '}
          <code>{'{ "id": "hw1", "label": "Homework 1", "possible": 10, "earned": null }'}</code>. A category
          with no items counts as 0, so if the course has none, delete it and its term in the formula, then rebalance the weights.
        </span>
      ) : null}
      {cat.items.map((item) => (
        <div
          key={item.id}
          style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 8 }}
        >
          <span style={{ opacity: item.earned == null ? 0.5 : 1 }}>{item.label}</span>
          <input
            className="input"
            type="number"
            min={0}
            step="0.5"
            placeholder="—"
            value={item.earned ?? ''}
            aria-label={`${item.label} score`}
            style={{ width: 78, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            onChange={(e) => onSet(item.id, e.target.value === '' ? null : Number(e.target.value))}
          />
          <span className="muted" style={{ minWidth: 42, fontVariantNumeric: 'tabular-nums' }}>
            / {item.possible}
          </span>
        </div>
      ))}
    </div>
  )
}

/** grades.json is there but not safe to build on: say why, and offer to look again after a fix. */
function Blocked({
  title,
  why,
  onRetry,
  children,
}: {
  title: string
  why?: string
  onRetry: () => void
  children: ReactNode
}) {
  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <div className="section-title">{title}</div>
      <p className="muted" style={{ margin: 0 }}>
        {children}
      </p>
      {why ? <p style={{ margin: 0, color: 'var(--danger)' }}>{why}</p> : null}
      <div>
        <button className="btn" onClick={onRetry}>
          Check again
        </button>
      </div>
    </div>
  )
}
