# Isolated visual fixture

sharing.fixture.jsx replaces bridge operations and fetch with fixture state.
Compile in a disposable copy with ShareSheet exported from ui/Board.jsx. Load
only in an authenticated test frame with all live storage calls blocked before
any fixture runs. Never apply this fixture as a real app or use production data.
Verify Finish sharing, Create invite link and Copy; then close the browser.

recovery.fixture.jsx mounts the Board with a synthetic viewer and rejected edit.
It replaces fetch/storage and intercepts anchor download without sending data.
Compile in a disposable copy. Verify **Download recovery copy** includes the
original operation and that starting the download dismisses only the exported
rejected-edit reminder. Never apply as a real app.

card-editing.fixture.jsx mounts the exported title, notes, and checklist editors
alongside presence, label, assignee, and avatar controls. Export those named
components only in a disposable copy of the app. The fixture uses synthetic
people and card data, blocks network and storage writes, and keeps edits in
fixture state; never install it in a real app or use production data.

The check covers native caret click offsets, plain-text insertion, Undo, multiline
notes, save-on-blur, Escape, links, remote updates, read-only mode, and blank
drafts. It also covers checklist prefill and usable width, Enter and blur saves,
completed items and blank-edit guards, hostless avatar identity, and rejected
save retention and retry. Run it at desktop and narrow phone widths.

Load a fresh isolated fixture in agent-browser before each run, including when
switching viewport sizes: the checks edit checklist and card state in memory. Run
`node tests/visual/card-editing.check.mjs <app-id>`. It connects to the current browser's
CDP session, refuses a live board, accounts for iframe scale, and checks native
click positions and keyboard behavior without touching any saved board.

For this coordinate-driven CDP check, first set a standard-density viewport:
`agent-browser set viewport 1512 911 1` (desktop) or
`agent-browser set viewport 390 844 1` (phone). High-density preview emulation
can route raw mouse coordinates differently. After changing the viewport, take
a fresh app-scoped snapshot to confirm the rendered layout before running the
coordinate check. Real-device keyboard behavior still requires a device check.
