# Agent rules: Recording frame, mid-take UI and activation

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## The recording frame may never paint inside the recorded rect

**On any platform that cannot hide one of our windows from the recorder
we are running, every lit pixel of the recording frame must be OUTSIDE
the recorded rect. This is not a style choice — the alternative is
tangerine baked into every frame of the user's MP4.**

Owner: [recording-frame-geometry.ts](../../apps/desktop/src/main/recording/recording-frame-geometry.ts)
(where to put the window) + [recording-frame.css](../../apps/desktop/src/renderer/src/styles/recording-frame.css)
(what each posture paints). Pinned by
[recording-frame-css-boundary.test.ts](../../apps/desktop/src/main/recording/__tests__/recording-frame-css-boundary.test.ts),
which scans the shipped stylesheet — jsdom does not resolve
`box-shadow`, so a render test cannot catch this.

| Platform | Posture | Why |
|---|---|---|
| macOS 13+ | `straddle` — glow may kiss the inside edge | `setContentProtection(true)` → `NSWindow.sharingType = .none`, which SCStream honours. The HUD already relies on it. |
| Windows 10 2004+ | `outset` — nothing inside, ever | The recorder is FFmpeg `gdigrab` reading the desktop DC. Same reason `anchorAwayFromRecordedRect` exists for the HUD. |
| Linux | `outset` | No content-protection concept at all. |

Five things that bite:

- **A border paints INWARD from the element's own edge**
  (`box-sizing: border-box`), so under `outset` an element's offset must
  be at least its border width or the difference lands inside the rect.
  This shipped in review: the corner ticks sat at `-1px` with a 2px
  border, lighting the pixel column at rect-relative 0 on all four
  corners — one tangerine column per corner, baked into every gdigrab
  frame. The hairline had it right at `-1px` / 1px, which is exactly why
  the corners read as correct. The widths are now
  `var(--psrf-corner-weight)` and the boundary test compares the two
  numbers rather than asserting a literal.
- **`outset` is the BASE CSS and macOS adds to it.** Writing it the
  other way round — a safe `[data-mode="outset"]` override on an unsafe
  base — means a dropped selector fails into the user's file instead of
  into a slightly plainer frame. Keep the default safe.
- **A full-display recording on Windows/Linux draws NOTHING.** There is
  no outside; `planRecordingFrame` returns `null` and the HUD carries
  the signal alone. Do not "fix" that by insetting the frame.
- **The planner takes `platform` as an argument and imports no Electron**,
  so the Windows branch — the one that protects the capture — actually
  runs on macOS CI. Reading `process.platform` inside it would switch
  that coverage off silently.
- **`RECORDING_FRAME_BAND_PX` is how far outside the rect the window
  extends, and it is derived from the widest shadow in the CSS**
  (spread + blur / 2). Widening the falloff without raising it gets the
  glow a hard edge where the window stops. The boundary test asserts
  the two agree.

`RecordingState.rect` is DISPLAY-LOCAL and the plan's `bounds` are
GLOBAL — see the coordinate-space note at the head of
[rect-overlap.ts](../../apps/desktop/src/main/capture/rect-overlap.ts) before
touching the arithmetic.

## Mid-take UI: only the HUD asks questions, and nothing takes focus

**During a live take, the recording-controller HUD is the ONLY surface
PwrSnap may ask the user anything on, and it must stay non-activating
for the whole take. No native dialog, and no `setFocusable(true)`.**
(The frame overlay is also on screen throughout — it is click-through
and asks nothing, and the section above governs where it may paint.)
The camera recorder may show a passive, nonfocusable preview on macOS only.
It must fit wholly outside the recorded rectangle, and ScreenCaptureKit must
confirm an explicit window exclusion before it becomes visible. Missing
exclusion, no free area, or changed display geometry hides it. Never rely on
`setContentProtection(true)` alone: recent macOS ScreenCaptureKit ignores
`NSWindow.sharingType`. Never exclude the main PID to hide the preview, since
that also removes Library windows the user may be recording.
Owners:
[recording-controller.ts](../../apps/desktop/src/main/recording/recording-controller.ts)
(the phase arms) and [tray.ts](../../apps/desktop/src/main/tray.ts)
(`confirmDiscardRecording`). Pinned by
[recording-controller-escape.test.ts](../../apps/desktop/src/main/recording/__tests__/recording-controller-escape.test.ts)
§"recording HUD must not intrude on the take" and
[tray-context-menu.test.ts](../../apps/desktop/src/main/__tests__/tray-context-menu.test.ts),
which also grep-asserts tray.ts for `dialog.showMessageBox`.

