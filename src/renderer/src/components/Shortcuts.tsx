import { useEffect, useRef } from 'react'

/** The one place to edit the cheat sheet. */
const GROUPS: { group: string; rows: { keys: string[]; what: string }[] }[] = [
  {
    group: 'Global',
    rows: [
      { keys: ['Ctrl', 'K'], what: 'Command palette' },
      { keys: ['?'], what: 'This sheet' },
      // Ctrl+N and Ctrl+F used to be listed here and were handled nowhere. These two are real,
      // and quick capture had never been used once because nothing told anyone it existed.
      { keys: ['Ctrl', 'Shift', 'Space'], what: 'Quick capture, from any app' },
      { keys: ['Ctrl', 'Shift', 'Q'], what: 'Quote your clipboard into the open note' },
      { keys: ['Ctrl', '\\'], what: 'Hide the sidebar' },
      { keys: ['Alt', '←'], what: 'Back, and Alt → forward' }
    ]
  },
  {
    group: 'Today',
    rows: [
      { keys: ['O'], what: 'Show or hide overdue' },
      { keys: ['T'], what: 'Move a focused row to today' },
      { keys: ['D'], what: 'Move it to tomorrow' },
      { keys: ['X'], what: 'Mark it done' },
      { keys: ['J', 'K'], what: 'Move between rows' }
    ]
  },
  {
    group: 'Calendar',
    rows: [
      { keys: ['T'], what: 'Back to this month' },
      { keys: ['←', '→'], what: 'Previous / next month' }
    ]
  },
  {
    group: 'Notes',
    rows: [
      { keys: ['Ctrl', 'S'], what: 'Force save' },
      { keys: ['/'], what: 'Slash commands' },
      { keys: ['[', '['], what: 'Link a note' },
      { keys: ['Ctrl', 'E'], what: 'Cycle edit, split, preview' }
    ]
  },
  {
    group: 'Lists',
    rows: [
      { keys: ['↑', '↓'], what: 'Move' },
      { keys: ['Enter'], what: 'Open' },
      { keys: ['Esc'], what: 'Close' }
    ]
  }
]

export default function Shortcuts({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '10vh'
      }}
    >
      <div
        className="card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-heading"
        style={{
          width: 640,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: '80vh',
          overflowY: 'auto',
          padding: 20
        }}
      >
        <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
          <h2 id="shortcuts-heading" style={{ margin: 0, fontSize: 'var(--fs-md)' }}>
            Keyboard shortcuts
          </h2>
          <div className="spacer" style={{ flex: 1 }} />
          <button ref={closeRef} type="button" className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="grid-2" style={{ alignItems: 'start' }}>
          {GROUPS.map((g) => (
            <div key={g.group} className="stack">
              <div className="section-title">{g.group}</div>
              {g.rows.map((r) => (
                <div
                  key={r.what}
                  className="row"
                  style={{ alignItems: 'baseline', gap: 10, padding: '3px 0' }}
                >
                  <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {r.keys.map((k, i) => (
                      <kbd key={`${k}-${i}`}>{k}</kbd>
                    ))}
                  </span>
                  <span className="muted">{r.what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <p className="faint" style={{ marginBottom: 0, marginTop: 16 }}>
          Shortcuts do not fire while you are typing in a field.
        </p>
      </div>
    </div>
  )
}
