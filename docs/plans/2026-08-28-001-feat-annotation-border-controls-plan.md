# Annotation Border (contrast outline) controls

- **Date**: 2026-08-28
- **Status**: v1 implemented (same-day) on `claude/border-color-controls-8b032c`
- **Design canvas**: Claude Design mockups —
  https://claude.ai/code/artifact/6509fde6-0068-4e22-b5d7-d33e50b81e5b
- **Problem** (operator report): text annotations have no controllable
  contrast border, and arrows/shapes carry a hardcoded always-white
  halo — invisible on white/light screenshots, which is exactly where
  a border is needed most.

## Decisions

1. **One universal control, named "Border" in the UI, `outline` in the
   schema.** Modes: `auto | white | black | stripe | none`. It appears
   in `ToolStyleBody` (so the popover, the right-rail ToolConfigPanel,
   the Library DetailRail Properties tab, and the Layers accordions all
   get it for free) for arrow, shape, and text. Highlight/blur are out
   of scope for v1 — translucent washes have no halo today.
2. **White + black only.** No arbitrary border colors; the border's
   job is contrast, not decoration. `stripe` (white base + black
   dashes) covers mixed backgrounds. Stripe is arrow/shape-only —
   `-webkit-text-stroke` is single-color and a dashed glyph outline is
   illegible at text stroke widths; renderers coerce a stray text
   stripe to solid black (`readTextOverlayOutline`).
3. **No width knob.** Border width stays derived from the annotation
   exactly as the legacy halo was: arrow/shape `max(1.5, stroke×0.25)`
   per side, text `max(1px, fontSize×0.08)` stroke.
4. **Auto = sample-at-edit-time, persist the pick.**
   - The editor samples up to `OUTLINE_AUTO_SAMPLE_COUNT` (100) points
     along the border's own path — arrow stem, shape perimeter, text
     body-box ring — from the capture's **base raster**, takes the
     **median** BT.601 luma, and picks black when it exceeds
     `OUTLINE_AUTO_LUMA_THRESHOLD` (160; mid-grays keep the historical
     white halo), else white. Spec lives in
     `packages/shared/src/outline-auto.ts`; pixel access in
     `apps/desktop/src/renderer/src/features/editor/outline-auto-sampler.ts`.
   - The resolved pick is **persisted** as `outlineAuto` on the row at
     placement, on Border-mode edits, and re-sampled after single-drag
     geometry commits. The bake reads stored row data only — preview
     and export agree by construction, and the render cache stays a
     pure function of (row data + source), no sampling in main.
   - Sampling degrades safely: a cold/unreadable sampler omits
     `outlineAuto` and renderers fall back to the legacy-look color
     (white for arrow/shape, black for text).
5. **Back-compat is byte-exact.** `outline` is optional; rows without
   it resolve to `{kind:"legacy"}` in `readOverlayOutline` and every
   renderer emits its historical output byte-identically (pinned by
   the pre-existing bake tests passing unchanged). No
   `BAKE_PIPELINE_VERSION` bump. Legacy per-kind looks: arrow/stroked
   shape = solid white halo; filled shape = no rim; text = translucent
   `rgba(0,0,0,0.6~0.7)` stroke.
6. **New annotations default to Auto** (`editor.toolStyles.*.outline:
   "auto"` in settings defaults) — the always-white halo is the bug
   this feature exists to fix.
7. **CORS enablement for pixel reads.** The renderer's document origin
   differs from `pwrsnap-capture://`, so canvas reads of the capture
   image would be tainted. `protocol-file-response.ts` now serves
   `access-control-allow-origin: *` and the sampler loads its own
   `crossorigin="anonymous"` image (the display `<img>` is untouched).
   Pinned end-to-end by `e2e/editor-border-outline.spec.ts` — if the
   header regresses, Auto-on-white stops resolving black and the spec
   fails.

## Surfaces touched

- Schema + read helpers + stripe dash math + sampling spec:
  `packages/shared/src/overlay-schemas.ts`, `outline-auto.ts`,
  `protocol.ts` (tool styles), `text-html-style.ts` (outline arg).
- Bake: `compose.ts` (arrowSvg/shapeSvg/textSvg), `text-html-bake.ts`.
- Editor: `OverlaySvg.tsx` (glyph halos + stripe + draft), `TextHtml*`,
  `TextDraftInput` + `text-draft-style.ts`, `Editor.tsx` (commit
  stamps, `layerStyleUpdate` outline case, post-drag re-sample, live
  draft sampling), `outline-auto-sampler.ts` (new),
  `styled-layer-style.ts`, `ToolStylePopover.tsx` (Border row).
- Settings: defaults + parse + validators.

## Known v1 limits / follow-ups

- Auto samples the **base raster only** — pasted raster layers, effect
  layers, and annotations underneath don't vote. Manual White/Black is
  the escape hatch.
- Post-move re-sampling covers single-select transform-handle drags;
  multi-drag translations and keyboard nudges keep the stored pick
  until the layer is next touched. Undoing a move also keeps the
  post-move pick (derived state is not an undo entry).
- Live Auto flip during a drag applies to NEW drafts; dragging an
  existing layer shows the stored color until commit re-samples.
- **Text background chip** (filled pill behind text, bordered with the
  same setting) is designed in the canvas as "Later": it needs
  measured text bounds in the bake (main has no text metrics), likely
  via renderer-measured bbox persisted on the row — same pattern as
  `sizePx`.
- Stripe on `dotted` stems halves each dot; visually fine but worth a
  look if someone reports it.
