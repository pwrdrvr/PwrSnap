# Text selection outline mis-sizes — measure the real glyph, don't re-derive it

**Date:** 2026-06-25
**Symptom:** Select a text annotation in the editor and the dashed
selection outline doesn't hug the glyphs — usually too wide (right edge
floats past the end of the text), sometimes too narrow on wide-capital
text. The transform-handle drag rect, the rotation pivot, and the
pointer hit-test (all sized from the same box) drift with it. This bug
has been "fixed" several times and kept coming back — see
[#253](https://github.com/pwrdrvr/PwrSnap/pull/253) and the earlier
HTML-text unification.

## Root cause

The editor renders persisted text as **HTML** — an absolutely-positioned
`<div>` ([TextHtml.tsx](../../apps/desktop/src/renderer/src/features/editor/TextHtml.tsx)
via `computeTextHtmlStyle`), laid out by Chromium's HTML/Core Text
pipeline. The dashed outline is **SVG** — a `<rect>` in the chrome SVG
inside [OverlaySvg.tsx](../../apps/desktop/src/renderer/src/features/editor/OverlaySvg.tsx),
drawn in an image-pixel `viewBox`. Two different rendering technologies,
two different DOM trees, two different coordinate systems.

`textBoundsBox` bridged them by **re-deriving** the glyph's size
analytically: bucket → fontSize, then `canvas.measureText()` for the
width. The fatal detail: a canvas 2D context does **not** resolve the
`-apple-system, BlinkMacSystemFont` font stack the way the DOM does —
it silently falls back to a default font, so `measureText` returns a
width for the *wrong* font and the outline never matches the rendered
`<div>`.

The deeper problem is structural: **any** independent re-computation of
the text box has to stay bit-for-bit in lockstep with how Chromium
actually lays the glyph out (font resolution, kerning, `line-height: 1`,
multi-line, whitespace). It never does for long. That's why each
point-fix (char-count advance → `measureText` → tweaks) drifted again.

## Fix — invert the dependency: measure the live element

The glyph is already a real, laid-out `<div>` on screen, so it is the
source of truth. Don't re-derive — read it.

- [text-measure-registry.ts](../../apps/desktop/src/renderer/src/features/editor/text-measure-registry.ts):
  a module-level store mapping overlay id → measured natural box (in
  **image px**), with `reportGlyphSize` / `getGlyphSize` / `clearGlyphSize`
  and a `useGlyphSize` hook (`useSyncExternalStore`, with a
  stable-reference dedup so a no-change report doesn't churn renders).
- `TextHtml` measures its glyph div's `offsetWidth`/`offsetHeight`
  (these are **transform-independent** — the CSS `rotate()` on the
  wrapper doesn't perturb them, so the un-rotated box falls out for
  free) and publishes it. CSS px → image px via the canvas's uniform
  scale (`canvasCssHeight / imageHeightPx`). A `ResizeObserver`
  re-publishes on edit / resize / font reflow; the box clears on
  unmount.
- `textBoundsBox` (and therefore the SelectionOutline, the
  TransformHandles body rect + rotation pivot, and the Editor pointer
  hit-test) read the published box and fall back to the old analytic
  estimate **only** on the first frame before measurement lands and in
  jsdom (no layout).

This is the same principle the tray + float-over popovers already use
(see CLAUDE.md "Tray + float-over popover sizing — outer `inline-block`
measurer"): **measure the real element, don't compute it.** Once the
outline is sourced from the same box the user sees, there's nothing left
to drift against.

## Why the obvious worries don't apply here

- **Zoom:** `useZoomPan` is a "canvas grows" model — zoom changes the
  canvas element's CSS width/height; pan is a pure `transform:
  translate(...)`. There is **no `scale()` transform**, so `offsetWidth`
  (transform-independent) and `canvasCssHeight` (from
  `getBoundingClientRect`) stay in the same space and the CSS↔image-px
  conversion holds at any zoom.
- **`overflow: hidden` clipping** (the trap from the popover lesson)
  affects `getBoundingClientRect` / `scrollHeight`, **not**
  `offsetWidth`/`offsetHeight` — the latter report the element's own
  border-box layout size regardless of ancestor clipping.
- **Rotation:** handled by `offsetWidth`/`offsetHeight` being
  pre-transform; the consumers apply rotation themselves around the
  box center, exactly as before.

## Tests

- `text-measure-registry.test.ts` — store behavior incl. the
  stable-reference dedup invariant `useSyncExternalStore` relies on.
- `OverlaySvg.test.tsx` — seeds the registry and asserts the outline
  `<rect>` tracks the published measured box, plus an analytic-fallback
  case.
- `editor-text-outline.spec.ts` (E2E) — the only layer that exercises
  real `offsetWidth` (jsdom layout is 0): creates text in a real
  Chromium editor, selects it, and asserts the selection-outline rect
  hugs the rendered glyph.

## If you're back here again

If the outline mis-sizes once more, the regression is almost certainly a
change that went **back** to computing the box instead of reading
`getGlyphSize(id)` — or a `TextHtml` change that stopped publishing
(check `reportGlyphSize` still fires and isn't guarded out by a zero
`canvasCssHeight`). Don't add another font-metric heuristic; keep the
outline sourced from the live element.
