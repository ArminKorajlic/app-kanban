// Run only AFTER loading card-editing.fixture.jsx in a disposable app frame.
// This refuses a live board and never installs or injects a fixture itself.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const appId = process.argv[2]
assert.match(appId || '', /^\d+$/, 'Usage: node tests/visual/card-editing.check.mjs <app-id>')
const appPath = `/api/apps/${appId}/`
const cdpUrl = execFileSync('agent-browser', ['get', 'cdp-url'], { encoding: 'utf8' }).trim()
const socket = new WebSocket(cdpUrl)
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))

let sequence = 0
const pending = new Map()
const contexts = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) request.reject(Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  } else if (message.method === 'Runtime.executionContextCreated') {
    contexts.push(message.params.context)
  }
})

function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

const { targetInfos } = await call('Target.getTargets')
const target = targetInfos.find(info => info.type === 'iframe' && info.url.includes(appPath))
assert.ok(target, 'Kanban app frame not found')
const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })
await call('Runtime.enable', {}, sessionId)
const tree = await call('Page.getFrameTree', {}, sessionId)
const frames = []
function collectFrames(node) {
  frames.push(node.frame)
  for (const child of node.childFrames || []) collectFrames(child)
}
collectFrames(tree.frameTree)
const frame = frames.find(item => item.url.includes(appPath)) || frames.find(item => item.parentId) || frames[0]
const context = contexts.find(item => item.auxData?.frameId === frame.id && item.auxData?.isDefault)

async function evaluate(expression) {
  const response = await call('Runtime.evaluate', {
    expression,
    contextId: context.id,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId)
  if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails))
  return response.result.value
}

let pageSession
for (const page of targetInfos.filter(info => info.type === 'page')) {
  const attached = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  const parentTree = await call('Page.getFrameTree', {}, attached.sessionId)
  if (parentTree.frameTree.frame.id === frame.parentId) {
    pageSession = attached.sessionId
    await call('Target.activateTarget', { targetId: page.targetId })
    break
  }
  await call('Target.detachFromTarget', { sessionId: attached.sessionId })
}
assert.ok(pageSession, 'Owning Kanban page not found')

// Input belongs to the owning page; DOM reads and fixture state belong to its iframe.
const insertText = text => call('Input.insertText', { text }, pageSession)
async function pressKey(key, code, windowsVirtualKeyCode, modifiers) {
  for (const type of ['keyDown', 'keyUp']) {
    await call('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode,
      ...(modifiers ? { modifiers } : {}),
    }, pageSession)
  }
}

try {
  assert.equal(
    await evaluate('typeof window.__cardEditing?.remote'),
    'function',
    'Refusing to test/edit a live board: load the isolated card fixture first',
  )
  await evaluate(`
    window.__cardEditing.cancelled = 0
    window.__cardEditing.commits = []
    window.__cardEditing.links = []
    window.__cardEditing.remote({
      id: 'fixture-reset',
      title: 'Polish Kanban controls and editing',
      notes: 'First line of card notes.\\nSecond line with https://example.com/docs.',
      label: 'blue',
      assignee: '@memberone',
      assigneeHost: 'me.example',
    })
  `)
  await new Promise(resolve => setTimeout(resolve, 40))
  await checkControls({ evaluate, call, pageSession })
  await checkChecklist({ evaluate })
  await checkEditing({ evaluate })
} finally {
  socket.close()
}