This is the same class as the two sections above it — "Tray popover
hide" (an NSPanel fade landed in users' screenshots) and "The recording
frame may never paint inside the recorded rect". Both defects below
shipped in [#496](https://github.com/pwrdrvr/PwrSnap/pull/496).

### Only the HUD WINDOW is protected

`collectOurPids()` narrows the capture filter's `excludePids` to the HUD
renderer alone, and the HUD stays invisible through
`setContentProtection(true)` set once in
`createRecordingControllerWindow` — read the "Why per-window content
protection instead of SCContentFilter PID exclusion" note there before
reaching for a filter change; excluding the main process takes every
other PwrSnap window out of the capture with it, because Electron may
share a renderer across BrowserWindows.

So the protection is a property of that one window, and two things fall
outside it:

- **A native dialog raised from main.** An `NSAlert` has no
  `sharingType`, and it is centred on the display, so it is inside
  almost any recorded rect. On Windows the recorder is FFmpeg
  `gdigrab` reading the desktop DC, which captures it wherever it sits,
  and `recordingBackendCapabilities("win32")` offers both destructive
  items there. The tray's Restart/Cancel confirm was such a dialog; its
  default button was "Keep Recording", so the path that ruined a take
  was the user changing their mind — the take survived with several
  seconds of a PwrSnap alert baked into the MP4.
- **The CONSEQUENCES of activating PwrSnap.** The HUD is constructed
  `focusable: false` and shown with `showInactive()` so a click on
  Stop / Restart / Cancel cannot take key focus. Flip that and clicking
  the HUD switches the macOS menu bar to PwrSnap, greys the recorded
  app's title bar, and drops its text caret — all inside the rect, all
  in the file. The first frames after a Restart arm-click became a
  recording of the user's app losing focus.

### Where a mid-take confirmation goes

The HUD already owns a two-press arm/confirm for Restart and Cancel, and
it is the one surface that is content-protected on macOS and anchored
outside the rect on Windows (`anchorAwayFromRecordedRect`). So the tray
arms it over `EVENT_CHANNELS.recordingControllerArm` and gets out of the
way.

- **The nudge is one-way.** The renderer owns the armed state and its
  5s auto-disarm, and the renderer is what dispatches. Main keeps no
  parallel armed state that could disagree with what the user sees.
- **No HUD, no destructive item.** When the HUD renderer has crashed
  past its retry budget the tray does not offer Restart/Cancel at all.
  "Stop and Save" always is: losing a take needs a confirmation
  surface, keeping one does not.
- **The HUD arms only what it rendered**, behind the same
  `backend?.controls.<x> ?? true` the buttons use, so a prompt can
  never point at a button that is not on screen.

### Escape is not available to this window, on purpose

A non-activating window receives no keydown, which is why the LEAD-IN
Escape goes through `globalShortcut`
(`registerDesiredLeadInEscapeShortcut`). Do not extend that bridge into
the recording phase: swallowing a key from the app being recorded is
the same class of intrusion as painting over it. The 5s auto-disarm and
the sibling button are the exits from an armed state, and `.rc-root`
carries no key handler.

## The Dock reclaim is not an activation recovery

**`scheduleDockReclaim` / `reclaimDockIconIfLibraryAlive` restore
activation POLICY. They do not restore activation, and they do not
restore z-order. Three different things. Never treat a recovered Dock
tile as evidence that our window is back on top.**

The AppKit Accessory demotion that follows selector teardown strips the
Dock tile first and takes our activation a few tens of ms later. The
reclaim catches the tile; nothing was asking for activation back. The
cost lands on the one path that needs PwrSnap frontmost for longer than
an instant — a recording whose subject is one of OUR windows, where the
~3s countdown outlives the commit-time raise and the window dove under
another app and got recorded that way.

- **`moveTop()` on an inactive app is not a fix.** macOS orders such a
  window only among that app's OWN windows, so
  `applyRecordingStateToController`'s per-tick re-raise loop runs, logs a
  correct overlap set, and cannot lift the window above the active app.
  A healthy-looking tick log is not evidence.
- **`getFocusedWindow() !== null` does NOT mean PwrSnap is active.**
  The focus-sink is a focusable non-activating panel and can hold key
  while another app is frontmost — the exact state this bug lives in.
  Ask the question you mean: is the window you want on top key
  (`win.isFocused()`)? Both diagnostic lines log which window is key
  AND whether it is the one that matters (`focusedIsOverlapping` on
  the debug `recording lead-in z-order tick`, `focusedIsLibrary` on the
  info-level reclaim line), because the Library and the sink can share
  a title.
- **Re-activation is scoped: macOS, the raise branch's own take, and
  the lead-in phases** (`scheduleLeadInReraise` in
  `record-from-selection.ts`). Widening any of them is a bug: case two
  must leave the user's app frontmost, activating mid-take records the
  recorded app losing focus (see "Mid-take UI" above), and on Windows
  there is no demotion to recover from. The recording-controller's tick
  cannot host this — it cannot tell case one from case two.

Measurements, the two hypotheses it replaced, and the log recipe:
[docs/solutions/2026-09-17-recording-lead-in-activation-loss.md](../../docs/solutions/2026-09-17-recording-lead-in-activation-loss.md).
