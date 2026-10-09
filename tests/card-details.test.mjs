import test from 'node:test'
import assert from 'node:assert/strict'
import { configureSync, pushSharedOp } from '../sync.js'
import { createBoardRepository } from '../boardRepository.js'
import { applyBoardOp } from '../operations.js'
import {
  MAX_ACTIVITY_PER_CARD, activityPath, describeActivity, describeCardChange, mergeActivity,
} from '../activity.js'

configureSync('fixture', 1)

const card = (extra = {}) => ({ id: 'c1', title: 'Fix login', notes: '', label: 'none', due: '', checklist: [], attachments: [], ...extra })
const snap = (c, column = 'To do') => ({ card: c, column })

test('a card edit is described field by field, from the reader’s point of view', () => {
  const before = card({ checklist: [{ id: 'i1', text: 'Write test', done: false }] })
  const after = card({ title: 'Fix sign-in', notes: 'More detail', label: 'blue', due: '2026-10-14',
    checklist: [{ id: 'i1', text: 'Write test', done: true }, { id: 'i2', text: 'Ship', done: false }],
    attachments: [{ id: 'a1', name: 'trace.png' }], pullRequestUrls: ['https://github.com/o/r/pull/7'] })
  const drafts = describeCardChange({ op: { type: 'update-card' }, before: snap(before), after: snap(after, 'Done') })
  const sentences = drafts.map(describeActivity)
  assert.deepEqual(sentences, [
    'renamed the card from “Fix login” to “Fix sign-in”',
    'edited the description',
    'moved this card from To do to Done',
    'set the label to Blue',
    sentences[4],
    'checked “Write test”',
    'added “Ship” to the checklist',
    'attached “trace.png”',
    'linked pull request #7',
  ])
  assert.match(sentences[4], /^set the due date to /)
})

test('replaying an operation that already landed records no activity', () => {
  const doc = { columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card({ checklist: [{ id: 'i1', text: 'A', done: true }] }) } }
  const before = structuredClone(doc.cards.c1)
  applyBoardOp(doc, { type: 'set-checklist-item', cardId: 'c1', itemId: 'i1', done: true })
  assert.deepEqual(describeCardChange({ op: {}, before: snap(before), after: snap(doc.cards.c1) }), [])
})

test('completing a card is one “marked done” entry, not a list of field changes', () => {
  const drafts = describeCardChange({ op: { type: 'complete-card', summary: 'Shipped' }, before: snap(card()), after: snap(card({ notes: '✅ Done — Shipped' }), 'Done') })
  assert.deepEqual(drafts, [{ type: 'completed', text: 'Shipped' }])
})

test('card activity keeps the newest entries once, oldest first', () => {
  const entry = (id, minute) => ({ id, at: `2026-10-09T08:${String(minute).padStart(2, '0')}:00Z`, type: 'notes' })
  const many = Array.from({ length: MAX_ACTIVITY_PER_CARD + 5 }, (_, i) => entry(`e${i}`, i % 60))
  const merged = mergeActivity(many.slice(0, 50), [...many.slice(40), entry('e0', 0)])
  assert.equal(merged.length, MAX_ACTIVITY_PER_CARD)
  assert.equal(new Set(merged.map(item => item.id)).size, MAX_ACTIVITY_PER_CARD)
  assert.ok(merged.every((item, i) => i === 0 || Date.parse(merged[i - 1].at) <= Date.parse(item.at)))
})

function privateFixture() {
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card() } }
  const files = {}
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: {} }, version: 'map' }
      if (path.startsWith('activity/')) return { value: files[path] ?? null, version: files[path] ? 'v' : null }
      return { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite(path, value) { if (path.startsWith('activity/')) files[path] = structuredClone(value); else doc = structuredClone(value) },
    async set() {},
    async list() { return [{ name: 'b.json' }] },
  }
  return { storage, files, doc: () => doc }
}

