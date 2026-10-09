// The open card's sections. Each section owns its own preview limit and
// empty state, so a card opens at a predictable size however much it holds:
// a few lines of description, the first checklist items, the first
// attachments, and Activity folded away.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, Check, ChevronDown, DotsHorizontal, ExternalLink, Paperclip, Pencil, Plus, Reload, Trash } from '@openai/apps-sdk-ui/components/Icon'
import { useModalFocus } from './modalFocus.js'
import { describeActivity, MAX_NOTES_CHARS } from '../activity.js'
import { describeAssignmentEvent, restorableAssignment } from '../assignment.js'
import { isPreviewImage, loadCardAttachment, MAX_CARD_ATTACHMENTS } from '../attachments.js'
import { checklistProgress, dueDateStatus, formatDueDate } from '../domain.js'
import { cardPullUrls } from '../operations.js'
import { parsePullRequestUrl } from '../prMatching.js'

export const CHECKLIST_PREVIEW_ITEMS = 3
export const ATTACHMENT_PREVIEW_ITEMS = 3
// The description preview height lives in theme.js (.kb-notes-display.is-clamped).

// ---- text ----

export function linkifiedParts(text) {
  return String(text || '').split(/(https?:\/\/[^\s<]+)/gu).flatMap(part => {
    if (!/^https?:\/\//u.test(part)) return [{ text: part }]
    const match = part.match(/^(.*?)([.,!?;:]+)?$/u)
    const url = match?.[1] || part
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) return [{ text: part }]
      return [{ text: url, href: parsed.href }, { text: match?.[2] || '' }]
    } catch {
      return [{ text: part }]
    }
  })
}

export function LinkifiedText({ text }) {
  return linkifiedParts(text).map((part, index) => {
    if (!part.href) return part.text
    return (
      <a
        key={index}
        href={part.href}
        target="_blank"
        rel="noreferrer"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      >
        {part.text}
      </a>
    )
  })
}

// React owns the editor shell, not its text nodes. The browser owns selection,
// typing, plain-text paste, composition and undo without replacing the clicked
// surface. Incoming polls update idle editors, never the focused draft/caret.
export function InlineCardText({
  value,
  className,
  label,
  placeholder,
  autoFocus = false,
  links = false,
  onCommit,
  onCancel,
}) {
  const editorRef = useRef(null)
  const dirtyRef = useRef(false)
  const savedText = value || ''

  const renderText = useCallback(text => {
    const editor = editorRef.current
    if (!editor) return
    const parts = links ? linkifiedParts(text) : [{ text }]
    const nodes = parts.map(part => {
      if (!part.href) return document.createTextNode(part.text)
      const anchor = document.createElement('a')
      anchor.textContent = part.text
      anchor.href = part.href
      anchor.target = '_blank'
      anchor.rel = 'noreferrer'
      return anchor
    })
    editor.replaceChildren(...nodes)
    editor.dataset.empty = text ? 'false' : 'true'
  }, [links])

  useLayoutEffect(() => {
    const isFocused = document.activeElement === editorRef.current
    if (!isFocused && !dirtyRef.current) renderText(savedText)
  }, [savedText, renderText])

  useLayoutEffect(() => {
    if (autoFocus) editorRef.current?.focus()
  }, [])

  const commitOnBlur = event => {
    const text = event.currentTarget.innerText.replace(/\r\n?/g, '\n')
    if (dirtyRef.current && text !== savedText) {
      const acceptedText = onCommit(text)
      if (acceptedText === false) return
      renderText(acceptedText ?? text)
    } else {
      renderText(savedText)
    }
    dirtyRef.current = false
  }

  const cancelOnEscape = event => {
    if (event.key !== 'Escape' || event.isComposing || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    dirtyRef.current = false
    renderText(savedText)
    onCancel?.()
  }

  const openLink = event => {
    const anchor = event.target.closest('a')
    if (!anchor) return
    event.preventDefault()
    event.stopPropagation()
    window.open(anchor.href, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      ref={editorRef}
      className={className}
      contentEditable="plaintext-only"
      role="textbox"
      tabIndex={0}
      aria-label={label}
      aria-multiline="true"
      data-placeholder={placeholder}
      data-modal-inline-editor
      spellCheck
      onInput={event => {
        dirtyRef.current = true
        event.currentTarget.dataset.empty = event.currentTarget.innerText ? 'false' : 'true'
      }}
      onBlur={commitOnBlur}
      onKeyDown={cancelOnEscape}
      onClick={openLink}
    />
  )
}

// ---- small shared pieces ----

// Appears only when loading takes long enough to notice, so a fast load
// never flickers a spinner.
export function DelayedSpinner({ label = 'Loading' }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150)
    return () => clearTimeout(timer)
  }, [])
  return visible ? <span className="kb-mini-spinner" role="status" aria-label={label} /> : null
}

