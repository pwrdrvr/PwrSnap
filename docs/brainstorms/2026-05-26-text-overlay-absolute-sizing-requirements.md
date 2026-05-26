---
date: 2026-05-26
topic: text-overlay-absolute-sizing
---

# Text Overlay Absolute Sizing (with "Custom" UI bucket)

## Problem Frame

Text overlays store size as a UI bucket (`"small" | "medium" | "large"`) and
resolve it to pixel height at render time using the **current** canvas's
short side: `sizePx = canvasShortSide / DIVISORS[size]`. That formula has
two failure modes, both fallout from the PR #110 crop-as-viewport work:

1. **Crop-time drift (fixed for now in commit `881cff0`):** when the user
   crops a v2 capture, the canvas shortSide shrinks and the SAME stored
   `"medium"` re-renders at a smaller absolute size. The text appears to
   "move" relative to the underlying image — the body shrinks horizontally,
   more chars fit before the canvas right edge, the user perceives the crop
   as wider than they drew it.

   Workaround in `881cff0`: derive `sizePx` from the SOURCE raster's
   shortSide (constant across crops) instead of the canvas's. Text stays put
   through edits.

2. **Cross-capture divergence (introduced by the `881cff0` workaround):** a
   capture cropped from 2880×1920 → 2294×1239 renders `"medium"` at 64
   source pixels tall, but a capture **natively** captured at 2294×1239
   renders `"medium"` at 41 source pixels tall. Two visually-identical
   canvases interpret the same UI bucket differently. Invisible side-by-
   side, but conceptually wrong — `"medium"` should mean the same thing
   for the same canvas.

The right long-term fix is to **store the resolved pixel height alongside
the bucket enum** so the absolute size becomes a row-level fact at
placement time. Both invariants then hold:

* Through edits (crop, paste): text stays the same physical size — the
  stored px doesn't change.
* Across captures: `"medium"` on a freshly captured 2294×1239 image
  renders at 41 px; on a cropped-to-2294×1239 image, the stored px is
  whatever it was at placement time, which is a row-level decision the
  user can re-bucket via a UI affordance.

When a row's stored `sizePx` doesn't match any of the current canvas's
bucket values (within tolerance), the tool popover surfaces a 4th option
labeled **"Custom"** so the user knows their text is "between" the named
buckets. Clicking S / M / L from the popover re-snaps `sizePx` to that
bucket's value for the current canvas — the text resizes on screen.

## Requirements

* **R1.** TextOverlay rows persist an absolute pixel size in source-pixel
  units. The existing bucket enum stays as the user's last UI intent.
* **R2.** Rendering (editor preview, bake, draft input) reads the absolute
  size when present; falls back to the legacy bucket-resolve for older
  rows without an absolute size persisted yet.
* **R3.** Cropping a capture does NOT modify the stored absolute size on
  any existing text overlay (the source-pixel size is invariant under a
  crop, which is a viewport change).
* **R4.** The tool-style popover for text shows a **"Custom"** indicator
  when the row's stored absolute size doesn't match any of the current
  canvas's bucket values within tolerance. Custom is not directly
  clickable — it's a state read-out.
* **R5.** Clicking S / M / L from the popover snaps the stored absolute
  size to that bucket's value for the **current** canvas. The text
  resizes on screen.
* **R6.** Existing rows without an absolute size persisted yet (legacy
  rows, including all rows created before this change ships) parse and
  render unchanged: rendering uses the bucket + current canvas formula
  exactly as before this change. The absolute size is persisted only
  when the row is re-saved through a user action (e.g. a popover click,
  a drag, a body edit).
* **R7.** The "Custom" indicator is purely visual UI state — it is NOT a
  new value in the persisted bucket enum. The schema's bucket enum stays
  `"small" | "medium" | "large"`.

## Success Criteria

* A text overlay placed at "medium" on an uncropped capture, then cropped,
  renders at the same absolute pixel size before and after the crop —
  whether the bake or the editor view. (R3)
* A user who crops a capture and re-opens the text popover sees "Custom"
  surfaced for their existing text, with the original S/M/L still
  visually selectable. (R4, R5)
* Clicking S, M, or L from "Custom" state visibly resizes the text on
  screen and updates the persisted size. (R5)
* Legacy text overlays from before this change render at exactly the
  same on-screen size as they did before the change. (R6)
