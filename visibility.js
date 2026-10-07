// Whether this Kanban frame is on screen, for pausing network polling.
//
// The Möbius shell keeps recently used apps mounted but hidden, and a hidden
// frame's document.hidden stays false. Runtimes that publish
// runtimeFeatures.frameVisibility combine the shell's verdict with
// document.hidden; older Möbius hosts only offer document.hidden.

function runtimeVisibility() {
  const mobius = window.mobius
  return mobius?.runtimeFeatures?.frameVisibility && typeof mobius.onVisibilityChange === 'function'
    ? mobius
    : null
}

export function appVisible() {
  const runtime = runtimeVisibility()
  return runtime ? runtime.visible !== false : !document.hidden
}

// cb(visible) runs on each change, not on subscription. Returns unsubscribe.
export function onAppVisibilityChange(cb) {
  const runtime = runtimeVisibility()
  if (runtime) {
    let last = runtime.visible !== false
    return runtime.onVisibilityChange(visible => {
      if (visible === last) return
      last = visible
      cb(visible)
    })
  }
  const listener = () => cb(!document.hidden)
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