export function SavedIndicator({ tick }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!tick) return undefined
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 1800)
    return () => clearTimeout(timer)
  }, [tick])
  return <span className={`kb-saved${visible ? ' is-visible' : ''}`} role="status" aria-live="polite">
    {visible && <><Check aria-hidden="true" /> Saved</>}
  </span>
}

export function ShowMore({ expanded, onToggle, more, less = 'Show less' }) {
  return <button type="button" className={`kb-show-more${expanded ? ' is-expanded' : ''}`} aria-expanded={expanded} onClick={onToggle}>
    {expanded ? less : more}<ChevronDown aria-hidden="true" />
  </button>
}

export function CardSection({ title, meta, loading, className = '', children }) {
  return <section className={`kb-section${className ? ` ${className}` : ''}`} aria-label={title}>
    <div className="kb-section-head">
      <h3>{title}</h3>
      {meta}
      {loading && <DelayedSpinner label={`Loading ${title.toLocaleLowerCase()}`} />}
    </div>
    {children}
  </section>
}

// On a phone the menu becomes a bottom sheet in document.body: the card sheet
// is transformed, so a fixed menu inside it would be positioned against it.
const PHONE = '(max-width: 640px)'

function usePopover() {
  const rootRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [sheet, setSheet] = useState(false)
  const menuRef = useModalFocus(open, () => setOpen(false))
  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePress = event => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [open])
  const toggle = () => {
    setSheet(typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches)
    setOpen(value => !value)
  }
  const layer = menu => (sheet ? createPortal(<>
    <div className="kb-popover-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
    {menu}
  </>, document.body) : menu)
  const menuClass = `kb-popover-menu${sheet ? ' is-sheet' : ''}`
  return { rootRef, menuRef, open, setOpen, toggle, layer, menuClass }
}

// A ••• trigger whose menu closes after any item is chosen. `children` are the
// menu items (buttons with role="menuitem").
export function MenuButton({ label, className = '', children }) {
  const { rootRef, menuRef, open, setOpen, toggle, layer, menuClass } = usePopover()
  return <div className={`kb-menu-button${className ? ` ${className}` : ''}`} ref={rootRef}>
    <button type="button" className="kb-iconbtn kb-menu-trigger" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
      onPointerDown={event => event.stopPropagation()} onClick={toggle}>
      <DotsHorizontal aria-hidden="true" />
    </button>
    {open && layer(<div ref={menuRef} className={`${menuClass} kb-menu-end`} role="menu" aria-label={label}
      onClick={event => { if (event.target.closest('button:not(:disabled)')) setOpen(false) }}>
      {children}
    </div>)}
  </div>
}

const capitalize = value => value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value

// ---- header ----

