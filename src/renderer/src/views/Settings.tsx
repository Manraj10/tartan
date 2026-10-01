import { useEffect, useState, type ReactNode } from 'react'
import {
  SCHEDULE_FILE,
  everyLabel,
  parseSchedule,
  ruleTarget,
  type Course,
  type ImportResult,
  type RecurringRule,
} from '@shared/types'
import { clock, toMinutes } from '@shared/day-plan'
import { useStore } from '../store'
import GoogleSync from '../components/GoogleSync'
import Feeds from '../components/Feeds'

interface Row {
  key: string
  course: Course
  isNew: boolean
}

/**
 * The slug is a folder name, and a note belongs to the space named by the first segment of its
 * path. "MATH/101" used to keep its slash, so notes landed in math/101/ and the space's own list —
 * which looks under "math" — never found them. Nothing a filesystem treats as a separator or
 * refuses in a name survives here, and a leading or trailing dot, dash or underscore does not either
 * (renameCourse wants a letter or digit first).
 *
 * Only what renameCourse accepts (letters, digits, dot, underscore, dash) is kept. "Café 101" must
 * not give "café-101", which "Move notes" would then offer and the rename refuse, so accents are
 * folded to their letter first; a code with no letter or digit left comes out empty.
 */
export const slugify = (code: string): string =>
  code
    .trim()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')

/** Electron prefixes a rejected invoke with "Error invoking remote method '...': Error: "; show what follows. */
const why = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')

/** "2026-09-14" as "Sep 14", the way the Schedule page says it. Anything hand-edited that is not a date stays as typed. */
const niceDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  // A hand-typed 2026-13-45 would otherwise roll over into a real-looking day.
  const real = /^\d{4}-\d{2}-\d{2}$/.test(iso) && date.getMonth() === m - 1 && date.getDate() === d
  return real ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : iso
}

/** "15:00" as "3:00 PM". A time that is not a real HH:MM (recurring.json is edited by hand) stays as typed. */
const time12 = (t: string): string =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? clock(toMinutes(t)).toUpperCase() : t

function uniqueId(code: string, taken: Set<string>): string {
  const base = slugify(code)
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  return id
}

