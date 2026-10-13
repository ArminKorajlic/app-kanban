// Card history is complete and goes away with what it describes: a shared
// edit and its activity are saved together, assignee changes are recorded,
// failures are visible, and deleting a list or board deletes its history.
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { applyBoardPieces, configureSync } from '../sync.js'
import { createBoardRepository } from '../boardRepository.js'
import { activityPath, cardTimeline, describeActivity, describeCardChange } from '../activity.js'
import { applyBoardOp } from '../operations.js'
import { assignmentHistory, createAssignmentEvent } from '../assignment.js'
import { assignmentLogPath, deleteBoard } from '../storage.js'
import { asOlderHost } from './older-host.mjs'

beforeEach(() => configureSync('fixture', 1))

const card = (id, extra = {}) => ({ id, title: id, notes: '', label: 'none', due: '', checklist: [], attachments: [], assignee: '', assigneeHost: '', ...extra })
const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'obj', role: 'editor' }

// A stand-in for the board's host: piece saves carry their activity, and a
// reply can be lost after the host committed (`loseNextReply`).
function sharedHost({ older = false } = {}) {
  let version = 1
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card('c1') } }
  const activity = {}
  const sent = []
  let loseNextReply = false
  const storage = {
    async getWithVersion(path) {
      return path === 'shared.json' ? { value: { byBoard: { b: entry } }, version: 'map' } : { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite() { throw new Error('A shared board must not write its cache as authority.') },
    async set() {},
  }
  const host = async (url, options = {}) => {
    if (url.endsWith('/changes')) {
      const body = JSON.parse(options.body)
      sent.push(body)
      if (body.expected_version !== version) return Response.json({ status: 'conflict', doc, version })
      doc = applyBoardPieces(doc, body.pieces); version++
      const saved = {}
      for (const [cardId, items] of Object.entries(body.activity || {})) {
        activity[cardId] = [...(activity[cardId] || []), ...items.map(item => ({ ...item, by: { host: 'self.example', name: 'Me' } }))]
        saved[cardId] = activity[cardId]
      }
      if (loseNextReply) { loseNextReply = false; throw new TypeError('network connection lost') }
      return Response.json({ status: 'ok', version, doc, activity: saved })
    }
    if (url.includes('/cards/')) return Response.json({ status: 'ok', notes: '', notes_version: 0, external: false, activity: [] })
    if ((options.method || 'GET') === 'PUT') {
      doc = JSON.parse(options.body).doc; version++
      return Response.json({ status: 'ok', version })
    }
    return Response.json({ doc, version })
  }
  return { storage, request: older ? asOlderHost(host) : host, activity, sent, doc: () => doc, loseReply: () => { loseNextReply = true } }
}

test('a shared edit sends its activity with the save, in one request', async () => {
  const host = sharedHost()
  const saved = await createBoardRepository(host).mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(host.sent.length, 1)
  assert.deepEqual(Object.keys(host.sent[0].activity), ['c1'])
  assert.equal(saved.activity.status, 'saved')
  assert.deepEqual(saved.activity.entries.map(item => item.type), ['renamed'])
})

test('an edit whose reply was lost still has its activity, and replaying it adds none', async () => {
  const host = sharedHost()
  const repo = createBoardRepository(host)
  host.loseReply()
  await assert.rejects(repo.mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } }))
  // The host committed the edit and its activity together before the reply was lost.
  assert.deepEqual(host.activity.c1.map(item => item.type), ['renamed'])
  // The queued edit replays against the landed card: nothing changes, nothing is described twice.
  const replay = await repo.mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(replay.activity.status, 'none')
  assert.equal(host.activity.c1.length, 1)
})

test('a host that cannot save activity is reported, never shown as saved', async () => {
  const host = sharedHost({ older: true })
  const saved = await createBoardRepository(host).mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(host.doc().cards.c1.title, 'Renamed')
  assert.equal(saved.activity.status, 'unsupported')
})

test('a private board reports activity it could not write; the edit stands', async () => {
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card('c1') } }
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: {} }, version: 'map' }
      return path.startsWith('activity/') ? { value: null, version: null } : { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite(path, value) {
      if (path.startsWith('activity/')) throw Object.assign(new Error('storage unavailable'), { code: 'unavailable' })
      doc = structuredClone(value)
    },
  }
  const saved = await createBoardRepository({ storage }).mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(doc.cards.c1.title, 'Renamed')
  assert.equal(saved.activity.status, 'failed')
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /result\?\.status === 'failed'[\s\S]{0,80}setSyncNote\(/u)
  // Replayed queued edits report their activity too, so a failure there is not dropped.
  assert.match(board, /\.mutate\(boardId, op, \{ sharedState: confirmedSharedRef\.current \}\)[\s\S]{0,240}noteActivity\(landed\.activity\)/u)
})