async function checkControls({ evaluate, call, pageSession }) {
  const pause = () => new Promise(resolve => setTimeout(resolve, 35))
  const parent = await call('Runtime.evaluate', {
    expression: `(() => {
      const bounds = document.querySelector('iframe[title="Kanban"]').getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width }
    })()`,
    returnByValue: true,
  }, pageSession)
  const origin = parent.result.value
  const scale = origin.width / (await evaluate('innerWidth'))

  async function clickAt(point) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await call('Input.dispatchMouseEvent', {
        type,
        x: origin.x + point.x * scale,
        y: origin.y + point.y * scale,
        button: 'left',
        clickCount: 1,
      }, pageSession)
    }
    await pause()
  }

  async function click(selector) {
    const point = await evaluate(`(() => {
      const bounds = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    })()`)
    await clickAt(point)
  }

  async function clickTextAt(label, offset) {
    const point = await evaluate(`(() => {
      const textNode = document.querySelector('[aria-label="${label}"]').firstChild
      const range = document.createRange()
      range.setStart(textNode, ${offset})
      range.setEnd(textNode, ${offset + 1})
      const bounds = range.getBoundingClientRect()
      return { x: bounds.x + 1, y: bounds.y + bounds.height / 2 }
    })()`)
    await clickAt(point)
    return evaluate(`({
      text: window.getSelection().anchorNode.textContent,
      offset: window.getSelection().anchorOffset,
      active: document.activeElement.getAttribute('aria-label'),
    })`)
  }

  const state = () => evaluate('window.__cardEditing')

  let selection = await clickTextAt('Card title', 7)
  assert.equal(selection.active, 'Card title')
  assert.ok(Math.abs(selection.offset - 7) <= 1, JSON.stringify(selection))
  const before = await evaluate(`document.querySelector('[aria-label="Card title"]').innerText`)
  await insertText('X')
  await pause()
  assert.equal(
    await evaluate(`document.querySelector('[aria-label="Card title"]').innerText`),
    before.slice(0, selection.offset) + 'X' + before.slice(selection.offset),
  )
  await click('.kb-card-toolbar-done')
  assert.ok((await state()).current.title.includes('X'))
  console.log('PASS title native click offset + insert + blur save')

  selection = await clickTextAt('Card notes', 6)
  assert.ok(Math.abs(selection.offset - 6) <= 1)
  await insertText('ZZ')
  await pause()
  await pressKey('Escape', 'Escape', 27)
  await pause()
  await click('.kb-card-toolbar-done')
  assert.equal((await state()).current.notes, 'First line of card notes.\nSecond line with https://example.com/docs.')
  console.log('PASS notes click offset + Escape cancellation does not save')

  await clickTextAt('Card notes', 4)
  const draft = await evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`)
  await evaluate(`window.__cardEditing.remote({notes:'Remote text received'})`)
  await pause()
  assert.equal(await evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`), draft)
  await click('.kb-card-toolbar-done')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`), 'Remote text received')
  console.log('PASS focused caret/draft survives remote updates; untouched blur adopts latest')

  await evaluate(`window.__cardEditing.remote({notes:'First line of card notes.\\nSecond line with https://example.com/docs.'})`)
  await pause()
  await click('[aria-label="Card notes"] a')
  assert.equal((await state()).links[0][0], 'https://example.com/docs')
  console.log('PASS notes links still open')

  await click('.kb-label-trigger')
  await click('[aria-label="No label"]')
  assert.equal((await state()).current.label, 'none')
  const empty = await evaluate(`({
    slash: getComputedStyle(document.querySelector('.kb-label-trigger'), '::after').content,
    bg: getComputedStyle(document.querySelector('.kb-label-trigger')).backgroundColor,
  })`)
  assert.ok(!empty.slash || empty.slash === 'none')
  await click('.kb-label-trigger')
  await click('[aria-label="Label blue"]')
  await click('.kb-assignee-trigger')
  await click('[aria-label="Assign card"] .kb-assignee-option[aria-pressed="true"]')
  assert.equal((await state()).current.assignee, '@memberone')
  console.log('PASS label/assignee interactions and slash-free empty state')

  const rendered = await evaluate(`({
    photos: [...document.querySelectorAll('.kb-avatar-photo')]
      .filter(image => image.complete && image.naturalWidth > 0).length,
    fill: document.querySelector('.kb-assignee-trigger').clientWidth ===
      document.querySelector('.kb-assignee-trigger .kb-assignee-avatar').clientWidth,
    overflow: document.documentElement.scrollWidth > innerWidth,
  })`)
  assert.ok(rendered.photos > 0)
  assert.equal(rendered.fill, true)
  assert.equal(rendered.overflow, false)
  console.log('PASS loaded person photos, full-circle assignee, no horizontal overflow')

  await evaluate(`window.__cardEditing.remote({assigneeHost:''})`)
  await pause()
  assert.equal(await evaluate(`document.querySelector('.kb-assignee-trigger .kb-avatar-photo')`), null)
  console.log('PASS same-name hostless assignment uses initials, not a member photo')
  await evaluate(`window.__cardEditing.remote({assigneeHost:'me.example'})`)
  await pause()
  assert.ok(await evaluate(`!!document.querySelector('.kb-assignee-trigger .kb-avatar-photo')`))
}

async function checkEditing({ evaluate }) {
  const wait = () => new Promise(resolve => setTimeout(resolve, 40))
  const state = () => evaluate('window.__cardEditing')
  const focusDone = () => evaluate(`document.querySelector('.kb-card-toolbar-done').focus()`)
  const notesText = () => evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`)
  const selectNotes = () => evaluate(`
    document.querySelector('[aria-label="Card notes"]').focus()
    window.getSelection().selectAllChildren(document.activeElement)
  `)

  await selectNotes()
  await insertText('A multiline note\nSecond line\nThird line')
  await wait()
  assert.equal(await notesText(), 'A multiline note\nSecond line\nThird line')
  await focusDone()
  await wait()
  assert.equal((await state()).current.notes, 'A multiline note\nSecond line\nThird line')
  console.log('PASS multiline notes grow naturally and save line breaks')

  await evaluate(`window.__cardEditing.rejectSaves = true`)
  await selectNotes()
  await insertText('Unsaved note retained for retry')
  await wait()
  await focusDone()
  await wait()
  assert.equal((await state()).current.notes, 'A multiline note\nSecond line\nThird line')
  assert.equal(await notesText(), 'Unsaved note retained for retry')
  await evaluate(`window.__cardEditing.remote({notes:'Incoming note after rejection'})`)
  await wait()
  assert.equal(await notesText(), 'Unsaved note retained for retry')
  await evaluate(`window.__cardEditing.rejectSaves = false; document.querySelector('[aria-label="Card notes"]').focus()`)
  await focusDone()
  await wait()
  assert.equal((await state()).current.notes, 'Unsaved note retained for retry')
  console.log('PASS rejected saves retain text through refresh and can be retried')

  await evaluate(`window.__cardEditing.remote({notes:'A multiline note\\nSecond line\\nThird line'})`)
  await wait()
  await selectNotes()
  await insertText('Temporary replacement')
  await wait()
  await pressKey('z', 'KeyZ', 90, 2)
  await wait()
  assert.equal(await notesText(), 'A multiline note\nSecond line\nThird line')
  console.log('PASS native Undo restores notes while editing')

  await evaluate(`document.querySelector('.kb-card-toolbar-done').focus();document.querySelector('[data-fixture-readonly]').click()`)
  await wait()
  assert.equal(await evaluate(`document.querySelectorAll('[contenteditable]').length`), 0)
  console.log('PASS read-only card has no editable surfaces')

  await evaluate(`document.querySelector('[data-fixture-readonly]').click();document.querySelector('[data-fixture-draft]').click()`)
  await wait()
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Card title')
  const count = (await state()).commits.length
  await focusDone()
  await wait()
  assert.equal((await state()).commits.length, count)
  await evaluate(`document.querySelector('[aria-label="Card title"]').focus()`)
  await pressKey('Escape', 'Escape', 27)
  await wait()
  assert.equal((await state()).cancelled, 1)
  console.log('PASS blank draft autofocus, no empty blur save, Escape discard')

  await evaluate(`window.__cardEditing.remote({
    id: 'final',
    title: 'Polish Kanban controls and editing',
    notes: 'First line of card notes.\\nSecond line with https://example.com/docs.',
    label: 'blue',
    assignee: '@memberone',
    assigneeHost: 'me.example',
  })`)
  await wait()
  await focusDone()
}

