# Text selection outline drifted ~1% — a stale, transform-polluted canvas scale

**Date:** 2026-08-28
**Area:** `apps/desktop` renderer — editor canvas sizing, text overlays
**Symptom:** On macOS the text selection outline sat ~2–4px off-center on a
~470px-wide glyph. Only ever reproduced on macOS; the Linux/xvfb E2E job was
green.

## TL;DR

`EditorLoaded` read the canvas's CSS height from
`getBoundingClientRect()`. That rect is **post-transform**, and the editor
mounts inside `.psl__focus`, which runs a 180ms `psl-focus-in` entrance
animation from `scale(0.985)` to `scale(1)`. `useZoomPan` assigns the canvas
its final explicit width/height **during** that window, so the single
`ResizeObserver` callback that the sizing triggers reads a rect ~1% short. The
**layout** box never changes again — the animation only mutates a transform,
which produces no resize notification — so the stale value is permanent for the
life of the editor.

Fix: read the layout box (`ResizeObserverEntry.borderBoxSize`, with
`offsetHeight` for the synchronous seed) instead of the rect.

## Why it mattered beyond a cosmetic 1%

`canvasCssHeight` is the CSS:image scale that `TextHtml` divides its measured
`offsetWidth` by before publishing the glyph box to `text-measure-registry.ts`:

```ts
const scale = canvasCssHeight / imageHeightPx;
const widthImagePx = el.offsetWidth / scale;
```

`offsetWidth` is a **layout** measure. Dividing it by a **post-transform**
scale yields an image-px box inflated by the animation's shrink factor. The
selection outline, the `TransformHandles` body-hit rect, and the pointer
hit-test all read that box, so all three hugged a box ~1% wider than the glyph.
Because the outline is anchored at the glyph's left edge and only its width was
wrong, the error showed up as a **center drift of half the width error**.

The same stale value also feeds `computeTextHtmlStyle`'s `fontPx`, so text
overlays rendered ~1% smaller than intended. That half of the bug was invisible
— nothing to compare against — until the outline made it measurable.

## Measurements

Diagnostic run in the packaged Electron renderer on macOS (800×600 fixture,
`"Inject WWWW message yqg"`, medium bucket):

All rows below are ONE run each — the "before" column is the worst of the runs
observed. Do not mix rows across runs: the drift magnitude varies with where in
the animation the observer happened to fire (see the spread note below).

| quantity | before | after |
|---|---|---|
| `canvasCssHeight` state | 771.994 | 783.75 |
| `.editor-canvas` layout height (`style.height`) | 783.75px | 783.75px |
| glyph width | 469.945 | 477.0 |
| outline inner width | 477.157 | 477.0 |
| **outline center drift** | **3.61px** | **0.00px** |

`477.157 / 469.945 = 1.015347` and `783.75 / 771.994 = 1.015228` — the width
error is the staleness ratio, to within `offsetWidth`'s integer rounding
(the published box came from `offsetWidth` = 470, and `477.157 / 470` is
1.015228 exactly).

The `ResizeObserver` log confirms the mechanism. Only two `update()` calls ever
run — the synchronous seed and a SINGLE observer callback — and that one
callback already sees the final layout height while the rect lags:

```
{ ev: "effect-run", h: 0 }
{ ev: "update", h: 0,       offsetH: 0,   clientH: 0,   styleH: ""        }   ← synchronous seed
{ ev: "update", h: 776.405, offsetH: 784, clientH: 784, styleH: "783.75px" }   ← rect ≠ layout
```

That log is from a different run than the table (state 776.405, drift 2.42px).
`776.405 / 783.75 = 0.9906`, i.e. mid-way through `scale(0.985) → scale(1)`;
the table's run froze earlier, at `771.994 / 783.75 = 0.985` — the animation's
start value. Forcing a real window resize later delivers a third callback, the
state corrects, and the drift falls to 0.005px — which is what made "it never
self-heals, but any resize fixes it" the tell.