export function StatusPill({ columns, columnId, colorFor, canWrite, onMove }) {
  const { rootRef, menuRef, open, setOpen, toggle, layer, menuClass } = usePopover()
  const current = columns.find(column => column.id === columnId)
  if (!current) return null
  return <div className="kb-status-pill-wrap" ref={rootRef}>
    <button
      type="button"
      className="kb-status-pill"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Status: ${current.name}${canWrite ? '. Change status' : ''}`}
      disabled={!canWrite}
      onClick={toggle}
    >
      <span className="kb-status-dot" style={{ background: colorFor(current) }} aria-hidden="true" />
      <span className="kb-status-name">{current.name}</span>
      {canWrite && <ChevronDown aria-hidden="true" />}
    </button>
    {open && layer(<div ref={menuRef} className={menuClass} role="menu" aria-label="Move card to">
      {columns.map(column => <button
        key={column.id}
        type="button"
        role="menuitemradio"
        aria-checked={column.id === columnId}
        onClick={() => { setOpen(false); if (column.id !== columnId) onMove(column.id) }}
      >
        <span className="kb-status-dot" style={{ background: colorFor(column) }} aria-hidden="true" />
        <span className="kb-menu-label">{column.name}</span>
        {column.id === columnId && <Check aria-hidden="true" />}
      </button>)}
    </div>)}
  </div>
}

// ---- details row: label and due date (assignee lives with the people picker) ----

export function LabelChip({ label, labels, canWrite, onChange }) {
  const { rootRef, menuRef, open, setOpen, toggle, layer, menuClass } = usePopover()
  const current = label && label !== 'none' && labels[label] ? label : ''
  if (!canWrite && !current) return null
  const choose = name => { onChange(name); setOpen(false) }
  return <div className="kb-chip-wrap" ref={rootRef}>
    <button
      type="button"
      className={`kb-detail-chip${current ? '' : ' is-empty'}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={current ? `Label: ${current}. Change label` : 'Add label'}
      disabled={!canWrite}
      onClick={toggle}
    >
      {current
        ? <><span className="kb-chip-swatch" style={{ background: labels[current] }} aria-hidden="true" />{capitalize(current)}</>
        : <><Plus aria-hidden="true" />Add label</>}
    </button>
    {open && layer(<div ref={menuRef} className={menuClass} role="menu" aria-label="Choose label">
      <div className="kb-menu-heading">Label</div>
      {Object.entries(labels).filter(([name]) => name !== 'none').map(([name, color]) => <button
        key={name}
        type="button"
        role="menuitemradio"
        aria-checked={current === name}
        onClick={() => choose(name)}
      >
        <span className="kb-chip-swatch" style={{ background: color }} aria-hidden="true" />
        <span className="kb-menu-label">{capitalize(name)}</span>
        {current === name && <Check aria-hidden="true" />}
      </button>)}
      {current && <><div className="kb-menu-separator" /><button type="button" role="menuitem" className="kb-menu-danger" onClick={() => choose('none')}>Remove label</button></>}
    </div>)}
  </div>
}

function localIsoDate(offsetDays = 0) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Due within this many days (but not overdue) reads as "soon" on cards.
export const DUE_SOON_DAYS = 2

export function dueTone(due, today = localIsoDate()) {
  const status = dueDateStatus(due, today)
  if (status === 'overdue') return 'overdue'
  if (status === 'today') return 'soon'
  if (status === 'upcoming' && due <= localIsoDateFrom(today, DUE_SOON_DAYS)) return 'soon'
  return status ? 'later' : ''
}

function localIsoDateFrom(iso, days) {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

export function dueChipText(due) {
  const face = formatDueDate(due)
  if (!face) return ''
  if (face === 'Today') return 'Due today'
  if (/ over$/u.test(face)) return face.replace(/ over$/u, ' overdue')
  return `Due ${face}`
}

function shortDate(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)))
}

