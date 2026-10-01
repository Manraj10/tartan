import { useCallback, useEffect, useState } from 'react'
import { LADDER, openUrl, problemUrl, streakOf, type LeetcodeState } from '@shared/leetcode'

/**
 * One problem a day, from a fixed ladder that ramps Easy → Hard topic by topic. The card never
 * asks anything: the next rung is always already chosen, the link is one click, and Done is the
 * only verb. Progress lives in leetcode.json in the data folder like everything else.
 */

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const DIFF_COLOR: Record<string, string> = {
  Easy: 'var(--ok)',
  Medium: 'var(--warn)',
  Hard: 'var(--danger)',
}


export default function LeetCode() {
  const [state, setState] = useState<LeetcodeState | null>(null)

  useEffect(() => {
    const load = (): void => {
      void window.api.leetcode.get().then(setState).catch(() => setState({ done: {} }))
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  const mark = useCallback(
    async (slug: string, done: boolean) => {
      if (!state) return
      const next = { done: { ...state.done } }
      if (done) next.done[slug] = ymd(new Date())
      else delete next.done[slug]
      setState(next)
      try {
        await window.api.leetcode.set(next)
      } catch {
        setState(state) // the write failed; show the truth
      }
    },
    [state],
  )

  if (!state) return null
  const solved = Object.keys(state.done).filter((s) => LADDER.some((p) => p.slug === s)).length
  const current = LADDER.find((p) => !state.done[p.slug])
  const today = ymd(new Date())
  const solvedToday = Object.entries(state.done).filter(([, day]) => day === today)
  const streak = streakOf(state.done)

  if (!current) {
    return (
      <div className="card lc" style={{ marginBottom: 'var(--sp-4)' }}>
        <span className="lc-label">LeetCode</span>
        <span>Ladder finished — all {LADDER.length} problems. 🏔️</span>
      </div>
    )
  }

  return (
    <div className="card lc" style={{ marginBottom: 'var(--sp-4)' }}>
      <div className="lc-head">
        <span className="lc-label">LeetCode</span>
        <span className="faint">
          {solved}/{LADDER.length} · {current.topic}
        </span>
        {streak > 0 ? (
          <span className="lc-streak" title={`${streak} day${streak === 1 ? '' : 's'} in a row`}>
            🔥 {streak}
          </span>
        ) : null}
      </div>
      <div className="lc-body">
        <span className="lc-diff" style={{ color: DIFF_COLOR[current.difficulty] }}>
          {current.difficulty}
        </span>
        <button
          type="button"
          className="lc-title"
          title="Opens the free mirror — full problem, video solution, no paywall and no login"
          onClick={() => void window.api.app.openExternal(openUrl(current))}
        >
          {current.title} ↗
        </button>
        {current.companies?.length ? (
          <span
            className="chip lc-companies"
            title={`Asked at: ${current.companies.join(', ')} — corroborated across the free company-wise datasets on GitHub`}
          >
            {current.companies.slice(0, 3).join(' · ')}
            {current.companies.length > 3 ? ` +${current.companies.length - 3}` : ''}
          </span>
        ) : current.asks >= 4 ? (
          <span className="chip" title="How many of Google / Amazon / Meta / Microsoft / Apple / Netflix / Uber ask this, per the free company-wise dataset">
            big-tech {current.asks}/7
          </span>
        ) : null}
        {!current.premium ? (
          <button
            type="button"
            className="btn ghost sm"
            title="The same problem on leetcode.com, if you would rather submit there"
            onClick={() => void window.api.app.openExternal(problemUrl(current.slug))}
          >
            LeetCode ↗
          </button>
        ) : null}
        <span className="spacer" />
        {solvedToday.length > 0 ? (
          <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
            {solvedToday.length === 1 ? 'one down today — extra credit from here' : `${solvedToday.length} today`}
          </span>
        ) : null}
        <button className="btn sm primary" onClick={() => void mark(current.slug, true)}>
          Done
        </button>
      </div>
      {solvedToday.length > 0 ? (
        <div className="lc-done">
          {solvedToday.map(([slug]) => {
            const p = LADDER.find((x) => x.slug === slug)
            if (!p) return null
            return (
              <span key={slug} className="lc-done-row">
                ✓ {p.title}
                <button
                  type="button"
                  className="lc-undo"
                  title="Not actually done — put it back"
                  aria-label={`Un-mark ${p.title}`}
                  onClick={() => void mark(slug, false)}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
