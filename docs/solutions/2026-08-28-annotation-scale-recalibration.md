# Annotation scale recalibration — one basis for text, arrows, and shapes

**Date:** 2026-08-28
**Owner:** [packages/shared/src/annotation-scale.ts](../../packages/shared/src/annotation-scale.ts)
**Pinned by:** [annotation-scale.test.ts](../../packages/shared/src/__tests__/annotation-scale.test.ts)
**Visual harness:** [apps/desktop/scripts/annotation-scale-eval.mjs](../../apps/desktop/scripts/annotation-scale-eval.mjs)

## The report

> "I went to create text on auto size and look at it… it's SUPER SMALL."
> "I have previously noticed that our arrow size for S / M are basically
> useless ratios and XL is not big enough."
> "We might have an error in which side length we use to determine the
> size or the ratio is just off."

Both, as it turned out. The reporting capture was a 777×207 Slack
notification grab; the text overlay it carried had `sizePx: 6.9`, against
Slack's own 15 px message font in the same image.

## What was wrong

### 1. Short side is the wrong scale reference

Every annotation sized itself off `min(width, height)`. That collapses on
wide-short and tall-thin captures, which are extremely common (a
notification strip, a toolbar, a sidebar, a cropped row):

| capture | short side | medium text (old) | UI text in the image |
|---|---|---|---|
| 777×207 Slack strip | 207 | **6.9 px** | ~15 px |
| 473×178 dialog crop | 178 | **5.9 px** | ~30 px (2×) |
| 200×80 button crop | 80 | **2.7 px** | ~15 px |
| 2212×249 toolbar | 249 | **8.3 px** | ~30 px (2×) |

The annotation was smaller than the content it annotated — the one thing
an annotation may never be.

### 2. Absolute pixel clamps flattened the preset ladder

The arrow/shape auto stroke was `clamp(shortSide / 220, 4, 14)`, and the
presets were multipliers on it with a short-side floor rescuing only the
top two rungs:

```
small   = max(auto × 0.5, shortSide × 0.003)
medium  = auto
large   = max(auto × 2,   shortSide × 0.012)
x-large = max(auto × 3,   shortSide × 0.020)
```

Because `auto` pinned to exactly **4 px for every capture with a short
side under 880 px** — i.e. most window grabs — Small and Medium resolved
to 2 px and 4 px on a 777×207 grab, a 1200×800 grab, and a 473×178 grab
alike. Two presets, one behavior, no scaling with the image. Large and
X-Large escaped through their floor fractions and landed far away, so on
1080p the ladder read:

```
3.2  →  4.9  →  13.0  →  21.6      (×1.5, ×2.7, ×1.7)
```

That uneven middle step is exactly the "S and M are on a scale all by
themselves" the report describes.

### 3. Two more things fell out of the audit

- **Text had no X-Large.** `ToolSizePreset` carried `"x-large"` (shared
  with arrow thickness), but the text popover hid it and three separate
  call sites silently coerced it to `"large"`.
- **The bake and the editor disagreed on stroked shapes.** The editor
  resolved an auto shape stroke through `shapeAutoStrokeWidthPx`
  (`min(short×0.012, max(short×0.003, 8))` → 8 px on 1080p) while
  `compose.ts shapeSvg` ran its own `clamp(short/220, 4, 14)` → 4.9 px.
  Invisible in the editor; only the exported PNG differed.

## The fix

One number per capture, which everything divides:

```ts
annotationBasisPx(w, h) = max(900, min(w, h), hypot(w, h) / 2)
```

- `min(w, h)` — the historical term. Wins for anything squarer than
  ~1.73:1, which is what keeps mainstream captures rendering the sizes
  users already have dialed in (1080p medium text moves 36 → 36.7 px).
- `hypot(w, h) / 2` — takes over past ~1.73:1, where the short side stops
  describing how big the image reads. A 2212×249 toolbar is a big image;
  its 249 px height says otherwise, and diagonal/2 says 1113.
- `900` — the floor. Below it, annotation size stops scaling and goes
  absolute, because the UI text inside a small crop is the same size as
  in any other screenshot: text size is a property of the display, not of
  the crop rectangle.

Then two even geometric ladders off that basis:

```
stroke:  basis / 160,  / 105,  / 68,  / 44     (~1.53× per rung)
text:    basis /  50,  /  30,  / 18,  / 11     (~1.66× per rung)
```

`auto` **is** the Medium rung now, by construction rather than by
coincidence — for arrows and shapes alike.

Resulting sizes (this table is asserted in the test file, so retuning a
constant shows up in review as a diff of real pixel sizes):

