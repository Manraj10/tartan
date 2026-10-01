import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SyncStatus } from '@shared/types'

/**
 * The Google Calendar panel.
 *
 * The web page equivalent of this was abandoned because a page cannot schedule a notification.
 * Google can, so Tartan pushes the semester to an Apps Script web app that runs as the user and
 * writes events carrying explicit reminders. Everything on this screen is the two things that
 * script needs: where it lives, and the secret that proves the caller is Tartan.
 */

const gen = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(secs)) return 'never'
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function GoogleSync() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const adopt = useCallback((s: SyncStatus, keepEdits = false) => {
    setStatus(s)
    if (keepEdits) return
    setUrl(s.url)
    setSecret(s.secret)
    setDirty(false)
  }, [])

  useEffect(() => {
    const read = (): void => void window.api.sync.status().then((s) => adopt(s))
    read()
    // Syncs happen on a debounce and on window focus, i.e. while this panel is already open. Read
    // once and a failure that arrives thirty seconds later is never shown, so the panel goes on
    // reporting the last success.
    const t = setInterval(read, 30_000)
    return () => clearInterval(t)
  }, [adopt])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      adopt(await window.api.sync.config({ url: url.trim(), secret: secret.trim() }))
      setSaved(true)
    } finally {
      setBusy(false)
    }
  }

  const push = async (everything: boolean): Promise<void> => {
    setBusy(true)
    try {
      adopt(await (everything ? window.api.sync.all() : window.api.sync.now()), true)
    } finally {
      setBusy(false)
    }
  }

  const edit = (set: (v: string) => void) => (v: string) => {
    set(v)
    setDirty(true)
  }

  const configured = Boolean(status?.url)

  return (
    <section className="card stack">
      <h2 className="section-title">Google Calendar</h2>

      <Field id="gc-url" label="Apps Script web app URL">
        <input
          id="gc-url"
          className="input"
          type="url"
          placeholder="https://script.google.com/macros/s/…/exec"
          value={url}
          onChange={(e) => edit(setUrl)(e.target.value)}
        />
      </Field>

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field id="gc-secret" label="Shared secret" flex="1 1 260px">
          <input
            id="gc-secret"
            className="input"
            value={secret}
            onChange={(e) => edit(setSecret)(e.target.value)}
          />
        </Field>
        <button className="btn" onClick={() => edit(setSecret)(gen())}>
          Generate
        </button>
      </div>

      <div className="row">
        <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
          Save
        </button>
        <button className="btn" disabled={busy || !configured || dirty} onClick={() => void push(false)}>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        <button
          className="btn ghost"
          disabled={busy || !configured || dirty}
          title="Re-creates anything you deleted in Google Calendar by hand."
          onClick={() => void push(true)}
        >
          Re-send everything
        </button>
        {saved ? <span style={{ color: 'var(--ok)' }}>Saved</span> : null}
      </div>

      {status ? (
        <div className="stack" style={{ gap: 4 }}>
          <div className="muted">
            {configured ? `Last synced ${ago(status.at)}` : 'Not set up yet.'}
            {status.dirty && configured ? ' · unsent changes' : ''}
          </div>
          {status.last ? (
            <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
              {status.last}
            </div>
          ) : null}
          {status.error ? <div style={{ color: 'var(--danger)' }}>{status.error}</div> : null}
        </div>
      ) : null}

      <p className="faint" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
        Deadlines become events with popup reminders. Give one a time and it buzzes a day, an hour,
        30 minutes and 15 minutes ahead; leave it all-day and it buzzes at 9am the day before and
        again that evening, because an all-day event starts at midnight and the close-in nudges
        would land while you were asleep. Classes become recurring events between your term dates, with no
        reminders, so they show up without buzzing. The secret here has to match the <code>TARTAN_SECRET</code> script
        property, and the deployment URL must end in <code>/exec</code>.
      </p>
    </section>
  )
}

function Field({
  id,
  label,
  flex = '1 1 auto',
  children,
}: {
  id: string
  label: string
  flex?: string
  children: ReactNode
}) {
  return (
    <div className="stack" style={{ gap: 3, flex, minWidth: 0 }}>
      <label className="faint" htmlFor={id} style={{ fontSize: 'var(--fs-micro)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}