* A native 2294×1239 capture and a cropped-to-2294×1239 capture both
  display their respective "medium" text at the bucket-correct absolute
  size for the action that placed that text (placed-natively-on-2294 =
  41 source px; placed-on-2880-then-cropped = 64 source px). The
  divergence is intentional and the popover surfaces it via "Custom"
  when applicable.

## Scope Boundaries

* **Not** adding a new bucket value to the persisted schema. "Custom" is
  UI-only.
* **Not** adding an "Auto" bucket to text size (text doesn't have one
  today; the user's mention of "Auto" was by analogy to arrow/rect/highlight,
  not a request for parity).
* **Not** retroactively migrating existing rows in a one-shot script.
  Existing rows persist their absolute size lazily on the next user
  action that touches the row.
* **Not** changing the bucket divisors (50 / 30 / 18 stay).
* **Not** addressing the Phase 5 paste-image flow's "source raster
  changes" interaction — covered in `Outstanding Questions` as a
  deferred item.

## Key Decisions

* **D1: Store source-pixel size on the row, not viewBox or CSS.** Source
  pixels are the invariant unit in v2 (crop is a viewport change, no
  resampling), so storing px in source-pixel units survives crops
  trivially. ViewBox units depend on canvas dims and would have the
  same bug. CSS pixels depend on display zoom.
* **D2: Keep the bucket enum as "user intent", not "resolved size".**
  Decoupling intent from resolved px is what makes "Custom" surface
  cleanly — the bucket records "user clicked Medium last", the px
  records "what the row actually is". Re-clicking M re-couples them
  for the current canvas.
* **D3: Lazy migration, no batch.** Legacy rows continue to work via
  the bucket-resolve formula until they're touched by a user action.
  Avoids a schema-version bump and a one-shot migration script for a
  cosmetic difference most users won't notice.
* **D4: "Custom" is UI-only.** Persisting "custom" as a 4th enum value
  would require a schema-version bump AND a reverse mapping ("which
  bucket was this 'custom' closest to before"). Cheaper to compute
  the Custom-or-bucket label from the stored sizePx + current canvas
  dims at popover-render time.

## Dependencies / Assumptions

* The bake pipeline (`apps/desktop/src/main/render/compose.ts` `textSvg`)
  and the live-typing draft input (`TextDraft.tsx`) both also derive
  sizing from canvas shortSide today. They will need the same
  source-shortSide + sizePx-override treatment for the editor view,
  bake, and draft to stay aligned. Planning will decide whether all
  three land together or staged.
* The raster layer's `natural_width_px` / `natural_height_px` are
  invariant across crops in v2 — verified by the PR #110 work. This
  feature relies on that invariant for "source dims" to be a stable
  reference.

## Outstanding Questions

### Resolve Before Planning

(none — all product decisions captured.)

### Deferred to Planning

* **[Affects R4][User decision]** What tolerance defines "matches a
  bucket" for the Custom label? Strict equality is brittle (floating
  point + bucket re-evaluation after crops will rarely hit exact
  values). 1 source-pixel slack? 5% of bucket value? Round-to-nearest-
  bucket-and-compare? Decide during plan or implementation.
* **[Affects R2][Technical]** Where does `sizePx` live on the schema?
  Add as an optional field on `TextOverlay`? Default null/undefined?
  Does the v2 layer-tree representation need a parallel field, or does
  `VectorLayer.shape` carrying the same `TextOverlay` shape suffice?
* **[Affects R6][Technical]** When does the lazy migration fire? On
  popover open? On any geometry/style update? On overlay re-render?
  Cheapest answer is "next time a user action touches the row", but
  pinning the exact trigger needs a code read.
* **[Affects R3][Technical]** Bake pipeline + draft input + editor
  preview should all share the resolved-size source of truth. Planning
  needs to confirm there's one shared helper (`text-glyph-size.ts`
  already exists for editor; bake has its own copy) and either unify
  them or extend both.
* **[Affects R1][User decision / Needs research]** Phase 5 paste-image
  flow: when a user pastes a *different* raster into the bundle, the
  bundle's raster `natural_*_px` can change. Does the existing text's
  stored `sizePx` (in source pixels) stay anchored to the OLD raster's
  pixel scale, the NEW one, or become Custom for both? Likely "stay
  anchored to whatever raster it was placed against" but defer until
  Phase 5 actually ships.
* **[Affects R4][Needs research]** Does the tool-style popover have
  room for a 4th option visually? Or does Custom render as a label
  *above* the S/M/L row rather than alongside?

## Next Steps

→ `/ce:plan` for structured implementation planning
