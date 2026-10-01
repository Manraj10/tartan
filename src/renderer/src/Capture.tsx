import { useEffect, useRef, useState } from 'react'
import { parseEntry, type Course } from '@shared/types'
import { MOD } from './keys'

/**
 * The quick-capture window: one line, one key. Enter still lands everything in notes/inbox.md with
 * a timestamp — sorting it out later is cheaper than deciding where it goes right now, and that
 * zero-decision default is the whole reason the window exists.
 *
 * Ctrl+Enter files it properly instead. Deliberately a *second* key, not a smarter Enter: any
 * hesitation added to this interaction defeats it, so the thoughtless path stays thoughtless.
 */
export default function Capture() {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [courses, setCourses] = useState<Course[]>([])
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    // The window is hidden and re-shown, never reloaded, so a space added or renamed since the
    // last open is only picked up by re-reading on focus. A failed read keeps the last list.
    const load = (): void => void window.api.courses.get().then(setCourses).catch(() => {})
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  const dismiss = (message: string): void => {
    setText('')
    setSaved(message)
    window.setTimeout(() => {
      setSaved('')
      void window.api.capture.close()
    }, 550)
  }

  /** A failed save keeps the text and the window, so the line is not lost with the error. */
  const guarded = async (save: () => Promise<void>): Promise<void> => {
    setError('')
    try {
      await save()
    } catch (err) {
      setError(`Could not save: ${(err as Error).message}`)
    }
  }

  const submit = async () => {
    if (!text.trim()) return
    await window.api.capture.save(text)
    dismiss('Saved to inbox')
  }

  /** Same parser as the Today and Todos fields, so one line means one thing everywhere. */
  const file = async () => {
    const parsed = parseEntry(text, courses)
    if (!parsed.title.trim()) return
    if (parsed.every) {
      await window.api.recurring.add({
        id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text: parsed.title,
        courseId: parsed.courseId,
        kind: parsed.kind,
        days: parsed.every.days,
        ...(parsed.every.time ? { time: parsed.every.time } : {}),
      })
      dismiss('Added as a recurring item')
    } else if (parsed.due) {
      const list = await window.api.deadlines.get()
      await window.api.deadlines.set([
        ...list,
        {
          id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: parsed.title,
          courseId: parsed.courseId,
          due: parsed.due,
          kind: parsed.kind,
          done: false,
          source: 'manual',
        },
      ])
      dismiss('Added as a deadline')
    } else {
      const list = await window.api.todos.get()
      await window.api.todos.set([
        {
          id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: parsed.title,
          courseId: parsed.courseId,
          done: false,
          created: new Date().toISOString(),
        },
        ...list,
      ])
      dismiss('Added as a todo')
    }
  }

  const preview = text.trim() ? parseEntry(text, courses) : null

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 6,
        padding: '0 16px',
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-strong)',
        borderRadius: 10,
        // The frameless window has no title bar, so give it a drag handle.
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <label htmlFor="capture" style={{ position: 'absolute', left: -9999 }}>
        Capture a thought
      </label>
      <input
        id="capture"
        ref={input}
        className="input"
        value={text}
        placeholder={saved || 'Capture a thought…'}
        onChange={(e) => {
          setText(e.target.value)
          setError('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void guarded(file)
          else if (e.key === 'Enter') void guarded(submit)
          if (e.key === 'Escape') void window.api.capture.close()
        }}
        style={{ fontSize: 'var(--fs-md)', padding: '10px 12px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      />
      <div className="faint" style={{ fontSize: 'var(--fs-micro)' }}>
        {saved
          ? saved
          : error
            ? error
            : preview
              ? preview.title.trim()
                ? `Enter → inbox · ${MOD} Enter → ${preview.every ? 'recurring' : preview.due ? 'deadline' : 'todo'}${preview.courseId ? ` (${preview.courseId})` : ''} · Esc`
                : // Ctrl Enter files nothing without a title; Enter still sends the raw line to the inbox.
                  'Needs a title · Enter → inbox · Esc'
              : `Enter saves to your inbox note · ${MOD}+Enter files a deadline or todo · Esc closes`}
      </div>
    </div>
  )
}