export function DueChip({ due, canWrite, onChange }) {
  const { rootRef, menuRef, open, setOpen, toggle, layer, menuClass } = usePopover()
  if (!canWrite && !due) return null
  const choose = value => { onChange(value); setOpen(false) }
  const quick = [['Today', 0], ['Tomorrow', 1], ['In a week', 7]]
  return <div className="kb-chip-wrap" ref={rootRef}>
    <button
      type="button"
      className={`kb-detail-chip${due ? ` kb-due-chip is-${dueTone(due)}` : ' is-empty'}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={due ? `${dueChipText(due)}. Change due date` : 'Add due date'}
      disabled={!canWrite}
      onClick={toggle}
    >
      {due ? <><Calendar aria-hidden="true" />{dueChipText(due)}</> : <><Plus aria-hidden="true" />Add due date</>}
    </button>
    {open && layer(<div ref={menuRef} className={menuClass} role="menu" aria-label="Choose due date">
      <div className="kb-menu-heading">Due date</div>
      {quick.map(([label, days]) => {
        const value = localIsoDate(days)
        return <button key={label} type="button" role="menuitemradio" aria-checked={due === value} onClick={() => choose(value)}>
          <span className="kb-menu-label">{label}</span>
          <span className="kb-menu-meta">{shortDate(value)}</span>
        </button>
      })}
      <label className="kb-menu-date">
        <span>Pick a date</span>
        <input type="date" value={due || ''} onChange={event => { if (event.target.value) choose(event.target.value) }} />
      </label>
      {due && <><div className="kb-menu-separator" /><button type="button" role="menuitem" className="kb-menu-danger" onClick={() => choose('')}>Remove due date</button></>}
    </div>)}
  </div>
}

// ---- description ----

// `text` is the full description when known. While a shared card's moved-out
// description is still loading, the board's preview is shown read-only: an
// edit started from the preview would save a truncated text.
export function DescriptionSection({ cardId, text, canWrite, editable, loading, conflict, error, onCommit, onKeepMine, onUseTheirs }) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const bodyRef = useRef(null)
  useEffect(() => { setExpanded(false) }, [cardId])
  useLayoutEffect(() => {
    const body = bodyRef.current?.querySelector('.kb-notes-display')
    if (!body) return undefined
    const measure = () => setOverflows(body.scrollHeight > body.clientHeight + 1)
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(body)
    return () => observer?.disconnect()
  }, [text, expanded, editable])
  if (!canWrite && !text) return null
  const commit = value => {
    if (value.length > MAX_NOTES_CHARS) return false
    return onCommit(value) === false ? false : value
  }
  const clamp = expanded ? '' : ' is-clamped'
  return <CardSection title="Description" loading={loading}>
    <div className="kb-description" ref={bodyRef}>
      {canWrite && editable ? <InlineCardText
        key={cardId}
        className={`kb-notes-display kb-editable-field${clamp}`}
        value={text}
        placeholder="Add a description…"
        label="Card description"
        links
        onCommit={commit}
      /> : <div className={`kb-notes-display${text ? '' : ' kb-notes-empty'}${clamp}`}>
        {text ? <LinkifiedText text={text} /> : 'Add a description…'}
      </div>}
    </div>
    {(overflows || expanded) && <ShowMore expanded={expanded} onToggle={() => setExpanded(value => !value)} more="Show more" />}
    {conflict && <div className="kb-notes-conflict" role="alert">
      <p>Someone else changed this description while you were editing.</p>
      <div className="kb-notes-conflict-actions">
        <button type="button" className="kb-btn kb-btn-quiet" onClick={onUseTheirs}>Use theirs</button>
        <button type="button" className="kb-btn kb-btn-primary" onClick={onKeepMine}>Keep mine</button>
      </div>
    </div>}
    {error && <p className="kb-attachment-error" role="alert">{error}</p>}
  </CardSection>
}

// ---- checklist ----

export function ChecklistSection({ checklist, canWrite, onAdd, onToggle, onDelete, onEdit }) {
  const [newItemText, setNewItemText] = useState('')
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [editingItem, setEditingItem] = useState(null)
  if (!checklist.length && !canWrite) return null
  const progress = checklistProgress(checklist)
  const visible = expanded ? checklist : checklist.slice(0, CHECKLIST_PREVIEW_ITEMS)
  const hidden = checklist.length - CHECKLIST_PREVIEW_ITEMS

  const addItem = () => {
    const text = newItemText.trim()
    if (!text || !canWrite) return
    onAdd(text)
    setNewItemText('')
    if (checklist.length >= CHECKLIST_PREVIEW_ITEMS) setExpanded(true)
  }
  const saveItem = item => {
    const text = editingItem.text.trim()
    if (text && text !== item.text) onEdit(item.id, text)
    setEditingItem(null)
  }
  const handleEditKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setEditingItem(null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }

  const meta = progress.total > 0 && <>
    <span className="kb-section-count">{progress.done}/{progress.total}</span>
    <span className={`kb-section-progress${progress.done === progress.total ? ' is-done' : ''}`} role="progressbar"
      aria-label={`${progress.done} of ${progress.total} checklist items complete`}
      aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
      <span style={{ width: `${progress.percent}%` }} />
    </span>
  </>

  return <CardSection title="Checklist" meta={meta}>
    {visible.length > 0 && <div className="kb-checklist">
      {visible.map(item => (
        <div className="kb-check-item" key={item.id}>
          <div className="kb-check-toggle">
            <input type="checkbox" checked={item.done} aria-label={item.text} disabled={!canWrite} onChange={() => onToggle(item.id)} />
            {editingItem?.id === item.id ? (
              <input
                className="kb-input kb-check-edit"
                data-modal-inline-editor
                value={editingItem.text}
                aria-label={`Edit checklist item ${item.text}`}
                autoFocus
                onChange={event => setEditingItem({ id: item.id, text: event.target.value })}
                onBlur={() => saveItem(item)}
                onKeyDown={handleEditKey}
              />
            ) : (
              <button type="button" className={`kb-check-text ${item.done ? 'kb-check-done' : ''}`}
                onClick={() => { if (canWrite) setEditingItem({ id: item.id, text: item.text }) }}>
                {item.text}
              </button>
            )}
          </div>
          {canWrite && <button className="kb-iconbtn kb-check-delete" aria-label={`Delete checklist item ${item.text}`} onClick={() => onDelete(item.id)}><Trash /></button>}
        </div>
      ))}
    </div>}
    {canWrite && adding && <div className="kb-check-add">
      <input
        className="kb-input"
        value={newItemText}
        autoFocus
        placeholder="Add an item…"
        aria-label="New checklist item"
        onChange={event => setNewItemText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); addItem() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAdding(false); setNewItemText('') }
        }}
      />
      <button className="kb-btn kb-btn-primary" disabled={!newItemText.trim()} onClick={addItem}>Add</button>
    </div>}
    <div className="kb-section-actions">
      {hidden > 0 && <ShowMore expanded={expanded} onToggle={() => setExpanded(value => !value)} more={`Show ${hidden} more`} less="Show fewer" />}
      {canWrite && !adding && <button type="button" className="kb-quiet-action" onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add an item</button>}
    </div>
  </CardSection>
}

// ---- pull requests: one line each ----

function pullRequestShortLabel(url) {
  const pull = parsePullRequestUrl(url)
  if (pull) return `#${pull.number}`
  try { return new URL(url).hostname } catch { return 'Link' }
}

function pullRequestTitle(url) {
  const pull = parsePullRequestUrl(url)
  return pull ? `${pull.owner}/${pull.repo} #${pull.number}` : url
}

// Statuses are keyed by URL. Offline, nothing new is fetched: a card keeps its
// last known status, and a link never checked (or not a GitHub PR) shows none.
export function PullRequestSection({ card, canWrite, online, statuses, onUpdate, onRefresh }) {
  const urls = cardPullUrls(card)
  const statusFor = url => (parsePullRequestUrl(url) ? statuses[url] || (online ? { label: 'Checking…', tone: 'unknown' } : null) : null)
  const hints = [...new Set(urls.map(url => statusFor(url)?.hint).filter(Boolean))]
  const [editor, setEditor] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { setEditor(null); setDraft(''); setError('') }, [card.id])
  if (!urls.length && !canWrite) return null
  const save = () => {
    if (!parsePullRequestUrl(draft)) { setError('Use a GitHub pull request link, like https://github.com/owner/repo/pull/123'); return }
    onUpdate(editor === 'add' ? null : editor, draft.trim())
    setEditor(null); setDraft(''); setError('')
  }
  const cancel = () => { setEditor(null); setDraft(''); setError('') }
  const form = submitLabel => <form className="kb-pr-editor" onSubmit={event => { event.preventDefault(); save() }}>
    <input className="kb-input" type="url" autoFocus value={draft} aria-label="Pull request link"
      placeholder="https://github.com/owner/repo/pull/123"
      onChange={event => { setDraft(event.target.value); setError('') }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() } }} />
    <button type="submit" className="kb-btn kb-btn-primary">{submitLabel}</button>
    <button type="button" className="kb-btn kb-btn-quiet" onClick={cancel}>Cancel</button>
  </form>
  const canRefresh = online && urls.some(parsePullRequestUrl)
  return <section className="kb-section kb-pr-section" aria-label="Pull requests">
    {urls.map((url, index) => {
      const status = statusFor(url)
      if (editor === url) return <div key={url}>
        {form('Save')}
        <button type="button" className="kb-quiet-action kb-menu-danger" onClick={() => { onUpdate(url, ''); cancel() }}><Trash aria-hidden="true" />Remove this pull request</button>
      </div>
      return <div className="kb-pr-line" key={url}>
        <h3 className={index ? 'kb-visually-hidden' : ''}>Pull request</h3>
        <span className="kb-pr-right">
          <a className="kb-pr-link" href={url} target="_blank" rel="noreferrer" title={`Open ${pullRequestTitle(url)}`}>
            {pullRequestShortLabel(url)}<ExternalLink aria-hidden="true" />
          </a>
          {status && <span className={`kb-pr-status kb-pr-status-${status.tone}`}>{status.label}</span>}
          {canWrite && <button type="button" className="kb-iconbtn kb-pr-edit" aria-label={`Change or remove ${pullRequestTitle(url)}`} title="Change or remove" onClick={() => { setEditor(url); setDraft(url) }}><Pencil /></button>}
        </span>
      </div>
    })}
    {!urls.length && editor !== 'add' && <div className="kb-pr-line">
      <h3>Pull request</h3>
      <span className="kb-pr-right"><button type="button" className="kb-detail-chip is-empty" onClick={() => { setEditor('add'); setDraft('') }}><Plus aria-hidden="true" />Add pull request</button></span>
    </div>}
    {editor === 'add' && <>{!urls.length && <div className="kb-pr-line"><h3>Pull request</h3></div>}{form('Add')}</>}
    {urls.length > 0 && editor === null && (canWrite || canRefresh) && <div className="kb-section-actions">
      {canWrite && <button type="button" className="kb-quiet-action" onClick={() => { setEditor('add'); setDraft('') }}><Plus aria-hidden="true" />Add another</button>}
      {canRefresh && <button type="button" className="kb-iconbtn kb-pr-refresh" aria-label="Refresh pull request statuses" title="Refresh statuses" onClick={onRefresh}><Reload /></button>}
    </div>}
    {hints.map(hint => <p className="kb-pr-hint" key={hint}>{hint}</p>)}
    {error && <p className="kb-attachment-error" role="alert">{error}</p>}
  </section>
}

