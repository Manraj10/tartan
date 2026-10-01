import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import { marked } from 'marked'
import type { NoteMeta } from '@shared/types'
import { localDay } from '@shared/day-plan'
import { useStore } from '../store'
import EmptyState from '../components/EmptyState'

type Mode = 'edit' | 'split' | 'preview'
type NoteIdx = Awaited<ReturnType<typeof window.api.notes.index>>[number]
type NoteVer = Awaited<ReturnType<typeof window.api.notes.versions>>[number]

/** An open completion popup: which flavour, where its trigger starts, what has been typed since. */
type Popup = { kind: 'slash' | 'link'; start: number; query: string }

type Snippet = { label: string; body: string | (() => string); from: number; to?: number }

const MODES: [Mode, string][] = [
  ['edit', 'Edit'],
  ['split', 'Split'],
  ['preview', 'Preview'],
]

/** Manuscript convention, not a measurement — the count's title attribute says so out loud. */
const WORDS_PER_PAGE = 275

const SNIPPETS: Snippet[] = [
  { label: 'Heading 1', body: '# ', from: 2 },
  { label: 'Heading 2', body: '## ', from: 3 },
  { label: 'Heading 3', body: '### ', from: 4 },
  { label: 'Bullet list', body: '- ', from: 2 },
  { label: 'Numbered list', body: '1. ', from: 3 },
  { label: 'Checkbox', body: '- [ ] ', from: 6 },
  { label: 'Table', body: '| A | B | C |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n', from: 2, to: 3 },
  { label: 'Code block', body: '```\n\n```\n', from: 4 },
  { label: 'Quote', body: '> ', from: 2 },
  { label: 'Divider', body: '\n---\n\n', from: 6 },
  { label: 'Math block', body: '$$\n\n$$\n', from: 3 },
  { label: 'Callout', body: '> [!note]\n> ', from: 12 },
  // Local date, not toISOString: after 8pm EDT the UTC date is already tomorrow.
  { label: "Today's date", body: () => localDay(new Date()), from: 10 },
]

/** The note up to where a quote's page number goes. The blank line separates it from earlier text, so an empty note gets none. */
export const quoteHead = (text: string, quote: string): string => {
  const before = text.replace(/\s+$/, '')
  return `${before}${before ? '\n\n' : ''}> ${quote}  (p. `
}

/** Lower is better: 0 prefix, 1 substring, 2 subsequence, null no match. Mirrors the palette. */
function rankTitle(label: string, query: string): number | null {
  const l = label.toLowerCase()
  if (l.startsWith(query)) return 0
  if (l.includes(query)) return 1
  let k = 0
  for (const ch of l) if (ch === query[k] && ++k === query.length) return 2
  return null
}

