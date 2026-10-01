import { useCallback, useEffect, useMemo, useState } from 'react'
import { LADDER, openUrl, problemUrl, streakOf, type LadderStep, type LeetcodeState } from '@shared/leetcode'

/**
 * The whole ladder as one table: what is done and when, where you are, and where you are stuck.
 * The Today card is the daily nudge; this is the map. Reading and ticking only — the curriculum
 * itself ships with the app and is not editable here.
 */

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const DIFF_COLOR: Record<string, string> = {
  Easy: 'var(--ok)',
  Medium: 'var(--warn)',
  Hard: 'var(--danger)',
}

export default function Grind() {
  const [state, setState] = useState<LeetcodeState | null>(null)
  // A minute-grain day key, so the heatmap's "today" ring rolls at midnight even when the view
  // just sits there — a memo keyed on data alone froze the clock at whenever the data last moved.
  const [today, setToday] = useState(() => ymd(new Date()))
  useEffect(() => {
    const t = setInterval(
      () =>
        setToday((prev) => {
          const next = ymd(new Date())
          return next === prev ? prev : next
        }),
      60_000,
    )
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const load = (): void => {
      void window.api.leetcode.get().then(setState).catch(() => setState({ done: {} }))
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  const toggle = useCallback(
    async (slug: string) => {
      if (!state) return
      const next = { done: { ...state.done } }
      if (next.done[slug]) delete next.done[slug]
      else next.done[slug] = ymd(new Date())
      setState(next)
      try {
        await window.api.leetcode.set(next)
      } catch {
        setState(state)
      }
    },
    [state],
  )

  /**
   * TickTick-style month of squares, from dates already in leetcode.json. Columns are weeks,
   * rows Mon–Sun, ending on this week's Sunday so today always sits in the last column.
   */
  const heat = useMemo(() => {
    if (!state) return null
    const counts = new Map<string, number>()
    for (const day of Object.values(state.done)) counts.set(day, (counts.get(day) ?? 0) + 1)
    const [y, mo, da] = today.split('-').map(Number)
    const base = new Date(y, mo - 1, da)
    const sunday = new Date(y, mo - 1, da + (6 - ((base.getDay() + 6) % 7)))
    const cells: { day: string; count: number; future: boolean }[] = []
    for (let i = 12 * 7 - 1; i >= 0; i--) {
      const d = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() - i)
      const day = ymd(d)
      cells.push({ day, count: counts.get(day) ?? 0, future: day > today })
    }
    return { cells, today, total: cells.reduce((a, c) => a + c.count, 0) }
  }, [state, today])

  const stats = useMemo(() => {
    if (!state) return null
    const done = state.done
    const solved = LADDER.filter((p) => done[p.slug])
    const current = LADDER.find((p) => !done[p.slug]) ?? null
    const per = (d: string) => ({
      done: solved.filter((p) => p.difficulty === d).length,
      total: LADDER.filter((p) => p.difficulty === d).length,
    })
    // Stuck = days since the last solve, while a rung is still open. Zero-solve mornings excluded
    // by streakOf; this is the harsher number the table exists to surface.
    const lastSolve = Object.values(done).sort().at(-1) ?? null
    const stuckDays = lastSolve
      ? Math.max(0, Math.floor((Date.now() - new Date(`${lastSolve}T00:00`).getTime()) / 86_400_000))
      : null
    return {
      solved: solved.length,
      current,
      streak: streakOf(done),
      easy: per('Easy'),
      medium: per('Medium'),
      hard: per('Hard'),
      stuckDays,
    }
  }, [state])

  if (!state || !stats || !heat) return null

  // Topic blocks, in ladder order.
  const topics: { topic: string; items: LadderStep[] }[] = []
  for (const p of LADDER) {
    const last = topics[topics.length - 1]
    if (last && last.topic === p.topic) last.items.push(p)
    else topics.push({ topic: p.topic, items: [p] })
  }

  return (
    <>
      <div className="topbar">
        <h1>LeetCode</h1>
        <span className="muted">
          {stats.solved}/{LADDER.length}
          {stats.streak > 0 ? ` · 🔥 ${stats.streak}` : ''}
        </span>
        <div className="spacer" />
        {/* Colour only the difficulty WORDS — three fully saturated count clusters in the title
            row out-shouted the h1 and restated the table's own Diff column at full volume. */}
        <span className="muted" style={{ display: 'flex', gap: 12 }}>
          <span>
            <span style={{ color: DIFF_COLOR.Easy }}>Easy</span> {stats.easy.done}/{stats.easy.total}
          </span>
          <span>
            <span style={{ color: DIFF_COLOR.Medium }}>Medium</span> {stats.medium.done}/{stats.medium.total}
          </span>
          <span>
            <span style={{ color: DIFF_COLOR.Hard }}>Hard</span> {stats.hard.done}/{stats.hard.total}
          </span>
        </span>
      </div>

      <div className="content wide">
        <div className="card" style={{ marginBottom: 'var(--sp-4)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
          <div style={{ flex: 'none' }}>
            <div className="section-title" style={{ margin: 0 }}>
              Last 12 weeks
            </div>
            <div className="muted" style={{ fontSize: 'var(--fs-sm)', marginTop: 4 }}>
              {heat.total} solved{stats.streak > 0 ? ` · 🔥 ${stats.streak}-day streak` : ''}
            </div>
          </div>
          <div className="heatmap" role="img" aria-label={`${heat.total} problems solved in the last 12 weeks`}>
            {heat.cells.map((c) => (
              <span
                key={c.day}
                className={`heat${c.count > 1 ? ' hot' : c.count ? ' warm' : ''}${c.day === heat.today ? ' today' : ''}${c.future ? ' future' : ''}`}
                title={`${c.day} — ${c.count} solved`}
              />
            ))}
          </div>
        </div>

        {stats.current && stats.stuckDays !== null && stats.stuckDays >= 2 ? (
          <div className="card" style={{ marginBottom: 14, padding: '8px 14px', borderLeft: '3px solid var(--warn)' }}>
            Stuck on <strong>{stats.current.title}</strong> for {stats.stuckDays} days — the video solution on the
            mirror is one click, and watching it still counts as learning.
          </div>
        ) : null}

        <table className="grind">
          <thead>
            <tr>
              <th style={{ width: 34 }}>#</th>
              <th style={{ width: 30 }} aria-label="Done" />
              <th>Problem</th>
              <th style={{ width: 72 }}>Diff</th>
              <th>Asked at</th>
              <th style={{ width: 96 }}>Done</th>
              <th style={{ width: 60 }} aria-label="Links" />
            </tr>
          </thead>
          {topics.map((t) => {
            const tDone = t.items.filter((p) => state.done[p.slug]).length
            return (
              <tbody key={t.topic}>
                <tr className="grind-topic">
                  <td colSpan={7}>
                    {t.topic}
                    <span className="faint" style={{ marginLeft: 8 }}>
                      {tDone}/{t.items.length}
                    </span>
                  </td>
                </tr>
                {t.items.map((p) => {
                  const doneAt = state.done[p.slug]
                  const isCurrent = stats.current?.slug === p.slug
                  return (
                    <tr key={p.slug} className={`${doneAt ? 'is-done' : ''}${isCurrent ? ' is-current' : ''}`}>
                      <td className="faint">{LADDER.indexOf(p) + 1}</td>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!doneAt}
                          aria-label={`Mark ${p.title} ${doneAt ? 'not done' : 'done'}`}
                          onChange={() => void toggle(p.slug)}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="grind-title"
                          title="Opens the free mirror"
                          onClick={() => void window.api.app.openExternal(openUrl(p))}
                        >
                          {p.title}
                        </button>
                        {isCurrent ? <span className="grind-here">← you are here</span> : null}
                      </td>
                      <td style={{ color: DIFF_COLOR[p.difficulty] }}>{p.difficulty}</td>
                      <td className="faint grind-companies">
                        {(p.companies ?? []).slice(0, 3).join(' · ')}
                        {(p.companies?.length ?? 0) > 3 ? ` +${(p.companies?.length ?? 0) - 3}` : ''}
                      </td>
                      <td className="faint">{doneAt ?? ''}</td>
                      <td>
                        {!p.premium ? (
                          <button
                            type="button"
                            className="grind-link"
                            title="On leetcode.com"
                            onClick={() => void window.api.app.openExternal(problemUrl(p.slug))}
                          >
                            LC
                          </button>
                        ) : (
                          <span className="faint" title="Paywalled on leetcode.com — the mirror is the free home for this one">
                            ★
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            )
          })}
        </table>
      </div>
    </>
  )
}
