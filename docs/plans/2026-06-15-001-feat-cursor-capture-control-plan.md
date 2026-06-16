---
title: Cursor Capture Control
type: feat
status: active
date: 2026-06-15
origin: docs/brainstorms/2026-06-15-cursor-capture-control-requirements.md
---

# ✨ Cursor Capture Control

## Enhancement Summary

**Deepened on:** 2026-06-15 · **Focus:** Phase 2 (Editor Raster LayerView), the long pole.
**Research agents:** existing editor edit-mechanics (repo), compositor parity math
(repo), external canvas-editor architecture (Figma / tldraw / Excalidraw / Konva,
cited). *Note: five automated code-review agents (architecture, performance,
frontend-races, simplicity, agent-native) hit a transient server rate limit and
returned nothing; their concerns are folded in from the research below, and the
review pass can be re-run.*

### Key improvements
1. **Reframe — Phase 2 is an extension, not a rewrite.** The editor **already** runs
   a DOM/CSS-per-layer live preview + a *separate* `sharp` exporter (`composeV2`):
   the base raster is a styled `<img>` (shared `computeEditorImageStyle` in
   `editor-image-style.ts`), vectors are SVG, text/blur are HTML/canvas overlays.
   Phase 2 **generalizes the base-raster path to N raster layers** and extends
   hit-test/handles to them — reusing `draftGeometry`/`liveOverride`,
   commit-on-drop via `layers:update`, and the existing broadcast→refetch. This
   materially de-risks the "long pole."
2. **Rendering model decided: DOM/CSS-transform-per-layer for interaction + re-bake-
   at-rest.** Drag mutates `transform: matrix()` locally (free GPU compositor path,
   no per-frame IPC); on commit/idle, swap in the real `composeV2` composite (cheap
   via the content-addressed cache) as the authoritative at-rest image — so
   "editor ≠ export" is structurally impossible at rest.
3. **Concrete preview↔`composeV2` parity checklist** + identification of the single
   hard wall (effects that sample rasters beneath them), which the codebase
   *already* solves via the `RotatedEffectCanvas` canvas-readback mirror.

### New considerations discovered
- **Single-source the math.** Affine/crop/style math must come from
  `@pwrsnap/shared` for both surfaces — `text-html-bake.ts` is the precedent (text
  parity was fixed by baking through a hidden Chromium window with the *same*
  `computeTextHtmlStyle`). Any per-surface re-derivation is a parity bug.
- **Per-layer bytes:** decode each layer source once (`createObjectURL`, revoke on
  unmount — *not* in the `load` handler) or serve via a new
  `pwrsnap-capture://s/<captureId>/<sha256>` URL; never re-encode per frame.
- **Add a golden-image parity CI test** (every layer type + effect; assert editor-
  at-rest vs bake within a ΔE/px threshold) — the institutional version of the
  text-bake spike.
- **Base-raster protection** needs an explicit marker (a `source_layer_id` in the
  manifest) + a `layers:delete` handler guard + a disabled UI affordance; today no
  raster is distinguished as the immutable base.

## Overview

Give users one "capture cursor" concept that governs whether the mouse pointer
is included in captures: a persisted default in Settings plus a quick inline
toggle on the existing region selector (no new blocking window). For **video**
the cursor is a baked-in pixel, so control is a pre-capture on/off flag threaded
into the native recorder. For **images** the brainstorm's intent was a
*deletable/movable* cursor layer — and research shows that's meaningfully more
expensive than assumed, because of where the editor stands today.

This plan keeps the origin document's product decisions intact (see origin:
docs/brainstorms/2026-06-15-cursor-capture-control-requirements.md) but **re-prices
the image half** against two findings from local + macOS research.

**Scope decision (2026-06-15): Option C-max** — build the general editor **raster
LayerView** so *all* raster layers become visible / selectable / movable in the
editor, and let the cursor layer ride on it. This is larger than the cursor
feature alone (it also unblocks editing pasted-image layers, which today render
only as bounding boxes), so the editor surface is now the long pole and is
sequenced as its own phase. Image cursor default stays **ON** (deletable).

## Problem Statement

Today the two capture paths are inconsistent and uncontrollable:

- **Video always bakes in the cursor** — `cfg.showsCursor = true` is hardcoded in
  the native recorder ([main.swift:202](apps/desktop/native/recorder/main.swift)),
  with no flag on the JSON-RPC `StartRequest` ([main.swift:37-57](apps/desktop/native/recorder/main.swift)).
- **Images always exclude the cursor** — every `screencapture` invocation omits
  it (no `-C` flag); the file header even lists "cursor exclusion for free" as a
  feature ([screencapture.ts:5, args at 302-309 / 383-390](apps/desktop/src/main/capture/screencapture.ts)).
- There is **no setting** for cursor capture and **no pre-capture control** of any
  kind. The region selector has no cursor affordance today.