export default function Settings() {
  const { courses, deadlines, saveCourses, refresh, announce } = useStore()

  const [dataDir, setDataDir] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [renameError, setRenameError] = useState('')
  /** What removing the space in confirmKey would leave pointing at nothing. */
  const [orphans, setOrphans] = useState<{ key: string; text: string } | null>(null)

  const [url, setUrl] = useState('')
  const [importCourse, setImportCourse] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  useEffect(() => {
    void window.api.app.dataDir().then(setDataDir)
  }, [])

  useEffect(() => {
    if (dirty) return
    setRows(courses.map((c) => ({ key: c.id, course: c, isNew: false })))
  }, [courses, dirty])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  const patch = (key: string, p: Partial<Course>) => {
    setDirty(true)
    setError('')
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, course: { ...r.course, ...p } } : r)))
  }

  /** The folder a saved space's notes would move to, or '' when its code already matches where they live. */
  const moveTarget = (r: Row): string => {
    const slug = slugify(r.course.code)
    return !r.isNew && slug && r.course.id !== slug ? slug : ''
  }

  const addCourse = () => {
    setDirty(true)
    setRows((prev) => [
      ...prev,
      {
        key: `new-${Date.now()}-${prev.length}`,
        course: { id: '', code: '', title: '', color: '#e8455f', units: 12, links: [] },
        isNew: true,
      },
    ])
  }

  const removeRow = (key: string) => {
    setDirty(true)
    // The error was about a row that may be the one going, or about a state that no longer exists.
    setError('')
    setConfirmKey(null)
    setRows((prev) => prev.filter((r) => r.key !== key))
  }

  /**
   * Classes and deadlines point at a space by id. Removing the space does not remove them, so
   * they go on showing under a raw id — say so before the second click rather than after it.
   */
  const pressRemove = (r: Row) => {
    if (confirmKey === r.key) return removeRow(r.key)
    setConfirmKey(r.key)
    setOrphans(null)
    if (r.isNew) return
    const id = r.course.id
    const due = deadlines.filter((d) => d.courseId === id).length
    void window.api.notes
      .read(SCHEDULE_FILE)
      .catch(() => '')
      .then((text) => {
        const classes = parseSchedule(text).filter((m) => m.courseId === id).length
        const parts = [
          due ? `${due} deadline${due === 1 ? '' : 's'}` : '',
          classes ? `${classes} class meeting${classes === 1 ? '' : 's'}` : '',
        ].filter(Boolean)
        if (parts.length) {
          setOrphans({ key: r.key, text: `${parts.join(' and ')} still point here and will be left without a space.` })
        }
      })
  }

  const save = async () => {
    const trimmed = rows.map((r) => ({
      ...r,
      course: { ...r.course, code: r.course.code.trim(), title: r.course.title.trim() },
    }))
    // The checks apply to rows that are new or whose code changed. A space saved before these rules
    // existed (a code with no ASCII letters, or two codes that now slug alike) must not block every
    // later save of an unrelated edit.
    const savedCode = new Map(courses.map((c) => [c.id, c.code.trim()]))
    const changed = (r: (typeof trimmed)[number]): boolean => r.isNew || savedCode.get(r.course.id) !== r.course.code
    if (trimmed.some((r) => changed(r) && !slugify(r.course.code))) {
      setError('Every course needs a code with at least one letter or digit.')
      return
    }
    // Two rows with one code both sit in every dropdown under the same label, and a pasted SIO
    // schedule files into whichever comes last. Better to refuse than to guess.
    const slugs = trimmed.map((r) => slugify(r.course.code))
    const twin = trimmed.find((r, i) => changed(r) && slugs[i] !== '' && slugs.some((s, j) => j !== i && s === slugs[i]))
    if (twin) {
      setError(`Two spaces use the code “${twin.course.code}”. Give each one its own.`)
      return
    }
    const taken = new Set(trimmed.filter((r) => !r.isNew).map((r) => r.course.id))
    const next = trimmed.map((r) => {
      if (!r.isNew) return r.course
      const id = uniqueId(r.course.code, taken)
      taken.add(id)
      return { ...r.course, id }
    })
    // The store has already said why a failed write failed. Leaving now would put the old list back
    // over the edits, so they stay on screen, unsaved, to try again.
    if (!(await saveCourses(next))) return
    setError('')
    setDirty(false)
    setSaved(true)
  }

  const runImport = async () => {
    setImporting(true)
    setResult(null)
    try {
      const r = await window.api.ics.import(url.trim(), importCourse || null)
      setResult(r)
      if (!r.error) await refresh()
    } catch (err) {
      setResult({ added: 0, updated: 0, skipped: 0, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>Settings</h1>
        <div className="spacer" />
      </div>

      <div className="content">
        <div className="stack" style={{ gap: 'var(--sp-4)', maxWidth: 820 }}>
          <section className="card stack">
            <h2 className="section-title">Your data</h2>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', wordBreak: 'break-all' }}>{dataDir || '…'}</div>
            <div className="row">
              <button className="btn" onClick={() => void window.api.app.openDataDir()}>
                Open folder
              </button>
              <button
                className="btn"
                onClick={() =>
                  void window.api.app
                    .chooseDataDir()
                    .then(setDataDir)
                    // Everything on screen was read from the old folder, unsaved space edits included:
                    // dropping them lets the rows re-seed from the new folder's spaces.
                    .then(() => refresh())
                    .then(() => setDirty(false))
                    .catch((e) => announce(`Could not change the data folder — ${why(e)}`, { kind: 'error' }))
                }
              >
                Change folder…
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Everything lives in that folder as plain JSON and markdown — edit it by hand or point Claude Code at it.
              Tartan re-reads the files every time the window regains focus.
            </p>
            <p className="faint" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
              Point this at your Google Drive folder (Drive for desktop mounts it as a normal drive) and the
              same notes open on your phone in the Drive app. Moving the folder does not copy your existing
              files — move them yourself first, then point Tartan at the new location.
            </p>
          </section>

          <Feeds />

          <GoogleSync />

          <RecurringRules />

          <section className="card stack">
            {/* A space is any bucket of work with its own notes, files, links and colour — a
                course is just the most common kind. A side project, research, personal: same machinery. */}
            <h2 className="section-title">Spaces</h2>

            {rows.length ? (
              <div className="stack">
                {rows.map((r) => (
                  <div key={r.key} className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field id={`code-${r.key}`} label="Code" flex="0 0 110px">
                      <input
                        id={`code-${r.key}`}
                        className="input"
                        value={r.course.code}
                        onChange={(e) => patch(r.key, { code: e.target.value })}
                      />
                    </Field>
                    <Field id={`title-${r.key}`} label="Title" flex="1 1 200px">
                      <input
                        id={`title-${r.key}`}
                        className="input"
                        value={r.course.title}
                        onChange={(e) => patch(r.key, { title: e.target.value })}
                      />
                    </Field>
                    <Field id={`units-${r.key}`} label="Units" flex="0 0 74px">
                      <input
                        id={`units-${r.key}`}
                        className="input"
                        type="number"
                        min={0}
                        value={r.course.units}
                        onChange={(e) => patch(r.key, { units: Number(e.target.value) || 0 })}
                      />
                    </Field>
                    <Field id={`color-${r.key}`} label="Color" flex="0 0 52px">
                      <input
                        id={`color-${r.key}`}
                        className="input"
                        type="color"
                        style={{ padding: 2, height: 31 }}
                        value={r.course.color}
                        onChange={(e) => patch(r.key, { color: e.target.value })}
                      />
                    </Field>
                    {!dirty && moveTarget(r) ? (
                      <button
                        className="btn sm"
                        title={`Notes currently live in "${r.course.id}". Move them to "${slugify(r.course.code)}" and re-point this course's deadlines.`}
                        onClick={() => {
                          setRenameError('')
                          void window.api.courses
                            .rename(r.course.id, slugify(r.course.code))
                            .then(() => refresh())
                            .catch((e: Error) => setRenameError(e.message))
                        }}
                      >
                        Move notes → {slugify(r.course.code)}
                      </button>
                    ) : (
                      // A move made from unsaved rows is undone by the next Save, so it waits for one.
                      <span className="chip" title={moveTarget(r) ? 'Save spaces first' : 'Notes folder'}>
                        {r.isNew ? slugify(r.course.code) || 'new' : r.course.id}
                      </span>
                    )}
                    <button
                      className="btn ghost sm"
                      onClick={() => pressRemove(r)}
                      onBlur={() => setConfirmKey((k) => (k === r.key ? null : k))}
                    >
                      {confirmKey === r.key ? 'Sure?' : 'Remove'}
                    </button>
                    {confirmKey === r.key && orphans?.key === r.key ? (
                      <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
                        {orphans.text}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">
                No spaces yet. Add one to get a sidebar entry, a color, and a notes folder — a course, a
                project, or just “Personal”.
              </div>
            )}

            <div className="row">
              <button className="btn" onClick={addCourse}>
                Add space
              </button>
              <button className="btn primary" onClick={() => void save()}>
                Save spaces
              </button>
              {error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : null}
              {renameError ? <span style={{ color: 'var(--danger)' }}>{renameError}</span> : null}
              {dirty ? (
                <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
                  Unsaved changes
                </span>
              ) : null}
              {saved && !dirty && !error ? <span style={{ color: 'var(--ok)' }}>Saved</span> : null}
            </div>

            <p className="faint" style={{ margin: 0 }}>
              A course id is the slug of its code and becomes its notes folder name, so it is fixed at the first save —
              editing the code later renames the label but leaves the folder alone.
            </p>
          </section>

          <TermDates />

          <section className="card stack">
            <h2 className="section-title">Import a calendar feed</h2>

            <Field id="ics-url" label="Feed URL" flex="1 1 auto">
              <input
                id="ics-url"
                className="input"
                type="url"
                placeholder="https://canvas.example.edu/feeds/calendars/user_….ics"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>

            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field id="ics-course" label="Course" flex="0 0 220px">
                <select
                  id="ics-course"
                  className="select"
                  value={importCourse}
                  onChange={(e) => setImportCourse(e.target.value)}
                >
                  <option value="">No course</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </Field>
              <button className="btn" disabled={importing || !url.trim()} onClick={() => void runImport()}>
                {importing ? 'Importing…' : 'Import'}
              </button>
              {result?.error ? (
                <span style={{ color: 'var(--danger)' }}>{result.error}</span>
              ) : result ? (
                <span className="muted">
                  Added {result.added}, updated {result.updated}
                </span>
              ) : null}
            </div>

            <p className="faint" style={{ margin: 0 }}>
              In Canvas, open Calendar and click “Calendar Feed” at the bottom right to get this URL. Re-running an
              import updates the items it already created instead of duplicating them. The URL contains a personal
              token — treat it like a password and do not share it.
            </p>
          </section>
        </div>
      </div>
    </>
  )
}

/**
 * The two dates the Calendar and Today draw classes between. They are the same stored values Google
 * sync bounds its class events with — they just used to sit under that card, where nothing said
 * that a term that has ended (or not started) empties the Calendar of classes without a word.
 */
function TermDates() {
  const [term, setTerm] = useState({ start: '', end: '' })
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.api.sync.status().then((s) => setTerm({ start: s.termStart, end: s.termEnd }))
  }, [])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  const edit = (p: Partial<typeof term>) => {
    setTerm((t) => ({ ...t, ...p }))
    setDirty(true)
    setError('')
  }

  const save = async () => {
    // An empty date is stored as "unset", which quietly puts the placeholder term back.
    if (!term.start || !term.end) return setError('Set both dates.')
    if (term.end < term.start) return setError('The term cannot end before it starts.')
    try {
      // A retry that works has to clear the failure it is retrying, or "Saved" never shows.
      setError('')
      const s = await window.api.sync.config({ termStart: term.start, termEnd: term.end })
      setTerm({ start: s.termStart, end: s.termEnd })
      setDirty(false)
      setSaved(true)
    } catch (e) {
      // The card stays dirty, so Save can be pressed again once the cause is fixed.
      setError(`Could not save the term dates — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <section className="card stack">
      <h2 className="section-title">Term dates</h2>
      <p className="muted" style={{ margin: 0 }}>
        Classes show on the Calendar and Today only between these dates, so set them each semester.
        The Schedule page always shows every class.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field id="term-start" label="Term starts" flex="0 0 170px">
          <input
            id="term-start"
            className="input"
            type="date"
            value={term.start}
            onChange={(e) => edit({ start: e.target.value })}
          />
        </Field>
        <Field id="term-end" label="Term ends" flex="0 0 170px">
          <input
            id="term-end"
            className="input"
            type="date"
            value={term.end}
            onChange={(e) => edit({ end: e.target.value })}
          />
        </Field>
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
        {error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : null}
        {saved && !error ? <span style={{ color: 'var(--ok)' }}>Saved</span> : null}
      </div>
    </section>
  )
}

/**
 * The rules behind "gym every mon wed". Read-only plus delete: rules are created by typing, and
 * edited — like everything else — by hand in recurring.json. Deleting one also removes its future
 * unticked occurrences, which is what "delete the rule" means to the person clicking it.
 */
function RecurringRules() {
  const { courses, courseById, refresh, deadlines, todos, announce } = useStore()
  const [rules, setRules] = useState<RecurringRule[]>([])

  /**
   * TickTick's habit streak, computed from rows already on disk: consecutive ticked occurrences
   * walking back from today. A day with NO row at all — a break the materializer skipped, a
   * hand-deleted occurrence, or history from before the rule existed — pauses the walk instead
   * of breaking it, and an unticked TODAY is still an open chance, not a failure.
   */
  const streakOf = (r: RecurringRule): number => {
    const pad = (n: number): string => String(n).padStart(2, '0')
    let streak = 0
    for (let i = 0; i < 180; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      if (r.from && day < r.from) break
      if (r.until && day > r.until) continue
      if (!r.days.includes((d.getDay() + 6) % 7)) continue
      const uid = `rec-${r.id}-${day}`
      const row = deadlines.find((x) => x.uid === uid) ?? todos.find((t) => t.id === uid)
      if (!row) continue
      if (row.done) streak++
      else if (i > 0) break
    }
    return streak
  }

  useEffect(() => {
    const load = (): void => void window.api.recurring.list().then(setRules).catch(() => setRules([]))
    load()
    // Rules can land while this is on screen — the capture hotkey, or a phone add applied by the
    // poll. Focus is when every other stale list in the app catches up, so this one does too.
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  /** Undo adds the rule again, which also re-creates the unticked occurrences that removing it pruned. */
  const remove = (r: RecurringRule): void => {
    void window.api.recurring
      .remove(r.id)
      .then((next) => {
        setRules(next)
        announce(`Removed “${r.text}”`, {
          undo: () =>
            void window.api.recurring
              .add(r)
              .then((list) => {
                setRules(list)
                return refresh()
              })
              .catch((e) => announce(`Could not bring back “${r.text}” — ${why(e)}`, { kind: 'error' })),
        })
        return refresh()
      })
      .catch((e) => announce(`Could not remove “${r.text}” — ${why(e)}`, { kind: 'error' }))
  }

  return (
    <section className="card stack">
      <h2 className="section-title">Recurring</h2>
      {rules.length ? (
        <div className="stack" style={{ gap: 0 }}>
          {rules.map((r) => {
            const course = courseById(r.courseId)
            return (
              <div key={r.id} className="row" style={{ padding: '6px 0', alignItems: 'baseline' }}>
                <span style={{ flex: 1, minWidth: 0 }}>{r.text}</span>
                {course ? <span className="chip">{course.code}</span> : null}
                <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                  {everyLabel(r.days)}
                  {r.time ? ` at ${time12(r.time)}` : ''}
                  {r.from ? ` from ${niceDay(r.from)}` : ''}
                  {r.until ? ` until ${niceDay(r.until)}` : ''} · {ruleTarget(r) === 'deadline' ? 'deadline' : 'todo'}
                  {streakOf(r) > 0 ? ` · 🔥 ${streakOf(r)}` : ''}
                </span>
                <button className="btn ghost sm" aria-label={`Remove rule ${r.text}`} onClick={() => remove(r)}>
                  ×
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="faint" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
          Nothing repeats yet. Type <em>gym every mon wed</em> or <em>{courses[0]?.code ?? 'CS 101'} quiz every friday 3pm</em> into the
          quick-add on Today — or into the phone page. Rules live in <code>recurring.json</code>.
        </p>
      )}
    </section>
  )
}

function Field({ id, label, flex, children }: { id: string; label: string; flex: string; children: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 3, flex, minWidth: 0 }}>
      <label className="faint" htmlFor={id} style={{ fontSize: 'var(--fs-micro)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}