export default function Notes({ courseId, openNote }: { courseId: string | null; openNote?: string }) {
  const { courseById } = useStore()
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [index, setIndex] = useState<NoteIdx[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>('split')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pop, setPop] = useState<Popup | null>(null)
  const [popIdx, setPopIdx] = useState(0)
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [versions, setVersions] = useState<NoteVer[]>([])
  const [viewing, setViewing] = useState<{ stamp: string; iso: string; content: string } | null>(null)
  const [backlinks, setBacklinks] = useState<(NoteIdx & { line: string; heading: string; offset: number })[]>([])
  const [texNote, setTexNote] = useState('')
  const [recent, setRecent] = useState<string[]>([])
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [renameErr, setRenameErr] = useState('')
  /** Why the last note would not open; shown where the editor would have been. */
  const [openErr, setOpenErr] = useState('')

  const pending = useRef<{ path: string; text: string; force?: boolean } | null>(null)
  const timer = useRef<number | null>(null)
  const ta = useRef<HTMLTextAreaElement | null>(null)
  /** Selection to apply once React has painted the spliced text. */
  const pendingSel = useRef<[number, number] | null>(null)
  /** Mirrors `selected` so async replies can tell whether they are still wanted. */
  const wanted = useRef<string | null>(null)
  /** Last quote appended, to swallow a repeated capture of the same passage. */
  const lastQuote = useRef('')
  /** Set by Escape so the blur that follows cancels instead of committing the rename. */
  const escaped = useRef(false)
  /** Survives the selection change so a freshly created note lands in its title field. */
  const renameOnOpen = useRef(false)

  const loadList = useCallback(async () => {
    const [list, idx] = await Promise.all([window.api.notes.list(), window.api.notes.index()])
    setNotes(list)
    setIndex(idx)
  }, [])

  /**
   * The edit stays in `pending` until the disk write actually succeeds. Clearing it first meant a
   * failed write lost the text outright — the label stuck on "Saving…" forever and there was
   * nothing left to retry with. In an app whose whole premise is that the folder is the database,
   * this is the one place a silent failure is unacceptable.
   */
  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const p = pending.current
    if (!p) return
    try {
      await window.api.notes.write(p.path, p.text, p.force)
      // Only drop it if nothing newer was typed while the write was in flight.
      if (pending.current === p) {
        pending.current = null
        setSaveState('saved')
        setSavedAt(new Date())
      }
    } catch (err) {
      setSaveState('error')
      setSaveError(plain(err))
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  /**
   * Edit the folder in another program (the README says you can) and come back: the list and the
   * open note should show it. The open note is only replaced when nothing of yours is waiting to be
   * saved — otherwise the next autosave would be the one overwriting, and this would be deciding
   * for you which side wins. A failed save keeps `pending`, so that case is left alone too.
   */
  useEffect(() => {
    const onFocus = () => {
      void loadList().catch(() => undefined)
      const path = wanted.current
      if (!path || pending.current) return
      void window.api.notes
        .read(path)
        .then((disk) => {
          // Typing may have started while the read was in flight. A missing file reads as empty;
          // keep what is on screen rather than blanking a note that was only moved or deleted.
          if (wanted.current === path && !pending.current) setText((cur) => disk || cur)
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadList])

  // Reset the armed "Sure?" on its own: a click minutes later, from somewhere else, must not delete.
  useEffect(() => {
    if (!confirmDelete) return
    const t = window.setTimeout(() => setConfirmDelete(false), 4000)
    return () => window.clearTimeout(t)
  }, [confirmDelete])

  useEffect(() => {
    setSelected(null)
    setOpenErr('')
  }, [courseId])

  // Arriving from the palette with a note already chosen. Runs after the courseId reset above,
  // so navigating to a specific note does not immediately clear itself.
  useEffect(() => {
    if (openNote) setSelected(openNote)
  }, [openNote])

  useEffect(() => {
    const onBlur = () => void flush()
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      void flush()
    }
  }, [flush])

  useEffect(() => {
    // Most-recent-first, so the [[ popup can lead with the notes you were just in.
    if (selected) setRecent((prev) => [selected, ...prev.filter((p) => p !== selected)].slice(0, 8))
    wanted.current = selected
    setConfirmDelete(false)
    setPop(null)
    setHistoryOpen(false)
    setVersions([])
    setViewing(null)
    // A brand-new note opens with its title selected; every other switch closes the rename field.
    setRenaming(renameOnOpen.current)
    if (renameOnOpen.current) setDraft('')
    renameOnOpen.current = false
    setRenameErr('')
    // A message about the last note ("Could not delete…", "Tidied") does not belong to this one.
    setTexNote('')
    if (!selected) {
      setText('')
      return
    }
    let stale = false
    setOpenErr('')
    // A file that cannot be read (a stub, a permissions error) closes the editor rather than
    // opening an empty one that can never save — and says so, instead of just going blank.
    void window.api.notes
      .read(selected)
      .then((content) => {
        if (!stale) setText(content)
      })
      .catch((err) => {
        if (stale) return
        setOpenErr(`Could not open ${selected}: ${plain(err)}`)
        setSelected(null)
      })
    return () => {
      stale = true
    }
  }, [selected])

  const title = useMemo(() => notes.find((n) => n.path === selected)?.title ?? '', [notes, selected])

  useEffect(() => {
    if (!title) {
      setBacklinks([])
      return
    }
    let stale = false
    void window.api.notes.backlinks(title).then((rows) => {
      if (!stale) setBacklinks(rows.filter((r) => r.path !== selected))
    })
    return () => {
      stale = true
    }
  }, [title, selected])

  useEffect(() => {
    const sel = pendingSel.current
    if (!sel) return
    pendingSel.current = null
    const el = ta.current
    if (!el) return
    el.focus()
    el.setSelectionRange(sel[0], sel[1])
  }, [text])

  const select = useCallback(
    async (path: string) => {
      await flush()
      // A Google Doc is listed here but lives in the browser. Opening it must never load it into
      // the editor — there is no markdown behind a .gdoc stub, only a document id.
      const doc = notes.find((n) => n.path === path)?.docUrl
      if (doc) {
        void window.api.app.openExternal(doc)
        return
      }
      setSelected(path)
    },
    [flush, notes],
  )

  const edit = (value: string, force = false) => {
    if (!selected) return
    setText(value)
    setSaveState('saving')
    pending.current = { path: selected, text: value, force }
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flush(), 600)
  }

  /**
   * A capture arrives as raw PDF text: Chromium's viewer breaks every visual line with a hard
   * newline and keeps the typesetter's end-of-line hyphens, so unwrap both before quoting.
   */
  useEffect(() => {
    return window.api.onQuote((raw) => {
      const quote = raw
        .replace(/-\r?\n/g, '')
        .replace(/\s*\r?\n\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      // A double-tap of the capture shortcut is common; the same quote twice is never wanted.
      if (!quote || quote === lastQuote.current || !wanted.current) return
      lastQuote.current = quote
      const head = quoteHead(text, quote)
      edit(`${head})\n\n`)
      pendingSel.current = [head.length, head.length]
    })
  }, [text, selected])

  /**
   * Flip the nth task box in the source. Fenced code is masked with equal-length space runs so a
   * "- [ ]" inside an example never shifts the offsets of the real ones.
   */
  const toggleTask = (n: number) => {
    const { body } = splitFrontmatter(text)
    const masked = body.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    const m = Array.from(masked.matchAll(/^[ \t]*[-*+] \[( |x|X)\]/gm))[n]
    if (!m) return
    const at = text.length - body.length + (m.index ?? 0) + m[0].length - 2
    edit(`${text.slice(0, at)}${text[at] === ' ' ? 'x' : ' '}${text.slice(at + 1)}`)
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items)

    // A URL pasted over a selection makes a link instead of destroying the words. Selecting
    // "the syllabus" and pasting a Canvas link used to just delete the phrase.
    const el = e.currentTarget
    if (el.selectionStart !== el.selectionEnd) {
      const url = e.clipboardData.getData('text/plain').trim()
      const selectedText = el.value.slice(el.selectionStart, el.selectionEnd)
      // Left alone when the selection is itself a URL — replacing one link with another is the
      // thing you actually meant there.
      if (/^https?:\/\/\S+$/.test(url) && !/^https?:\/\//.test(selectedText.trim())) {
        e.preventDefault()
        const s = el.selectionStart
        typeInto(el, s, el.selectionEnd, `[${selectedText}](${url})`)
        return
      }
    }

    // Copying from a web page puts both HTML and a PNG on the clipboard — the text is what was meant.
    if (items.some((it) => it.kind === 'string' && it.type === 'text/plain')) return
    const file = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'))?.getAsFile()
    if (!file || !selected) return
    e.preventDefault()
    const base = el.value
    const from = el.selectionStart
    const to = el.selectionEnd
    const stem = selected.split('/').pop()?.replace(/\.md$/, '') || 'note'
    const ext = file.type.split('/')[1]?.split(/[+;]/)[0] || 'png'
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { rel } = await window.api.files.writeBytes(courseId ?? 'inbox', `${stem}-${fileStamp()}.${ext}`, bytes)
      const md = `![](tartan://${rel.replace(/\\/g, '/')})`
      edit(base.slice(0, from) + md + base.slice(to))
      pendingSel.current = [from + md.length, from + md.length]
    } catch {
      setTexNote('Could not save that image — the note is untouched')
    }
  }

  /** A failed write has to say so: the toolbar shows texNote while a note is open, and the empty state shows openErr. */
  const fail = (msg: string): void => (selected ? setTexNote(msg) : setOpenErr(msg))

  /**
   * A new note opens straight into its own title field. The old behaviour named it
   * "<date>-untitled" and dropped you in the body, so naming it later was a separate trip you
   * never made — which is how notes end up called 2026-01-01-untitled.
   */
  const create = async () => {
    await flush()
    setOpenErr('')
    setTexNote('')
    // Local date, not toISOString().slice — after 8pm EDT that would stamp tomorrow's date.
    const d = new Date()
    const stem = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-untitled`
    const dir = courseId ? `${courseId}/` : ''
    const taken = new Set(notes.map((n) => n.path))
    let name = stem
    for (let i = 2; taken.has(`${dir}${name}.md`); i++) name = `${stem}-${i}`
    const path = `${dir}${name}.md`
    try {
      await window.api.notes.write(path, '')
    } catch (err) {
      return fail(`Could not create a note: ${plain(err)}`)
    }
    await loadList().catch(() => undefined)
    // The [selected] effect clears `renaming` on every switch, so the intent rides a ref through it.
    renameOnOpen.current = true
    setSelected(path)
  }

  /**
   * The ONLY way anything in this file is allowed to mutate the textarea programmatically.
   *
   * Building a new string and calling edit() wipes Chromium's native textarea undo stack, which
   * matters more here than usual because the app sells undo elsewhere. execCommand is the only
   * path that pushes onto it, so one Ctrl+Z undoes one bullet. It is formally deprecated but
   * Chromium still ships it and Electron pins its Chromium, so it cannot vanish underneath us.
   */
  const typeInto = (el: HTMLTextAreaElement, start: number, end: number, text: string): void => {
    el.focus()
    el.setSelectionRange(start, end)
    document.execCommand('insertText', false, text)
    edit(el.value)
  }

  const remove = async () => {
    if (!selected) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    pending.current = null
    setSaveState('idle')
    setTexNote('')
    try {
      await window.api.notes.remove(selected)
    } catch (err) {
      return fail(`Could not delete this note: ${plain(err)}`)
    }
    setSelected(null)
    await loadList()
  }

  const startRename = () => {
    if (!selected) return
    escaped.current = false
    setRenameErr('')
    setDraft(baseName(selected))
    setRenaming(true)
  }

  const commitRename = async () => {
    if (!selected) return
    const next = draft.trim()
    // An empty title is "never mind", not a request to name the note nothing. A new note opens in
    // this field empty, so clicking away from it lands here.
    if (!next || next === baseName(selected)) {
      setRenaming(false)
      setRenameErr('')
      return
    }
    try {
      // A rename before the debounce fires would write the buffered text back to the old path.
      await flush()
      const moved = await window.api.notes.rename(selected, next)
      setRenaming(false)
      setRenameErr('')
      await loadList()
      setSelected(moved)
    } catch (err) {
      setRenameErr(plain(err))
    }
  }

  const toggleHistory = async () => {
    if (historyOpen) {
      setHistoryOpen(false)
      setViewing(null)
      return
    }
    setHistoryOpen(true)
    if (!selected) return
    const path = selected
    await flush()
    const rows = await window.api.notes.versions(path)
    if (wanted.current === path) setVersions(rows)
  }

  const showVersion = async (v: NoteVer) => {
    if (!selected) return
    const path = selected
    const content = await window.api.notes.version(path, v.stamp)
    if (wanted.current === path) setViewing({ stamp: v.stamp, iso: v.iso, content })
  }

  const restore = async () => {
    if (!viewing || !selected) return
    const path = selected
    // Save what is on screen first; if that fails, stop — the next edit() would overwrite the
    // text still waiting in `pending`. The forced write then snapshots it, however recent the last
    // snapshot was, so a restore can always be undone.
    await flush()
    if (pending.current) return
    edit(viewing.content, true)
    setViewing(null)
    await flush()
    const rows = await window.api.notes.versions(path)
    if (wanted.current === path) setVersions(rows)
  }

  const byTitle = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of index) m.set(n.title.toLowerCase(), n.path)
    return m
  }, [index])

  /**
   * Search the body, not just the title. Main already keeps a full-text corpus keyed on mtime
   * (so it cannot go stale against hand edits) and already returns ranked hits with snippets —
   * the renderer was simply not asking. This is the "look across everything before an exam"
   * affordance that Ctrl+K structurally cannot give you, because the palette closes on selection.
   */
  const [hits, setHits] = useState<Map<string, string> | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q || q.startsWith('#')) {
      setHits(null)
      return
    }
    let stale = false
    const t = window.setTimeout(() => {
      void window.api.notes
        .search(q)
        .then((rows) => {
          if (!stale) setHits(new Map(rows.map((r) => [r.path, r.snippet])))
        })
        .catch(() => {
          if (!stale) setHits(null)
        })
    }, 150)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [query])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const tag = q.startsWith('#') ? q.slice(1) : ''
    const tagged = tag
      ? new Set(
          index
            .filter((n) =>
              n.tags.some((t) => {
                const k = t.toLowerCase().replace(/^#/, '')
                // A parent tag finds its children: #math lists #math/algebra too.
                return k === tag || k.startsWith(`${tag}/`)
              }),
            )
            .map((n) => n.path),
        )
      : null
    return notes.filter((n) => {
      if (courseId !== null && n.courseId !== courseId) return false
      if (!q) return true
      if (tagged) return tagged.has(n.path)
      // Title match OR body match. Until the debounced search lands, the title filter alone keeps
      // the list responsive rather than briefly empty.
      return n.title.toLowerCase().includes(q) || (hits?.has(n.path) ?? false)
    })
  }, [notes, index, courseId, query, hits])

  /**
   * Ranked, not substring-filtered, and it can offer a note that does not exist yet — linking to
   * something unwritten used to mean leaving the editor, creating it, coming back and retyping.
   *
   * With no query it shows the notes most recently opened, then the ones in this course: the note
   * you want next is nearly always one you just had open.
   */
  const popItems = useMemo<{ key: string; label: string; hint?: string; create?: boolean }[]>(() => {
    if (!pop) return []
    const q = pop.query.trim().toLowerCase()
    if (pop.kind === 'slash') {
      return SNIPPETS.filter((s) => s.label.toLowerCase().includes(q)).map((s) => ({ key: s.label, label: s.label }))
    }

    const scored = index
      .map((n) => ({ n, r: q ? rankTitle(n.title, q) : null }))
      .filter((x) => (q ? x.r !== null : true))
      .sort((a, b) => {
        if (q) return (a.r ?? 9) - (b.r ?? 9)
        const ra = recent.indexOf(a.n.path)
        const rb = recent.indexOf(b.n.path)
        if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
        const ca = a.n.courseId === courseId ? 0 : 1
        const cb = b.n.courseId === courseId ? 0 : 1
        return ca - cb
      })
      .slice(0, 8)
      .map((x): { key: string; label: string; hint?: string; create?: boolean } => ({
        key: x.n.path,
        label: x.n.title,
        hint: x.n.courseId ?? undefined,
      }))

    const exact = index.some((n) => n.title.toLowerCase() === q)
    if (q && !exact) scored.push({ key: `__create__${pop.query}`, label: `Create “${pop.query.trim()}”`, create: true })
    return scored
  }, [pop, index, recent, courseId])

  const detect = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart
    const upto = el.value.slice(0, caret)
    // Inside a code fence or inline code, `[[` is text. Odd counts before the caret mean we are
    // still inside one, and the popup would be opening over a code sample.
    const fences = (upto.match(/```/g) ?? []).length
    const ticks = (upto.split('\n').pop()?.match(/`/g) ?? []).length
    if (fences % 2 === 1 || ticks % 2 === 1) {
      setPop(null)
      return
    }
    const link = /\[\[([^[\]\n]*)$/.exec(upto)
    const slash = link ? null : /(?:^|\s)\/([A-Za-z0-9' ]*)$/.exec(upto)
    if (!link && !slash) {
      setPop(null)
      return
    }
    setPopIdx(0)
    setPopPos(caretPoint(el, caret))
    if (link) setPop({ kind: 'link', start: caret - link[0].length, query: link[1] })
    else if (slash) setPop({ kind: 'slash', start: caret - slash[1].length - 1, query: slash[1] })
  }

  const choose = (i: number) => {
    const el = ta.current
    const item = popItems[i]
    if (!pop || !el || !item) return
    let body: string
    let from: number
    let to: number
    if (pop.kind === 'link') {
      // "Create X" links to the title now and writes the file behind it, so the link never dangles.
      const title = item.create ? pop.query.trim().replace(/[\\/:*?"<>|]/g, '-') : item.label
      if (!title) return
      if (item.create) {
        const dir = courseId ? `${courseId}/` : ''
        void window.api.notes.write(`${dir}${title}.md`, `# ${title}\n\n`).then(loadList)
      }
      body = `[[${title}]]`
      from = body.length
      to = body.length
    } else {
      const s = SNIPPETS.find((x) => x.label === item.key)
      if (!s) return
      body = typeof s.body === 'function' ? s.body() : s.body
      from = s.from
      to = s.to ?? s.from
    }
    edit(text.slice(0, pop.start) + body + text.slice(el.selectionStart))
    pendingSel.current = [pop.start + from, pop.start + to]
    setPop(null)
  }

  /** Wrap the selection, or unwrap it if it is already wrapped. Ctrl+B / Ctrl+I / Ctrl+K. */
  const wrapSelection = (el: HTMLTextAreaElement, before: string, after = before): void => {
    const { selectionStart: s, selectionEnd: e } = el
    const inside = el.value.slice(s, e)
    const outside = el.value.slice(s - before.length, s) === before && el.value.slice(e, e + after.length) === after
    if (inside.startsWith(before) && inside.endsWith(after) && inside.length >= before.length + after.length) {
      typeInto(el, s, e, inside.slice(before.length, inside.length - after.length))
      pendingSel.current = [s, e - before.length - after.length]
    } else if (outside) {
      typeInto(el, s - before.length, e + after.length, inside)
      pendingSel.current = [s - before.length, e - before.length]
    } else {
      typeInto(el, s, e, `${before}${inside}${after}`)
      pendingSel.current = [s + before.length, e + before.length]
    }
  }

  const onEditorKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget

    // Escape with no popup open leaves the textarea. Required, not optional: swallowing Tab below
    // makes this a keyboard trap otherwise, which fails WCAG 2.1.2.
    if (e.key === 'Escape' && !pop) {
      el.blur()
      return
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'b' || k === 'i' || k === 'k') {
        e.preventDefault()
        if (k === 'b') wrapSelection(el, '**')
        else if (k === 'i') wrapSelection(el, '*')
        else {
          // With a selection: [selection](). Without: [](url) with the caret on url.
          const { selectionStart: s, selectionEnd: t } = el
          const sel = el.value.slice(s, t)
          typeInto(el, s, t, sel ? `[${sel}]()` : '[](url)')
          pendingSel.current = sel ? [s + sel.length + 3, s + sel.length + 3] : [s + 3, s + 6]
        }
        return
      }
    }

    // The slash and [[ popups own the arrows and Enter only while they are open.
    if (!pop || !popItems.length) {
      if (e.key === 'Tab') {
        // Tab used to move focus and eject you from the writing surface, while tab-size: 2
        // implied it did something.
        e.preventDefault()
        const { selectionStart: s, selectionEnd: t } = el
        const from = el.value.lastIndexOf('\n', s - 1) + 1
        const to = el.value.indexOf('\n', t) === -1 ? el.value.length : el.value.indexOf('\n', t)
        const block = el.value.slice(from, to)
        const next = e.shiftKey
          ? block.replace(/^ {1,2}/gm, '')
          : block.replace(/^/gm, '  ')
        typeInto(el, from, to, next)
        pendingSel.current = [from, from + next.length]
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const { selectionStart: s } = el
        if (s !== el.selectionEnd) return
        const from = el.value.lastIndexOf('\n', s - 1) + 1
        const line = el.value.slice(from, s)
        const m = /^(\s*)(?:([-*+])|(\d+)\.)(\s+\[[ xX]\])?\s+(.*)$/.exec(line)
        if (!m) return
        e.preventDefault()
        const [, indent, bullet, num, box, content] = m
        if (!content.trim()) {
          // An empty item exits the list. This single behaviour is most of the felt value.
          typeInto(el, from, s, '')
          return
        }
        const marker = bullet ? `${bullet} ` : `${Number(num) + 1}. `
        const insert = `\n${indent}${marker}${box ? '[ ] ' : ''}`
        typeInto(el, s, s, insert)
        pendingSel.current = [s + insert.length, s + insert.length]
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setPopIdx((i) => (i + 1) % popItems.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setPopIdx((i) => (i - 1 + popItems.length) % popItems.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(popIdx)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setPop(null)
    }
  }

  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const i = visible.findIndex((n) => n.path === selected)
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, visible.length - 1) : Math.max(i - 1, 0)
    const target = visible[next]
    if (!target || next === i) return
    e.preventDefault()
    void select(target.path)
  }

  const onPreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const hit = e.target instanceof HTMLElement ? e.target : null
    if (!hit) return
    const el = hit.closest<HTMLElement>('[data-wikilink],[data-tag]')
    if (el) {
      const path = el.dataset.wikilink
      const tag = el.dataset.tag
      if (path) void select(path)
      else if (tag) setQuery(`#${tag}`)
      return
    }
    // A link in a note opens in the browser. Left to itself it navigates this window away from the
    // app — which main also blocks, but the click should do the useful thing, not just nothing.
    const link = hit.closest('a')
    if (link) {
      e.preventDefault()
      if (/^https?:\/\//.test(link.href)) void window.api.app.openExternal(link.href)
      return
    }
    if (viewing) return
    // Chromium swallows pointer events on disabled inputs, so the click lands on the <li>.
    const box = hit.closest('li')?.querySelector<HTMLInputElement>('input[type=checkbox]')
    if (!box) return
    const i = Array.from(e.currentTarget.querySelectorAll('li input[type=checkbox]')).indexOf(box)
    if (i >= 0) toggleTask(i)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pop) setPop(null)
        else if (viewing) setViewing(null)
        else if (historyOpen) setHistoryOpen(false)
        return
      }
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === 's') {
        e.preventDefault()
        void flush()
      } else if (e.key === 'e') {
        e.preventDefault()
        setMode((m) => (m === 'edit' ? 'split' : m === 'split' ? 'preview' : 'edit'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flush, pop, viewing, historyOpen])

  const source = viewing ? viewing.content : text
  const front = useMemo(() => splitFrontmatter(source), [source])
  const limit = useMemo(() => wordLimit(front), [front])
  const showEditor = mode !== 'preview' && !viewing
  const showPreview = mode !== 'edit' || !!viewing
  const html = useMemo(
    () => (showPreview ? renderBody(front.body, byTitle) : ''),
    [showPreview, front.body, byTitle],
  )

  return (
    <>
      <div className="topbar">
        {/* Inside a course workspace the code is already the page headline — repeating it here
            stacked two identical top-tier titles 140px apart, and the eye had nowhere to land. */}
        <h1>{courseId === null ? 'All notes' : 'Notes'}</h1>
        <div className="spacer" />
        <span className="faint">
          {visible.length} note{visible.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="content flush">
        <div className="notes-layout">
          <div className="notes-list" onKeyDown={onListKey}>
            <div className="stack" style={{ gap: 6, marginBottom: 12 }}>
              {/* Not primary: cardinal is spent on overdue and real commits. A pane utility
                  wearing the CTA fill made two reds compete on one screen. */}
              <button className="btn" onClick={() => void create()}>
                New note
              </button>
              <input
                id="note-search"
                className="input"
                aria-label="Search notes"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search text, title or #tag"
              />
            </div>

            {visible.length ? (
              visible.map((n) => (
                <button
                  key={n.path}
                  className={`note-item${n.path === selected ? ' active' : ''}`}
                  aria-current={n.path === selected}
                  onClick={() => void select(n.path)}
                >
                  <div className="name">{n.title}</div>
                  <div className="when">
                    {courseId === null
                      ? `${courseById(n.courseId)?.code ?? 'Unfiled'} · ${shortWhen(n.updated)}`
                      : shortWhen(n.updated)}
                    {/* An affordance, not metadata: this note opens in the browser. */}
                    {n.docUrl ? (
                      <span className="chip" style={{ marginLeft: 6 }}>
                        Google Doc ↗
                      </span>
                    ) : null}
                  </div>
                  {/* Why this note matched, when the match was in the body rather than the title. */}
                  {hits?.get(n.path) ? <div className="note-snippet">{hits.get(n.path)}</div> : null}
                </button>
              ))
            ) : (
              <div className="empty">
                {query.trim().startsWith('#')
                  ? 'No note carries that tag. Tags are #words in the text.'
                  : query.trim()
                    ? 'Nothing matches, in any title or body.'
                    : 'No notes yet. New note starts one.'}
              </div>
            )}
          </div>

          <div
            className="editor-pane"
            onKeyDown={(e) => {
              if (e.key !== 'F2' || renaming) return
              e.preventDefault()
              startRename()
            }}
          >
            {selected ? (
              <>
                <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  {renaming ? (
                    <input
                      className="input"
                      aria-label="Note title"
                      style={{ width: 220 }}
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void commitRename()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          escaped.current = true
                          setRenaming(false)
                          setRenameErr('')
                        }
                      }}
                      onBlur={() => {
                        if (escaped.current) {
                          escaped.current = false
                          return
                        }
                        void commitRename()
                      }}
                    />
                  ) : (
                    <button className="btn ghost sm" title="Click to rename (F2)" onClick={startRename}>
                      {selected} ✎
                    </button>
                  )}
                  {renameErr ? (
                    <span role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>
                      {renameErr}
                    </span>
                  ) : null}
                  {saveState === 'error' ? (
                    <button
                      className="btn ghost sm"
                      style={{ color: 'var(--danger)' }}
                      title={saveError}
                      onClick={() => void flush()}
                    >
                      Not saved — retry
                    </button>
                  ) : (
                    <span className="faint">
                      {saveState === 'saving'
                        ? 'Saving…'
                        : savedAt
                          ? // A clock turns the label from decoration into information.
                            `Saved ${savedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                          : 'Saved'}
                    </span>
                  )}
                  {limit && (
                    <span
                      className="faint"
                      title={`Limit from this note's "limit" property. Pages assume ${WORDS_PER_PAGE} words per page; fenced code and any works-cited section are not counted.`}
                      style={{
                        color:
                          limit.words > limit.max
                            ? 'var(--danger)'
                            : limit.words >= limit.max * 0.9
                              ? 'var(--warn)'
                              : undefined,
                      }}
                    >
                      {limit.words.toLocaleString()} / {limit.max.toLocaleString()} words ·{' '}
                      {(limit.words / WORDS_PER_PAGE).toFixed(1)} pp
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  {MODES.map(([m, label]) => (
                    <button
                      key={m}
                      className={`btn sm${mode === m ? ' on' : ''}`}
                      aria-pressed={mode === m}
                      onClick={() => setMode(m)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    className="btn sm"
                    title="Fix headings, bullets, numbering, tables and spacing. Never changes your words, maths or code."
                    onClick={() => {
                      void window.api.notes.tidy(text).then((pretty) => {
                        if (pretty !== text) edit(pretty)
                        setTexNote(pretty === text ? 'Already tidy' : 'Tidied')
                      })
                    }}
                  >
                    Tidy
                  </button>
                  <button className="btn sm" aria-pressed={historyOpen} onClick={() => void toggleHistory()}>
                    History
                  </button>
                  {texNote ? (
                    <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
                      {texNote}
                    </span>
                  ) : null}
                  <button className="btn ghost sm" onClick={() => void remove()} onBlur={() => setConfirmDelete(false)}>
                    {confirmDelete ? 'Sure?' : 'Delete'}
                  </button>
                </div>

                {historyOpen && (
                  <div
                    style={{
                      borderBottom: '1px solid var(--border)',
                      padding: '8px 12px',
                      maxHeight: 180,
                      overflowY: 'auto',
                      background: 'var(--bg-inset)',
                    }}
                  >
                    {versions.length ? (
                      versions.map((v) => (
                        <button
                          key={v.stamp}
                          className={`note-item${viewing?.stamp === v.stamp ? ' active' : ''}`}
                          aria-current={viewing?.stamp === v.stamp}
                          onClick={() => void showVersion(v)}
                        >
                          <div className="name">{shortWhen(v.iso)}</div>
                          <div className="when">
                            {new Date(v.iso).toLocaleString()} · {Math.max(1, Math.round(v.bytes / 100) / 10)} kB
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="empty" style={{ padding: '14px 8px' }}>
                        No earlier versions yet. Tartan snapshots the text it replaces, about once every five minutes, and always before a restore or a big cut.
                      </div>
                    )}
                  </div>
                )}

                <div className={`editor-split${showEditor && showPreview ? '' : ' single'}`}>
                  {showEditor && (
                    <textarea
                      id="note-editor"
                      ref={ta}
                      aria-label="Note text"
                      className="editor-area"
                      value={text}
                      spellCheck={false}
                      onChange={(e) => {
                        edit(e.target.value)
                        detect(e.target)
                      }}
                      onKeyDown={onEditorKey}
                      onPaste={(e) => void onPaste(e)}
                      onBlur={() => setPop(null)}
                    />
                  )}
                  {showPreview && (
                    <div className="preview" onClick={onPreviewClick}>
                      {viewing && (
                        <div className="card row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
                          <span className="muted">Viewing a version from {shortWhen(viewing.iso)} — read only</span>
                          <div style={{ flex: 1 }} />
                          <button className="btn sm primary" onClick={() => void restore()}>
                            Restore
                          </button>
                          <button className="btn ghost sm" onClick={() => setViewing(null)}>
                            Back
                          </button>
                        </div>
                      )}
                      {front.props.length > 0 && (
                        <table style={{ marginBottom: 16 }}>
                          <tbody>
                            {front.props.map(([k, v]) => (
                              <tr key={k}>
                                <th style={{ width: '30%', textAlign: 'left' }}>{k}</th>
                                <td>{v}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      <div dangerouslySetInnerHTML={{ __html: html }} />
                    </div>
                  )}
                </div>

                {backlinks.length > 0 && (
                  <details
                    style={{ borderTop: '1px solid var(--border)', padding: '8px 16px' }}
                    // A course index note accumulates dozens of hits, so the collapse threshold
                    // is load-bearing: open by default only while the list is still readable.
                    open={backlinks.length <= 5}
                  >
                    <summary className="section-title" style={{ cursor: 'pointer' }}>
                      Linked from ({backlinks.length})
                    </summary>
                    <div className="stack" style={{ gap: 2, marginTop: 8 }}>
                      {backlinks.map((b) => (
                        <button key={b.path} className="backlink" onClick={() => void select(b.path)}>
                          <span className="backlink-where">
                            {b.title}
                            {b.heading ? <span className="faint"> › {b.heading}</span> : null}
                          </span>
                          {/* The sentence is the point: it says why this note points here. */}
                          {b.line ? <span className="backlink-line">{b.line}</span> : null}
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </>
            ) : (
              <EmptyState
                headline="Nothing open."
                detail={
                  openErr ? (
                    <span role="alert" style={{ color: 'var(--danger)' }}>
                      {openErr}
                    </span>
                  ) : (
                    'Pick a note on the left, or start a new one — it opens straight into its title.'
                  )
                }
                action={{ label: 'New note', run: () => void create() }}
              />
            )}
          </div>
        </div>
      </div>

      {pop && popPos && popItems.length > 0 && (
        <div
          role="listbox"
          aria-label={pop.kind === 'slash' ? 'Insert block' : 'Link a note'}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'fixed',
            top: Math.min(popPos.top, window.innerHeight - 280),
            left: Math.min(popPos.left, window.innerWidth - 250),
            width: 230,
            zIndex: 40,
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            padding: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
          }}
        >
          {popItems.map((it, i) => (
            <button
              key={it.key}
              role="option"
              aria-selected={i === popIdx}
              className={`note-item${i === popIdx ? ' active' : ''}`}
              onMouseEnter={() => setPopIdx(i)}
              onClick={() => choose(i)}
            >
              <div className="name">{it.label}</div>
              {it.hint && <div className="when">{it.hint}</div>}
            </button>
          ))}
          <div className="faint" style={{ fontSize: 'var(--fs-micro)', padding: '6px 9px 2px' }}>
            <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close
          </div>
        </div>
      )}
    </>
  )
}

/** The title is the filename: last segment, without the ".md". */
const baseName = (path: string): string => path.split('/').pop()?.replace(/\.md$/, '') ?? path

/** An IPC rejection reads "Error invoking remote method 'notes:rename': Error: <the message>"; show the message. */
const plain = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ENT[c])

const LINK_STYLE =
  // --accent is the fill tier at 3.53:1 and is not legal on a word; --accent-text is 5.82:1.
  'background:none;border:0;padding:0;font:inherit;color:var(--accent-text);text-decoration:underline;cursor:pointer'
const DEAD_STYLE = 'color:var(--text-faint);border-bottom:1px dotted var(--text-faint)'

/** A leading `---` block is properties, not prose: pull it out so marked never sees it. */
function splitFrontmatter(src: string): { props: [string, string][]; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!m) return { props: [], body: src }
  const props = m[1].split(/\r?\n/).flatMap<[string, string]>((line) => {
    const i = line.indexOf(':')
    return i < 0 ? [] : [[line.slice(0, i).trim(), line.slice(i + 1).trim()]]
  })
  return { props, body: src.slice(m[0].length) }
}

/** Counts prose against a `limit: 2000w` / `limit: 8p` property. Anything malformed counts as none. */
function wordLimit(front: { props: [string, string][]; body: string }): { words: number; max: number } | null {
  const raw = front.props.find(([k]) => k.toLowerCase() === 'limit')?.[1]
  const m = raw ? /^(\d+)\s*([wp])$/.exec(raw.trim()) : null
  if (!m) return null
  const max = Number(m[1]) * (m[2] === 'p' ? WORDS_PER_PAGE : 1)
  if (!max) return null
  const prose = front.body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}[ \t]*(works cited|bibliography|references)\b[\s\S]*$/im, ' ')
  return { words: prose.split(/\s+/).filter(Boolean).length, max }
}

function fileStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * `\$` is a literal dollar; `$$…$$` is display math; `$…$` is inline math only by the usual
 * pandoc rule — no space right after the opening `$`, no space before the closing one, no digit
 * after it — so "I paid $5 and then $10" stays a sentence while `$2x$` and `$0$` are still math.
 */
const MATH_RE = /\\\$|\$\$([\s\S]+?)\$\$|\$(?![\s$])([^$\n]*?[^\s$\\])\$(?!\d)/g

/**
 * Raw HTML in a note reaches the page as-is. <meta http-equiv="refresh"> navigates the window by
 * itself and <base> re-aims every link, so neither is let through. Repeated until stable, or
 * `<<meta>meta …>` would reassemble itself from what is left.
 */
const stripHead = (html: string): string => {
  const next = html.replace(/<\/?(?:meta|base)\b[^>]*>?/gi, '')
  return next === html ? html : stripHead(next)
}

/**
 * Math, wikilinks and tags are lifted out to opaque tokens before marked runs and put back as HTML
 * afterwards, so markdown can never mangle them. Code spans and fences are lifted out first and
 * restored before marked, which keeps `#include` and `$x` inside code from being rewritten.
 */
export function renderBody(src: string, byTitle: Map<string, string>): string {
  const code: string[] = []
  const held: string[] = []
  const hold = (h: string): string => `@@TARTANX${held.push(h) - 1}@@`

  let s = src.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => `@@TARTANC${code.push(m) - 1}@@`)

  s = s.replace(MATH_RE, (m, display: string | undefined, inline: string | undefined) =>
    hold(
      m === '\\$'
        ? '$'
        : katex.renderToString(display ?? inline ?? '', { displayMode: display !== undefined, throwOnError: false }),
    ),
  )

  s = s.replace(/\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g, (_m, target: string, label: string | undefined) => {
    const path = byTitle.get(target.trim().toLowerCase())
    const shown = esc((label ?? target).trim())
    return hold(
      path
        ? `<button type="button" data-wikilink="${esc(path)}" style="${LINK_STYLE}">${shown}</button>`
        : `<span style="${DEAD_STYLE}" title="No note with that title">${shown}</span>`,
    )
  })

  s = s.replace(
    /(^|\s)#([A-Za-z][\w/-]*)/g,
    (_m, pre: string, tag: string) =>
      `${pre}${hold(`<button type="button" class="chip" data-tag="${esc(tag)}" style="cursor:pointer">#${esc(tag)}</button>`)}`,
  )

  s = s.replace(/@@TARTANC(\d+)@@/g, (_m, i: string) => code[Number(i)])
  const html = stripHead(marked.parse(s, { gfm: true, breaks: false, async: false }))
  return html.replace(/@@TARTANX(\d+)@@/g, (_m, i: string) => held[Number(i)])
}

/** Viewport point just below the caret, measured with a throwaway mirror of the textarea. */
function caretPoint(el: HTMLTextAreaElement, pos: number): { top: number; left: number } {
  const cs = getComputedStyle(el)
  const mirror = document.createElement('div')
  const copied = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textIndent',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'tabSize',
  ] as const
  for (const p of copied) mirror.style[p] = cs[p]
  mirror.style.position = 'absolute'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  mirror.style.width = `${el.clientWidth}px`
  mirror.textContent = el.value.slice(0, pos)
  const marker = document.createElement('span')
  marker.textContent = '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop
  const left = marker.offsetLeft
  mirror.remove()
  const rect = el.getBoundingClientRect()
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6
  return { top: rect.top + top - el.scrollTop + lh, left: rect.left + left - el.scrollLeft }
}

function shortWhen(iso: string): string {
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  if (mins < 10_080) return `${Math.round(mins / 1440)}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
