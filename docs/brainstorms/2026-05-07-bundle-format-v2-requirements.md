---
date: 2026-05-07
topic: bundle-format-v2
---

# Bundle Format v2 — Multi-Source Canvas + Layer Tree + Contextual Effects

## Problem Frame

PwrSnap's current bundle format ([Phase 1](docs/plans/2026-05-07-001-feat-pwrsnap-bundle-storage-plan.md), v1) ships an excellent screenshot annotator: one immutable source PNG, a flat overlay array (arrow / rect / text / blur / highlight / step / crop), one composite. The data model assumes **source == canvas** — overlay coordinates normalize to source W×H, and `OVERLAY_RENDER_ORDER` bakes a single fixed composite.

The product trajectory is wider than screenshot annotation: users will copy images and paste them onto a canvas, position multiple draggable images simultaneously, layer compound documents, and apply blur/highlight as *live effects* that recompute based on whatever sits below them. Three specific shapes the v1 format can't carry:

- **Multi-source documents** — a stitched panorama or "drop my logo onto this screenshot" has N source images on a shared canvas. The bundle holds exactly one `source.png`.
- **Independent layer transforms** — each pasted image needs its own position / rotation / scale / opacity / blend mode / mask. The flat overlay array has none of these.
- **Contextual effects** — blur and highlight today bake into the composite at fixed source-pixel positions. Users intuitively expect "move the photo below the blur and the blur follows the photo." That's an adjustment-layer model: the effect samples what's beneath it at composite time.

Without v2 we ship a worse compositor: every multi-image workflow forces a manual paste-and-flatten-now flow, and blur/highlight stop being usable as design primitives the moment users start moving layers around.

v2 doesn't change Phase 1's durability story (bundles are still the system of record, DB is still the live read path, doctor still reconciles). v2 changes the *content* of a bundle: multi-source, multi-layer, with effects that compute against the stack.

## Requirements

- **R1.** Introduce `bundle_format_version: 2` in the manifest, distinct from v1. v1 bundles remain valid forever; v2-aware builds read both; v1-only builds refuse v2 cleanly with a "this snap was edited in a newer PwrSnap" error.

- **R2.** Manifest adds `canvas_dimensions: { width_px, height_px }` as a required top-level field, independent of any single source. v1 bundles migrate to v2 by setting `canvas_dimensions = source_dimensions` (the single-source case where canvas equals source).

- **R3.** Coordinate system shifts from "normalized [0,1] of source W×H" to **absolute canvas-pixel coordinates** for all layers and shapes. Migration scales v1's normalized coords to canvas pixels.

- **R4.** A flat layer list with `parent_id` and `z_index` replaces v1's flat overlay array. Tree structure emerges from the parent-pointer graph; the compositor builds the in-memory tree once per render. Flat-list-plus-pointers (not nested children arrays) is the chosen shape because incremental updates (move-layer, add-layer) don't require rewriting the whole tree, and it's DB-friendly (one row per layer).

- **R5.** Five layer kinds, discriminated on `kind`:
  - **`raster`** — references a content-addressable source by `source_ref: { sha256 }`; has `natural_width_px` / `natural_height_px` (intrinsic), a `transform` (position / rotation / scale / anchor), and an optional `mask_id`.
  - **`vector`** — the existing `OverlaySchema` discriminated union slides in as the `shape` field. Arrow / rect / text / step survive unchanged in semantics; their coords switch to canvas-pixel space.
  - **`effect`** — *contextual* effects (blur / highlight, future adjustments). Samples whatever is below this layer in z-order, applies an operation, paints the result back. Has a `clip_rect` (null = entire canvas, adjustment-layer scope) and an optional `mask_id` for soft edges.
  - **`group`** — container with its own transform / opacity / blend / mask. Children point back via `parent_id`. Flatten-on-export bakes children into a single raster.
  - **`mask`** — luminance or vector mask applied to its parent layer. First-class layer so masks can themselves be edited / nested.

