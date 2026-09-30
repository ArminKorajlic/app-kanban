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

card-editing.fixture.jsx exercises exported native title/notes editors, profile
photos, presence, color and assignee controls. Export its named components only
in the disposable copy. All network and storage operations are blocked; changes
are fixture state only. Verify native caret click offsets, plain-text paste,
undo, multiline notes, save-on-blur, Escape, links, remote updates, read-only and
blank drafts on desktop and a narrow viewport. Never apply this fixture.

With that isolated fixture loaded in agent-browser, run
`node tests/visual/card-editing.check.mjs <app-id>`. It connects to the current browser's
CDP session, refuses a live board, accounts for iframe scale, and checks native
click positions and keyboard behavior without touching any saved board.

For this coordinate-driven CDP check, first set a standard-density viewport:
`agent-browser set viewport 1512 911 1` (desktop) or
`agent-browser set viewport 390 844 1` (phone). High-density preview emulation
can route raw mouse coordinates differently; real-device keyboard behavior
still requires a device check.
