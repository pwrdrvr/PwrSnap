# Agent rules: Annotation sizing and draw strokes

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Annotation sizing — one basis, one ladder

**Every sized annotation — text glyphs, arrow stems + heads, shape
strokes — divides ONE number: `annotationBasisPx(sourceW, sourceH)`.
No call site invents its own scale reference, and no call site sizes
off the image's short side.** Owner:
[packages/shared/src/annotation-scale.ts](../../packages/shared/src/annotation-scale.ts).

```
basis  = max(900, min(w, h), hypot(w, h) / 2)
stroke = basis / (160 | 105 | 68 | 44)     // S / M / L / XL, ~1.53× step
text   = basis / ( 50 |  30 | 18 | 11)     // S / M / L / XL, ~1.66× step
```

`auto` IS the Medium rung, for arrows and shapes alike.

Three rules that are easy to get wrong:

- **Pass SOURCE raster dims, never canvas dims.** Crop is a viewport
  change in v2, so canvas dims shrink on every crop. Sizing off them
  re-thins an arrow (or re-shrinks text — that was
  pwrdrvr/PwrSnap#110) each time the user crops around it.
- **Scaled bakes multiply the basis by `renderScale`**, they do not
  re-derive it from render dims. The basis has a FLOOR, and a floored
  capture would otherwise export proportionally thinner than the
  preview painted it. `computeArrowGeometry`, `arrowSvg`, and
  `shapeSvg` all accept an explicit `basisPx` for this.
- **Don't reach for `device_pixel_ratio`.** It's untrustworthy (the
  capture that prompted this work is stamped 2.0 with measurably 1×
  content; imports and video records hardcode 1) and it isn't in the
  `.pwrsnap` bundle, so using it would make the same bundle render
  differently on another machine.

Retuning any constant re-bakes every existing annotation at that
preset — deliberate, per the 2026-08 recalibration. Read the printed
size matrix in
[annotation-scale.test.ts](../../packages/shared/src/__tests__/annotation-scale.test.ts)
and run the visual harness
(`node apps/desktop/scripts/annotation-scale-eval.mjs`) before and
after; update the test's hardcoded table in the same commit.

Full history, the measurements, and why short side + absolute px
clamps failed:
[docs/solutions/2026-08-28-annotation-scale-recalibration.md](../../docs/solutions/2026-08-28-annotation-scale-recalibration.md).

## Draw strokes — one geometry, canvas-normalized points

**The Draw tool (key D: pen, marker, airbrush, eraser) stores a vector
`stroke` shape, and everything that paints one goes through
`strokeGeometry` in
[packages/shared/src/freehand-stroke.ts](../../packages/shared/src/freehand-stroke.ts).**
The editor renders that geometry as JSX (`StrokeGlyph` in
`OverlaySvg.tsx`), and the bake serializes the same geometry as SVG text
(`strokeSvgForV2` in `compose.ts`). Pinned by
[freehand-stroke.test.ts](../../packages/shared/src/__tests__/freehand-stroke.test.ts),
[OverlaySvg-stroke.test.tsx](../../apps/desktop/src/renderer/src/features/editor/__tests__/OverlaySvg-stroke.test.tsx)
and [stroke-bake.test.ts](../../apps/desktop/src/main/render/__tests__/stroke-bake.test.ts).

- **Points are fractions of the CURRENT canvas, like every other
  overlay coordinate**, so crop re-normalizes them
  (`inverseTransformOverlayByCrop`). The width is sized from the SOURCE
  basis (`strokeWidthPx` → `annotationBasisPx`), so a crop never re-thins
  a stroke. The pen is the arrow ladder exactly; marker and airbrush are 3×
  it (`STROKE_WIDTH_FACTORS`).
- **Every tool is one path along `points`; the airbrush is that path
  stroked five times.** Its soft edge is `AIRBRUSH_BANDS`: concentric
  round-capped strokes of the same centerline, widest and faintest first,
  whose alphas are chosen so the stack composites to an even ramp ending
  in a solid core. No filter (resvg and Chromium blur differently, and
  the bake would stop matching the preview), no randomness, nothing
  stored beyond the points. A scaled bake wraps the 1× geometry in
  `scale()` like every stroke. The first version was a seeded particle
  spray; it was replaced because a few hundred dots per stroke cost far
  more to store, paint and erase than a soft line, and a cut re-scattered
  the dots beside it.
- **The eraser cuts only strokes, and a cut stroke stays ONE layer.** The
  eraser is a mode of the Draw tool, never a shape and never a bag slot
  (settings refuse one). What it leaves of a stroke are SEGMENTS of that
  one row (`breaks` indexes the flat `points`; read them through
  `strokeSegments`), at the original's z_index. A stroke erased whole is
  deleted. The first build wrote every piece as its own row, and one
  scrub across a page of strokes filled the Layers panel with dozens of
  them. Each segment still paints on its own (`strokeGeometries`), so a
  cut never changes how the rest of the stroke looks. One eraser drag is
  ONE undo step (the `replace` op in `useUndoRedo.ts`). The original is
  deleted only after its replacement is written. An earlier build
  deleted it regardless while every write was being refused (a 21-char
  `nanoid()` id; the bundle schema takes 16), so one swipe erased the
  whole stroke. The jsdom test missed that because its dispatch stub
  accepted anything; it now validates upserts against `BundleLayerNode`.
  Masking was considered and rejected: a mask layer leaves its holes
  behind when a stroke moves, and no ink or markup app erases that way.
- **Nothing a drag does per pointer event may scale with what was drawn
  before it.** A page of handwriting is hundreds of strokes and a long
  stroke is thousands of samples, so per-event work that touches the
  whole stroke, or every stroke, goes quadratic and lags. Three rules:
  - **The live stroke is appended in place.** `DraftStroke.points` is one
    array for the whole drag, and `count` says how much of it to draw;
    never `slice()` it per event. A long draft paints frozen spans plus a
    live tail (`useLiveStrokeSpans` in `OverlaySvg.tsx`, built on
    `smoothStrokeSpanD`). A span's sections are final once the next point
    exists, so its `d` is built once. The spans overlap by one section
    inside a group that carries the opacity, so the joints show no seam.
    Opacity on a span instead of the group would double it at every
    joint.
  - **The eraser cuts with each move's new samples only**
    (`StrokeEraseSession`), against the pieces earlier moves left, and
    only for strokes whose box the new segments reach. The preview shows
    the session's pieces and the release commits them. No second pass
    over the whole drag runs anywhere, so the two cannot disagree.
  - **The bake paints adjacent arrows, shapes and strokes as one SVG
    run** (`compositeSvgRunOntoAccumulator` in `compose-tree.ts`). Every
    sharp composite rewrites the whole accumulator, so one pass per
    stroke made a 150-stroke page at 4K take ~2.9 s; as one run it takes
    ~0.1 s. Text, highlights, rasters and effects end a run.
- **A burst of strokes is one layer.** A stroke started within
  `STROKE_BURST_GAP_MS` of the last one ending, in the same tool, color
  and weight, joins the layer that stroke landed in as another segment,
  if it is still the top layer (`stroke-burst.ts`). It names that layer
  by id, not "whatever stroke is on top": after an ⌘Z the top stroke can
  be an older one the burst never touched. Each stroke stays its own undo step: the
  join is written as a `replace`, so ⌘Z takes back one stroke, not the
  burst. Each segment paints on its own, so a burst looks exactly like
  the separate strokes it holds, crossings included.
- **A Draw press does not select what it lands on.** Freehand marks go on
  top of other annotations, and the eraser is dragged across strokes on
  purpose. A finished stroke is not auto-selected either, unlike the other
  tools, so the property bar stays on the pen while the user writes.
- **Older builds cannot parse a `stroke`.** What that costs is written up
  in [docs/architecture.md](../../docs/architecture.md) §"Storage: data, not
  pixels". Read it before adding the next shape kind.