Users who want a pointer in a screenshot (to point at something) can't get one;
users who want a clean screencast can't remove it.

## Research Findings (read before planning scope)

Two findings reshape the image half of this feature. The video half is clean.

### Finding A — The editor cannot show or edit a non-base raster layer (image blocker)

The brainstorm assumed "reuse the v2 layer model, zero compositor changes" → a
deletable/movable cursor layer is cheap. The **compositor** half is true
(`composeV2` paints any raster at any `x,y`), but the **editor** half is not:

- The editor canvas renders exactly **one** raster — `<img src=captureSrcUrl(record.id)>`
  ([Editor.tsx:4362-4377](apps/desktop/src/renderer/src/features/editor/Editor.tsx)),
  and `pwrsnap-capture://r/<id>` serves the **bare base `source.png`**, never the
  composite ([pwrsnap.ts:117-119](apps/desktop/src/renderer/src/lib/pwrsnap.ts);
  [protocols.ts:6-12, 242-261](apps/desktop/src/main/protocols.ts)).
- The overlay/selection layer projects only `vector` + `effect` layers and
  **explicitly skips rasters** ([Editor.tsx:487, 573](apps/desktop/src/renderer/src/features/editor/Editor.tsx));
  `hitTestOverlays` never returns a raster id, so rasters can't be clicked,
  selected, or dragged. Move/drag exists only for vector overlays.
- A **pasted image** today only shows on canvas as a bounding-box rectangle, not
  as real pixels — it becomes visible in the actual image only after a repack,
  which the editor preview doesn't display
  ([editor:pasteImageAsLayer → scheduleRepack](apps/desktop/src/main/handlers/editor-handlers.ts) at 240-328/307).

**Consequence:** a cursor stored as a separate raster layer renders correctly in
**export / clipboard / thumbnail** (all go through `composeV2`), but is
**invisible in the editor preview** and **not movable on canvas** until net-new
editor work lands (the deferred "Phase 4-5 LayerView" raster surface,
[Editor.tsx:574](apps/desktop/src/renderer/src/features/editor/Editor.tsx)).
Deleting it by id is cheap and needs no canvas hit-testing — `layers:delete`
soft-deletes any layer id ([layers-handlers.ts:415-428](apps/desktop/src/main/handlers/layers-handlers.ts)
→ [rejectLayer, layers-repo.ts:675-709](apps/desktop/src/main/persistence/layers-repo.ts)).

### Finding B — Isolating the cursor sprite for a still is net-new native work with risk

macOS gives no clean public, supported way to grab another app's cursor sprite
for a still (ScreenCaptureKit only *bakes* the cursor in — no cursor metadata in
`SCStreamFrameInfo`). Ranked options (full table in Sources):

1. **`NSCursor.currentSystem`** (primary) — one call returns the foreground app's
   live cursor `NSImage` (with alpha) + `hotSpot`, cross-process. **Deprecated in
   macOS 15** (still works; no public replacement). Returns `nil` unless called
   from a process with a live AppKit main thread (i.e. our native helper, **not**
   a renderer). No extra TCC permission needed.
2. **Two-frame diff** (fallback) — capture with/without cursor via
   `SCScreenshotManager` and subtract over a tight bbox. Public + non-deprecated,
   but slower and an *estimated* matte that frays over animated content. Requires
   the Screen Recording grant.
3. **`CGSGetGlobalCursorData`** (opt-in fallback) — private SkyLight API; highest
   fidelity; passes notarization but unsupported/breakable — `dlsym` + graceful
   degrade only.

Position via `CGEvent(source: nil)?.location` (top-left origin, no flip).
Pitfalls: place sprite at `position − hotSpot`; scale points→backing pixels by the
**cursor's** display scale; resolve the cursor's display for multi-monitor;
cursor can change between position read and sprite read (read them adjacent).

### Other findings (carried into the design)

- **Settings:** no `capture.*` namespace exists; capture-time defaults live in
  `Settings["recording"]` ([protocol.ts:1662-1686](packages/shared/src/protocol.ts)).
  Adding booleans is additive — **no `schemaVersion` bump** (per CLAUDE.md;
  `recording.screenCapturePrompted` from 2026-06-14 is the template).
- **No BAKE_PIPELINE_VERSION bump needed:** a cursor raster layer carries its own
  `source_ref.sha256` and is part of the tree the render hash already covers
  (docs/solutions/2026-05-28). Only a *compose-logic* change would require a bump.
- **Crop translation:** a positioned cursor *layer* must be translated by the v2
  crop op (raster `transform` family in `useCaptureModel.ts`) or it drifts on
  off-origin crops (docs/solutions/2026-06-13). A baked-in cursor needs nothing.
