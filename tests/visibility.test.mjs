import test from 'node:test'
import assert from 'node:assert/strict'
import { appVisible, onAppVisibilityChange } from '../visibility.js'

function fakeDocument(hidden = false) {
  const listeners = new Set()
  return {
    hidden,
    addEventListener(type, cb) { if (type === 'visibilitychange') listeners.add(cb) },
    removeEventListener(type, cb) { if (type === 'visibilitychange') listeners.delete(cb) },
    flip(next) { this.hidden = next; for (const cb of listeners) cb() },
    listeners,
  }
}

function fakeRuntime(visible = true) {
  const listeners = new Set()
  return {
    runtimeFeatures: { frameVisibility: true },
    visible,
    onVisibilityChange(cb) {
      listeners.add(cb)
      cb(this.visible)
      return () => listeners.delete(cb)
    },
    set(next) { this.visible = next; for (const cb of listeners) cb(next) },
  }
}

test('polling pauses on the shell frame signal, not only on a hidden tab', () => {
  globalThis.document = fakeDocument(false)
  const runtime = fakeRuntime(true)
  globalThis.window = { mobius: runtime }
  const seen = []
  const stop = onAppVisibilityChange(visible => seen.push(visible))
  assert.equal(appVisible(), true)
  runtime.set(false)
  assert.equal(appVisible(), false, 'a hidden frame stops polling while the tab stays visible')
  runtime.set(false)
  runtime.set(true)
  stop()
  runtime.set(false)
  assert.deepEqual(seen, [false, true], 'changes only: no immediate call and no repeats')
})

test('an older Möbius runtime falls back to document visibility', () => {
  const doc = fakeDocument(false)
  globalThis.document = doc
  globalThis.window = { mobius: { runtimeFeatures: {} } }
  const seen = []
  const stop = onAppVisibilityChange(visible => seen.push(visible))
  doc.flip(true)
  assert.equal(appVisible(), false)
  doc.flip(false)
  stop()
  assert.equal(doc.listeners.size, 0)
  assert.deepEqual(seen, [false, true])
})
