import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

/** Lower is better: 0 = prefix, 1 = substring, 2 = subsequence, null = no match. */
function rank(label: string, query: string): number | null {
  const l = label.toLowerCase()
  if (l.startsWith(query)) return 0
  if (l.includes(query)) return 1
  let k = 0
  for (const ch of l) {
    if (ch === query[k] && ++k === query.length) return 2
  }
  return null
}

const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap'
}

const OPT_ID = (i: number): string => `cmdp-opt-${i}`

export default function CommandPalette({
  open,
  onClose,
  commands
}: {
  open: boolean
  onClose: () => void
  commands: Command[]
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? commands
          .map((cmd) => ({ cmd, r: rank(cmd.label, q) }))
          .filter((m): m is { cmd: Command; r: number } => m.r !== null)
          .sort((a, b) => a.r - b.r)
          .map((m) => m.cmd)
      : commands

    const out: { group: string; items: { cmd: Command; index: number }[] }[] = []
    for (const cmd of matched) {
      let g = out.find((x) => x.group === cmd.group)
      if (!g) {
        g = { group: cmd.group, items: [] }
        out.push(g)
      }
      // Eight per group. Past that a group stops being scannable and starts burying the others.
      if (g.items.length < 8) g.items.push({ cmd, index: 0 })
    }

    // Groups keep the order they were declared in, not the order their best match happened to
    // rank. Otherwise a note titled "Today" outranks the Today view and takes the first row.
    const declared = new Map<string, number>()
    commands.forEach((c, i) => {
      if (!declared.has(c.group)) declared.set(c.group, i)
    })
    out.sort((a, b) => (declared.get(a.group) ?? 0) - (declared.get(b.group) ?? 0))

    let n = 0
    for (const g of out) for (const item of g.items) item.index = n++
    return out
  }, [commands, query])

  const flat = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.cmd)), [groups])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active, flat])

  if (!open) return null

  const run = (cmd: Command | undefined): void => {
    if (!cmd) return
    cmd.run()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(flat[active])
    }
  }

  return (
    <div
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        // Same dim and drop as the other overlays — three modals had three opinions.
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
        aria-label="Command palette"
        style={{ width: 560, maxWidth: 'calc(100vw - 32px)', padding: 0, overflow: 'hidden' }}
      >
        <label htmlFor="cmdp-query" style={SR_ONLY}>
          Search commands
        </label>
        <input
          id="cmdp-query"
          ref={inputRef}
          className="input"
          type="text"
          placeholder="Type a command…"
          value={query}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdp-list"
          aria-activedescendant={flat.length ? OPT_ID(active) : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          style={{
            width: '100%',
            border: 'none',
            borderRadius: 0,
            background: 'transparent',
            padding: '14px 16px',
            fontSize: 'var(--fs-md)',
            outline: 'none'
          }}
        />
        <div
          id="cmdp-list"
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          style={{
            maxHeight: '48vh',
            overflowY: 'auto',
            padding: 8,
            borderTop: '1px solid var(--border)'
          }}
        >
          {flat.length === 0 ? (
            <div className="empty">Nothing matched “{query.trim()}”</div>
          ) : (
            groups.map((g) => (
              <div key={g.group} role="group" aria-label={g.group}>
                <div className="section-title">{g.group}</div>
                {g.items.map(({ cmd, index }) => (
                  <button
                    key={cmd.id}
                    id={OPT_ID(index)}
                    type="button"
                    role="option"
                    className="cmdp-item"
                    aria-selected={index === active}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(cmd)}
                  >
                    <span>{cmd.label}</span>
                    {cmd.hint ? <span className="faint">{cmd.hint}</span> : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