- **Selector state hygiene:** selector BrowserWindows are pre-warmed and reused —
  any new toggle state must be scrubbed in `resetToSnap()` **and** `commit()`
  **and** on entry, and must not visually collide with the synthetic crosshair
  (docs/solutions/2026-06-07).
- **Thumbnail:** `composite_thumbnail.jpg` is built from the bare source at capture
  ([bundle-store.ts:847](apps/desktop/src/main/persistence/bundle-store.ts)); a
  cursor *layer* is missing from it until the first repack regenerates it from the
  composite ([bundle-store.ts:982](apps/desktop/src/main/persistence/bundle-store.ts)).

## Proposed Solution

Split into a clean, ship-now video phase and an image phase whose scope is the
one open decision.

### Phase 1 — Shared control + Video cursor toggle  ✅ low risk, ship independently

Delivers the origin doc's R1/R2/R5/R6 for video and stands alone.

1. **Settings (shared substrate).** Add to `Settings["recording"]`:
   `videoCaptureCursor: boolean` (default `true` — preserves today) and
   `imageCaptureCursor: boolean` (default per the decision below).
   - Type: [protocol.ts:1662-1686](packages/shared/src/protocol.ts) (patch auto-covered by `Partial<>` at 2105).
   - Default: [desktop-settings-service.ts:161-174](apps/desktop/src/main/settings/desktop-settings-service.ts).
   - `parseV1` back-fill via `pickBoolean` (`:284`): [desktop-settings-service.ts:622-641](apps/desktop/src/main/settings/desktop-settings-service.ts).
   - Validator: add keys to the boolean loop at [settings-validators.ts:421-437](apps/desktop/src/main/handlers/settings-validators.ts).
   - No `schemaVersion` bump.
   - Settings → Recording UI: two toggles.
2. **Video end-to-end flag.**
   - `recording:start` req gains `captureCursor?: boolean` ([protocol.ts:2954-2961](packages/shared/src/protocol.ts)).
   - Handler passes it into `service.start({captureCursor})` ([recording-handlers.ts:242-246](apps/desktop/src/main/handlers/recording-handlers.ts)).
   - `StartOptions` + stdin JSON gain the field; snapshot it for `restart()` ([recording-service.ts:43-47, 221-232, 421-429](apps/desktop/src/main/recording/recording-service.ts)).
   - Swift: add `showsCursor: Bool?` to `StartRequest`; `cfg.showsCursor = req.showsCursor ?? true` ([main.swift:37-57, 202](apps/desktop/native/recorder/main.swift)). Update the RPC contract comment (main.swift:8-12).
   - `runInteractiveRecord` already reads settings ([index.ts:1039-1047](apps/desktop/src/main/index.ts)); read `recording.videoCaptureCursor`, override with the inline toggle, pass into the `recording:start` dispatch ([index.ts:1084-1088](apps/desktop/src/main/index.ts)).
3. **Inline toggle on the region selector.** Add a "Cursor: on/off" affordance to
   the `region-hint` bar (already branches on `intent==="video"`,
   [RegionSelector.tsx:1153-1172](apps/desktop/src/renderer/src/features/region/RegionSelector.tsx)).
   Ride the existing submit payload rather than a new channel:
   add `captureCursor?: boolean` to the `submitRegion` payload
   ([preload/index.ts:175-189](apps/desktop/src/preload/index.ts)),
   `isSelectorPayload` ([region-selector.ts:1528-1557](apps/desktop/src/main/capture/region-selector.ts)),
   `SelectorResult.ok` ([region-selector.ts:142-174](apps/desktop/src/main/capture/region-selector.ts)),
   and the result-assembly copy block (`:337-342`). Seed the toggle from the
   settings default; scrub it in all reset paths.

### Image cursor scope — options considered (decided: C-max)

The origin doc chose a **deletable/movable cursor layer**. Finding A means the
"movable/visible-in-editor" part is gated behind editor work. The shapes weighed:

