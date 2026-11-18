# Agent rules: Float-over state and dock

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## The float-over asks for its state; main never sends it on a timer

**FloatOverHost subscribes to `floatOverState` and then calls
`requestFloatOverState()`. Main answers with `lastEvent` on that
channel, and sends nothing live before the request arrives. Do not bring
back a grace period after a load event.** Owners:
`wireFloatOverStateRequestChannel` in
[float-over.ts](../../apps/desktop/src/main/float-over.ts) and the subscribe
effect in
[FloatOverHost.tsx](../../apps/desktop/src/renderer/src/features/float-over/FloatOverHost.tsx).
Pinned by
[float-over-state-request.test.ts](../../apps/desktop/src/main/__tests__/float-over-state-request.test.ts)
and the "asks main for the current state" case in
[FloatOver.test.tsx](../../apps/desktop/src/renderer/src/features/float-over/__tests__/FloatOver.test.tsx).

The first `setFloatOverState` of a session creates the window, so that
event always exists before the renderer that has to show it. Main used
to send it 100ms after `did-finish-load`. React subscribes in a passive
effect after the first render, and nothing bounds how long that takes.

- **Measured in the Linux Docker harness.** With no load, FloatOverHost
  subscribed 9–48ms after `did-finish-load` and the send always found
  it. With the CPU oversubscribed, the send could land mid-render, and
  its IPC task then raced React's effect flush. It lost 2 of 2 such races
  at 6× (2 of 30 launches) and 3 of 7 at 12× (3 of 10). A lost event
  left the toast empty. Main had already put the window on screen,
  taking clicks, with the copy shortcuts armed.
- **Subscribe, then ask.** The answer travels on the state channel, and
  an event with no subscriber is dropped. The renderer test fails if the
  two lines are swapped.
- **Ask rather than latch, because this is state.** Each event replaces
  the renderer's whole state, and main keeps the latest one, so a late
  subscriber needs only that. A preload latch is for a one-shot intent
  that exists nowhere else.
- **Only the float-over's own webContents may ask.** A renderer that
  reloads asks again and gets the latest state. Main stops sending live
  at `did-start-loading` until it does.
- **Ask once per mount.** StrictMode re-runs the effect, and a repeated
  `show-loaded` resets the toast's enrichment to null.
- **Do not probe this with `page.evaluate` before the send.** It queues
  behind the first render and hides the race. Have the preload report
  its receipt times to main over IPC, aligned with
  `performance.timeOrigin`.

Measurements, the two failure timelines, and the probe:
[docs/solutions/2026-09-26-float-over-first-state-lost.md](../../docs/solutions/2026-09-26-float-over-first-state-lost.md).

## The float-over dock is the toast's own window, and it never lands in a capture

**When a toast's countdown ends, the snap stays in tabs on the screen edge,
regardless of whether AI is off, running, completed, or failed. The dock is the SAME
BrowserWindow as the toast, reshaped. It is placed inside the work area,
excluded from screen capture, and hidden for every snapshot and every
recording.** Owners: `enterTucked` / `applyDockLayout` /
`releaseFloatOverDock` in [float-over.ts](../../apps/desktop/src/main/float-over.ts)
(where the dock is and whether it shows), and the queue in
[FloatOverHost.tsx](../../apps/desktop/src/renderer/src/features/float-over/FloatOverHost.tsx)
with its rules in
[float-over-dock-model.ts](../../apps/desktop/src/renderer/src/features/float-over/float-over-dock-model.ts)
(which snaps wait). The renderer owns the list because only it knows each
snap's enrichment status. Pinned by
[float-over-dock.test.ts](../../apps/desktop/src/main/__tests__/float-over-dock.test.ts)
and
[FloatOverDock.test.tsx](../../apps/desktop/src/renderer/src/features/float-over/__tests__/FloatOverDock.test.tsx).

- **A shape change parks the window until the renderer draws the new
  shape.** Every layout post carries `mode: "toast" | "dock"`, main drops a
  post for the shape it has already left, and the window is shown only
  when a post for the new shape arrives. The host bumps a layout epoch on
  every state event, so it re-posts even when the new shape measures the
  same. Without that, a dock that happened to match its last size would
  never be shown.
- **The window is exactly the size of what it draws.** Transparent pixels
  still take clicks. The dock rests as an 18px sliver and widens only
  while the pointer is over it. The one accepted exception is the rail
  beside a toast: it is only as tall as its thumbnails, capped at the
  toast's height (`--fo-rail-max`, a layout measure the host publishes
  before it measures), so with a short catalog the strip below it is
  see-through. A rail stretched to the toast's height read as a tall
  empty panel. On macOS and Windows that
  strip (and the gaps between dock tabs) passes clicks through: the host
  reports each time the pointer crosses between a drawn part
  (`FLOAT_OVER_SOLID`) and the rest, and main answers with
  `setIgnoreMouseEvents(true, { forward: true })`. Main only honors it
  while the window is on screen, and every show and park resets it to
  taking clicks, so a report can never un-park a window. Linux has no
  move forwarding, so the strip keeps taking clicks there.