The magnitude varies run to run (observed 2.415, 2.417, 3.606) because it is a
race against the animation clock.

## Two hypotheses this replaced — both wrong, both plausible

Recorded because they were each load-bearing in a comment somewhere, and both
survived review by sounding right.

### 1. "A 2D canvas can't resolve `-apple-system`"

This claim lived in `text-measure-registry.ts`'s module doc and in
`editor-text-outline.spec.ts`. **It is false.** Measured on macOS, at equal
font size, `measureText` and the laid-out `<div>` agree to **0.013%** inside
Electron and **0.002%** in standalone Chromium, across 16–40px and weights
400/600.

### 2. "The analytic fallback is being used, not the published measurement"

Also false — the measured path was live the whole time. This one was disproved
arithmetically before the repro: the outline pads symmetrically, so a live
measured box puts the centers within `offsetWidth`'s integer rounding
(<0.25px). The diagnostic then confirmed it numerically — the outline width
matched *neither* the measured-path prediction (470) *nor* the analytic-path
prediction (473.264), but 477.157, which is the measured path over a stale
scale.

The lesson: the outline's width had three candidate explanations and the cheap
move was to compute what each one **predicts** and compare all three against the
observed number, rather than instrumenting the first plausible one.

## A real (separate, bounded) inaccuracy in the analytic fallback

Not the bug here, but true and worth knowing before someone trusts the
fallback. `textBoundsBox` calls `measureTextWidthPx(body, fontSizePx, weight)`
with `fontSizePx` in **image px**, then treats the result as image px — which
assumes `measureText` scales linearly with font size. macOS system-font metrics
are **not** linear in size (optical sizing). Measured error of
`measure(F) × s` versus the real layout at `F × s`:

| image px | scale | error |
|---|---|---|
| 18 | 0.5 | −7.3% |
| 18 | 0.78 | −2.7% |
| 30 | 0.6 | −2.3% |
| 30 | 0.78 | +0.07% |
| 81.8 | 0.5 | −1.6% |

This only affects the first frame before the glyph's layout effect publishes,
and jsdom unit tests. Linux's fallback face is linear, so CI cannot see it. If
the fallback ever needs to be accurate, measure at the **CSS-px** size the
glyph actually renders at and divide by the scale — do not measure at image px
and scale the result.

## A second instance, in the same file

`canvasRect` (the `DOMRect` EditorLoaded caches for CropTool) had the identical
defect and was found by this fix's review. Its effect deps are
`[canvasRef, canvasStyle.width/height/transform]` — all of which last change
while the animation is still running — so it too froze mid-animation and never
re-measured. Measured with the `canvasCssHeight` fix already applied:

| | cached `canvasRect` | live |
|---|---|---|
| width | 1029.33 | 1045 |
| left | 25.34 | 17.5 |

Because the animation scales about the CENTER, the origin is off by 7.8px on
top of the 1.5% scale error. A correction to this section's first draft, which
claimed "a crop drag landed ~6 source px from where the user dragged": it did
NOT — that number was arithmetic from the stale rect, never an observed drag.
Every CropTool gesture is DELTA-based, and a delta maps screen→source→screen
through the same cached width, so the staleness cancels exactly; a
drag-tracking assertion passed 8/8 against the un-fixed build. What the stale
rect actually breaks is the RENDER: the selection and dim tiles draw at the
cached scale inside the live-sized canvas, so the highlighted region covers
~1.5% different image content than the commit keeps (~12px at the far
corner), and the dim overlay stops short of the canvas edge — the visible
corner gap that exposed the bug. Fixed by adding `tool` to the effect's deps,
so the rect is re-measured when the tool that consumes it appears (long after
the 180ms animation). Pinned by `editor-crop-drag.spec.ts`, which recreates
the staleness deterministically (re-apply the entrance transform, force
re-measures under it via a zoom round-trip, wait out the trailing
ResizeObserver delivery, remove the transform) and asserts the rendered
selection against the live rect — measured bite: 12.5px, 4/4 runs, vs 0.00px
with the fix.