| Option | What ships | Editor visibility | Deletable | Movable | Cost | Honors origin intent |
|---|---|---|---|---|---|---|
| **A. Baked-in (`-C`)** | cursor in the source PNG | ✅ (it's in source) | ❌ permanent pixels | ❌ | **S** (flag only) | ❌ contradicts "deletable" |
| **B. Cursor layer + delete-only** | native sprite → "Cursor" RasterLayer + a "Remove cursor" button | ❌ not in editor preview (only in export/clipboard) | ✅ via `layers:delete` by id | ❌ (until LayerView) | **M** (native helper + insert + crop xlate + button) | ⚠️ partial — delete yes, move/WYSIWYG no |
| **C. Cursor layer + cursor-specific editor overlay (RECOMMENDED)** | B, plus render the single known cursor layer in the editor via the existing overlay path (positioned `<img>`/SVG overlay) with select/move/delete | ✅ WYSIWYG | ✅ | ✅ | **M-L** (B + a bounded, cursor-only editor surface) | ✅ full intent without the general raster rewrite |
| **C-max. General raster LayerView** | C's behavior but via the full deferred raster render/hit-test/drag surface for *all* rasters | ✅ | ✅ | ✅ (all rasters) | **L** (roadmap-level) | ✅ + unblocks pasted-image editing etc. |

**Chosen: C-max.** The user opted for the full raster LayerView: rather than a
cursor-only editor surface (C), build the general raster render/hit-test/drag
surface so every `kind:"raster"` layer is first-class in the editor. The cursor is
then just one such layer and gets visible/selectable/movable for free, and the
long-deferred pasted-image editing gap closes at the same time. Image default
stays **ON** (the cursor is fully deletable, so default-ON is safe). **A** was the
cheap dead-end (contradicts the brief); **B/C** are valid earlier-ship intermediates
that this plan could fall back to if Phase 2 must be descoped.

### Phase 2 — Editor Raster LayerView  ⬅ the long pole (general, not cursor-specific)

Make non-base raster layers first-class on the editor canvas. This is a real
editor-architecture change and is large enough to warrant its own deepened sub-plan;
it is the dependency the image cursor (Phase 3) rides on, and it independently
unblocks pasted-image editing. It does **not** need any of Phase 1 or 3.

Today: the editor renders one `<img>` = bare `source.png` + vector/effect SVG
overlays; rasters are skipped in projection and hit-testing
([Editor.tsx:487, 573, 4362-4377](apps/desktop/src/renderer/src/features/editor/Editor.tsx)).
Target: render each raster layer as a real, transform-positioned element stacked by
`z_index`, interleaved with the existing SVG overlays, selectable and draggable.

1. **Render raster layers.** Stop treating `source.png` as the sole image. Render
   every `kind:"raster"` node (base + cursor + pasted) as a positioned element in
   z-order. Resolve each layer's source bytes (the per-capture cache already holds
   `<sha>.png`, written by `persistRasterFromBytes`
   [editor-handlers.ts:186](apps/desktop/src/main/handlers/editor-handlers.ts)); a
   per-source URL (extend the `pwrsnap-capture://` resolver, [protocols.ts](apps/desktop/src/main/protocols.ts))
   avoids re-baking on every drag. Apply the layer `transform` via CSS so moves are
   live and don't round-trip the compositor.
2. **Hit-test + select rasters.** Extend `projectV2LayersToOverlayRows` /
   `hitTestOverlays` ([Editor.tsx:487, 573, 602](apps/desktop/src/renderer/src/features/editor/Editor.tsx))
   to include rasters so a click selects them, reusing the existing
   `selectedLayerIds` model and `TransformHandles`/`SelectionOutline`.
