import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadMemberAvatar } from '../sync.js'

test('own member photo uses authenticated account avatar; peer uses joined host public profile', async () => {
  const reads = []
  const fetcher = async (url, options) => {
    reads.push([url, options])
    return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
  }
  const signal = new AbortController().signal
  const avatar = await loadMemberAvatar('me.example', 'me.example', 'app-only', fetcher, signal)

  assert.equal(avatar, 'data:image/png;base64,AQID')
  assert.equal(reads[0][0], '/api/identity/avatar')
  assert.equal(reads[0][1].headers.Authorization, 'Bearer app-only')
  assert.equal(reads[0][1].signal, signal)

  await loadMemberAvatar('peer.example', 'me.example', 'app-only', fetcher)
  assert.equal(
    reads[1][0],
    '/api/proxy?url=https%3A%2F%2Fpeer.example%2Fapi%2Fapp-services%2Fsocial%2Favatar',
  )
})

test('unpublished, offline, malformed hosts and non-image responses fall back without exposing network content', async () => {
  const unavailableResponses = [
    async () => new Response('', { status: 404 }),
    async () => { throw Error('offline') },
    async () => new Response('<script/>', { headers: { 'Content-Type': 'text/html' } }),
    async () => new Response(new Blob(['bad'], { type: 'image/svg+xml' })),
  ]
  for (const fetcher of unavailableResponses) {
    const avatar = await loadMemberAvatar('peer.example', 'me.example', 'app-only', fetcher)
    assert.equal(avatar, '')
  }

  let called = false
  const fetcher = async () => { called = true }
  const avatar = await loadMemberAvatar('peer.example/secret', 'me.example', 'app-only', fetcher)
  assert.equal(avatar, '')
  assert.equal(called, false)
})

test('oversized avatar streams are cancelled before reading the remaining response', async () => {
  let reads = 0
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      reads++
      controller.enqueue(new Uint8Array(1024 * 1024))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const fetcher = async () => new Response(stream, { headers: { 'Content-Type': 'image/png' } })
  const avatar = await loadMemberAvatar('peer.example', 'me.example', 'app-only', fetcher)

  assert.equal(avatar, '')
  assert.equal(reads, 3)
  assert.equal(cancelled, true)
})

test('declared oversized avatars are cancelled without reading the body', async () => {
  let reads = 0
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      reads++
      controller.enqueue(new Uint8Array([1]))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const fetcher = async () => new Response(stream, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(2 * 1024 * 1024 + 1),
    },
  })
  const avatar = await loadMemberAvatar('peer.example', 'me.example', 'app-only', fetcher)

  assert.equal(avatar, '')
  assert.equal(reads, 0)
  assert.equal(cancelled, true)
})

test('empty and aborted avatar reads keep initials and release the stream', async () => {
  const emptyResponse = async () => new Response(new Blob([], { type: 'image/png' }))
  assert.equal(await loadMemberAvatar('peer.example', 'me.example', 'app-only', emptyResponse), '')

  const signal = new AbortController().signal
  const stream = new ReadableStream({
    pull(controller) {
      controller.error(new DOMException('Aborted', 'AbortError'))
    },
  })
  const abortedResponse = async () => new Response(stream, {
    headers: { 'Content-Type': 'image/png' },
  })
  const avatar = await loadMemberAvatar('peer.example', 'me.example', 'app-only', abortedResponse, signal)

  assert.equal(avatar, '')
  assert.equal(stream.locked, false)
})
