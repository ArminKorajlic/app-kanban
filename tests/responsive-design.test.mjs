import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CSS } from '../theme.js'
const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
test('long lists scroll instead of compressing card content', () => {
  assert.match(CSS, /\.kb-board \{[^}]*min-height: 0/s)
  assert.match(CSS, /\.kb-card \{[^}]*flex-shrink: 0/s)
  assert.match(CSS, /\.kb-cards \{[^}]*overflow-y: auto/s)
})
test('horizontal board movement stays free instead of snapping to lists', () => {
  assert.doesNotMatch(CSS, /scroll-snap-(?:type|align)/)
})
test('mobile list navigation changes the viewport, not the board data', () => {
  const nav = board.slice(board.indexOf('<nav className="kb-list-nav"'), board.indexOf('</nav>') + 6)
  assert.match(nav, /scrollIntoView/)
  assert.doesNotMatch(nav, /reorderColumn|moveCard|renameColumn/)
})
test('on a phone the tab of the list in view is its header, and the list menu sits beside the tabs, not in them', () => {
  const nav = board.slice(board.indexOf('<nav className="kb-list-nav"'), board.indexOf('</nav>') + 6)
  assert.match(nav, /aria-current=\{column\.id === activeColumn\?\.id \? 'true' : undefined\}/)
  assert.doesNotMatch(nav, /listMenu\(/, 'tapping a tab only navigates; list actions stay in the menu beside the tabs')
  assert.match(board, /<\/nav>\s*\{access\.canWrite && activeColumn && <div className="kb-list-bar-menu">\{listMenu\(activeColumn, activeColumnIndex\)\}<\/div>\}/)
  assert.match(CSS, /\.kb-col:not\(\.is-renaming\) > \.kb-col-head \{ display: none; \}/, 'the repeated list header is hidden except while renaming')
  assert.match(board, /onClick=\{\(\) => startRenameList\(col\.id\)\}>Rename list</)
  assert.equal(board.match(/<MenuButton key=\{col\.id\} label=\{`List options for/g).length, 1, 'one list menu definition')
})
