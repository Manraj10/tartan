import type { ReactNode } from 'react'

/**
 * An empty view is one of three different events, and rendering all three as the same grey
 * paragraph loses that. A gap wants the action; a mistake wants a way back; a win wants to be
 * left alone.
 *
 * The old states named the action in prose — "add one from Today, or import a course calendar in
 * Settings" — and then made you go find it. Two navigations to do the thing the screen is asking
 * for. The button does it here.
 */
export default function EmptyState({
  kind = 'first-run',
  headline,
  detail,
  action,
  shortcut,
}: {
  /** first-run: nothing here yet. filtered: your query hid it. done: you finished. */
  kind?: 'first-run' | 'filtered' | 'done'
  headline: string
  detail?: ReactNode
  action?: { label: string; run: () => void }
  shortcut?: string
}) {
  return (
    <div className={`empty empty-${kind}`}>
      <p className="empty-headline">{headline}</p>
      {detail ? <p className="empty-detail">{detail}</p> : null}
      {/* A win must never carry a button — that turns finishing into a nag. */}
      {action && kind !== 'done' ? (
        <p style={{ marginTop: 'var(--sp-4)' }}>
          <button className={kind === 'filtered' ? 'btn' : 'btn primary'} onClick={action.run}>
            {action.label}
          </button>
          {shortcut ? (
            <span className="faint" style={{ marginLeft: 'var(--sp-2)' }}>
              <kbd>{shortcut}</kbd>
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
