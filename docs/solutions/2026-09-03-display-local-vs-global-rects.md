# Display-local vs global rects in the capture/recording flow

**Symptom:** on a multi-monitor desk, starting a video recording over
PwrSnap's own Library did not raise the Library — it stayed behind
whatever app was frontmost, and the recording captured the wrong thing.
Nobody could reproduce it on a single display.

## What was wrong

Two logical-pixel spaces, separated only by `display.bounds.{x,y}`:

- **GLOBAL (virtual-screen)** — `BrowserWindow.getBounds()`,
  `setPosition`, `screen.getCursorScreenPoint()`, and
  `SelectorResult.rect`.
- **DISPLAY-LOCAL** — relative to one display's top-left. What the
  region-selector *renderer* reports, what ScreenCaptureKit's
  `sourceRect` wants, and what `RecordingState.rect` carries.

The trap is that **the selector's public result is GLOBAL even though
its renderer speaks display-local**: `region-selector.ts` adds the
display origin when it builds `SelectorResult`. So a
`SelectorResult.rect` — or a `RecordingSubject.rect` seeded from one —
is already global.

`appWindowsOverlappingRect` wanted display-local and re-added the
origin itself. Its doc comment described the parameter as
"display-local logical pixels **(selector convention)**". The
parenthetical was wrong, and wrong in the direction that hurts: it told
callers the one rect they are most likely to be holding was already in
the right space. Two call sites believed it and passed a global rect
in, applying the origin twice.

Measured on a display at `bounds {x:1496, y:-473}`, a selection
squarely inside the Library was tested at `{x:3192, y:-846}` — roughly
a full display away, off the display it was selected on. It matched
zero windows, so the raise branch never ran.

## Why it survived review and shipped twice

**On a primary display at (0,0), adding the origin a second time is
the identity.** A single-display dev machine, and every test that used
a display at the origin, report the mistake as correct. The first
instance lived in `index.ts`; when the Snap-vs-Record chooser
extracted that flow into `record-from-selection.ts`, the bug was
carried along verbatim.

The tests did not catch it either. There *was* a non-zero-origin case,
but only on X (a secondary at `{x:-1920, y:0}`). Deleting the
`bounds.y` term from the helper outright left all seven of them green —
the Y axis was entirely unconstrained, and `{x:1496, y:-473}` is
exactly the shape that needs both.

## What we changed

- **The arithmetic has one owner.** `displayLocalRectToGlobal` and
  `globalRectToDisplayLocal` in
  [rect-overlap.ts](../../apps/desktop/src/main/capture/rect-overlap.ts)
  replace four hand-rolled `± display.bounds` sites.
- **Two overlap entry points, named for the space they take.**
  `appWindowsOverlappingGlobalRect` needs no display and does no
  arithmetic, so a caller holding a selector rect has no origin to
  double-add. `appWindowsOverlappingRect` keeps the display-local
  parameter for `RecordingState.rect`, and its parameter is now named
  `displayLocalRect`.
- **Tests that constrain both axes.** A display at `{x:1496, y:-473}`,
  plus a pin on the boundary itself, plus a test at the call site —
  because the defect was never in the helper's arithmetic, it was in
  which entry point a caller reached for.

## If you touch this again

- **Neither entry point can detect a rect in the wrong space.** They
  both take a bare `Rect`. Naming and these docs are the only guard; a
  branded type would be stronger but `Rect` is a shared IPC protocol
  type and the ripple is large.
- **The two converters take opposite unknown-display policies,
  deliberately.** `displayLocalRectToGlobal` returns `null` (refuse —
  the overlap test would rather match nothing than aim wrong);
  `globalRectToDisplayLocal` returns the rect unchanged (guess — the
  recorder and HUD need *something* to proceed with a capture already
  in flight). Both are documented at the function.
- **Green tests on a primary display prove nothing here.** Any new
  assertion about display origins must run against a display whose
  origin is non-zero on both axes.