Note the asymmetry: for `canvasCssHeight` the rect was the WRONG KIND of
measurement (it gets combined with `offsetWidth`, a layout measure). For
`canvasRect` the post-transform rect is the RIGHT kind — pointer coordinates
are post-transform too — it was merely STALE. Same root cause, two different
correct fixes.

## Aside: the three "pre-existing" visual-regression failures were mine

While verifying this fix I ran `visual-regression.spec.ts` and got three
failures (3, 4 and 14 pixels). I twice reported them as a pre-existing
local-baseline mismatch against the CI goldens. That was wrong, and the
reasoning that produced it — "they fail identically on pristine HEAD, so
they are not mine" — is only half an argument: it establishes the change
did not cause them, not that they are expected.

They were operator error. CI runs the whole macOS desktop suite with
`PWRSNAP_E2E_DISABLE_GPU: "1"` (ci.yml), i.e. software rendering, and
`pnpm test:desktop-e2e` does not set it. Skia's software path and a real
Apple GPU do not composite antialiased geometry identically. Every flagged
pixel sat on the crossing of two SVG strokes — the Focus close button's
`<path d="M5 5l14 14M19 5L5 19">` at `stroke-width: 2.2` — where the
golden has a grey crossing and the GPU produces a solid black one.

The suite now pins `PWRSNAP_E2E_DISABLE_GPU` itself in
`launchVisualPwrSnap` and asserts the pin landed
(`expectPinnedRasterizer`), mirroring what `expectPinnedDeviceScale`
already did for the backing scale factor. A plain `npx playwright test
visual-regression` now passes on a GPU machine.

Two things worth keeping from how this went wrong:

- **Device scale was already pinned and asserted**, so "it is just a
  Retina display" was ruled out from the start — and checking that is what
  made the real cause findable. `--force-color-profile=srgb` and
  `--disable-lcd-text` also changed nothing, which narrowed it to the
  rasterizer.
- **Read the diff mask, not the pixel count.** A raw comparison showed
  85,220 differing pixels in library-grid, which looks catastrophic; 84,750
  of those differ by 1–3 per channel and are filtered by Playwright's
  perceptual threshold. Only pixelmatch's own 14 flagged pixels pointed at
  the stroke crossings.

## Rules this leaves behind

- **Never read a size from `getBoundingClientRect()` when you are going to
  combine it with a layout measure** (`offsetWidth` / `offsetHeight` /
  `clientWidth`). The rect is post-transform; the others are not. Mixing them
  silently bakes in whatever transform is in flight.
- **A `ResizeObserver` will not save you from a transform.** It reports layout
  box changes. An ancestor animating `transform` fires nothing, so a bad value
  read inside a callback is not merely transient — it is permanent until an
  unrelated real resize happens to occur.
- **A cached `DOMRect` is only valid until something moves.** A
  `ResizeObserver` does not tell you the element MOVED, only that it resized.
  Either re-read at the moment of use, or make the cache's deps include
  whatever brings the consumer on screen.
- **`PWRSNAP_E2E=1` green on Linux proves nothing about animation races.**
  Entrance-animation timing differs per platform, and this class of bug is a
  race, not a font or layout difference.

## Files

- Fix: `apps/desktop/src/renderer/src/features/editor/Editor.tsx`
  (`canvasCssHeight` layout effect).
- Animation: `apps/desktop/src/renderer/src/styles/library.css`
  (`.psl__focus` / `@keyframes psl-focus-in`).
- Consumer: `apps/desktop/src/renderer/src/features/editor/TextHtml.tsx` →
  `text-measure-registry.ts`.
- Guard: `apps/desktop/e2e/editor-text-outline.spec.ts` — center-drift bound
  tightened from `max(3, glyphWidth × 0.02)` to an absolute 1px.
- Prior fix this regressed against:
  `docs/solutions/2026-06-25-text-selection-outline-measure-real-glyph.md`.