- **R6.** Common properties on every layer: `id`, `parent_id`, `name`, `visible`, `locked`, `opacity` (0–1), `blend_mode`, `transform`. Blend modes start with sharp's natively-supported set; the long tail (hue / saturation / color / luminosity) lands when an editor feature needs them, via Skia (`@napi-rs/canvas`) or a CPU compositor.

- **R7.** Bundle ZIP layout extends additively (v1 entries remain a *subset* of v2's allowlist):

  ```
  <id>.pwrsnap (v2)
  ├── manifest.json
  ├── document.json        (layer list — replaces overlays.json)
  ├── sources/<sha>.png    (content-addressable raw inputs)
  ├── layers/<uuid>.png    (raster layer content from brush strokes, rasterized effects, raster masks)
  ├── thumbnails/<sha>.webp (optional small previews for fast layer panel; defer)
  └── composite.png        (final flattened render — paired with the flat sibling .png)
  ```

  The four-entry allowlist becomes a **per-version prefix allowlist**. Path validators don't change — still no `..`, no absolute, no null bytes, no leading-dot, normalized basenames only. v2 accepts the fixed top-level entries plus the prefix-matched directories.

- **R8.** Contextual effects render against a hash of the composite-up-to-this-point. Cache key extends to `(effect_params, hash_of_layers_below)`. Computed bottom-up at composite time; cache invalidates per-layer.

- **R9.** **Live effects can be "rasterized" / "frozen"** — a UI action walks the tree at one moment, renders the effect's output, replaces the effect node with a new `raster` layer (pointing at a fresh entry under `layers/`). Smart-filter conversion in Photoshop terms. Bundle handles this trivially because it's a layer-kind swap plus a new file in the bundle.

- **R10.** **Clipboard interop** is bilingual. When the user copies a selection from PwrSnap:
  - Write standard PNG bytes to the clipboard (interop with every other app).
  - Also write a PwrSnap-private payload under a custom UTI (`com.pwrdrvr.pwrsnap.layer-fragment`) carrying serialized layer-tree slices. Paste detection prefers the private type if present (preserves effects, masks, transforms across PwrSnap-to-PwrSnap copy/paste); falls back to PNG ingest otherwise (creates a new raster layer from clipboard bytes).

- **R11.** **Sources stay embedded by default** for v2.0. The schema reserves `source_ref: { kind: "embedded" | "linked"; sha256, uri? }` so a future "smart object" / "linked external file" workflow (Lightroom-class) can land without a bundle-format bump. Embedded is the only kind in v2.0.

- **R12.** **Bundle rewrite stays the write model.** Existing `scheduleRepack` debounce (Phase 1) is the right abstraction; for paint-class workloads we tune the debounce window upward (5s for steady editing, "on stop drawing" / "on window blur" for brush sessions). DB absorbs every keystroke in real-time; bundle re-pack happens at natural pauses. The atomic-rename + 0o600 + fsync pattern is unchanged.

- **R13.** **ZIP append-on-write is deferred as a future optimization, not the v2.0 default.** Append is technically possible (new local file headers at end of ZIP, central directory rewritten) but creates duplicate central-directory entries, which our existing shadow-entry-attack defense (reject duplicates) is incompatible with. The alternatives — "last-wins with a budget", generation-suffixed entry names, or compaction-on-close — all add complexity for a bandwidth/IO win we don't feel yet. Reserved as an opt-in optimization for large bundles; flagged here so we don't trip over it in v2.0.

- **R14.** **Migration v1 → v2 runs lazily via the doctor**, not eagerly at boot. When a v2-aware build encounters a v1 bundle, it migrates that bundle on first read: rename `source.png` → `sources/<sha>.png`, build a single-layer-group document.json from the old overlays array, scale coordinates to canvas pixels (canvas == source for v1 docs), preserve `composite.png` unchanged, write the new bundle, advance `bundle_format_version` in the manifest. Per-bundle idempotent; failure of one bundle doesn't block others.

- **R15.** **Package-directory mode** (macOS Finder bundle, folder with extension treated as a single file) is reserved as a future option for genuinely large editor-class bundles where iCloud delta-sync of a single ZIP becomes painful. Not v2.0. Flagged here so we don't paint ourselves into a corner on path expectations.

## Success Criteria

- A user pastes an image onto a canvas, drags it around, and sees it persist across app restart — the new bundle holds N raster layer entries with independent transforms.
- A user adds a blur layer above an image, then drags the image. The blur visibly re-renders against the new position — proving the contextual-effect "samples-below at composite time" semantics.
- A user converts a live blur to a rasterized layer ("flatten this effect") and subsequent layer moves below it no longer change the blurred region — the freeze worked.
- Copying a layer fragment in PwrSnap A and pasting into PwrSnap B preserves the layer tree (transforms, effects, masks intact).
- Loading a v1 bundle in a v2-aware build migrates it silently in the background; the user sees no behavioral difference for screenshot-only workflows.
- The existing Phase 1 disaster-recovery story (wipe `<userData>`, doctor rebuilds) still works; v2 doctor handles v1 + v2 bundles uniformly.

## Scope Boundaries

- **Out of scope: the editor UI itself.** This brainstorm defines the *bundle format* + *runtime data model* + *compositor contract*. Building the canvas, layer panel, transform handles, brush engine, color picker, etc. is its own feature.
- **Out of scope: panorama stitching algorithm.** Multi-source composition via the layer system is in scope; *automatic* alignment / blending / seam-finding (Lightroom Photo Merge, Photoshop Photomerge) is a separate feature.
- **Out of scope: brush engine.** Vector strokes (Phase 2 editor) stay vector; true raster brushes (bristles, pressure, blending) need a dedicated brush engine — out of scope.
- **Out of scope: full Photoshop blend-mode parity.** v2.0 ships with sharp's native set; the long tail (hue / saturation / color / luminosity) lands when a feature requests them.
- **Out of scope: PSD / Affinity / Sketch import-export.** v2 bundles are a PwrSnap-private format; interop with other editors is a separate plan.
- **Out of scope: undo tree / branching history.** The current `superseded_by` chain handles linear undo; a proper operation log / undo tree is its own design.
- **Out of scope: ZIP append-on-write optimization** (see R13).
- **Out of scope: package-directory mode** (see R15).
- **Out of scope: linked external sources / smart objects** (R11 reserves the schema slot; embedded is the only kind in v2.0).

## Key Decisions

- **Flat layer list + `parent_id` + `z_index`, not nested children arrays.** Easier incremental updates; DB-friendly (one row per layer); compositor builds the tree once per render. PSD-style structure; Affinity uses nested children — we picked flat.
- **Absolute canvas-pixel coordinates, not normalized.** Normalized [0,1] was fine when source == canvas; once they diverge, normalized creates ambiguity (whose dimensions are we normalizing to?). Migration scales v1's normalized coords once.
- **Contextual effects sample-below at composite time, not bake-on-write.** Adjustment-layer / live-filter model (Photoshop / Affinity). Users intuitively expect this. Cache key incorporates the hash-of-layers-below.
- **Rasterize / freeze as a first-class action.** Lets users opt into "lock this effect in place" when they want stability over live updates. Just a layer-kind swap.
- **Clipboard: PNG bytes + private UTI.** Standard interop preserved; PwrSnap-to-PwrSnap paste preserves layer fragments.
- **Sources embedded by default; linked deferred.** Reserved schema slot so the future smart-object workflow doesn't need a v3 bump.
- **v1 → v2 migration is lazy via the doctor, per-bundle.** No big-bang migration. v1 bundles remain valid forever; v2-aware builds upgrade them on first read.
- **The four-entry allowlist becomes per-version prefix allowlist.** Same path-validation primitives; expanded match set under `sources/`, `layers/`, `thumbnails/`.
- **Bundle rewrite stays the write model; debounce tunes the cadence.** The DB absorbs every change in real-time; the bundle is the periodic snapshot. ZIP append-on-write is a future optimization, not the default.

## Dependencies / Assumptions

- **sharp** continues as the primary compositor; native blend modes cover v2.0. **`@napi-rs/canvas` (Skia)** is the likely path for full Photoshop blend-mode parity *when a feature requires it* — not a v2.0 dependency.
- The DB schema gains tables to mirror the on-disk layer tree: `layers` (one row per layer, with parent_id FK), `layer_attachments` (raster content references), `effects` (effect-specific parameters). Phase 1's `overlays` table survives as the data source for v1 bundles; v2 readers query `layers` instead.
- The compositor gains tree-walking semantics. Today's `OVERLAY_RENDER_ORDER` array becomes a runtime z-order walk.
- The Zip-Slip / symlink defenses from Phase 1 carry forward unchanged; the path validator just runs against an expanded allowlist (regex like `^(sources|layers|thumbnails)/[a-f0-9]{16,64}\.(png|webp)$` for the directory entries, exact match for the top-level entries).

## Outstanding Questions

### Resolve Before Planning

(None — the format shape, layer kinds, and compositor contract are settled. Implementation details and sequencing below are proper `/ce:plan` concerns.)

### Deferred to Planning

- [Affects R4][Technical] DB schema for the `layers` table — column shape, indexes, FK cascade behavior, retention semantics for trashed bundles. Mirror the existing `overlays` table pattern.
- [Affects R5][Technical] Concrete zod schemas for each layer kind. `BundleLayerNode` discriminated union; per-kind sub-schemas. Mirrors `OverlaySchema` discipline (zod-parse on every read AND write).
- [Affects R7][Technical] Path validator regex for the prefix allowlist. Test fixtures for malicious bundles with paths under fake `sources/../etc/passwd` etc.
- [Affects R8][Technical] Cache invalidation strategy for contextual effects. Per-layer cache under `<userData>/cache/<capture>/<layer-id>/<hash>.png`; key includes layers-below hash. Bottom-up hash propagation.
- [Affects R9][Technical] Rasterize-to-layer flow: where the new `layers/<uuid>.png` entry is written (atomic; uses existing atomic-write helper); how the effect node is swapped for a raster node atomically with the bundle re-pack.
- [Affects R10][Technical] macOS clipboard API for the private UTI — `NSPasteboard` with a custom type identifier; Electron exposes this via `clipboard.writeBuffer(type, buffer)`. Detection on paste reads the type list first.
- [Affects R12][Needs research] Debounce-window tuning for paint-class workloads. Likely event-driven ("on stop drawing", "on window blur") rather than purely time-based for high-frequency edit streams.
- [Affects R14][Technical] Doctor's v1 → v2 migration step. Lives in the existing `doctor.ts` reconcile pass (Phase 2 of v1 plan); per-bundle migration includes manifest version bump, coord-scaling, single-layer-group document.json synthesis, atomic rewrite.
- [Affects R13][Needs research] If/when we revisit the ZIP append-on-write optimization, the exact compatibility cost with the duplicate-entry defense and a sensible migration path for the path validator.
- [Affects R15][Needs research] Performance threshold at which the package-directory mode becomes worth the complexity. Likely bundle-size-based (≥ 50 MB? ≥ 100 layers?). Defer until we feel the pain.

## Next Steps

→ `/ce:plan` for the v2 implementation plan. The format shape is settled; the planner sequences phases (v1-handling first to preserve compatibility, then v2 write path, then v2 editor seams), picks DB schema specifics, drafts the doctor's v1→v2 migration, and plans the clipboard wiring.
