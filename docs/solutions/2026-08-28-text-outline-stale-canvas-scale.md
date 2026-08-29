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

| quantity | before | after |
|---|---|---|
| `canvasCssHeight` state | 776.405 | 783.75 |
| `.editor-canvas` layout height (`style.height`) | 783.75px | 783.75px |
| glyph width | 469.945 | 477.0 |
| outline inner width | 477.157 | 477.0 |
| **outline center drift** | **2.42px** | **0.00px** |

`477.157 / 470 = 1.015228` and `783.75 / 776.405 = 1.015228` — the width error
is exactly the staleness ratio.

The `ResizeObserver` log confirms the mechanism. Only two callbacks ever fire,
and the second one already sees the final layout height while the rect lags:

```
{ ev: "effect-run", h: 0 }
{ ev: "update", h: 0,       offsetH: 0,   clientH: 0,   styleH: ""        }
{ ev: "update", h: 776.405, offsetH: 784, clientH: 784, styleH: "783.75px" }   ← rect ≠ layout
```

`776.405 / 783.75 = 0.9906`, i.e. mid-way through `scale(0.985) → scale(1)`.
Forcing a real window resize later delivers a third callback, the state
corrects, and the drift falls to 0.005px — which is what made "it never
self-heals, but any resize fixes it" the tell.

The magnitude varies run to run (observed 2.415, 2.417, 3.606) because it is a
race against the animation clock.

## Two hypotheses this replaced — both wrong, both plausible

Recorded because they were each load-bearing in a comment somewhere, and both
survived review by sounding right.

### 1. "A 2D canvas can't resolve `-apple-system`, so `measureText` silently
picks a different face."

This claim lived in `text-measure-registry.ts`'s module doc and in
`editor-text-outline.spec.ts`. **It is false.** Measured on macOS, at equal
font size, `measureText` and the laid-out `<div>` agree to **0.013%** inside
Electron and **0.002%** in standalone Chromium, across 16–40px and weights
400/600.

### 2. "The analytic fallback is being used instead of the published
measurement."

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

## Rules this leaves behind

- **Never read a size from `getBoundingClientRect()` when you are going to
  combine it with a layout measure** (`offsetWidth` / `offsetHeight` /
  `clientWidth`). The rect is post-transform; the others are not. Mixing them
  silently bakes in whatever transform is in flight.
- **A `ResizeObserver` will not save you from a transform.** It reports layout
  box changes. An ancestor animating `transform` fires nothing, so a bad value
  read inside a callback is not merely transient — it is permanent until an
  unrelated real resize happens to occur.
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