// ---- attachments ----

export function AttachmentImage({ boardId, share, attachment, className, alt = '' }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setSrc(''); setFailed(false)
    loadCardAttachment({ boardId, share, attachment }).then(value => {
      if (alive) setSrc(value)
    }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [boardId, share?.host, share?.oid, attachment.id, attachment.path])
  if (failed) return <span className={`${className} kb-image-missing`} role="img" aria-label="Image unavailable" />
  if (!src) return <span className={`${className} kb-image-loading`} aria-hidden="true" />
  return <img className={className} src={src} alt={alt} />
}

function fileBadge(attachment) {
  const extension = String(attachment.name || '').split('.').pop()
  return extension && extension.length <= 5 && extension !== attachment.name ? extension.toLocaleUpperCase() : 'FILE'
}

export function AttachmentsSection({ boardId, share, attachments, canWrite, isDraft, busy, error, onPick, onPreview, onDownload, onRemove }) {
  const [expanded, setExpanded] = useState(false)
  if (!attachments.length && !canWrite) return null
  const visible = expanded ? attachments : attachments.slice(0, ATTACHMENT_PREVIEW_ITEMS)
  const hidden = attachments.length - ATTACHMENT_PREVIEW_ITEMS
  const full = attachments.length >= MAX_CARD_ATTACHMENTS
  return <CardSection title="Attachments" meta={attachments.length > 0 && <span className="kb-section-count">{attachments.length}</span>}>
    {visible.length > 0 && <div className="kb-attachment-tiles">
      {visible.map(attachment => {
        const image = isPreviewImage(attachment)
        const name = attachment.name || (image ? 'Image' : 'Attachment')
        return <figure className="kb-attachment-tile" key={attachment.id}>
          <button type="button" className="kb-attachment-open" aria-label={image ? `Preview ${name}` : `Download ${name}`} title={name}
            onClick={() => (image ? onPreview(attachment) : onDownload(attachment))}>
            {image
              ? <AttachmentImage boardId={boardId} share={share} attachment={attachment} className="kb-attachment-thumb" alt="" />
              : <span className="kb-attachment-thumb kb-attachment-file" aria-hidden="true">{fileBadge(attachment)}</span>}
            <figcaption>{name}</figcaption>
          </button>
          {canWrite && <button type="button" className="kb-iconbtn kb-attachment-remove" aria-label={`Remove ${name}`} onClick={() => onRemove(attachment)}><Trash /></button>}
        </figure>
      })}
    </div>}
    <div className="kb-section-actions">
      {hidden > 0 && <ShowMore expanded={expanded} onToggle={() => setExpanded(value => !value)} more={`Show all ${attachments.length} attachments`} less="Show fewer" />}
      {canWrite && <button type="button" className="kb-quiet-action" disabled={isDraft || busy || full} onClick={onPick}
        title={isDraft ? 'Add a title to attach files' : full ? `Limit of ${MAX_CARD_ATTACHMENTS} reached` : 'Images or files. You can also drop or paste them onto the card.'}>
        <Paperclip aria-hidden="true" />{busy ? 'Adding files…' : 'Add attachment'}
      </button>}
    </div>
    {error && <p className="kb-attachment-error" role="alert">{error}</p>}
  </CardSection>
}

