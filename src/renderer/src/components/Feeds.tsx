import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { FeedStatus, Subscription } from '@shared/types'
import { useStore } from '../store'

/**
 * Subscribed calendars.
 *
 * The mode switch is the whole design. An academic calendar is a few hundred institutional dates
 * you never act on; a Canvas feed is a list of work you owe someone. Treating both as deadlines
 * buries the four things that matter under two hundred that do not, so a feed declares which it is.
 */

// Center, not flex-end: the row has no stacked labels, so baseline-bottom just sank the
// checkboxes six pixels below the inputs beside them.
const rowStyle: CSSProperties = { alignItems: 'center', flexWrap: 'wrap' }

/** What the main process sends: FeedStatus, plus a note when a feed was too big to show whole. */
type Status = FeedStatus & { note?: string }

const newId = (): string => `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

/** subscriptions.json is hand-edited, so an entry can arrive with no url at all. */
const noUrl = (s: Subscription): boolean => !(s.url ?? '').trim()

function ago(iso: string | null): string {
  if (!iso) return 'never fetched'
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(secs)) return 'never fetched'
  if (secs < 90) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

/** What a fetched feed is contributing, in the words of its mode. Zero is said, not hidden. */
function countOf(s: Subscription, n: number): string {
  if (s.mode === 'deadlines') return `${n} ${n === 1 ? 'item' : 'items'} imported`
  return `${n} ${n === 1 ? 'event' : 'events'} in view`
}

export default function Feeds() {
  const { courses, refresh } = useStore()
  const [subs, setSubs] = useState<Subscription[]>([])
  const [status, setStatus] = useState<Status[]>([])
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  // What load() checks when its reads come back: `dirty` itself would be the value from when it started.
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const load = useCallback(async (first = false) => {
    const [list, st] = await Promise.all([window.api.feeds.list(), window.api.feeds.status()])
    setStatus(st)
    // status took ~90 ms on real data; an edit made in that gap is newer than the list just read.
    // The first load is exempt: there is nothing on screen yet, so a click before it lands edits an
    // empty list, and dropping the read would leave Save to overwrite the file with that.
    if (!first && dirtyRef.current) return
    setSubs(list)
    setDirty(false)
  }, [])

  useEffect(() => {
    void load(true)
  }, [load])

  // The list lives in subscriptions.json, which is meant to be hand-edited, and a card that only
  // ever read it once would save its stale copy over the edit. Coming back to the window re-reads it
  // — but never over changes you have not saved yet.
  useEffect(() => {
    if (dirty) return
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [dirty, load])

  const statusOf = (id: string): Status | undefined => status.find((s) => s.id === id)

  const patch = (id: string, p: Partial<Subscription>): void => {
    setDirty(true)
    setSubs((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s)))
  }

  const add = (): void => {
    setDirty(true)
    setSubs((prev) => [
      ...prev,
      {
        id: newId(),
        name: '',
        url: '',
        mode: 'events',
        courseId: null,
        color: '#5c9ea8',
        enabled: true,
      },
    ])
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      // Saving fetches, because the reason you edited the list was to see the result.
      setStatus(await window.api.feeds.save(subs))
      setDirty(false)
      await refresh()
    } catch (e) {
      // The list is written before the clean-up and the fetch, so a failure there still needs saying.
      setError(`Save did not finish: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const refreshAll = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.feeds.refresh()
      // Asked for afterwards: the answer to refresh() is taken before the new rows are merged, so a
      // Work feed would report the count from before this fetch.
      setStatus(await window.api.feeds.status())
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card stack">
      <h2 className="section-title">Calendar subscriptions</h2>

      {subs.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing subscribed. Add any <code>.ics</code> URL — your school&apos;s academic calendar, a Canvas
          course feed, a club calendar, a Google Calendar&apos;s secret address.
        </p>
      ) : null}

      {subs.map((s) => {
        const st = statusOf(s.id)
        return (
          <div key={s.id} className="stack" style={{ gap: 6, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
            <div className="row" style={rowStyle}>
              <label className="row" style={{ gap: 6, flex: '0 0 auto' }}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => patch(s.id, { enabled: e.target.checked })}
                  aria-label={`Show ${s.name || 'this feed'}`}
                />
              </label>
              <input
                className="input"
                style={{ flex: '1 1 150px', width: 'auto' }}
                placeholder="Name"
                aria-label="Feed name"
                value={s.name}
                onChange={(e) => patch(s.id, { name: e.target.value })}
              />
              <input
                className="input"
                type="color"
                style={{ flex: '0 0 46px', padding: 2, height: 31 }}
                aria-label="Feed colour"
                value={s.color}
                onChange={(e) => patch(s.id, { color: e.target.value })}
              />
              <select
                className="select"
                style={{ width: 'auto' }}
                aria-label="What this feed contains"
                value={s.mode}
                onChange={(e) => patch(s.id, { mode: e.target.value as Subscription['mode'] })}
              >
                <option value="events">Events — just show them</option>
                <option value="deadlines">Work — make them tickable</option>
              </select>
              {/* Only rows are filed under a course; an events feed's chips never are. */}
              {s.mode === 'deadlines' || s.promote ? (
                <select
                  className="select"
                  style={{ width: 'auto' }}
                  aria-label="Course"
                  value={s.courseId ?? ''}
                  onChange={(e) => patch(s.id, { courseId: e.target.value || null })}
                >
                  <option value="">No course</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                className="btn ghost sm"
                aria-label={`Remove ${s.name || 'this feed'}`}
                onClick={() => {
                  setDirty(true)
                  setSubs((prev) => prev.filter((x) => x.id !== s.id))
                }}
              >
                ×
              </button>
            </div>

            <input
              className="input"
              type="url"
              placeholder="https://…/feed.ics"
              aria-label="Feed URL"
              aria-invalid={noUrl(s)}
              value={s.url ?? ''}
              onChange={(e) => patch(s.id, { url: e.target.value })}
            />

            {/* A feed that is failing says so here and nowhere else — it is not worth a toast. */}
            {noUrl(s) ? (
              <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>
                Needs a URL before it can be saved.
              </div>
            ) : (
              <>
                {st?.error ? (
                  <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>{st.error}</div>
                ) : null}
                <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
                  {/* The cache outlives a failed fetch, so what is on screen is the old copy: say so. */}
                  {st?.error && st.at ? `Still showing the copy fetched ${ago(st.at)}` : ago(st?.at ?? null)}
                  {st?.at ? ` · ${countOf(s, st.events)}` : ''}
                </div>
                {st?.note ? (
                  <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
                    {st.note}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )
      })}

      {error ? <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>{error}</div> : null}

      <div className="row">
        <button className="btn" onClick={add}>
          Add a calendar
        </button>
        <button
          className="btn primary"
          disabled={busy || !dirty || subs.some(noUrl)}
          onClick={() => void save()}
        >
          {busy ? 'Fetching…' : 'Save and fetch'}
        </button>
        <button className="btn" disabled={busy || dirty || subs.length === 0} onClick={() => void refreshAll()}>
          Refresh all
        </button>
      </div>

      <p className="faint" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
        Feeds are cached on disk, so they still show with no connection, and refresh themselves when
        they are more than six hours old. <strong>Events</strong> appear on the Calendar and Today
        but are never tickable and never counted as work. <strong>Work</strong> feeds merge into your
        deadlines keyed on the calendar&apos;s own id, so re-fetching updates an item instead of
        duplicating it — and ticking something off is never undone by a refresh. Removing or switching
        off a Work feed takes the items you have not ticked with it.
      </p>
      <p className="faint" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
        For Canvas: open Calendar, click <strong>Calendar Feed</strong> at the bottom right, and copy
        that URL. It contains a personal token — treat it like a password.
      </p>
    </section>
  )
}