- **On Windows the dock's window is 32px wide, and its edge is placed, not
  its request.** Under Electron 44, Windows will not make any window
  narrower than 32 DIP. Measured on the GitHub Windows runner at 100%: transparent or opaque,
  resizable or not, through `setBounds` or `setContentSize`, every request
  below 32 came back as 32. Electron 41 gave 18. The renderer pins the tab
  to the window's edge, so `applyDockLayout` reads the width back and puts
  THAT flush with the work area. Placed by the requested 18, the window ran
  14px past the right edge and 4px of tab showed. The spare strip is
  see-through, so it passes clicks like the rail's. The E2E specs
  assert where the tab lands (`dockGeometry`), not the window's width.
- **No native shadow on the dock.** macOS draws the shadow, with a light
  rim, around the window's whole shape, which outlined the gap between
  the tabs. `setWindowShape` turns it off for the dock and back on for
  the toast.
- **No rounded window corners, ever** (`roundedCorners: false` in
  `createFloatOverWindow`). macOS and Windows 11 round a frameless
  window's corners unless told not to. The toast's own 14px radius hid
  that, but on the 18px-wide dock it cut all four window corners, and the
  top tab and the bottom ⋮ tab read as one canoe. It is a construction
  option, so it cannot follow the shape the way the shadow does. The
  headless render harness cannot show this: there is no window around
  the page. Only a real display does.
- **Placed flush inside the work area, never past it.** AppKit moves a
  window placed outside it (see "macOS MOVES a window placed outside the
  work area"). The tabs only look like they run off the screen, because
  the window's own edge clips them.
- **Never in a capture.** While tucked, the window is content-protected on
  macOS and Windows. The chrome-hide `cancel` before every snapshot parks
  it on every platform, which is the only protection on Linux. A
  recording parks it for the whole take (`subscribeToRecordingState`).
- **Only a cancel that ENDS a capture session brings the dock back.** That
  is a cancel from `idle` or `hidden`. The same event from `loaded` or
  `tucked` is the chrome hide before a snapshot, and must only park.
  `holdDock: true` is for a session that hands the screen to a
  recording. A path that hides the chrome and can then end with no toast
  and no session-ending cancel calls `releaseFloatOverDock()`. Today that
  is `capture:fullScreen` / `capture:allScreens` (wrapped in
  capture-handlers.ts) and `startRecordingFromSelection`. Without it, a
  failed capture strands the waiting snaps until the next one.
- **A tuck sent because a new capture started is `markOnly`.** It records
  that snaps are waiting without touching the screen. A plain tuck that
  lands after the new capture's `show-loaded` would collapse the toast the
  user is about to look at.
- **The rail is the recent-snaps catalog, not the dock's list.** It pages
  `library:list` newest first, keeps itself current from the
  captures-changed broadcast, and scrolls past the toast's height. Opening
  a snap from it never removes or reorders anything: the order is capture
  time. The dock's glyphs sit on the snaps that are waiting; everything
  else is a plain thumbnail with its age. Ages count from `captured_at`,
  never from when a snap joined the dock.
- **Dock membership does not depend on enrichment status.** Timeout or
  replacement by another capture keeps the snap; opening it does not
  remove it. Explicit dismissal, discard, Library handoff, deletion, or
  "Clear finished" removes it. A failed run shows `!`; a completed run
  shows `✓`. A snap with no expected AI run has no AI glyph.
  Re-read an active image on capture-change broadcasts too: deletion
  closes its toast before it can be retained on the dock.
- **`recording.showRecentCaptureSidebar` decides whether the dock is SEEN,
  never what is on it.** Off parks the window through the same
  `dockParked()` gate a recording uses (`setFloatOverRecentSidebarVisible`
  in float-over.ts, fed from `onSettingsChanged` in index.ts). The
  renderer still retains, tucks and shows status glyphs exactly as with it
  on, and main never sends `dismiss` for it, so turning it back on shows
  the same tabs. Do not implement "off" as a dismiss or as a renderer-side
  skip of `retainSnap`: either one makes the switch delete dock state. The
  only renderer change is that the toast drops its Tuck button, which
  would send the snap somewhere invisible. The countdown is unchanged.
- **"No run yet" means "not yet" only for a snap just taken**
  (`mayAwaitFirstRun`) with AI enabled and available. `awaitingFirstRun`
  keeps an older snap or one with AI off from showing a waiting glyph
  or being counted as in-flight. A real queued/running run still wins.
  Expire that expectation after `FIRST_RUN_GRACE_MS` when no run arrives,
  so a skipped enrichment becomes a plain tab eligible for "Clear finished".
- **A snap's fate is decided once, at the close the host caused.**
  `settledRef` stops main's echo of that close from deciding again. By
  then the model may have answered. A snap that has been on the dock
  stays, ✓ and all, until explicitly dismissed or cleared.
- **No dock where placement is not ours** (`windowPlacementIsOurs()`,
  native Wayland). `float-over:capabilities` says so. The toast then holds
  the corner while the model reads, as it did before the dock existed.
- **The dock's position is process-lifetime, not a setting.** It resets on
  relaunch, deliberately. Persisting it means a new field in Settings.
- **Headless E2E cannot see any of this.** Placement, content protection
  and the park are window-server behavior. Check a change on a real
  display, and on Windows and Linux as well as macOS.