test('a private board keeps each card’s activity beside the board, never inside it', async () => {
  const f = privateFixture()
  const repo = createBoardRepository({ storage: f.storage, via: 'agent' })
  const saved = await repo.mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(saved.activity.status, 'saved')
  assert.equal(f.doc().cards.c1.activity, undefined)
  const [entry] = f.files[activityPath('b', 'c1')].entries
  assert.equal(entry.type, 'renamed')
  assert.equal(entry.via, 'agent')
  assert.equal((await repo.readCard('b', 'c1')).activity[0].to, 'Renamed')
})

function sharedFixture({ older = false } = {}) {
  let version = 1
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card({ notes: 'Preview…', notesLength: 900 }) } }
  let notes = 'Full description'.repeat(60)
  let notesVersion = 3
  const activity = []
  const calls = []
  const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'obj', role: 'editor' }
  const storage = {
    async getWithVersion(path) {
      return path === 'shared.json' ? { value: { byBoard: { b: entry } }, version: 'map' } : { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite() { throw new Error('A shared board must not write its cache as authority.') },
    async set() {},
    async list() { return [{ name: 'b.json' }] },
  }
  const request = async (url, options = {}) => {
    const method = options.method || 'GET'
    calls.push(`${method} ${url.replace('/api/apps/1/service/boards/peer.example/obj', '')}`)
    if (url.includes('/cards/') && older) {
      return Response.json({ protocol: 'kanban/1', code: 'invalid-operation', detail: 'Unsupported board operation.' }, { status: 400 })
    }
    if (url.endsWith('/cards/c1/notes')) {
      const body = JSON.parse(options.body)
      if (body.expected_version !== notesVersion) return Response.json({ status: 'conflict', notes, notes_version: notesVersion })
      notes = body.notes; notesVersion++; version++
      doc.cards.c1 = { ...doc.cards.c1, notes: notes.slice(0, 10) + '…', notesLength: notes.length }
      return Response.json({ status: 'ok', notes_version: notesVersion, version, card: doc.cards.c1 })
    }
    if (url.endsWith('/cards/c1/activity')) {
      activity.push(...JSON.parse(options.body).entries)
      return Response.json({ status: 'ok', activity })
    }
    if (url.endsWith('/cards/c1')) {
      return Response.json({ status: 'ok', notes, notes_version: notesVersion, external: Number.isInteger(doc.cards.c1?.notesLength), activity })
    }
    if (method === 'PUT') {
      const body = JSON.parse(options.body)
      if (body.expected_version !== version) return Response.json({ status: 'conflict', doc, version })
      doc = body.doc; version++
      return Response.json({ status: 'ok', version })
    }
    return Response.json({ doc, version })
  }
  return { storage, request, calls, activity, notes: () => notes, doc: () => doc }
}

test('opening a shared card reads its full description and activity in one request', async () => {
  const f = sharedFixture()
  const details = await createBoardRepository(f).readCard('b', 'c1')
  assert.equal(details.notes, f.notes())
  assert.equal(details.notesVersion, 3)
  assert.deepEqual(f.calls, ['GET /cards/c1'])
})

test('a shared description save never resends the board and records one activity line', async () => {
  const f = sharedFixture()
  const saved = await createBoardRepository(f).saveNotes('b', 'c1', 'New text', 3)
  assert.equal(saved.status, 'saved')
  assert.equal(f.notes(), 'New text')
  assert.ok(!f.calls.some(call => call.startsWith('PUT /state')))
  assert.deepEqual(f.activity.map(item => item.type), ['notes'])
})

test('a description changed by someone else comes back as a conflict, not an overwrite', async () => {
  const f = sharedFixture()
  const before = f.notes()
  const result = await createBoardRepository(f).saveNotes('b', 'c1', 'Mine', 2)
  assert.deepEqual(result, { status: 'conflict', notes: before, notesVersion: 3 })
  assert.equal(f.notes(), before)
})

test('an agent completing a shared card appends to the full description, not the preview', async () => {
  const f = sharedFixture()
  f.doc().columns.push({ id: 'done', name: 'Done', cardIds: [] })
  await createBoardRepository(f).mutate('b', { type: 'complete-card', cardId: 'c1', expectedTitle: 'Fix login', summary: 'Shipped', link: '' })
  assert.match(f.notes(), /^Full description[\s\S]*\n\n✅ Done — Shipped$/u)
  assert.deepEqual(f.doc().columns.find(column => column.id === 'done').cardIds, ['c1'])
  assert.deepEqual(f.activity.map(item => item.type), ['completed'])
})

test('a host on an older Kanban still saves descriptions through the board', async () => {
  const f = sharedFixture({ older: true })
  f.doc().cards.c1 = card({ notes: 'Old inline note' })
  const repo = createBoardRepository(f)
  assert.equal((await repo.readCard('b', 'c1')).status, 'unsupported')
  const saved = await repo.saveNotes('b', 'c1', 'Edited inline', 0)
  assert.equal(saved.status, 'saved')
  assert.equal(f.doc().cards.c1.notes, 'Edited inline')
  assert.equal(saved.activity.status, 'unsupported')
})

test('an edit made from a preview cannot replace a moved-out description', async () => {
  const f = sharedFixture()
  const before = f.notes()
  await assert.rejects(
    createBoardRepository(f).mutate('b', { type: 'update-card', cardId: 'c1', patch: { notes: 'Preview… plus a line' } }),
    error => error.code === 'notes-version-required' && error.retryable === false && error.discardable === true,
  )
  assert.equal(f.notes(), before)
  assert.ok(!f.calls.some(call => call.startsWith('PUT /cards/c1/notes')))
})

test('a queued description edit that names an older version goes to recovery, not over newer text', async () => {
  const f = sharedFixture()
  const before = f.notes()
  await assert.rejects(
    createBoardRepository(f).mutate('b', { type: 'update-card', cardId: 'c1', patch: { notes: 'Mine' }, notesVersion: 2 }),
    error => error.code === 'notes-conflict' && error.discardable === true,
  )
  assert.equal(f.notes(), before)
})

test('a description edit that names the current version replaces the full text', async () => {
  const f = sharedFixture()
  await createBoardRepository(f).mutate('b', { type: 'update-card', cardId: 'c1', patch: { notes: 'Rewritten' }, notesVersion: 3 })
  assert.equal(f.notes(), 'Rewritten')
})

test('completing a card whose title changed leaves its description untouched', async () => {
  const f = sharedFixture()
  f.doc().columns.push({ id: 'done', name: 'Done', cardIds: [] })
  const before = f.notes()
  await assert.rejects(
    createBoardRepository(f).mutate('b', { type: 'complete-card', cardId: 'c1', expectedTitle: 'Old title', summary: 'Shipped', link: '' }),
    error => error.code === 'card-title-changed',
  )
  assert.equal(f.notes(), before)
  assert.ok(!f.calls.some(call => call.startsWith('PUT /cards/c1/notes')))
})

test('a writer adopts the host copy when the host moves a long description out', async () => {
  const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'obj', role: 'editor' }
  const long = 'x'.repeat(500)
  const settled = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }],
    cards: { c1: card({ notes: `${'x'.repeat(399)}…`, notesLength: 500 }) } }
  const request = async (url, options = {}) => (options.method === 'PUT'
    ? Response.json({ status: 'ok', version: 2, doc: settled })
    : Response.json({ doc: { ...settled, cards: { c1: card({ notes: '' }) } }, version: 1 }))
  const landed = await pushSharedOp(entry, doc => { doc.cards.c1.notes = long; return doc }, null, request)
  assert.equal(landed.version, 2)
  assert.equal(landed.doc.cards.c1.notesLength, 500)
  assert.equal(landed.doc.cards.c1.notes.length, 400)
})