```
capture                       dims       ui   basis    text S/M/L/XL          stroke S/M/L/XL
Slack notification strip (1x) 777x207    15     900   18.0  30.0  50.0  81.8   5.6   8.6  13.2  20.5
Tiny button crop (1x)         200x80     15     900   18.0  30.0  50.0  81.8   5.6   8.6  13.2  20.5
Small dialog crop (2x)        473x178    30     900   18.0  30.0  50.0  81.8   5.6   8.6  13.2  20.5
Toolbar strip (2x)            2212x249   30    1113   22.3  37.1  61.8 101.2   7.0  10.6  16.4  25.3
Tall sidebar (2x)             366x832    30     900   18.0  30.0  50.0  81.8   5.6   8.6  13.2  20.5
Phone screenshot (portrait)   1080x2400  30    1316   26.3  43.9  73.1 119.6   8.2  12.5  19.4  29.9
App window (1x)               1200x800   15     900   18.0  30.0  50.0  81.8   5.6   8.6  13.2  20.5
App window (2x)               1876x1410  30    1410   28.2  47.0  78.3 128.2   8.8  13.4  20.7  32.0
1080p full screen (1x)        1920x1080  15    1102   22.0  36.7  61.2 100.1   6.9  10.5  16.2  25.0
MacBook full screen (2x)      2880x1800  30    1800   36.0  60.0 100.0 163.6  11.3  17.1  26.5  40.9
5K full screen (2x)           5120x2880  30    2937   58.7  97.9 163.2 267.0  18.4  28.0  43.2  66.8
```

## Why not `device_pixel_ratio`

It is the theoretically correct input — a 2× capture's UI text is twice
as tall in raster pixels as a 1× capture's, and no function of (w, h) can
tell the two apart. Two things rule it out:

1. **It isn't trustworthy.** The 777×207 capture that prompted this work
   is stamped `device_pixel_ratio = 2.0` in SQLite while its content is
   measurably 1× (Slack's 15 px message font occupies ~15 raster px — a
   4× zoom shows soft, upscaled 1× glyphs). Video records hardcode 1;
   `pwrsnap-import-service` hardcodes 1; `capture-handlers` defaults to 2.
2. **It isn't portable.** `.pwrsnap` bundles carry `canvas_dimensions`
   but no scale factor, so a bundle opened on another machine would size
   its annotations differently than the machine that wrote it — a WYSIWYG
   break in the one place we've worked hardest to guarantee
   preview == export.

A pure function of (width, height) is deterministic, portable, and
re-derivable from the bundle alone. The floor is what absorbs the
resulting 1×/2× ambiguity: it was chosen by rendering the ladder over
both content scales and picking the midpoint of the band that reads
correctly in each.

## How the floor value was chosen

Not by taste alone. The harness renders every rung over a synthetic UI
screenshot whose body copy is set at a realistic UI font size, so each
annotation can be judged against the thing annotations actually sit next
to:

```bash
node apps/desktop/scripts/annotation-scale-eval.mjs --out /tmp/eval
```

It writes one before/after PNG per capture shape plus an `index.html`.
`--base <png> --dims WxH` swaps in a real capture instead of the mock.

Floors of 800 / 1000 / 1200 were rendered across the 1× Slack strip and a
2× dialog crop. 800 read well at 1× and slightly small at 2×; 1000 was
the reverse; 900 is the midpoint that works in both, and maps to a
memorable reference — *annotate anything smaller than a 1600×900 window
as if it were one.*

## Two subtleties in the wiring

**Source dims, not canvas dims.** Crop is a viewport change in v2, so
canvas dims shrink with every crop while source dims don't. Deriving the
basis from canvas dims would re-thin an arrow each time the user cropped
around it — the stroke-width version of the text-shrink bug
pwrdrvr/PwrSnap#110 fixed. `OverlaySvg` computes the basis once at its
root from `sourceWidthPx/sourceHeightPx` and threads it into every glyph;
the hit-test and the drag rect read the same number so the grabbable
region tracks the painted line.

**× renderScale in the bake.** The SVG renderers draw into a render-dims
viewBox, so `compose-tree-vector` passes
`annotationBasisPx(source) × renderScale`. Re-deriving from render dims
would break whenever the floor binds on one side of the scale and not the
other: a 473×178 capture floors at 900 whether baked at 1× or upscaled to
the 800-wide LOW tier, so its arrows would export proportionally thinner
than the preview painted them. `computeArrowGeometry`, `arrowSvg`, and
`shapeSvg` all take an explicit `basisPx` for this reason.

## What this deliberately broke

Per the user's call ("I'm not worried about breaking people… we have like
5 users"), the recalibration is **retroactive**: existing captures
re-bake at the new sizes on next load. The arrow style-version table
(`ARROW_STYLE_VERSIONS`) still pins head SHAPE across time — that is what
it is for — but it no longer carries stroke sizing, which is now a single
global ladder. Its `STROKE_DIVISOR` / `STROKE_MIN_PX` / `STROKE_MAX_PX`
fields are gone.

The `LENGTH_DIVISOR` long-arrow bump survives but is now provably inert
for any arrow that fits inside the canvas: `basis ≥ diagonal/2` means the
auto stroke is at least `diagonal/210`, while the length term is at most
`diagonal/250`. It is kept only for arrows whose endpoints sit outside
the canvas after a crop (legal — see `NormalizedScalar`).

## If you retune this

1. Change the constant in `annotation-scale.ts`.
2. Run `pnpm vitest run --project shared annotation-scale` and READ the
   printed matrix. Every row is a capture shape someone actually has.
3. Run the visual harness and look at the before/after PNGs — the numeric
   matrix tells you what changed, not whether it looks right.
4. Update the hardcoded `EXPECTED` table in the test in the same commit.