async function checkChecklist({ evaluate }) {
  const wait = () => new Promise(resolve => setTimeout(resolve, 40))
  const state = () => evaluate('window.__cardEditing')
  async function openItem(index = 0) {
    await evaluate(`document.querySelectorAll('.kb-check-text')[${index}].click()`)
    await wait()
  }
  async function replaceText(text) {
    await evaluate(`document.querySelector('.kb-check-edit').select()`)
    await insertText(text)
    await wait()
  }

  await openItem()
  const editor = await evaluate(`(() => {
    const input = document.querySelector('.kb-check-edit')
    const style = getComputedStyle(input)
    const bounds = input.getBoundingClientRect()
    const rowBounds = input.parentElement.getBoundingClientRect()
    return {
      value: input.value,
      focused: document.activeElement === input,
      usable: bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      rowWidth: rowBounds.width,
      checkboxWidth: document.querySelector('.kb-check-toggle input[type="checkbox"]').getBoundingClientRect().width,
    }
  })()`)
  assert.equal(editor.value, 'Review the card controls')
  assert.equal(editor.focused, true)
  assert.ok(editor.usable > editor.rowWidth / 2, JSON.stringify(editor))
  assert.equal(Math.round(editor.checkboxWidth), 20)

  await replaceText('  Review updated controls  ')
  await pressKey('Enter', 'Enter', 13)
  await wait()
  assert.equal((await state()).checklist[0].text, 'Review updated controls')
  await openItem()
  assert.equal(await evaluate(`document.querySelector('.kb-check-edit').value`), 'Review updated controls')
  await replaceText('Discard this edit')
  await pressKey('Escape', 'Escape', 27)
  await wait()
  assert.equal((await state()).checklist[0].text, 'Review updated controls')

  await openItem(1)
  assert.equal(await evaluate(`document.querySelector('.kb-check-edit').value`), 'Check editing on a phone')
  await replaceText('Check editing at both widths')
  await evaluate(`document.querySelector('.kb-card-toolbar-done').focus()`)
  await wait()
  assert.equal((await state()).checklist[1].text, 'Check editing at both widths')
  assert.equal((await state()).checklist[1].done, true)

  await openItem()
  const count = (await state()).commits.length
  await replaceText('   ')
  await pressKey('Enter', 'Enter', 13)
  await wait()
  assert.equal((await state()).commits.length, count)
  assert.equal((await state()).checklist[0].text, 'Review updated controls')
  await evaluate(`document.querySelector('[data-fixture-readonly]').click()`)
  await wait()
  await openItem()
  assert.equal(await evaluate(`document.querySelector('.kb-check-edit')`), null)
  await evaluate(`document.querySelector('[data-fixture-readonly]').click()`)
  await wait()
  console.log('PASS checklist prefill/usable width, Enter/blur saves, reopening, Escape, completed item, blank and read-only guards')
}