// ---- activity ----

export function formatActivityTime(iso, now = new Date()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`
  const day = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date)
  return `${day}, ${time}`
}

const lowerFirst = text => text ? text.charAt(0).toLocaleLowerCase() + text.slice(1) : text

// One timeline: the card's activity (kept beside the board) plus its
// assignment history (kept on the card) and assignment changes this device
// noticed from apps that record no history. Newest first.
export function cardTimeline({ card, activity, assignmentTimeline, actorName }) {
  const changes = (activity || []).map(entry => {
    const actor = actorName(entry)
    return { key: `a-${entry.id}`, at: entry.at, actor, text: describeActivity(entry), kind: 'change' }
  })
  const assignments = (assignmentTimeline || []).map((event, index) => ({
    key: `${event.observed ? 'seen' : 'assign'}-${event.id}`,
    at: event.at,
    event,
    first: index === 0,
    kind: event.observed ? 'observed' : 'assignment',
  }))
  return [...changes, ...assignments].sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
}

export function CardActivity({ card, timeline, status, canWrite, nameFor, onRestore }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [card.id])
  const latest = timeline[0]
  const loading = status === 'loading'
  const restoreEvent = timeline.find(item => item.event && !item.event.observed)?.event
  const restore = canWrite && restoreEvent ? restorableAssignment(restoreEvent, card) : null
  const summary = latest
    ? `Last change ${lowerFirst(formatActivityTime(latest.at))}${latest.actor ? ` by ${latest.actor}` : ''}`
    : loading ? '' : 'No changes yet'
  return <section className="kb-section kb-card-activity" aria-label="Activity">
    <button type="button" className="kb-activity-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <h3>Activity</h3>
      {timeline.length > 0 && <span className="kb-section-count">{timeline.length}</span>}
      {loading && <DelayedSpinner label="Loading activity" />}
      <span className="kb-activity-summary">{open ? '' : summary}</span>
      <ChevronDown aria-hidden="true" className="kb-activity-chevron" />
    </button>
    {open && <>
      {status === 'unsupported' && <p className="kb-activity-note">Full activity appears once this board’s host updates Kanban. Assignment changes are shown below.</p>}
      {status === 'error' && <p className="kb-activity-note">Activity couldn’t be loaded right now.</p>}
      {timeline.length > 0 && <ol className="kb-activity-list" tabIndex={0} aria-label="Card activity, newest first">
        {timeline.map(item => <li key={item.key} className={`kb-activity-item is-${item.kind}`}>
          <span className="kb-activity-dot" aria-hidden="true" />
          <div className="kb-activity-copy">
            {item.event
              ? <span>{describeAssignmentEvent(item.event, nameFor)}</span>
              : <span><strong>{item.actor}</strong> {item.text}</span>}
            <small>
              <time dateTime={item.at}>{formatActivityTime(item.at)}</time>
              {item.kind === 'observed' && <> · changed outside Kanban</>}
            </small>
          </div>
          {item.event && item.event === restoreEvent && restore && (
            <button type="button" className="kb-btn kb-btn-quiet kb-activity-restore" onClick={() => onRestore(restore)}>
              {nameFor(restore) === 'you' ? 'Put me back' : `Restore ${nameFor(restore)}`}
            </button>
          )}
        </li>)}
      </ol>}
    </>}
  </section>
}