test('an assignee change is recorded, from a plain edit as much as from the picker', async () => {
  const drafts = describeCardChange({ op: { type: 'update-card' },
    before: { card: card('c1'), column: 'To do' }, after: { card: card('c1', { assignee: 'Ana', assigneeHost: 'ana.example' }), column: 'To do' } })
  assert.deepEqual(drafts.map(describeActivity), ['assigned this card to Ana'])
  const host = sharedHost()
  const saved = await createBoardRepository({ ...host, via: 'agent' }).mutate('b',
    { type: 'update-card', cardId: 'c1', patch: { assignee: 'Ana', assigneeHost: 'ana.example' } })
  const [event] = assignmentHistory(host.doc().cards.c1)
  assert.deepEqual([event.from.label, event.to.label], ['', 'Ana'])
  // The activity line names the card's assignment event, so the sheet shows them as one line.
  const [line] = saved.activity.entries
  assert.deepEqual([line.type, line.id], ['assigned', event.id])
})

test('an assignment recorded in activity is one timeline line with the host’s author, and can still be restored', () => {
  const event = createAssignmentEvent({ id: 'ev1', at: '2026-10-13T08:00:00.000Z', by: { label: 'Claimed', host: 'forged.example' },
    from: { label: 'Ben', host: 'ben.example' }, to: { label: 'Ana', host: 'ana.example' } })
  const older = createAssignmentEvent({ id: 'ev0', at: '2026-10-12T08:00:00.000Z', from: { label: '' }, to: { label: 'Ben', host: 'ben.example' } })
  const timeline = cardTimeline({
    card: card('c1', { assignee: 'Ana', assigneeHost: 'ana.example' }),
    activity: [{ id: 'ev1', at: '2026-10-13T08:00:01.000Z', type: 'assigned', from: 'Ben', to: 'Ana', by: { host: 'self.example', name: 'Me' } }],
    assignmentTimeline: [event, older],
    actorName: item => item.by.name,
  })
  assert.deepEqual(timeline.map(item => [item.actor, item.text || 'from the card']), [
    ['Me', 'reassigned this card from Ben to Ana'],
    [undefined, 'from the card'],
  ])
  assert.equal(timeline[0].event, event)
})

test('deleting a list deletes the activity of its cards on a private board', async () => {
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1', 'c2'] }, { id: 'done', name: 'Done', cardIds: ['c3'] }],
    cards: { c1: card('c1'), c2: card('c2'), c3: card('c3') } }
  const files = { [activityPath('b', 'c1')]: { v: 1, entries: [] }, [activityPath('b', 'c2')]: { v: 1, entries: [] }, [activityPath('b', 'c3')]: { v: 1, entries: [] } }
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: {} }, version: 'map' }
      return path.startsWith('activity/') ? { value: files[path] ?? null, version: files[path] ? 'v' : null } : { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite(path, value) { if (path.startsWith('activity/')) files[path] = value; else doc = structuredClone(value) },
    async remove(path) { delete files[path] },
  }
  await createBoardRepository({ storage }).mutate('b', { type: 'delete-column', columnId: 'todo' })
  assert.deepEqual(Object.keys(files), [activityPath('b', 'c3')])
})

test('deleting a board deletes its activity, noticed assignments and personal view choices', async () => {
  const files = {
    'boards/b.json': {}, 'boards/keep.json': {},
    [activityPath('b', 'c1')]: {}, [activityPath('b', 'c2')]: {}, [activityPath('keep', 'c1')]: {},
    [assignmentLogPath('b')]: {}, [assignmentLogPath('keep')]: {},
    'ui.json': { lastBoardId: 'keep', boardViews: { b: 'mine', keep: 'all' }, collapsedLists: { b: ['x'] },
      openedLists: { b: [], keep: ['y'] }, seenCards: { b: {}, keep: {} } },
  }
  const storage = {
    async remove(path) { delete files[path] },
    async list(prefix) { return Object.keys(files).filter(path => path.startsWith(prefix)).map(path => ({ name: path.slice(prefix.length) })) },
    async getWithVersion(path) { return { value: structuredClone(files[path] ?? null), version: files[path] ? 'v' : null } },
    async durableWrite(path, value) { files[path] = structuredClone(value) },
  }
  await deleteBoard('b', storage)
  assert.deepEqual(Object.keys(files).sort(), ['boards/keep.json', activityPath('keep', 'c1'), assignmentLogPath('keep'), 'ui.json'].sort())
  assert.deepEqual(files['ui.json'], { lastBoardId: 'keep', boardViews: { keep: 'all' }, collapsedLists: {},
    openedLists: { keep: ['y'] }, seenCards: { keep: {} } })
})

test('a colour-only label and the card counts are announced to screen readers', async () => {
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const tile = board.slice(board.indexOf('function Card('), board.indexOf('function memberRecords('))
  for (const name of ['kb-card-label', 'kb-card-count']) {
    for (const span of tile.match(new RegExp(`<span className=[^>]*${name}[^>]*>`, 'gu'))) {
      assert.match(span, /role="img"/u, span)
      assert.match(span, /aria-label=/u, span)
    }
  }
})

test('applying an assignment through a plain edit is idempotent on replay', () => {
  const doc = { columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card('c1') } }
  const op = { type: 'update-card', cardId: 'c1', patch: { assignee: 'Ana' }, assignmentEvent: { id: 'e1', at: '2026-10-13T08:00:00.000Z' } }
  applyBoardOp(doc, op)
  applyBoardOp(doc, op)
  assert.equal(assignmentHistory(doc.cards.c1).length, 1)
})
