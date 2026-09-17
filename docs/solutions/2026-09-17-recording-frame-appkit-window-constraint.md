# The recording frame drew below the window it was framing

**Date:** 2026-09-17
**Area:** `apps/desktop/src/main/recording/recording-frame-geometry.ts`
**Symptom:** the tangerine recording outline sat ~26px BELOW the top of
the recorded window and hung off its bottom by the same amount. Single
display. The region picker's own highlight was correct, and so was the
recorded MP4.

## What it looked like

A video take started with ⌘⇧C → Record on a near-maximized window. The
frame overlay was the right SIZE and the right SHAPE, just translated
down by roughly a title-bar height — top edge inside the window, bottom
edge past it by the same distance. Because the frame window is
`setContentProtection(true)`, it does not appear in a screenshot, so the
only evidence was what the operator saw on the glass.

The two things that make the report diagnostic are what was NOT wrong:

- **The picker was right.** The selector renders its own highlight from
  its own display-local data.
- **The file was right.** `subjectToPhysicalRect` →
  `globalRectToDisplayLocal` → the Swift recorder's
  `SCStreamConfiguration.sourceRect`.

Both consume the same rect the frame planner does, so the rect was fine
and the coordinate-space arithmetic (the usual suspect — see
[2026-09-03-display-local-vs-global-rects.md](2026-09-03-display-local-vs-global-rects.md))
was fine. Everything downstream of `planRecordingFrame` was also fine:
the renderer positions one box at the insets it is handed, and
`.psrf`'s containing block is the initial one, so no stray padding or
positioned ancestor could shift it.

## Cause

**`BrowserWindow` is not the last word on where a window goes.**

AppKit runs `-[NSWindow constrainFrameRect:toScreen:]` and MOVES any
window whose frame falls outside `NSScreen.visibleFrame` — Electron's
`display.workArea`. The planner clamped the inflated band to
`display.bounds`, so for a window sitting flush at the top of the work
area it asked for a frame 26px higher, i.e. under the menu bar. AppKit
put it back.

Measured, macOS 26 + Electron 41.10.7, 1920x1080@2x, 30px menu bar,
89px Dock (`workArea = {y: 30, height: 961}`), probe window 600x500:

| requested | after `show()` | delta |
|---|---|---|
| `y=400` | `y=400` | 0 (fits, untouched) |
| `y=35` | `y=35` | 0 |
| `y=30` | `y=30` | 0 |
| `y=23` | `y=30` | **+7** |
| `y=4` | `y=30` | **+26** |
| `y=0` | `y=30` | **+30** |
| `y=600 h=500` | `y=491` | **−109** (pulled up off the Dock) |
| `x=-50` | `x=0` | **+50** |
| `x=1700 w=600` | `x=1320` | **−380** |

Three properties of the behavior are what made this expensive to find:

1. **The size is never touched, only the origin.** So the window slides
   and keeps its height — exactly "shifted down, hanging off the bottom
   by the same amount". A clamp that resized would have looked like a
   layout bug and been chased far sooner.
2. **The move lands on `show()`, not on construction.** `getBounds()`
   right after the constructor still returns what was asked for, and
   `ensureWindow` in `recording-frame.ts` deliberately records the
   constructor bounds as placed and never re-asserts them (a
   `setBounds` during construction fights the implicit-minimum-size
   clamp — see AGENTS.md). So nothing in the main process observed the
   difference, which is why it shipped. Note the limit of that claim: a
   read-back AFTER `show()` does see the moved origin — every `30` in
   the table above is a post-`show()` `getBounds()`. Comparing
   `getBounds()` to the planned bounds once shown would be a cheap
   backstop for a clamp this fix does not model (a Linux WM strut, a
   future macOS rule); it is not currently wired.
3. **AppKit only moves a window that FITS.** A window taller than the
   work area is left where it was asked (`y=30 h=1000` → untouched).
   So the bug reproduces on an ordinary window and evaporates on a
   full-screen one — or vice versa, depending which edge you are on.

And one dead end worth recording: **no window level escapes it.**
`floating`, `status`, `pop-up-menu` and `screen-saver` were all
measured at `y=4`; all four came back at `y=30`. The region selector
covers the menu bar via `setSimpleFullScreen`, which is a different
mechanism and far too heavy for a small click-through overlay.

## Fix

`planRecordingFrame` clamps to the box the window is actually allowed
to occupy — `display.workArea` on darwin, `display.bounds` everywhere
else (there is no `constrainFrameRect` off macOS, and the `outset`
posture needs every pixel of band it can get).

It also adds a guard for a plan whose rect does not intersect the clamp
box at all. That is not hypothetical and is not about menu-bar size:
`onDisplayMetricsChanged` re-plans the session's stored rect against the
display's new bounds, so shrinking the recorded display mid-take leaves
a rect off it entirely — which before this change produced a negative
`width` and handed it to `createRecordingFrameWindow`. A second,
pre-existing bug, fixed incidentally.

The window therefore always fits where AppKit is willing to put it, and
never moves. The difference is carried by the insets, which are now
explicitly allowed to be **negative**: a rect edge the window cannot
reach (under the menu bar, behind the Dock) is described as an overhang
and Chromium clips it. That keeps the drawn box ON the recorded rect,
which is the only property that matters. The alternative — keeping every
inset non-negative — is precisely the bug: it moves the frame off the
rect to make the numbers look tidy.

Concretely, a full-display macOS recording used to plan
`{x:0, y:0, 1440x900}` with zero insets (and got slid down 30px, with
its bottom 30px off-screen). It now plans `{x:0, y:30, 1440x781}` with
`inset.top = -30`, `inset.bottom = -89`: left and right edges drawn,
top and bottom clipped where nothing could have drawn them anyway.

## Pinned by

- `recording-frame-geometry.test.ts` §"the window server moves a window
  it does not like — do not give it one" — the clamp, the anchor
  invariant (`bounds + inset === the recorded rect`) across a table of
  rects, the secondary-display case, and that Windows/Linux are
  untouched.
- `recording-frame.test.ts` §"the window is placed inside the recorded
  display's work area" — the PRODUCTION wiring. `planForRect` has to
  forward the whole Electron `Display`; forwarding only `bounds` would
  still type-check, because structural typing does not notice a field
  the call site never reads.
- `RecordingFrame.test.tsx` §"a negative inset overhangs the window
  instead of being clamped to zero" — the renderer half of the
  contract.

## Related, and NOT fixed here

`fillRect` in `recording-controller.ts` positions the countdown leader
over the recorded rect with the same `setPosition` call and is subject
to the same constraint. It is only wrong when the rect's top is above
the work area (a full-display take), and the leader is a transient dim
rather than a measurement, so it was left alone rather than changing
the leader's layout in a bug fix. If it is taken on, note that the
leader has no inset protocol — it fills its window — so the honest fix
there is different from this one.

## How to re-measure

`scripts` has nothing for this on purpose; it is a ten-line Electron
main script. Create a window at a given `y` with `show: false`, read
`getBounds()`, call `showInactive()`, wait a frame, read `getBounds()`
again, and print both. Run one case per process — driving several
windows through show/destroy in one run wedged the probe. Compare
against `screen.getPrimaryDisplay().workArea`, not `bounds`.