3. **Move / resize / delete / z-order.** Wire raster drag/resize to commit
   `transform_json` via `layers:update`
   ([layers-handlers.ts:293-339](apps/desktop/src/main/handlers/layers-handlers.ts) →
   [layers-repo.ts:408-493](apps/desktop/src/main/persistence/layers-repo.ts)); delete
   via `layers:delete`; reuse the existing context-menu z-order ops. Keep the **base
   raster** non-deletable / pinned as the bottom layer (special-case it, or mark it
   so the LayerView won't let the user delete the whole capture).
4. **Preview ↔ export parity.** Verify the CSS-transform live preview matches
   `composeV2` output (export/clipboard/thumbnail) for translate/scale/opacity, incl.
   off-origin crop and effect sampling order. This parity is the main correctness risk.

> Sizing note: this phase is roadmap-level. Recommend `/deepen-plan` on it (or split
> into its own plan file) before implementation. Phases 1 and 3 do not block on it
> shipping first, but Phase 3's "visible/movable in editor" acceptance does.

### Phase 2 — Research Insights (deepened)

**Big reframe: the editor is already this architecture.** It renders the base
raster as a styled `<img>` (`editorImageRef`, positioned by the shared
`computeEditorImageStyle` in `editor-image-style.ts` — `transform-origin: 0 0`,
percentage translate), vectors as SVG (`OverlaySvg.tsx`), text/blur as HTML/canvas
overlays, and `mix-blend-mode: multiply` for highlights. The exporter `composeV2`
(`compose-tree.ts`, `sharp`) is *separate*. So Phase 2 is **"generalize the existing
single-raster preview path to N rasters + extend hit-test/handles to rasters,"** not
a new renderer. The team has already paid the two hardest parity lessons here
(`text-html-bake.ts` for text; `RotatedEffectCanvas` in `BlurOverlays.tsx` for
sample-below effects) — reuse those patterns, don't reinvent.

**Rendering-model decision (resolves the open Phase-2 question): DOM/CSS-transform-
per-layer for interaction + re-bake-at-rest.**
- During drag/resize, mutate `transform: matrix()` on the dragged layer locally via
  the existing `draftGeometry` → `liveOverride` mechanism (no IPC per pointermove;
  promote only the active layer with `will-change: transform`, drop it on commit).
- On commit/idle, request `composeV2` and show the real composite (via the
  content-addressed cache / a `pwrsnap-cache://`-style flat image) as the at-rest
  truth. Cache makes an unchanged re-bake a hash lookup.

**Mechanics to extend (all already exist — reuse, don't rebuild):**
- **Hit-test/select:** extend `projectV2LayersToOverlayRows` / `hitTestOverlays`
  (Editor.tsx ~487/573/602) to emit raster bounds; the `selectedLayerIds` model and
  `decideClickSelection` need no change.
- **Drag/handles:** add a raster branch to `TransformHandles` (`OverlaySvg.tsx`,
  normalized [0,1]² coords); reuse `geometryFromDrag`/`applyGeometryLocally` and the
  `draftGeometry` live path. Multi-drag snapshots via `multiDragStartRef` already
  generalize.
- **Commit:** `dispatchEdit({kind:"updateGeometry"})` → `layers:update`
  (`layers-repo.ts:462` writes `transform_json`) inside an undo bracket
  (`beginInteraction`/`endInteraction`) — exactly today's vector path. Delete via
  `layers:delete`. **No DB/IPC schema changes.**
- **Refetch reconciliation:** `events:overlays:changed` → `useCaptureModel` refetch
  is already in place; **guard it against clobbering an in-flight drag** with a
  monotonic `seq`/interaction-active ref (the codebase uses this pattern elsewhere).
- **Per-source bytes:** add a `pwrsnap-capture://s/<captureId>/<sha256>` resolver
  (extract from the bundle/per-capture cache) so each raster `<img>` loads its
  source by sha without re-baking; decode once.

**Preview ↔ `composeV2` parity checklist** (canvas-pixel space, `transform-origin:
0 0`, scale by `renderScale = width>canvasWidth ? width/canvasWidth : 1`):
- `transform: matrix(scaleX, 0, 0, scaleY, tx, ty)` where `scaleX=transform[0]`,
  `scaleY=transform[3]`, `tx=transform[4]`, `ty=transform[5]` (compositor rounds
  tx/ty to integers — `compose-tree.ts:334-352`).
- `opacity` linear; `mix-blend-mode: normal` (v2.0 locks blend to "normal").
- Canvas-bounds clip for off-canvas/cropped rasters (`overflow:hidden` parent +
  per-layer clip) — mirrors the compositor's `.extract()` clip (`compose-tree.ts:365-384`).
- **Off-origin crop:** raster `transform[4]/[5] -= offset`, effect `clip_rect -=
  offset` — already centralized in `useCaptureModel.ts:1126-1207`; keep editor + bake
  calling the same helper.
- `image-rendering: pixelated` for nearest-neighbor parity where the bake uses
  `kernel:"nearest"` (already done for mosaic).

**Known parity risks + mitigations** (from external research — Figma/tldraw/Excalidraw):
1. **DPR / fractional-transform drift** (DOM GPU-antialiases; sharp snaps to integer
   device px) → single shared affine math; compare at 100% zoom; re-bake-at-rest
   hides residual.
2. **Interpolation kernel** (Chromium bilinear vs sharp Lanczos on scaled rasters) →
   pin/pre-scale or render layers at native resolution.
3. **Sample-below effects are impossible in pure DOM** (an SVG/overlay effect cannot
   sample a sibling `<img>`) → keep the existing `RotatedEffectCanvas` canvas-readback
   mirror; never use `backdrop-filter` (its backdrop-root scope ≠ the layer tree).
4. **Many-layer GPU layer explosion** → promote only the actively-dragged layer.
5. **`createObjectURL` lifecycle** → revoke on unmount, not in `load` (revoking
   before decode corrupts the image).

**Base-raster protection:** add a `source_layer_id` to the v2 manifest pointing at
the immutable base raster; guard `layers:delete` in the handler; disable the delete
affordance in the UI when the base is selected. (No such marker exists today —
name/`z_index` conventions are fragile.)

> Folded-in review concerns (the rate-limited pass would have raised these):
> **Perf** — never `scheduleRepack`/re-encode on pointermove; commit-on-drop only;
> watch render-hash churn in the bake cache when transforms change frequently.
> **Races** — stale refetch vs in-flight drag (seq guard above); pointer-capture /
> unmount-mid-drag / pointerup-outside. **Simplicity** — C-max is broader than the
> cursor strictly needs; if it slips, ship Phase 1 + an intermediate "B" (cursor
> layer + delete-by-id button, no drag) and upgrade later. **Agent-native** — move/
> delete already route through `layers:update`/`layers:delete` on the command bus,
> so agent parity holds; ensure the per-capture cursor decision is also expressible
> via bus params (settings + capture/recording request fields), not only the
> selector GUI.

### Phase 3 — Image cursor (rides on Phase 2)

1. **Native cursor sampling helper.** Add a one-shot `cursor` command to the
   existing `PwrSnapRecorder` Swift binary (it already links ScreenCaptureKit/AVFoundation
   and owns an AppKit context). Returns JSON `{ pngBase64, hotspotX/Y, posX/Y,
   displayScale, displayId }`. Primary: `NSCursor.currentSystem` +
   `CGEvent(source:nil)?.location`; fallbacks per Finding B behind a flag.
   - **Timing:** sample at hotkey-trigger time — *before* the selector overlay
     replaces the OS cursor with the synthetic crosshair (the frozen snapshot is
     taken later at `pickRegion` time, [region-selector.ts:590](apps/desktop/src/main/capture/region-selector.ts)).
     Stash the sample for the persist step.
2. **Insert the cursor layer at capture.** In `persistCaptureFromTempV2`
   ([bundle-store.ts:790-855](apps/desktop/src/main/persistence/bundle-store.ts)),
   when enabled **and** the cursor position falls within the captured bounds (R6),
   embed the cursor PNG in the `sources` Map (`:852`) and push a second
   `RasterLayer` into `initialLayers` (`:831`): `name:"Cursor"`, `source:"user"`,
   `kind:"raster"`, `source_ref:{kind:"embedded",sha256}`, `z_index:1` (on top),
   `transform:[1,0,0,1, x, y]` where `x,y` = `(globalPos − hotSpot − regionOrigin)`
   scaled into canvas pixels by the cursor's display scale. Mirror the existing
   `persistRasterFromBytes` template ([editor-handlers.ts:165-221](apps/desktop/src/main/handlers/editor-handlers.ts)).
   Build the initial thumbnail from a one-shot composite (or accept a one-cycle
   stale thumb fixed on first repack, `:982`).
3. **Crop translation.** Ensure the v2 crop op translates the cursor raster
   `transform` (raster family in `useCaptureModel.ts`) — see docs/solutions/2026-06-13.
   (General raster crop handling lands with Phase 2; confirm the cursor is covered.)
4. **No cursor-specific editor code.** Because Phase 2 makes all rasters
   first-class, the cursor layer is visible / selectable / movable / deletable with
   no cursor-only UI. The only cursor nicety worth considering: a distinctive
   `name:"Cursor"` (already planned) so a future layers panel can label it.

## Alternatives Considered

- **Baked-in cursor everywhere via `-C` / `showsCursor`** (learnings-researcher's
  pragmatic pick). Cheapest, WYSIWYG, no cache/crop work. Rejected as the *primary*
  image path because it makes the cursor permanent — directly against the origin
  decision that the image cursor be deletable/movable. Retained as Option A / a
  possible interim.
- **Promote stills to ScreenCaptureKit** to get `showsCursor`. Rejected: the
  buildout plan keeps stills on the CLI on purpose (~70ms vs ~120ms cold), and it
  still bakes the cursor in (no separability).
- **Dedicated pre-capture config window** (the original phrasing). Rejected in the
  brainstorm — capture speed is the product's core value; a blocking window
  regresses it. Settings default + inline toggle instead.
- **Two-frame diff as the primary sprite source.** Rejected as primary (latency +
  fraying over animated content); kept as the public, non-deprecated fallback.

## System-Wide Impact

- **Interaction graph:** hotkey → (sample cursor) → selector (reads toggle) →
  image: `capture:interactive`→crop→`persistCaptureFromTempV2`(insert cursor layer)
  / video: `recording:start`→service→Swift `showsCursor`. Settings writes broadcast
  `events:settings:changed`; capture reads the service at capture time, not a cached
  renderer copy.
- **Error / failure propagation:** native cursor sampling must degrade gracefully —
  if `currentSystem` returns `nil` / out-of-bounds / timeout, **skip the cursor
  layer** and produce a normal capture (best-effort enhancement, never a hard
  dependency; macOS 15+/26 is actively narrowing cursor capture).
- **State lifecycle risks:** selector toggle state leaking across pre-warmed
  reuse (scrub in 3 paths); stale thumbnail for one repack cycle; cursor layer not
  crop-translated → drift.
- **API-surface parity:** export (`library:export` wholesale), `clipboard:copy` /
  `copy-file` / `copyLayerFragment` all render through `composeV2`
  ([coordinator.ts:66-87](apps/desktop/src/main/render/coordinator.ts)) → cursor
  layer included automatically; no raw-source bypass exists.
- **Permissions:** unchanged for the primary native path (`NSCursor.currentSystem`
  needs no TCC grant); the diff fallback needs the Screen Recording grant the video
  path already requires (`guardScreenCapture` chokepoint).

## Acceptance Criteria

### Functional

- [ ] Settings → Recording exposes "Capture cursor in video" (default on) and
      "Capture cursor in screenshots" (default per chosen option).
- [ ] Video: with the setting/toggle OFF, the recording contains no cursor; ON
      (default) it does, exactly as today.
- [ ] Inline cursor toggle appears on the region selector and overrides the
      default for that one capture; never adds a blocking window; capture speed is
      unchanged when untouched; toggle state never leaks to the next capture.
- [ ] Editor raster LayerView (Phase 2): non-base raster layers render as real
      pixels on the canvas, can be selected, moved/resized, z-ordered, and deleted;
      pasted-image layers become editable; live preview matches `composeV2` export.
- [ ] Image cursor (Phase 3, C-max): with cursor enabled, the capture shows the
      real system cursor (correct glyph, position, retina scale) as a "Cursor"
      layer; the user can see it in the editor, move it, and delete it; export and
      clipboard reflect the edit — with no cursor-specific editor code.
- [ ] Image (R6): for region/window captures the cursor layer is added only when
      the pointer was inside the captured bounds.
- [ ] Cursor sampling failure degrades to a normal cursor-less capture (no error
      surfaced to the user).
- [ ] Off-origin crop keeps the cursor correctly positioned (crop translation).

### Non-Functional / Quality Gates

- [ ] No `schemaVersion` bump; old settings files load (parseV1 back-fill).
- [ ] No `BAKE_PIPELINE_VERSION` bump (verify: cursor layer hashing only).
- [ ] Renderers stay sandboxed; native cursor read runs in the helper, not a renderer.
- [ ] Private-API fallback (if implemented) resolved via `dlsym` with graceful
      degradation; off by default.
- [ ] Tests: settings round-trip + validator; recorder `showsCursor` plumbing;
      selector toggle state scrub; cursor-layer insert + in-bounds gate + crop
      translate; export/clipboard include the cursor.

## Dependencies & Risks

- **macOS cursor-capture is narrowing** (`currentSystem` deprecated in 15; cursor-
  window capture broke in 26). Treat the image cursor sprite as best-effort with a
  documented fallback ladder.
- **Editor raster LayerView (Phase 2) is the long pole** — a real editor-architecture
  change. If it slips, the feature can ship an intermediate (B: cursor layer +
  delete-by-id button, data correct, editor-visibility gap documented) and upgrade
  later. Phases 1 and 3 don't block on Phase 2 shipping first.
- **Preview ↔ `composeV2` parity** is the main correctness risk of the LayerView —
  CSS-transform live preview must match the baked composite across translate/scale/
  opacity, off-origin crop, and effect sampling order.
- **Frozen-snapshot timing**: cursor must be sampled at trigger, not at snapshot
  time, or it captures the crosshair.

## Open Questions

### Resolved
- **[Scope]** Image-cursor option = **C-max** (full editor raster LayerView). Image
  default = **ON** (deletable, so safe).

### Resolve before building Phase 2
- **[Technical]** Raster rendering model for the editor preview: per-layer
  transform-positioned DOM elements (live CSS transforms, no re-bake on drag — the
  recommended path) vs switching the preview to the composite. Determines the whole
  LayerView shape and the preview↔export parity strategy. Strong candidate for
  `/deepen-plan` or its own plan file.

### Deferred to implementation
- **[Technical]** Exact host for the native cursor helper (extend `PwrSnapRecorder`
  vs a new tiny helper) and the JSON contract.
- **[Technical]** How the base raster is pinned/protected so the LayerView can't
  delete the whole capture.
- **[Needs research]** Fidelity of `NSCursor.currentSystem` for non-standard/custom
  app cursors; whether the diff fallback is needed in practice.

## Sources & References

### Origin
- **Origin document:** [docs/brainstorms/2026-06-15-cursor-capture-control-requirements.md](docs/brainstorms/2026-06-15-cursor-capture-control-requirements.md).
  Carried forward: one concept / two per-mode defaults both ON; video = baked-in
  pre-capture toggle; image = deletable cursor layer; Settings default + inline
  toggle, no blocking window; region cursor only when in-bounds.

### Internal references
- Video flag: [main.swift:37-57, 202](apps/desktop/native/recorder/main.swift); [recording-service.ts:43-47,221-232,421-429](apps/desktop/src/main/recording/recording-service.ts); [recording-handlers.ts:204-267](apps/desktop/src/main/handlers/recording-handlers.ts); [protocol.ts:2954-2961](packages/shared/src/protocol.ts).
- Settings: [protocol.ts:1662-1686,2105](packages/shared/src/protocol.ts); [desktop-settings-service.ts:161-174,284,622-641](apps/desktop/src/main/settings/desktop-settings-service.ts); [settings-validators.ts:406-450](apps/desktop/src/main/handlers/settings-validators.ts).
- Selector: [RegionSelector.tsx:134,401-424,1153-1172](apps/desktop/src/renderer/src/features/region/RegionSelector.tsx); [region-selector.ts:142-183,282-351,392-411,1528-1557](apps/desktop/src/main/capture/region-selector.ts); [preload/index.ts:175-189](apps/desktop/src/preload/index.ts); image callsite [capture-handlers.ts:222,327-334](apps/desktop/src/main/handlers/capture-handlers.ts); video callsite [index.ts:934-938,1039-1047,1084-1088](apps/desktop/src/main/index.ts).
- Image pixels: [screencapture.ts:5,302-309,383-390](apps/desktop/src/main/capture/screencapture.ts).
- Layers: [bundle-store.ts:790-855,847,892,982](apps/desktop/src/main/persistence/bundle-store.ts); [bundle-manifest-schema-v2.ts:115-156](packages/shared/src/bundle-manifest-schema-v2.ts); [layers-repo.ts:165,408-493,500,526,675-709](apps/desktop/src/main/persistence/layers-repo.ts); [editor-handlers.ts:165-221,240-328](apps/desktop/src/main/handlers/editor-handlers.ts).
- Editor preview: [Editor.tsx:487,573,4362-4377](apps/desktop/src/renderer/src/features/editor/Editor.tsx); [pwrsnap.ts:117-119](apps/desktop/src/renderer/src/lib/pwrsnap.ts); [protocols.ts:6-12,242-261](apps/desktop/src/main/protocols.ts); export/clipboard [coordinator.ts:66-87](apps/desktop/src/main/render/coordinator.ts), [clipboard-handlers.ts:96,343-477](apps/desktop/src/main/handlers/clipboard-handlers.ts).
- Learnings: [docs/solutions/2026-06-07-capture-selector-interaction-and-state.md](docs/solutions/2026-06-07-capture-selector-interaction-and-state.md), [docs/solutions/2026-05-12-settings-substrate.md](docs/solutions/2026-05-12-settings-substrate.md), [docs/solutions/2026-05-28-bake-render-cache-orphans.md](docs/solutions/2026-05-28-bake-render-cache-orphans.md), [docs/solutions/2026-06-13-off-origin-crop-effect-clip-rect.md](docs/solutions/2026-06-13-off-origin-crop-effect-clip-rect.md), [docs/solutions/2026-06-14-first-run-screen-recording-permission.md](docs/solutions/2026-06-14-first-run-screen-recording-permission.md), [buildout plan §CLI vs SCKit](docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md).

### External (macOS cursor capture)
- [CodeJam — harvest cursor from any app](https://www.codejam.info/2023/07/macos-harvest-cursor-from-any-app.html)
- [Apple Forums 760305 — replacement for NSCursor.currentSystemCursor](https://developer.apple.com/forums/thread/760305) · [819931 — capture only the cursor (Tahoe)](https://developer.apple.com/forums/thread/819931) · [702740 — notarizing with private API](https://developer.apple.com/forums/thread/702740)
- [Apple — SCStreamFrameInfo](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo) · [SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)
- [NUIKit/CGSInternal — private CGS cursor headers](https://github.com/NUIKit/CGSInternal) · [electron #6578 — currentSystemCursor nil in renderer](https://github.com/electron/electron/issues/6578)

### External (editor / canvas-editor architecture — Phase 2 deepening)
- [Figma — Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/) · [Evan Wallace — How Figma's renderer works](https://madebyevan.com/figma/) (one renderer, two compile targets → guaranteed parity)
- [tldraw — Image export](https://tldraw.dev/sdk-features/image-export) · [Excalidraw — Canvas & Image Export](https://deepwiki.com/excalidraw/excalidraw/7.1-canvas-and-image-export) (shared element-prep + `isExporting` divergences)
- [Konva — High-Quality Export](https://konvajs.org/docs/data_and_serialization/High-Quality-Export.html) · [Performant Drag/Zoom with Fabric.js](https://medium.com/@Fjonan/performant-drag-and-zoom-using-fabric-js-3f320492f24b)
- [webperf.tips — Layers & Compositing](https://webperf.tips/tip/layers-and-compositing/) · [Smashing — GPU Animation: Doing It Right](https://www.smashingmagazine.com/2016/12/gpu-animation-doing-it-right/) · [MDN — backdrop-filter (backdrop-root scoping)](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter) · [javascript.info — Blob / object URLs](https://javascript.info/blob)
- Internal parity precedents: [text-html-bake.ts](apps/desktop/src/main/render/text-html-bake.ts) (Chromium-bake-for-text), [BlurOverlays.tsx `RotatedEffectCanvas`](apps/desktop/src/renderer/src/features/editor/BlurOverlays.tsx) (sample-below mirror), [editor-image-style.ts](apps/desktop/src/renderer/src/features/editor/editor-image-style.ts) (`computeEditorImageStyle`).
