# Agent rules: BrowserWindow sizing and placement

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## BrowserWindow sizing — `setMinimumSize(0, 0)` after construction

**Any BrowserWindow that auto-sizes to its content via `setContentSize`
at runtime must call `setMinimumSize(0, 0)` once after construction.**
This applies to the tray popover, the float-over toast, the E2E test
fixtures, and any future popover / HUD that grows or shrinks past its
initial frame.

### What goes wrong without it

When a BrowserWindow is constructed with explicit `width` and `height`,
Electron records those values as the IMPLICIT MINIMUM CONTENT SIZE
(this is internal — there's no `minimumSize` constructor option that
makes it explicit). Subsequent `setContentSize` calls are then clamped
at that minimum on macOS — the call returns without error, but the
window's content area never grows or shrinks past the constructor
frame. `getContentSize()` reads back the requested value, so the
clamp is invisible from the main process side; only the rendered
window reveals it.

Symptom: the renderer's ResizeObserver fires the resize-to-fit IPC
with the right measured height, main dutifully calls `setContentSize`,
and the popover stays stuck at its constructor frame. Rows past the
clamp are clipped off the bottom edge. Looks like a CSS / measurement
bug, isn't.

This is amplified for `type: 'panel'` (NSPanel) windows because
`resizable: false` removes `NSResizableWindowMask` from the styleMask,
which AppKit interprets as "no programmatic resize either." The
implicit min-size is the headline issue, but combining `panel + non-
resizable + non-movable + frame: false` is the configuration where
the clamp matters most.

References: [electron/electron#14065](https://github.com/electron/electron/issues/14065).

### The fix

Call `window.setMinimumSize(0, 0)` immediately after `new BrowserWindow(...)`
to lift the constraint. After that, `setContentSize` is free to set
whatever the renderer measured. No need to flip `resizable` or pad
the constructor with min/max bounds — `setMinimumSize(0, 0)` is the
one thing that makes setContentSize land.

```ts
const window = new BrowserWindow({
  type: "panel",
  width: 440,
  height: 440,
  resizable: false,          // OK to keep — user UX is unaffected
  movable: false,
  frame: false,
  // ...
});
// ⚠️  REQUIRED if anything will setContentSize() this window later.
window.setMinimumSize(0, 0);
```

### Where this matters today

- `createTrayWindow` in `apps/desktop/src/main/window.ts` — sized by
  the renderer's `pwrsnap:tray:resize` IPC; main listens in
  `apps/desktop/src/main/tray.ts` (`wireTrayResizeChannel`).
- `createFloatOverWindow` in `apps/desktop/src/main/window.ts` — sized
  by the renderer's `float-over:resize` IPC; main listens in
  `apps/desktop/src/main/float-over.ts` (`wireFloatOverResizeChannel`).
- `apps/desktop/e2e/fixtures/electron-app.ts` — Playwright harness
  needs to shrink the library window below its constructor frame for
  size-sensitive specs. Same fix.

### How we keep losing this

We've solved this exact problem before — first in the E2E fixture
(commit `943ff64`), then re-discovered it for the tray + float-over
windows when their content grew past the constructor frame after the
design refresh. The clamp is invisible from the main side
(`getContentSize` reads back the requested value), the renderer's
ResizeObserver isn't broken, and the CSS isn't broken — so the
investigation tends to chase visible symptoms (CSS, observer timing,
overflow rules) before landing on the actual platform behavior. If
you find yourself debugging "popover is stuck at its initial size,"
check for `setMinimumSize(0, 0)` first.

## macOS MOVES a window placed outside the work area

**Any window positioned to line up with something on screen — an
overlay, a frame, a HUD pinned to a rect — must be planned against
`display.workArea`, not `display.bounds`.** AppKit runs
`-[NSWindow constrainFrameRect:toScreen:]` on show and slides any
window whose frame falls outside `NSScreen.visibleFrame` (the menu bar
at the top, the Dock at the bottom) back inside it. It is not a
refusal and not an error; the window simply ends up somewhere else.

Owner for the recording frame:
[recording-frame-geometry.ts](../../apps/desktop/src/main/recording/recording-frame-geometry.ts)
(`clampBox`). Pinned by
[recording-frame-geometry.test.ts](../../apps/desktop/src/main/recording/__tests__/recording-frame-geometry.test.ts)
§"the window server moves a window it does not like" and by
[recording-frame.test.ts](../../apps/desktop/src/main/recording/__tests__/recording-frame.test.ts)
§"the window is placed inside the recorded display's work area".

This shipped: the tangerine recording frame drew ~26px below the window
it was framing and hung off the bottom by the same amount, while the
picker and the recorded MP4 were both correct.

Four things that bite:

- **The ORIGIN moves; the SIZE never does.** So the window slides and
  keeps its height — which reads as "shifted down, hanging off the
  bottom by the same amount", not as a sizing bug. Measured on macOS 26
  / Electron 41.10.7 with a 30px menu bar: `y=0 → 30`, `y=4 → 30`,
  `y=23 → 30`, `y=600 h=500 → y=491` (pulled up off the Dock),
  `x=-50 → 0`.
- **The move lands on `show()`, not on construction.** `getBounds()`
  right after the constructor still returns what you asked for, and
  `ensureWindow` records exactly that as placed and never reads back —
  so today nothing in main notices, which is why this shipped. A
  read-back AFTER `show()` DOES see the moved origin (it is where the
  measurements above come from), so comparing `getBounds()` to the
  planned bounds once shown is a cheap backstop for any platform this
  clamp does not model. That is the one thing it has over the
  `setMinimumSize(0, 0)` clamp above, where the main-side getter really
  does answer from the value we set.
- **AppKit only moves a window that FITS** in the work area. One taller
  than it is left alone — so the bug reproduces on an ordinary window
  and vanishes on a big one.
- **No window level escapes it.** `floating`, `status`, `pop-up-menu`
  and `screen-saver` were all measured; all four were moved. Covering
  the menu bar needs `setSimpleFullScreen`, which is what
  `region-selector.ts` uses and is far too heavy for a small overlay.

The fix shape is "never ask": clamp to the work area so the window
always fits, and let whatever geometry protocol the window has carry
the difference. For the recording frame that protocol is
`RecordingFrameLayout.inset`, **which is why those insets may be
negative** — a rect edge no window can reach is drawn as an overhang
and clipped, which keeps the frame ON the rect. Do not "tidy" a
negative inset to zero; that is the original bug wearing a clean face.

Windows and Linux have no equivalent, and the recording frame's
`outset` posture depends on every pixel of band it can get, so the
clamp is darwin-only and the platform split is pinned by test.

Full measurements, the probe recipe, and the dead ends:
[docs/solutions/2026-09-17-recording-frame-appkit-window-constraint.md](../../docs/solutions/2026-09-17-recording-frame-appkit-window-constraint.md).
