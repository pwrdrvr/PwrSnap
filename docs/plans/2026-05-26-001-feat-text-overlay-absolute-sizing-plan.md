---
title: Text Overlay Absolute Sizing (with "Custom" UI bucket)
type: feat
status: active
date: 2026-05-26
origin: docs/brainstorms/2026-05-26-text-overlay-absolute-sizing-requirements.md
---

# Text Overlay Absolute Sizing (with "Custom" UI bucket)

## Overview

Text overlays currently store a UI bucket (`small | medium | large`) and resolve
it to a pixel size at render time from the canvas's short side. That formula
breaks under crops, with two failure modes (the brainstorm covers both in
detail — see origin). Commit `881cff0` (on PR #110) patched the worst symptom
by switching to the SOURCE raster's short side, but introduced a cross-capture
divergence where two canvases of the same dim render `"medium"` at different
absolute sizes depending on their history.

The proper fix is to **persist the resolved pixel height on the row** so
absolute size becomes a row-level fact at placement time. The bucket enum
stays as the user's last UI intent; the new field stores the resolved truth.
When the two diverge (after a crop), the tool popover surfaces a **"Custom"**
indicator so the user knows their text is off-bucket, and re-clicking S / M /
L re-snaps the absolute size to the current canvas's bucket value.

The change spans schema, editor render, bake, draft input, and popover UI.
Lazy migration: legacy rows continue to work via the existing fallback path
until a user action touches them.

## Problem Statement / Motivation

(See origin §"Problem Frame" for the full diagnostic — captured during
PR #110 iteration on the user's real cropped capture.)

Today's behavior:

| State                       | sizePx (legacy formula = sourceShortSide / 30) |
| --------------------------- | ----------------------------------------------- |
| Native 2880×1920 capture    | 64 source px                                    |
| Cropped to 2294×1239        | 64 source px (post-`881cff0`)                   |
| Native 2294×1239 capture    | 41 source px (no source-dim history)            |

So a "medium" text on a cropped canvas renders at 64 source px, but a "medium"
text placed on an identically-sized native capture renders at 41 source px.
Conceptually wrong — the user's bucket choice should mean the same thing for
the same canvas.

The fix moves the source of truth from "current canvas + bucket" to
"persisted row-level absolute size". The bucket becomes UI intent metadata,
not a sizing input.

## Proposed Solution

Persist `sizePx` (source-pixel value) alongside `size: "small" | "medium" |
"large"` on every TextOverlay row. Update the render path to prefer
`sizePx` when present, falling back to the legacy bucket-resolve for rows
that don't have it yet (lazy migration). Surface `"Custom"` in the tool-style
popover when the persisted `sizePx` doesn't match any of the current
canvas's bucket values within tolerance. Clicking S / M / L from the popover
re-snaps `sizePx` to that bucket's value for the current canvas.

This unifies the two invariants the brainstorm flagged:

1. **Through edits (crop, paste):** text stays at the same physical size
   because the persisted px doesn't change (see origin §R3).
2. **Across captures:** "medium" means the bucket's value for whatever
   canvas the text was placed (or re-bucketed) on, NOT whatever the
   current canvas is. Divergence surfaces in UI as "Custom".

## Technical Approach

### Architecture

The change cuts across four layers, each with a small, focused
modification. The unifying piece is **`computeTextGlyphSize` in
`packages/shared/src/text-glyph-size.ts`** (moved from
`apps/desktop/src/renderer/src/features/editor/` to shared so the bake
pipeline can import it too — see origin §"Deferred to Planning"
DQ4 resolution below). The helper grows one new optional input:

```ts
// packages/shared/src/text-glyph-size.ts
export interface TextGlyphSizeArgs {
  size: TextSizeBucket;
  sourceWidthPx: number;
  sourceHeightPx: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** Persisted absolute size in source pixels. When present, this
   *  is the source of truth — `size` is ignored for sizing math
   *  (it's still the UI intent the popover renders). When absent
   *  (legacy rows), fall back to the source-shortSide-based
   *  formula from commit `881cff0`. */
  storedSizePx?: number;
}
```

The fallback path keeps the post-`881cff0` math so legacy rows render at
exactly the same size they do today. The new path returns `sizePx =
storedSizePx` and `fontSize = storedSizePx / canvasShortSide`.

### Deferred Questions Resolved (from origin §"Deferred to Planning")

| ID  | Question                                              | Decision |
| --- | ----------------------------------------------------- | -------- |
| DQ1 | Tolerance for "matches a bucket" (R4)                 | `Math.abs(storedSizePx - bucketPx) < 1` — 1-source-pixel slack. Canvas dims are integers; bucket values like `2880/30 = 96` are exact, and even fractional `1239/30 = 41.3` resolve cleanly within 1px. Avoids floating-point trap doors of strict equality. |
| DQ2 | Schema location for sizePx (R2)                       | Optional field on TextOverlay zod (`packages/shared/src/overlay-schemas.ts`). v2 `VectorLayer.shape` carries TextOverlay verbatim, so the field propagates without any v2 schema change. |
| DQ3 | When does lazy migration fire (R6)                    | On any dispatchEdit op that touches the row: `upsert` (new placement always writes sizePx), `updateOverlay` (popover click on S/M/L OR body edit), `updateGeometry` (handle drag — translates point, doesn't change sizePx, but we still persist it on the new row since the IPC is delete-plus-insert). NOT on read. |
| DQ4 | Shared helper across editor + bake (R3)               | Move `text-glyph-size.ts` to `packages/shared/src/`. The helper is pure math; no React, no Electron. Both `apps/desktop/src/renderer/src/features/editor/OverlaySvg.tsx` + `apps/desktop/src/main/render/compose.ts` import from `@pwrsnap/shared`. |
| DQ5 | Phase 5 paste-image interaction (R1)                  | Defer. See §"Future Considerations". |
| DQ6 | Popover UI room for "Custom" (R4)                     | Custom renders as a small badge ABOVE the S/M/L row, not as a 4th button. Keeps the existing 3-button layout clickable + always available; adds a label/chip showing the current state ("Custom · 64 px") when applicable. |

### Implementation Units

Each unit is a self-contained slice with a clear `Goal`, `Files`, `Approach`,
`Patterns to follow`, `Execution note`, `Test scenarios`, and `Verification`.
Units are ordered by dependency — Unit 1 lands first, others can land in
parallel after that. The `Execution note` carries the TDD posture the user
asked for (test-first or characterization-first).

#### Unit 1 — Schema field + shared helper

**Goal:** Add optional `sizePx` to TextOverlay zod. Move `text-glyph-size.ts`
to `packages/shared/src/`. Extend the helper to accept `storedSizePx`
override.

**Files:**
- `packages/shared/src/overlay-schemas.ts` (extend `TextOverlay`)
- `packages/shared/src/text-glyph-size.ts` (new — move from editor + extend)
- `packages/shared/src/index.ts` (re-export `computeTextGlyphSize`,
  `TextSizeBucket`)
- `apps/desktop/src/renderer/src/features/editor/text-glyph-size.ts` (delete
  — replaced by shared import)
- `packages/shared/src/__tests__/overlay-schemas.test.ts` (extend with
  sizePx round-trip + legacy parse)
- `packages/shared/src/__tests__/text-glyph-size.test.ts` (move from
  editor; extend with `storedSizePx` overrides)

**Approach:**
- TextOverlay schema: `sizePx: z.number().positive().finite().optional()`
- Helper: when `storedSizePx` provided, return
  `{ sizePx: storedSizePx, fontSize: storedSizePx / safeCanvasShort }`;
  otherwise the existing source-shortSide formula.
- All renderer-side imports of `./text-glyph-size` → `@pwrsnap/shared`.

**Patterns to follow:**
- Optional schema fields in TextOverlay (see existing `weight?:` field).
- Helper test layout in `editor-image-style.test.ts` (the
  `transformOrigin` + percentage-conversion proof style).

**Execution note:** Test-first. Write the failing `storedSizePx
override` test, watch it fail (`storedSizePx` arg unknown), then
implement.

**Test scenarios:**
- Legacy: `storedSizePx` absent → unchanged math (regression).
- Stored: `storedSizePx: 64` on a 1239-tall canvas → `fontSize = 64/1239`,
  `sizePx = 64`.
- Bucket mismatch: `storedSizePx: 64` on a canvas where medium = 41 →
  helper returns 64 (= ignore `size`).
- Zero/missing: graceful fallback per existing helper.

**Verification:**
- All shared tests pass.
- TypeScript build clean across workspace.
- `apps/desktop/src/renderer/src/features/editor/` no longer references
  `./text-glyph-size` (only `@pwrsnap/shared`).

#### Unit 2 — Editor render path consumes sizePx

**Goal:** `OverlaySvg.TextGlyph`, `textBoundsBox`, `bodyBoxForOverlay`,
`TextDraftInput` all pass `storedSizePx` from `data.sizePx` (when
present) into `computeTextGlyphSize`.

**Files:**
- `apps/desktop/src/renderer/src/features/editor/OverlaySvg.tsx`
- `apps/desktop/src/renderer/src/features/editor/TextDraftInput.tsx`
- `apps/desktop/src/renderer/src/features/editor/__tests__/OverlaySvg.test.tsx`

**Approach:**
- TextGlyph + textBoundsBox: pass `storedSizePx: data.sizePx` to the helper.
- `bodyBoxForOverlay` (line ~1342): same.
- TextDraftInput: inline shortSide+sizePx math (lines 73-77) → call
  `computeTextGlyphSize`. If the draft is editing an existing row (re-edit
  via `draft.editingId`), prefer the existing row's `sizePx` so the
  input matches what's drawn underneath.

**Patterns to follow:**
- Existing `computeTextGlyphSize` callsite in `OverlaySvg.TextGlyph`.
- `editor-image-style.test.ts` style for inline-style assertions.

**Execution note:** Test-first via OverlaySvg test harness. Add a "renders
text at row.sizePx when present, regardless of size bucket" assertion.

**Test scenarios:**
- Row with `size: "medium"` + `sizePx: 100` on a 1239-tall canvas:
  rendered fontSize is `100/1239`, not `41/1239`.
- Row with `size: "medium"` only (no sizePx): unchanged from today.
- textBoundsBox returns the same width regardless of whether sizePx
  matches a bucket — so the selection outline + hit-test box wrap the
  rendered text exactly.

**Verification:**
- All OverlaySvg + TransformHandles tests pass.
- Manual: in dev app, open a cropped capture with an existing legacy
  text → renders unchanged. Add a new text → still works (Unit 4 wires
  the persistence; until then new texts have no `sizePx` and use the
  fallback).

#### Unit 3 — Bake pipeline consumes sizePx

**Goal:** `apps/desktop/src/main/render/compose.ts` `textSvg` uses
`computeTextGlyphSize` with `storedSizePx` and SOURCE shortSide. Source
dims plumbed through `compose-tree.ts` so the textSvg function has them
available alongside canvas dims.

**Files:**
- `apps/desktop/src/main/render/compose.ts` (the `textSvg` function +
  callsites)
- `apps/desktop/src/main/render/compose-tree.ts` (plumb sourceWidthPx /
  sourceHeightPx through the vector-layer composite path)
- `apps/desktop/src/main/render/__tests__/compose-tree.test.ts` (extend
  with cropped-text snapshot scenarios)

**Approach:**
- The current `textSvg(data, imageWidthPx, imageHeightPx)` takes ONLY
  canvas dims. Extend to `textSvg(data, canvasWidthPx, canvasHeightPx,
  sourceWidthPx, sourceHeightPx)` and call the shared helper.
- `compose-tree-vector.ts`'s vector dispatcher needs the source dims —
  these come from the raster layer's `natural_*_px` in the tree. Look
  them up once at the top of the compose pass and thread to all vector
  composites.

**Patterns to follow:**
- `compose-tree.ts`'s existing raster-dim lookup at line ~256
  (`const sourceW = layerInputInfo?.width ?? node.natural_width_px`).
- The shared helper's invariants are now testable in `packages/shared`,
  so the bake test just verifies the helper is wired correctly + the
  SVG width / height attributes match expectation.

**Execution note:** Characterization-first. Snapshot current bake output
for a fixture (cropped capture with a "medium" text). The snapshot
should NOT change for legacy rows. Add a NEW snapshot for a row with
`sizePx: 100` on a small canvas — text renders larger.

**Test scenarios:**
- Legacy text (no sizePx) on uncropped capture: snapshot unchanged from
  today.
- Legacy text (no sizePx) on cropped capture: snapshot reflects the
  source-shortSide formula (matches commit `881cff0` editor behavior).
- New text (with sizePx: 64) on the same cropped capture: snapshot
  matches Unit 2's editor rendering — bake and editor agree.

**Verification:**
- Compose-tree tests + any existing bake snapshot tests pass.
- Manual: bake a cropped capture in dev → output PNG renders text at
  the right absolute size.

#### Unit 4 — Persist sizePx on placement + user actions

**Goal:** When the user commits text (new placement), set `sizePx` on the
overlay before dispatch. When the user updates an existing text via the
popover (S/M/L click) or a geometry drag, persist the resolved sizePx
on the new row that lands.

**Files:**
- `apps/desktop/src/renderer/src/features/editor/Editor.tsx` (the
  `commitText` builder; the `onRequestEditOverlay` path)
- `apps/desktop/src/renderer/src/features/editor/useCaptureModel.ts`
  (`dispatchEditV1.updateOverlay` + `dispatchEditV2.updateOverlay`;
  same for updateGeometry — these are the lazy-migration entry points
  for legacy rows that get touched)
- `apps/desktop/src/renderer/src/features/editor/__tests__/useCaptureModel.test.ts`
  (add: commit + edit cycles include sizePx)

**Approach:**
- `commitText` (Editor.tsx ~line 1098): when building the `overlay:
  Overlay` literal, compute `sizePx = computeTextGlyphSize({...}).sizePx`
  using current source + canvas dims, write it to the literal.
- `useCaptureModel.dispatchEditV1.updateOverlay` (~line 1011) +
  `dispatchEditV2.updateOverlay`: when applying a patch to a TextOverlay,
  if the patch CHANGES `size` (popover click) → recompute `sizePx` from
  the patched size + current canvas. If the patch only changes `body` or
  unrelated fields → preserve the existing `sizePx`.
- Legacy lazy migration: when an existing row is touched (any
  updateOverlay or updateGeometry), if the inbound row has no `sizePx`
  yet, resolve and write it. The dispatcher already does delete-plus-
  insert, so the new row just gets the field on insert.

**Patterns to follow:**
- Existing `commitText` overlay-literal construction (Editor.tsx
  ~line 1098-1111 — already passes `size`, `weight`, `color` from
  textStyleSrc; `sizePx` slots in next to them).
- `applyPatchToOverlay` (or similar) in useCaptureModel — the geometry/
  style patch resolvers are where we intercept.

**Execution note:** Test-first. Write `commitText with size: "medium" on a
1239-tall canvas writes sizePx: 41` (or whatever the math resolves), then
implement.

**Test scenarios:**
- New text placement persists `sizePx`.
- Re-edit via double-click → body edit only → `sizePx` preserved.
- Popover click S → row updated with `size: "small"` AND `sizePx =
  canvasShortSide/50`.
- Geometry drag (move) → `sizePx` preserved.
- Legacy row (no sizePx) touched by ANY user action → emerges with
  `sizePx` populated (lazy migration).

**Verification:**
- Tests pass.
- Manual: in dev app, place a new text → DB row has sizePx column
  populated (or whatever the persistence mechanism is for VectorLayer
  shape JSON).

#### Unit 5 — "Custom" indicator in popover

**Goal:** ToolStylePopover surfaces a "Custom" badge above the S/M/L
buttons when the selected row's `sizePx` doesn't match any of the
current canvas's bucket values within tolerance. S/M/L buttons remain
clickable and always re-snap.

**Files:**
- `apps/desktop/src/renderer/src/features/editor/ToolStylePopover.tsx`
  (the text-size picker block — find via `ToolSizePreset` usage around
  line 738-740)
- `apps/desktop/src/renderer/src/features/editor/__tests__/ToolStylePopover.test.tsx`
- `apps/desktop/src/renderer/src/features/editor/editor.css` (new
  `.ed-popover-size-custom-badge` rule — small chip)

**Approach:**
- Compute `isCustom = sizePx !== undefined && !matchesAnyBucket(sizePx,
  source, canvas, tolerance: 1)`. Helper colocated with
  `computeTextGlyphSize` or inline.
- When `isCustom`, render a small chip "Custom · {Math.round(sizePx)} px"
  above the size row. Non-clickable; informational only.
- S/M/L buttons fire `onStyleFieldChange("fontSize", "small" | "medium" |
  "large")` — the caller in Editor.tsx maps this through
  `dispatchEdit.updateOverlay` which lands in Unit 4's recompute path.

**Patterns to follow:**
- Existing popover chip / badge styling (search the popover for similar
  state indicators — e.g. the "Auto" label rendering).
- `__tests__/ToolStylePopover.test.tsx` harness for popover rendering.

**Execution note:** Test-first. Write `renders Custom badge when sizePx
is off-bucket`, watch it fail (badge doesn't exist), implement.

**Test scenarios:**
- Row with `sizePx: 64` on 1239-tall canvas (medium = 41) → Custom badge
  visible.
- Row with `sizePx: 41` on 1239-tall canvas → no Custom badge; medium is
  highlighted.
- Row with no `sizePx` (legacy) on 1239-tall canvas: badge hidden
  (legacy rows render via fallback which matches the displayed bucket
  by definition).
- Click M while in Custom state → onStyleFieldChange("fontSize",
  "medium") fires; popover re-renders without badge (re-snap happened
  through Unit 4's persistence).

**Verification:**
- Tests pass.
- Manual: open a cropped capture with a legacy "medium" text, click the
  text → popover should show Custom (after Unit 4 migrates the row on
  first action; alternatively, plan for "show Custom if computed sizePx
  doesn't match" even for legacy rows by including the legacy fallback
  in the matching computation).

#### Unit 6 (deferred) — Phase 5 paste-image interaction

Out of scope. When Phase 5 paste-image ships and the bundle's raster
`natural_*_px` can change, revisit how stored `sizePx` interacts with
the new raster. Likely: stored sizePx stays in source-pixel units of
the ORIGINAL raster; if a paste replaces the raster, the text becomes
Custom for the new raster's bucket math (since the bucket divisors
resolve against the new raster's shortSide).

## System-Wide Impact

### Interaction Graph

1. **`commitText` → `persistOverlay` → `dispatchEdit.upsert`** —
   propagates `sizePx` on every new placement.
2. **`dispatchEdit.updateOverlay({ patch: { fontSize: 'medium' } })`** —
   resolves new sizePx from current canvas's medium-bucket value;
   updates persisted row.
3. **`dispatchEdit.updateGeometry`** — preserves existing sizePx;
   lazy-migrates if absent.
4. **`compose-tree.ts` → `compose.ts.textSvg`** — bake reads sizePx (if
   present) or falls back to the legacy formula. Bake invalidation:
   any TextOverlay row change triggers `scheduleRepack` per the existing
   bus pattern.
5. **`ToolStylePopover` opens for a selected text row** — popover reads
   the row's sizePx, computes `isCustom`, renders accordingly.

### Error & Failure Propagation

- **Schema parse failure on legacy rows:** can't happen — `sizePx` is
  optional. Legacy rows parse unchanged.
- **`sizePx <= 0` or non-finite:** zod's `.positive().finite()` refuses
  at the bus boundary. Defense-in-depth: the helper falls back to the
  bucket-resolve path if `storedSizePx` is somehow invalid.
- **Lazy migration write fails:** the user's edit dispatched and the
  delete landed but the upsert failed. Existing error path
  (`dispatchEdit` returns `Result.err`) surfaces this; the user retries.
  The row may be left in a transient "deleted" state — same risk class
  as the existing dispatcher.

### State Lifecycle Risks

- **Crop dispatcher already handles vector layer delete-plus-insert
  per PR #110.** The new `sizePx` field travels through that loop
  unchanged (it's just a field on `shape: TextOverlay`).
- **Lazy migration on first touch:** if a user reads a legacy row and
  immediately edits it, the row writes back with `sizePx`. Concurrent
  reads from another window won't see the field until their refetch.
  Same broadcast pattern as the existing overlays:changed event.

### API Surface Parity

- **v1 path** (`overlays:upsert`, `overlays:update`): TextOverlay shape
  same in v1 + v2, so the field propagates through both via the same
  schema.
- **v2 path** (`layers:upsert`): VectorLayer.shape is TextOverlay
  verbatim. No new IPC verb needed.
- **Bake** (`compose-tree.ts` + `compose.ts`): both consume the schema
  via `BundleLayerNode.shape` (v2) or `OverlayRow.data` (v1) — same
  zod-parsed object.
- **Clipboard-layer-fragment** (`packages/shared/src/clipboard-layer-fragment.ts`):
  copies VectorLayer wholesale; the field rides along.

### Integration Test Scenarios

- **Cross-window edit sync**: user opens capture in two windows, types
  text in one, the other window's broadcast-refetch receives the row
  with `sizePx` populated and renders identically.
- **Bake-after-edit**: place text, immediately bake (no debounce wait)
  — bake reads from the just-upserted row + uses sizePx.
- **Undo of size change**: re-click S after M was the original →
  undo round-trips through dispatchEdit and restores `sizePx: medium-px`.
  Verify the row's history through the existing undo stack.
- **Legacy row migration during crop**: existing legacy text on a
  capture that gets cropped by another user action (not a popover
  click) — does the crop dispatcher trigger a migration? Currently
  Step 0 of the crop dispatcher does layers:delete + layers:upsert
  (with the same shape); the inserted shape is `{ ...layer, id:
  nanoid(16), shape: transformed }` so it carries the existing shape
  fields verbatim. **If shape.sizePx is undefined for legacy rows, the
  crop preserves that absence.** That's correct — the row stays legacy
  until the user explicitly touches it. (Alternative: have the crop
  dispatcher lazily-write sizePx during the insert. Cleaner long-term
  but expands the dispatcher's responsibility.)
- **Re-edit via double-click → only body changes**: dispatcher's
  updateOverlay patch is `{ body }`. The patch resolver must preserve
  the existing sizePx (NOT recompute from current canvas, since the
  user didn't change size). Verify with a test that asserts sizePx
  pre-edit === sizePx post-edit when only body changes.

## Acceptance Criteria

### Functional Requirements

- [ ] **R1 satisfied (origin):** TextOverlay zod accepts `sizePx?:
      number`. New rows from `commitText` include it.
- [ ] **R2 satisfied (origin):** Editor view + bake + draft input
      prefer `sizePx` when present, fall back to bucket-resolve when
      absent. (Units 2 + 3.)
- [ ] **R3 satisfied (origin):** Cropping a capture doesn't modify
      `sizePx` on any text overlay. Verified by a test that crops a
      capture with a known `sizePx` row and asserts the post-crop row
      has the same value.
- [ ] **R4 satisfied (origin):** Popover shows "Custom" badge when
      `sizePx` doesn't match any bucket within 1 source pixel.
- [ ] **R5 satisfied (origin):** Clicking S / M / L re-snaps `sizePx`
      to `canvasShortSide / DIVISORS[bucket]` and the text resizes on
      screen.
- [ ] **R6 satisfied (origin):** Legacy rows without `sizePx` render at
      the same on-screen size as before this change (post-`881cff0`
      behavior).
- [ ] **R7 satisfied (origin):** Schema's bucket enum unchanged
      (`"small" | "medium" | "large"`). "Custom" is UI state computed
      from `sizePx` + current canvas, not a persisted enum value.

### Non-Functional Requirements

- [ ] No regressions in existing OverlaySvg, TransformHandles, compose-tree,
      or popover tests.
- [ ] TypeScript strict + `exactOptionalPropertyTypes` clean.
- [ ] License + color lint clean.
- [ ] Bake snapshot count grows by at most a few; legacy snapshots
      unchanged.

### Quality Gates

- [ ] Each Implementation Unit has at least one test that fails
      against the pre-unit state (per the user's TDD discipline
      request).
- [ ] The `Custom` UX is verifiable manually in the dev app:
      cropped capture + legacy text → Custom appears → click M →
      text resizes + Custom disappears.

## Success Metrics

* Zero new bug reports of the "text moves after crop" class on PR #110
  follow-up captures (functional regression).
* Custom badge accurately surfaces in all cropped-capture states
  (qualitative — verify via the dev app).
* No invalidation of existing captures' baked PNGs (legacy fallback
  path preserves byte-equivalence for pre-`sizePx` rows).

## Dependencies & Risks

### Dependencies

- Builds on PR #110's `881cff0` fix (source-shortSide-based fallback).
  The fallback path stays as-is; the new code only activates when
  `sizePx` is present.
- Builds on `text-glyph-size.ts` (introduced in `881cff0`). Unit 1
  moves it to `@pwrsnap/shared`; all referencing code switches imports.

### Risks

| Risk                                                          | Likelihood | Mitigation |
| ------------------------------------------------------------- | ---------- | ---------- |
| Lazy-migration timing surprises (row "becomes Custom" mid-edit) | Low      | Test the legacy-touched-by-crop scenario explicitly. |
| Bake snapshot tests churn on existing captures               | Low        | Legacy rows take the fallback path; bake output should be byte-equivalent. Snapshot diff during Unit 3 is the verification. |
| Tolerance choice misses an edge case                          | Low        | 1-source-pixel slack is generous; bucket values are integer-like. If a real case surfaces, easy to tweak. |
| Custom badge clutters the popover                              | Low        | The chip is small and conditional; never appears when row is in-bucket. UX preview during Unit 5. |
| Schema-version bump needed?                                    | Low        | Field is optional; doesn't change manifest version. No migration script needed. Confirm in Unit 1's test "legacy parses unchanged". |

## Resource Requirements

Single-implementer scope. Unit ordering: 1 first (foundation), then 2 + 3 +
4 can land in parallel (independent files mostly), then 5 (depends on 4 to
have an up-to-date sizePx to read).

Estimated effort: 1-2 days of focused work (small unit count, well-bounded
scope, existing test harnesses in place for each touched file).

## Future Considerations

- **Phase 5 paste-image flow** (origin §"Outstanding Questions" DQ5):
  when a paste replaces the bundle's raster, the new raster has different
  `natural_*_px`. Stored `sizePx` is in source-pixel units of the
  ORIGINAL raster — visually consistent if the new raster scales
  similarly, surfaces as Custom if not.
- **Per-raster sizing in a multi-raster bundle** (Phase 5+): when a
  bundle has multiple rasters, "the source's shortSide" is ambiguous.
  Likely path: each text overlay carries a `raster_id` link, and
  `sizePx` is in that raster's source-pixel units. Out of scope.
- **One-shot migration** (origin §"Scope Boundaries" excluded): if
  enough rows accumulate in the legacy-no-sizePx state and the lazy
  migration churn becomes annoying, a one-shot main-process backfill
  script could populate `sizePx` for all existing TextOverlay rows.
  Defer until pain.

## Documentation Plan

- No user-facing doc changes (Custom is a UI affordance the user
  discovers naturally).
- Update the inline comment block in `compose.ts.textSvg` to point at
  the shared helper.
- Add a one-paragraph note to `CLAUDE.md` explaining the sizePx /
  Custom contract for future agents — same pattern as the existing
  "BrowserWindow.setMinimumSize" note.

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-05-26-text-overlay-absolute-sizing-requirements.md](../brainstorms/2026-05-26-text-overlay-absolute-sizing-requirements.md) — Key decisions carried forward:
  - Persist absolute sizePx alongside bucket enum (origin §"Key Decisions" D1)
  - Bucket enum stays as UI intent, sizePx is resolved truth (D2)
  - Lazy migration on first touch, no batch script (D3)
  - "Custom" is UI-only, not a 4th enum value (D4)

### Internal References

- Editor render path: `apps/desktop/src/renderer/src/features/editor/OverlaySvg.tsx:1399` (`TextGlyph`)
- Hit-test / outline box: `apps/desktop/src/renderer/src/features/editor/OverlaySvg.tsx:710` (`textBoundsBox`)
- Draft input: `apps/desktop/src/renderer/src/features/editor/TextDraftInput.tsx:73-77`
- Bake textSvg: `apps/desktop/src/main/render/compose.ts:602` (`textSvg`)
- Bake vector composite: `apps/desktop/src/main/render/compose-tree.ts:313+` (vector dispatcher)
- Popover size picker: `apps/desktop/src/renderer/src/features/editor/ToolStylePopover.tsx:738-740`
- Existing helper (to move): `apps/desktop/src/renderer/src/features/editor/text-glyph-size.ts`
- Schema location: `packages/shared/src/overlay-schemas.ts:232` (`TextOverlay`)
- Commit / re-edit flow: `apps/desktop/src/renderer/src/features/editor/Editor.tsx:1098` (`commitText`), `:1150` (`onRequestEditOverlay`)
- v2 layer-tree shape carrier: `packages/shared/src/bundle-manifest-schema-v2.ts:159` (`VectorLayer.shape`)

### Related Work

- **PR #110** (in flight on this worktree) — `881cff0`: source-shortSide
  fallback. This plan builds on that commit's helper extraction.
- **v2 editor refresh plan**: [docs/plans/2026-05-23-001-feat-v2-editor-plan.md](2026-05-23-001-feat-v2-editor-plan.md) — text-size handling discussed in passing; no blocker.

## Post-Deploy Monitoring & Validation

`No additional operational monitoring required: this is a renderer + bake
behavior change with no new IPC verbs, no migrations, no external services.
Verification is via the existing test suite + manual dev-app smoke (place
text, crop, undo, re-edit).`
