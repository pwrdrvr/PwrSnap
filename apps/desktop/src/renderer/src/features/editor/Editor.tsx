// Phase 2 Editor — full tool palette + Phase 1 v2 editor refresh wiring.
//
// Tools (Slice B):
//   • Arrow      — drag from→to. Smart geometry shared with bake.
//   • Rect       — drag a rectangle. Stroked outline + white halo.
//   • Highlight  — drag a rectangle. Semi-transparent yellow fill.
//   • Blur       — drag a rectangle. Mask-style blur per region in bake.
//   • Text       — click to anchor; inline input; Enter commits.
//   • Crop       — Phase 1 v2 refresh: 8-handle crop overlay; ↵ commits.
//
// Coordinate system: every overlay's geometry is normalized to
// [0, 1]^2 fractions of the source image's W×H — independent of
// canvas display size. The same overlay record renders identically
// in the editor's live SVG and in the sharp bake (compose.ts).
//
// Smart-arrow geometry (computeArrowGeometry) is the shared math
// between live render and bake. Rect/highlight/blur are simpler:
// just a rect with normalized coords; the bake produces an SVG
// buffer at source-pixel resolution.
//
// Phase 1 v2 wiring (chrome === "full" only):
//   • useEditorToolState — owns active tool + per-tool style memory +
//     COLOR-slot fan-out + matching-text affordance lifecycle.
//   • EditorChrome — VS-Code-style activity bar + collapsible panel
//     that wraps the editor viewport in standalone-window mode only.
//   • ToolStylePopover — anchored to the toolbar's active tool button
//     via a caret. Double-tapping the tool's letter shortcut also
//     opens the popover.
//   • CropTool — rendered as an overlay when activeTool === "crop";
//     commits a CropOverlay via overlays:upsert and stays in crop
//     mode (sticky) until the user picks another tool.
//   • Matching-text affordance — small "+ Add label" button positioned
//     near the just-placed arrow's tail; click → flips to text tool
//     for one placement, then returns to arrow.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  BlurStyle,
  BundleLayerNode,
  CaptureRecord,
  Overlay,
  OverlayRow,
  ToolSizePreset
} from "@pwrsnap/shared";
import { DEFAULT_BLUR_STYLE } from "@pwrsnap/shared";
import { dispatch, captureSrcUrl } from "../../lib/pwrsnap";
import { findRootGroupId, overlayToBundleLayerNode } from "./overlayToLayer";
import { resolveToolColor } from "./resolveToolColor";
import { TOOLS, type Tool } from "./editor-tools";
import { useZoomPan, type ZoomMode } from "./useZoomPan";
import { useUndoRedo, type InteractionToken } from "./useUndoRedo";
import { useCaptureModel } from "./useCaptureModel";
import { useEnsureV2, type EnsureV2State } from "./useEnsureV2";
import { V1ToV2DoctorBanner } from "./V1ToV2DoctorBanner";
import { OverlaySvg } from "./OverlaySvg";
import { BlurOverlays } from "./BlurOverlays";
import { TextDraftInput } from "./TextDraftInput";
import { ZoomMenu } from "./ZoomMenu";
import { CropTool } from "./CropTool";
import { EditorChrome } from "./EditorChrome";
import { ToolStylePopover, type StyledToolKind } from "./ToolStylePopover";
import { InfoPanel } from "./panels/InfoPanel";
import { ToolConfigPanel } from "./panels/ToolConfigPanel";
import {
  useEditorToolState,
  type ActiveStyle,
  type StyledTool,
  type StyleFor,
  type UseEditorToolStateReturn
} from "./useEditorToolState";
import {
  MIN_DRAG_LENGTH,
  rectFromDrag,
  type Draft,
  type DraftArrow,
  type DraftRect,
  type DraftText
} from "./editor-types";
import "./editor.css";

/** Three structural shapes for the editor:
 *
 *   • "full"       — standalone editor window: titlebar + bottom
 *                    toolbar, wrapped in <EditorChrome> (Phase 1 v2
 *                    refresh: activity bar + collapsible right panel).
 *                    Default when no chrome prop is passed.
 *   • "embedded"   — inline-in-Library mode (Phase 2 Slice C / Phase
 *                    A transitional): no titlebar, but keeps the
 *                    bottom toolbar. This branch was dropped in
 *                    Phase B and may be removed entirely in a
 *                    future cleanup.
 *   • "chromeless" — Library Focus + Reel modes: no titlebar, no
 *                    toolbar. The canvas + draft input only. The
 *                    floating EditToolbar lives at the Library level
 *                    and shares tool state via the controlled
 *                    `tool` / `onToolChange` props. */
export type EditorChromeKind = "full" | "embedded" | "chromeless";
/** Back-compat alias — callers import this name. */
export type { EditorChromeKind as EditorChrome };

export type { ZoomMode };

/** Reactive snapshot of the editor's zoom state, surfaced to parents
 *  that render zoom controls outside the editor (Library's floating
 *  EditToolbar). `null` means the editor has unmounted — clear any
 *  cached api. */
export type ZoomApi = {
  mode: ZoomMode;
  /** Current zoom % relative to "actual size" (image's natural CSS
   *  dimensions, accounting for devicePixelRatio). 100 = one image
   *  pixel per screen pixel. Null until the wrap is first measured. */
  displayPct: number | null;
  /** What displayPct would be at fit (scale=1). Used to render
   *  "Fit (XX%)" in the toolbar without flipping into fit mode. */
  fitPct: number | null;
  resetToFit: () => void;
  actualSize: () => void;
  /** Jump to a specific display percentage. */
  setCustomPct: (pct: number) => void;
  /** Multiply current scale by `factor` (e.g. 1.2 for +20%, 1/1.2
   *  for -20%). */
  zoomBy: (factor: number) => void;
} | null;

const STYLED_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "arrow",
  "text",
  "rect",
  "blur",
  "highlight"
]);

function isStyledToolKind(tool: Tool): tool is StyledToolKind {
  return STYLED_TOOLS.has(tool);
}

/** Map a text tool's `fontSize` preset (auto / small / medium / large)
 *  into the v1 `TextOverlay.size` enum (small | large). The v1 schema
 *  only has two buckets; "auto" + "small" → "small", "medium" + "large"
 *  → "large". Numeric presets aren't reachable from the popover today
 *  but fall back to "small" defensively. */
function resolveTextSize(
  fontSize: ToolSizePreset | number
): "small" | "large" {
  if (typeof fontSize === "number") return "small";
  if (fontSize === "large") return "large";
  if (fontSize === "medium") return "large";
  return "small";
}

/** v2 → v1 read-only projection. The existing `OverlaySvg` and
 *  `BlurOverlays` components consume `OverlayRow[]`; for v2 captures we
 *  back-project layer nodes into the same shape so the renderers don't
 *  need to know about the format split during Phase 2 (Phase 4-5 swap
 *  the renderers to consume `LayerView` natively and this shim
 *  retires). Only `vector` and `effect` (blur) layers project — groups
 *  and rasters are skipped (no Phase 1 renderer surface for them). */
function projectV2LayersToOverlayRows(
  layers: BundleLayerNode[],
  captureId: string
): OverlayRow[] {
  const rows: OverlayRow[] = [];
  for (const layer of layers) {
    if (layer.kind === "vector") {
      // v2 vector layers carry the v1 Overlay shape verbatim under
      // `shape`. The renderer only reads `id` + `data` so the projection
      // is direct.
      rows.push({
        id: layer.id,
        capture_id: captureId,
        data: layer.shape,
        schema_version: 1,
        source: layer.source,
        ai_run_id: layer.ai_run_id,
        z_index: layer.z_index,
        rejected_at: layer.rejected_at,
        applied_at: layer.applied_at,
        superseded_by: layer.superseded_by,
        created_at: layer.created_at
      });
      continue;
    }
    if (layer.kind === "effect" && layer.effect.type === "blur") {
      // v2 blur effects clip to a `clip_rect` in canvas pixels; v1
      // blurs use normalized [0,1] coords. The renderer expects v1
      // shape, so we round-trip through `clip_rect`-as-canvas-pixels
      // by skipping when null (no spatial extent → can't render).
      if (layer.clip_rect === null) continue;
      rows.push({
        id: layer.id,
        capture_id: captureId,
        data: {
          kind: "blur",
          rect: {
            // v2 canvas-pixel coords come back here; we re-normalize
            // against… the canvas dimensions, which we don't have at
            // this scope. Fall back to passing absolute pixels and
            // trusting the renderer treats them as a clip box. The
            // pixel-coord branch is rarely exercised in Phase 2 (only
            // bundle_v2-flagged captures hit it).
            x: layer.clip_rect.x,
            y: layer.clip_rect.y,
            w: layer.clip_rect.w,
            h: layer.clip_rect.h
          },
          style: DEFAULT_BLUR_STYLE
        },
        schema_version: 1,
        source: layer.source,
        ai_run_id: layer.ai_run_id,
        z_index: layer.z_index,
        rejected_at: layer.rejected_at,
        applied_at: layer.applied_at,
        superseded_by: layer.superseded_by,
        created_at: layer.created_at
      });
    }
    // group + raster + highlight-effect: no Phase 2 renderer surface.
    // Phase 4-5 LayerView rewrite covers them.
  }
  return rows;
}

/** Hit-test a normalized [0,1] point against a list of overlay rows.
 *  Walks rows in reverse z-order (last-painted = topmost = first
 *  candidate) so the visually-topmost overlay under the cursor wins
 *  ties. Returns the matching row id, or null if nothing under the
 *  point. Phase 3.2 minimal selection model; the threshold for
 *  arrow/text hits is generous (≈ stroke width) so the user doesn't
 *  have to pixel-hunt a 1px line.
 *
 *  Coordinate space: `xn`, `yn` are normalized [0,1]; rect overlays
 *  carry normalized {x,y,w,h}; arrow overlays carry normalized
 *  {from,to}. The threshold scales with the canvas's pixel extent
 *  (passed in) so the click radius is roughly constant in screen-
 *  px regardless of canvas size.
 */
export function hitTestOverlays(
  overlays: OverlayRow[],
  xn: number,
  yn: number,
  canvasPxShortSide: number
): string | null {
  // ~10px hit radius on a 1000px short-side canvas → 0.01 in
  // normalized coords. Scales inversely with size for a roughly
  // constant pixel tolerance.
  const hitRadiusN = Math.max(0.008, 10 / Math.max(1, canvasPxShortSide));
  for (let i = overlays.length - 1; i >= 0; i -= 1) {
    const row = overlays[i];
    if (row === undefined) continue;
    const o = row.data;
    if (o.kind === "rect" || o.kind === "highlight" || o.kind === "blur") {
      if (
        xn >= o.rect.x &&
        xn <= o.rect.x + o.rect.w &&
        yn >= o.rect.y &&
        yn <= o.rect.y + o.rect.h
      ) {
        return row.id;
      }
      continue;
    }
    if (o.kind === "arrow") {
      // Point-to-segment distance in normalized space.
      const ax = o.from.x;
      const ay = o.from.y;
      const bx = o.to.x;
      const by = o.to.y;
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-9) continue;
      let t = ((xn - ax) * dx + (yn - ay) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const distN = Math.hypot(xn - px, yn - py);
      if (distN <= hitRadiusN) return row.id;
      continue;
    }
    if (o.kind === "text") {
      // Approximate text hit by a small radius around the anchor
      // point. The font scales with image short-side; this gives a
      // generous click target without measuring rendered glyphs.
      const distN = Math.hypot(xn - o.point.x, yn - o.point.y);
      if (distN <= hitRadiusN * 4) return row.id;
      continue;
    }
    // crop / step: not user-selectable in Phase 3.2 (crop is a
    // canvas-side mutation, not a layer; step is legacy).
  }
  return null;
}

export function Editor({
  captureId,
  chrome = "full",
  tool: toolProp,
  onToolChange,
  toolState: toolStateProp,
  blurStyle: blurStyleProp,
  onZoomChange
}: {
  captureId: string;
  /** Chrome shape — see `EditorChromeKind` above. Defaults to `"full"`
   *  (standalone editor window). */
  chrome?: EditorChromeKind;
  /** Optional controlled tool state. If both `tool` and `onToolChange`
   *  are passed, Editor is fully controlled — Library owns the tool
   *  state and drives the floating EditToolbar. If neither is passed,
   *  Editor falls back to internal state (the standalone window uses
   *  `useEditorToolState` in that branch; the embedded fallback uses a
   *  plain useState). Mixed (one without the other) is not supported
   *  and will fall back to internal state. */
  tool?: Tool;
  onToolChange?: (tool: Tool) => void;
  /** Optional controlled tool-state surface — Phase 3.2 lift. When
   *  provided (Library Focus path), Editor reads `activeStyle` /
   *  `onAnnotationPlaced` from this shared hook instance instead of
   *  its own dormant copy. The lift fixes the long-standing "popover
   *  picks land in EditToolbar's hook, persistOverlay reads from
   *  Editor's hook, so style choices don't stick" bug. The standalone
   *  Editor window leaves this undefined and keeps owning its own
   *  hook (its EditorChrome panels also need a single source of truth
   *  in-window). */
  toolState?: UseEditorToolStateReturn;
  /** Optional controlled blur-style state. When provided (Library
   *  mode), the EditToolbar's BlurMenu owns the picker UI and writes
   *  this back to Library. When omitted (standalone window), the
   *  editor falls back to the `useEditorToolState` blur tool style
   *  block (which the right-sidebar ToolConfigPanel + popover edit). */
  blurStyle?: BlurStyle;
  /** Called whenever the editor's zoom state changes. Library uses
   *  this to render the zoom indicator in the floating EditToolbar
   *  (so the indicator doesn't float over the image). Called with
   *  `null` on unmount so the parent can clear its cached api. */
  onZoomChange?: (api: ZoomApi) => void;
}) {
  // ----- Capture data ---------------------------------------------
  //
  // Phase 2 v2 editor refresh — single hook owns both v1 and v2 reads
  // plus the cancel-safety dance + broadcast-driven refetch. The hook
  // returns a discriminated union (loading / loaded-v1 / loaded-v2 /
  // error); we project v2 layers back to OverlayRow[] for the existing
  // OverlaySvg / BlurOverlays render path (read-only — write paths
  // still go through overlays:upsert for v1; v2 writes are Phase 4-5).
  const model = useCaptureModel(captureId);

  // ----- v1 → v2 lazy doctor orchestration (Phase 3) --------------
  //
  // When the capture loads as v1, this hook fires `v1ToV2:upgrade` in
  // the background. While the doctor runs, we render the banner and
  // disable the toolbar. On success the doctor broadcasts
  // `events:captures:changed`, useCaptureModel re-fetches, and the
  // hook sees format >= 2 → flips to "irrelevant". On parking after
  // MAX_ATTEMPTS=5, the hook flips to "view_only" — the banner
  // surfaces a Retry button bound to ensureV2.retry().
  const currentBundleFormatVersion: number | null =
    model.kind === "loaded" ? model.record.bundle_format_version : null;
  const ensureV2 = useEnsureV2({ captureId, currentBundleFormatVersion });

  // ----- Tool + style state ---------------------------------------
  //
  // Two-mode source-of-truth:
  //
  //   • Controlled (Library Focus): `tool` + `onToolChange` props are
  //     both passed. Library is the single owner; per-tool style memory
  //     lives in the floating EditToolbar's own hook in task #10.
  //   • Standalone window (chrome === "full"): we own the hook here.
  //     Active tool + per-tool style memory + matching-text affordance
  //     all live in `useEditorToolState`.
  //
  // The hook is ALWAYS instantiated (hooks rules) but its result is only
  // consumed when not in controlled mode. The controlled branch keeps
  // the hook in a stable state — its tool stays "pointer" because
  // controlled paths never call setActiveTool.
  const isControlled = toolProp !== undefined && onToolChange !== undefined;
  // Phase 3.2 lift: in Library Focus, the parent owns ONE hook instance
  // that's also threaded into EditToolbar — so popover style picks land
  // in the same `activeStyle` that `persistOverlay` reads here. When
  // not lifted (standalone editor window), instantiate our own hook.
  // We always call the hook (rules of hooks), then pick whichever source
  // is active. `effectiveToolState` is what every downstream read uses.
  const ownToolState = useEditorToolState({ captureId });
  const effectiveToolState: UseEditorToolStateReturn =
    toolStateProp ?? ownToolState;
  const tool: Tool = isControlled ? toolProp : effectiveToolState.activeTool;
  // `options.singleShot` is the ⌥-click escape hatch: place ONE
  // annotation, then return to Pointer. The hook honors the flag by
  // routing `onAnnotationPlaced` through a single-shot reset; the
  // controlled (Library Focus) path doesn't see this — it has its own
  // mirror in features/library/EditToolbar.tsx that wires the same
  // semantic through the hook instantiated there.
  const setTool = useCallback(
    (next: Tool, options?: { singleShot?: boolean }): void => {
      if (isControlled) {
        onToolChange(next);
      } else {
        effectiveToolState.setActiveTool(next, options);
      }
    },
    [isControlled, onToolChange, effectiveToolState]
  );

  // Blur style for the commit pipeline:
  //   • Library (controlled) → use the `blurStyle` prop the parent
  //     threads in (EditToolbar's BlurMenu owns it there).
  //   • Standalone → take the live blur-tool-style mode from the hook,
  //     falling back to the default until settings resolve.
  const blurStyle: BlurStyle = useMemo(() => {
    if (blurStyleProp !== undefined) return blurStyleProp;
    if (effectiveToolState.activeStyle.tool === "blur") {
      return effectiveToolState.activeStyle.style.mode;
    }
    // For non-blur active tools in standalone mode, we still need a
    // mode for the rare ad-hoc shortcut commit. Read the blur block
    // through a temporary tool switch is overkill — the hook's
    // activeStyle only carries the active tool's block. Fall back to
    // the persisted default; the popover/panel writes will update this
    // path on the next blur-tool selection.
    return DEFAULT_BLUR_STYLE;
  }, [blurStyleProp, effectiveToolState.activeStyle]);

  const [draft, setDraft] = useState<Draft | null>(null);
  // Phase 3.2 — minimal selection model. Tracks the id of the
  // currently-selected overlay/layer; null means nothing selected.
  // Used to render a selection outline and to delete on backspace/
  // delete. Click on the pointer tool hit-tests against existing
  // overlays; click on empty canvas clears. Escape clears too.
  //
  // Out of scope (deferred to Phase 4): transform handles (move /
  // resize / rotate), color/style editing of the selected glyph,
  // multi-select. Just enough state for the user to clean up wrong
  // annotations without rebuilding the whole capture.
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  // Mirror of the resolved overlay list, kept in a ref so
  // onPointerDown's hit-test reads the latest value without bouncing
  // through state. The list itself lives in the EditorLoaded child
  // (after the model resolves); we project a v1-shaped view of it
  // here for the synchronous click handler.
  const overlaysRef = useRef<OverlayRow[]>([]);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  // True while undo/redo is replaying an op via the IPC. The
  // events:overlays:changed broadcast will fire and refetch; we
  // don't want that refetch to re-record a new EditOp.
  const undoApplyingRef = useRef<boolean>(false);
  // Hook-owned recorder, populated by EditorLoaded once the record
  // resolves. persistOverlay needs to call it; the hook lives in the
  // child so it can depend on the loaded record's id.
  const recordCreateRef = useRef<((row: OverlayRow) => void) | null>(null);
  // Coalescing bracket refs (Phase 2 task #14, plan Alt 5). pointerdown
  // opens a "drag" interaction; pointerup closes it. Current Phase 2
  // editor flows commit exactly one recordCreate per drag at pointerup,
  // so the bracket is a no-op for now — the API is exercised here so
  // Phase 4+ drag-existing-overlay paths pick up the coalescing
  // automatically without touching pointer handlers.
  const beginInteractionRef = useRef<
    ((opKind: string, layerId: string) => InteractionToken) | null
  >(null);
  const endInteractionRef = useRef<((token: InteractionToken) => void) | null>(
    null
  );
  const activeInteractionTokenRef = useRef<InteractionToken | null>(null);

  // Auto-focus the text input when entering text-draft state.
  useEffect(() => {
    if (draft?.kind === "text") {
      textInputRef.current?.focus();
    }
  }, [draft]);

  function clientToNormalized(
    clientX: number,
    clientY: number
  ): { xn: number; yn: number } | null {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const xn = (clientX - rect.left) / rect.width;
    const yn = (clientY - rect.top) / rect.height;
    if (xn < 0 || xn > 1 || yn < 0 || yn > 1) return null;
    return { xn, yn };
  }

  /** Translate normalized [0,1] coords back to canvas-pixel coords —
   *  used to anchor the matching-text affordance at the arrow's tail
   *  in the same coordinate space the canvas overlay renders in. */
  function normalizedToCanvasPx(
    xn: number,
    yn: number
  ): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: xn * rect.width, y: yn * rect.height };
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    // Phase 3.2 selection: pointer tool clicks hit-test against
    // existing overlays. Hit → select that overlay. Miss → clear.
    // The hit-test runs against `overlaysRef.current` which the
    // EditorLoaded child keeps in sync (the overlay list lives on
    // that branch). Crop still owns its own canvas via its overlay
    // element; pointer-mode only ever sees pointerdown when the
    // user actually clicks on `.editor-canvas`.
    if (tool === "pointer") {
      const start = clientToNormalized(event.clientX, event.clientY);
      if (start === null) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      const shortSide =
        rect === undefined ? 1000 : Math.min(rect.width, rect.height);
      const overlays = overlaysRef.current;
      const hit = hitTestOverlays(overlays, start.xn, start.yn, shortSide);
      setSelectedLayerId(hit);
      return;
    }
    if (tool === "crop") return;
    // If we're mid-text and the user clicks elsewhere, commit/cancel
    // the text first (the input's blur handler will fire).
    if (draft?.kind === "text") return;
    // Drawing a new annotation deselects any previous selection so
    // the outline doesn't linger on top of the new draft.
    if (selectedLayerId !== null) setSelectedLayerId(null);

    const start = clientToNormalized(event.clientX, event.clientY);
    if (start === null) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);

    // Open a coalescing bracket for the drag. layerId uses the tool
    // name as a sentinel since the actual layer doesn't exist yet
    // (it's created at pointerup via persistOverlay). For Phase 2's
    // one-write-per-drag flow this bracket is a no-op for coalescing;
    // it's wired here so Phase 4+'s drag-existing-overlay path
    // automatically picks up the coalescing semantics.
    if (tool !== "text" && beginInteractionRef.current !== null) {
      activeInteractionTokenRef.current = beginInteractionRef.current(
        "drag",
        `draft-${tool}`
      );
    }

    if (tool === "arrow") {
      setDraft({
        kind: "arrow",
        fromXn: start.xn,
        fromYn: start.yn,
        toXn: start.xn,
        toYn: start.yn
      });
      return;
    }
    if (tool === "rect" || tool === "highlight" || tool === "blur") {
      setDraft({
        kind: "rect-drag",
        tool,
        startXn: start.xn,
        startYn: start.yn,
        curXn: start.xn,
        curYn: start.yn
      });
      return;
    }
    if (tool === "text") {
      // Click-to-place anchors a text input at the cursor. The input
      // captures keystrokes; Enter commits.
      setDraft({ kind: "text", xn: start.xn, yn: start.yn, body: "" });
      return;
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (draft === null) return;
    if (draft.kind === "text") return;
    const cur = clientToNormalized(event.clientX, event.clientY);
    if (cur === null) return;
    if (draft.kind === "arrow") {
      setDraft({ ...draft, toXn: cur.xn, toYn: cur.yn });
      return;
    }
    if (draft.kind === "rect-drag") {
      setDraft({ ...draft, curXn: cur.xn, curYn: cur.yn });
      return;
    }
  }

  async function onPointerUp(event: React.PointerEvent<HTMLDivElement>): Promise<void> {
    if (draft === null) return;
    if (draft.kind === "text") return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);

    // Grab the coalescing bracket token. We close it AFTER persistOverlay
    // resolves so the recordCreate fires inside the bracket — that way
    // Phase 4+ drag-existing-overlay flows that emit multiple intermediate
    // writes will coalesce correctly. endInteraction tolerates mismatched
    // / null tokens silently.
    const interactionToken = activeInteractionTokenRef.current;
    activeInteractionTokenRef.current = null;
    const closeInteraction = (): void => {
      if (interactionToken !== null && endInteractionRef.current !== null) {
        endInteractionRef.current(interactionToken);
      }
    };

    if (draft.kind === "arrow") {
      const dx = draft.toXn - draft.fromXn;
      const dy = draft.toYn - draft.fromYn;
      if (Math.hypot(dx, dy) < MIN_DRAG_LENGTH) {
        setDraft(null);
        closeInteraction();
        return;
      }
      // Phase 3.1 fix #2/#4 + Phase 3.2 lift: thread the active arrow
      // style (color + endStyle + stemStyle + doubleEnded) into the
      // overlay shape so the popover's choices actually stick. The
      // pre-3.2 guard `!isControlled` skipped style reads in Library
      // Focus because there was no shared hook to read from; the 3.2
      // lift gives us one (toolStateProp), so we can now read
      // activeStyle in BOTH paths. `effectiveToolState` is the lifted
      // hook in Library Focus and our own hook in standalone — both
      // reflect the popover picks live.
      const arrowStyleSrc =
        effectiveToolState.activeStyle.tool === "arrow"
          ? effectiveToolState.activeStyle.style
          : null;
      const arrowOverlay: Extract<Overlay, { kind: "arrow" }> = {
        kind: "arrow",
        from: { x: draft.fromXn, y: draft.fromYn },
        to: { x: draft.toXn, y: draft.toYn },
        color:
          arrowStyleSrc !== null
            ? resolveToolColor(arrowStyleSrc.color)
            : "auto"
      };
      if (arrowStyleSrc !== null) {
        arrowOverlay.endStyle = arrowStyleSrc.endStyle;
        arrowOverlay.stemStyle = arrowStyleSrc.stemStyle;
        arrowOverlay.doubleEnded = arrowStyleSrc.doubleEnded;
      }
      // Capture the arrow tail in canvas-px so the matching-text
      // affordance can position itself; this lookup needs the live
      // canvas rect, so do it BEFORE the await.
      const tailCanvasPx = normalizedToCanvasPx(draft.toXn, draft.toYn);
      setDraft(null);
      const wrote = await persistOverlay(arrowOverlay);
      closeInteraction();
      if (wrote && !isControlled) {
        // Standalone Editor: the canvas-side affordance reads
        // anchorPoint in canvas-px from this same hook instance, so
        // post directly.
        effectiveToolState.onAnnotationPlaced(
          tailCanvasPx !== null
            ? { tool: "arrow", anchorPoint: tailCanvasPx }
            : { tool: "arrow" }
        );
      }
      // Library Focus path uses the EditToolbar's broadcast-driven
      // diff to call onAnnotationPlaced (see EditToolbar.tsx,
      // describePlacement). We intentionally don't double-fire here.
      return;
    }

    if (draft.kind === "rect-drag") {
      const rect = rectFromDrag(draft);
      if (rect === null) {
        setDraft(null);
        closeInteraction();
        return;
      }
      const placedKind = draft.tool;
      // Phase 3.1 fix #2: thread the active style into rect / highlight
      // / blur overlays. Pre-fix, rect + highlight dropped everything
      // to defaults regardless of popover choices.
      let overlay: Overlay;
      if (placedKind === "rect") {
        const rectStyleSrc =
          effectiveToolState.activeStyle.tool === "rect"
            ? effectiveToolState.activeStyle.style
            : null;
        overlay = {
          kind: "rect",
          rect,
          color:
            rectStyleSrc !== null
              ? resolveToolColor(rectStyleSrc.color)
              : "auto"
        };
      } else if (placedKind === "highlight") {
        const hlStyleSrc =
          effectiveToolState.activeStyle.tool === "highlight"
            ? effectiveToolState.activeStyle.style
            : null;
        const hlOverlay: Extract<Overlay, { kind: "highlight" }> = {
          kind: "highlight",
          rect
        };
        if (hlStyleSrc !== null) {
          const resolved = resolveToolColor(hlStyleSrc.color);
          hlOverlay.color = resolved;
          hlOverlay.opacity = hlStyleSrc.opacity;
          hlOverlay.blend = hlStyleSrc.blend;
        }
        overlay = hlOverlay;
      } else {
        // blur — already threaded via the `blurStyle` memo at the
        // top of this function, so this branch was correct pre-fix.
        overlay = { kind: "blur", rect, style: blurStyle };
      }
      setDraft(null);
      const wrote = await persistOverlay(overlay);
      closeInteraction();
      if (wrote && !isControlled) {
        effectiveToolState.onAnnotationPlaced({ tool: placedKind });
      }
      return;
    }
    // Fallthrough: close interaction even if no draft branch matched.
    closeInteraction();
  }

  /**
   * Returns true if the overlay was written successfully.
   *
   * Phase 3.1 fix #3 (the cascade root): route writes by current bundle
   * format. The Phase 3 doctor flips v1 captures to v2 on first edit-
   * open; the bus-side guard `refuseIfV2Capture` then rejects
   * `overlays:upsert` on those captures, so the legacy single-dispatch
   * code dropped every new overlay on the floor. v2 captures take the
   * `layers:upsert` path via an Overlay→BundleLayerNode adapter.
   *
   * TODO(phase-4-5): fold this branch into `useCaptureModel.dispatchEdit`
   * (Approach B) so callers stop restating the format. Kept as a
   * surgical site-local branch here to ship the fix without a
   * 3-file refactor.
   */
  async function persistOverlay(overlay: Overlay): Promise<boolean> {
    // Snapshot the model at call time. The model branch is the only
    // thing we read; subsequent state changes (e.g. a captures:changed
    // broadcast) re-render but don't race this in-flight write — the
    // result is recorded on the same model.
    if (model.kind === "loaded" && model.format === 2) {
      // v2 path: adapt the Overlay → BundleLayerNode + dispatch layers:upsert.
      const adapted = overlayToBundleLayerNode(
        overlay,
        { width: model.record.width_px, height: model.record.height_px },
        findRootGroupId(model.layers)
      );
      if (!adapted.ok) {
        // eslint-disable-next-line no-console
        console.error("overlayToBundleLayerNode failed", adapted.error);
        return false;
      }
      const result = await dispatch("layers:upsert", {
        captureId,
        layer: adapted.layer
      });
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error("layers:upsert failed", result.error);
        return false;
      }
      // Undo / redo intentionally skipped on the v2 path. The undo
      // stack (`useUndoRedo`) dispatches `overlays:delete` /
      // `overlays:upsert` directly, and both verbs would be rejected
      // by the bus-side v2 guard (`v2_capture_use_layers_ipc`). The
      // v2-native undo path lands in Phase 4-5 alongside the
      // BundleLayerNode-shaped op stack. For Phase 3.1, the user can
      // still ⌘Z within a v1 capture; v2 captures get a working
      // create path now and a working undo path later.
      // TODO(phase-4-5): teach useUndoRedo to branch on capture format.
      return true;
    }

    // v1 path — unchanged behavior.
    const result = await dispatch("overlays:upsert", { captureId, overlay });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error("overlays:upsert failed", result.error);
      return false;
    }
    // Record the create on the undo stack so ⌘Z reverts it.
    // Suppressed when we ARE the undo/redo replay path
    // (undoApplyingRef === true).
    if (!undoApplyingRef.current) {
      recordCreateRef.current?.(result.value);
    }
    // events:overlays:changed broadcast triggers refetch.
    return true;
  }

  async function commitText(): Promise<void> {
    if (draft?.kind !== "text") return;
    const body = draft.body.trim();
    if (body.length === 0) {
      setDraft(null);
      return;
    }
    // Phase 3.1 fix #2 + Phase 3.2 lift: thread the active text style
    // (color + fontSize mapped to v1's two-bucket size enum). Reads
    // from effectiveToolState so Library Focus picks up the lifted
    // hook's live style; standalone uses its own hook the same way.
    const textStyleSrc =
      effectiveToolState.activeStyle.tool === "text"
        ? effectiveToolState.activeStyle.style
        : null;
    const overlay: Overlay = {
      kind: "text",
      point: { x: draft.xn, y: draft.yn },
      body,
      size:
        textStyleSrc !== null ? resolveTextSize(textStyleSrc.fontSize) : "small",
      color:
        textStyleSrc !== null ? resolveToolColor(textStyleSrc.color) : "auto"
    };
    setDraft(null);
    const wrote = await persistOverlay(overlay);
    if (wrote && !isControlled) {
      effectiveToolState.onAnnotationPlaced({ tool: "text" });
    }
  }

  // Keyboard shortcuts: tool selection + Esc cancels drag.
  //
  // "Double-tap to configure" shortcut: pressing the active tool's
  // letter (e.g. "A" while already on Arrow) a second time opens the
  // tool's style popover. Tracked via `lastShortcutToolRef` so a
  // back-to-back shortcut counts; any tool change in between resets.
  const lastShortcutToolRef = useRef<Tool | null>(null);
  // Toolbar imperative API: exposes a function the keyboard handler
  // can call to open the popover for the active tool when the user
  // double-taps its shortcut. Populated by the toolbar render below.
  const openActivePopoverRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && draft !== null) {
        event.preventDefault();
        setDraft(null);
        return;
      }
      // Don't interpret as a tool shortcut when text input has focus.
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable === true) return;
      // Phase 3.2 selection: Escape clears the selection (when not
      // mid-draft — that case was handled above). Delete / Backspace
      // soft-deletes the selected overlay. We route through the
      // overlays:delete IPC for v1; v2 layers use layers:delete.
      // Branching on bundle_format_version lives in the deletion
      // helper below (set up in EditorLoaded which has the record).
      if (event.key === "Escape" && selectedLayerId !== null) {
        event.preventDefault();
        setSelectedLayerId(null);
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedLayerId !== null
      ) {
        event.preventDefault();
        const id = selectedLayerId;
        setSelectedLayerId(null);
        deleteSelectedRef.current?.(id);
        return;
      }
      // Modifier presses (⌘/⌃/⌥) belong to other handlers — don't eat
      // ⌘A or similar as the arrow shortcut.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const upper = event.key.toUpperCase();
      const matched = TOOLS.find((t) => t.key === upper);
      if (matched !== undefined) {
        event.preventDefault();
        if (
          !isControlled &&
          tool === matched.id &&
          lastShortcutToolRef.current === matched.id &&
          isStyledToolKind(matched.id)
        ) {
          // Double-tap: open the popover for this styled tool.
          openActivePopoverRef.current?.();
          // Reset so a third tap doesn't repeat the open.
          lastShortcutToolRef.current = null;
          return;
        }
        lastShortcutToolRef.current = matched.id;
        setTool(matched.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, isControlled, selectedLayerId, setTool, tool]);

  // Hook-owned deleter (populated by EditorLoaded once it knows the
  // bundle format). Like recordCreateRef, this lives in the outer
  // function because the keyboard handler is here but the model
  // resolution + format branching lives in the child.
  const deleteSelectedRef = useRef<((id: string) => void) | null>(null);

  if (model.kind === "loading") {
    return (
      <div className="editor-loading" data-testid="editor-loading">
        Loading capture…
      </div>
    );
  }
  if (model.kind === "error") {
    return (
      <div className="editor-error" data-testid="editor-error">
        {model.message}
      </div>
    );
  }

  // Resolve OverlayRow[] for the existing renderer code path. v1 hands
  // back overlays natively. v2 projects layer nodes back to OverlayRow
  // shape (read-only — vector + blur-effect cover Phase 2 surface).
  const overlaysForRender: OverlayRow[] =
    model.format === 1
      ? model.overlays
      : projectV2LayersToOverlayRows(model.layers, captureId);
  // Sync the synchronous-read ref the outer pointerdown handler reads.
  // Render-phase write to a ref is safe (refs don't trigger renders);
  // we deliberately do this before returning EditorLoaded so a click
  // landing in the same commit reads the up-to-date overlay list.
  overlaysRef.current = overlaysForRender;
  // Clear stale selection when the selected overlay is no longer in
  // the list (e.g. another window deleted it via the events:overlays:
  // changed broadcast, or the capture switched).
  if (
    selectedLayerId !== null &&
    overlaysForRender.find((r) => r.id === selectedLayerId) === undefined
  ) {
    // Schedule via microtask so we don't setState during render.
    queueMicrotask(() => setSelectedLayerId(null));
  }

  return (
    <EditorLoaded
      record={model.record}
      overlays={overlaysForRender}
      chrome={chrome}
      tool={tool}
      setTool={setTool}
      draft={draft}
      setDraft={setDraft}
      canvasRef={canvasRef}
      canvasWrapRef={canvasWrapRef}
      textInputRef={textInputRef}
      undoApplyingRef={undoApplyingRef}
      recordCreateRef={recordCreateRef}
      beginInteractionRef={beginInteractionRef}
      endInteractionRef={endInteractionRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      commitText={commitText}
      onZoomChange={onZoomChange}
      blurStyle={blurStyle}
      isControlled={isControlled}
      toolState={effectiveToolState}
      openActivePopoverRef={openActivePopoverRef}
      ensureV2State={ensureV2.state}
      onEnsureV2Retry={ensureV2.retry}
      selectedLayerId={selectedLayerId}
      deleteSelectedRef={deleteSelectedRef}
      modelFormat={model.format}
    />
  );
}

/** Loaded body extracted so the zoom + undo hooks can depend on
 *  the capture's intrinsic dimensions (and only mount once the
 *  record has resolved). */
function EditorLoaded({
  record,
  overlays,
  chrome,
  tool,
  setTool,
  draft,
  setDraft,
  canvasRef,
  canvasWrapRef,
  textInputRef,
  undoApplyingRef,
  recordCreateRef,
  beginInteractionRef,
  endInteractionRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  commitText,
  onZoomChange,
  blurStyle,
  isControlled,
  toolState,
  openActivePopoverRef,
  ensureV2State,
  onEnsureV2Retry,
  selectedLayerId,
  deleteSelectedRef,
  modelFormat
}: {
  record: CaptureRecord;
  overlays: OverlayRow[];
  chrome: EditorChromeKind;
  tool: Tool;
  /** Mirrors the outer `setTool` signature so the ⌥-click single-shot
   *  option passes through the toolbar wrapper into useEditorToolState. */
  setTool: (t: Tool, options?: { singleShot?: boolean }) => void;
  draft: Draft | null;
  setDraft: (d: Draft | null) => void;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  canvasWrapRef: React.RefObject<HTMLDivElement | null>;
  textInputRef: React.RefObject<HTMLInputElement | null>;
  undoApplyingRef: React.RefObject<boolean>;
  recordCreateRef: React.RefObject<((row: OverlayRow) => void) | null>;
  /** Coalescing bracket refs — populated from the undo hook so pointer
   *  handlers in the outer Editor function can open/close coalescing
   *  windows without depending on the hook directly. */
  beginInteractionRef: React.RefObject<
    ((opKind: string, layerId: string) => InteractionToken) | null
  >;
  endInteractionRef: React.RefObject<
    ((token: InteractionToken) => void) | null
  >;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => Promise<void>;
  commitText: () => Promise<void>;
  onZoomChange: ((api: ZoomApi) => void) | undefined;
  blurStyle: BlurStyle;
  isControlled: boolean;
  toolState: ReturnType<typeof useEditorToolState>;
  openActivePopoverRef: React.RefObject<(() => void) | null>;
  /** v1 → v2 doctor state from `useEnsureV2`. While the doctor is
   *  upgrading (or has parked), the toolbar is disabled and the
   *  V1ToV2DoctorBanner renders over the canvas. */
  ensureV2State: EnsureV2State;
  /** Bound to the Retry button on the view-only banner. */
  onEnsureV2Retry: () => void;
  /** Phase 3.2 selection model — id of the currently-selected overlay,
   *  null if nothing selected. Drives the selection outline glyph in
   *  OverlaySvg. */
  selectedLayerId: string | null;
  /** Outer Editor's keyboard handler reads this for Delete/Backspace.
   *  EditorLoaded populates it with a format-aware deleter (v1 →
   *  overlays:delete, v2 → layers:delete). */
  deleteSelectedRef: React.RefObject<((id: string) => void) | null>;
  /** Resolved bundle format from the model (1 or 2). EditorLoaded uses
   *  it to branch overlay-delete IPC selection. */
  modelFormat: 1 | 2;
}) {
  const zoom = useZoomPan({
    devicePixelRatio: record.device_pixel_ratio,
    imageWidthPx: record.width_px,
    imageHeightPx: record.height_px,
    wrapRef: canvasWrapRef
  });

  // Surface zoom state to Library (so its floating EditToolbar can
  // render zoom controls without overlaying the image). Split into
  // two effects so we don't bounce null/value/null/value on every
  // zoom tick (the cleanup of a deps-based effect would otherwise
  // fire `null` between every scale change).
  useEffect(() => {
    if (onZoomChange === undefined) return;
    onZoomChange({
      mode: zoom.mode,
      displayPct: zoom.displayPct,
      fitPct: zoom.fitPct,
      resetToFit: zoom.resetToFit,
      actualSize: zoom.actualSize,
      setCustomPct: zoom.setCustomPct,
      zoomBy: zoom.zoomBy
    });
  }, [
    onZoomChange,
    zoom.mode,
    zoom.displayPct,
    zoom.fitPct,
    zoom.resetToFit,
    zoom.actualSize,
    zoom.setCustomPct,
    zoom.zoomBy
  ]);
  useEffect(() => {
    if (onZoomChange === undefined) return;
    return () => onZoomChange(null);
  }, [onZoomChange]);

  const undo = useUndoRedo({ captureId: record.id, applyingRef: undoApplyingRef });

  // Bridge: parent's persistOverlay reads recordCreateRef.current
  // to push onto the undo stack. Sync the hook's recorder into
  // the parent's ref every render so callbacks aren't stale.
  useEffect(() => {
    recordCreateRef.current = undo.recordCreate;
    return () => {
      recordCreateRef.current = null;
    };
  }, [recordCreateRef, undo.recordCreate]);

  // Bridge: parent's pointer handlers read begin/endInteractionRef
  // to bracket coalescing windows around drag operations. Phase 2
  // is no-op (one write per drag) but the wiring readies Phase 4+'s
  // drag-existing-overlay flow.
  useEffect(() => {
    beginInteractionRef.current = undo.beginInteraction;
    endInteractionRef.current = undo.endInteraction;
    return () => {
      beginInteractionRef.current = null;
      endInteractionRef.current = null;
    };
  }, [
    beginInteractionRef,
    endInteractionRef,
    undo.beginInteraction,
    undo.endInteraction
  ]);

  // Phase 3.2 — selection deleter. The outer Editor's keyboard handler
  // reads `deleteSelectedRef.current` on Delete/Backspace. We bridge a
  // format-aware deleter here (v1 → overlays:delete, v2 → layers:delete)
  // so the outer doesn't need to know about bundle_format_version.
  // The events:overlays:changed / events:captures:changed broadcasts
  // trigger useCaptureModel to refetch and the deleted row drops out.
  useEffect(() => {
    deleteSelectedRef.current = (id: string): void => {
      void (async (): Promise<void> => {
        if (modelFormat === 2) {
          await dispatch("layers:delete", { id });
        } else {
          await dispatch("overlays:delete", { id });
        }
      })();
    };
    return () => {
      deleteSelectedRef.current = null;
    };
  }, [deleteSelectedRef, modelFormat, record.id]);

  // ⌘0 / ⌘1 / ⌘+ / ⌘- keyboard shortcuts for zoom.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true
      ) {
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        zoom.resetToFit();
      } else if (e.key === "1") {
        e.preventDefault();
        zoom.actualSize();
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoom.zoomBy(1.25);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoom.zoomBy(1 / 1.25);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  // Attach the non-passive wheel listener at the WINDOW level with
  // CAPTURE phase. Two reasons:
  //
  // 1. Capture-phase at window catches wheel events BEFORE any
  //    intermediate element can stopPropagation or otherwise hide
  //    them from us. Earlier debugging suggested the wheel-with-
  //    ctrlKey synthetic events from macOS trackpad pinch weren't
  //    reliably reaching a wrap-level listener even with
  //    setVisualZoomLevelLimits(1, 1) on the webContents. Going
  //    window-level guarantees we see the events.
  //
  // 2. React's synthetic events go through a passive listener, so
  //    event.preventDefault() inside an onWheel JSX prop would warn
  //    or no-op. Native addEventListener with `passive: false` is
  //    the only reliable way.
  //
  // We filter by whether the event target is inside the canvas-wrap
  // so wheel events over the DetailRail, sidebar, popover, etc.
  // pass through normally.
  //
  // `onWheelRef` lets the listener attach ONCE on mount but still
  // call the latest `zoom.onWheel` closure (which captures `state`,
  // `computeFit`, etc.). Without the ref the effect would have to
  // depend on `zoom` (a new object every render) and re-attach the
  // listener every render — a microsecond window where pinch
  // events get dropped.
  const onWheelRef = useRef(zoom.onWheel);
  const onGestureStartRef = useRef(zoom.onGestureStart);
  const onGestureChangeRef = useRef(zoom.onGestureChange);
  const onGestureEndRef = useRef(zoom.onGestureEnd);
  useEffect(() => {
    onWheelRef.current = zoom.onWheel;
    onGestureStartRef.current = zoom.onGestureStart;
    onGestureChangeRef.current = zoom.onGestureChange;
    onGestureEndRef.current = zoom.onGestureEnd;
  });
  useEffect(() => {
    const inWrap = (e: Event): boolean => {
      const wrap = canvasWrapRef.current;
      if (wrap === null) return false;
      if (!(e.target instanceof Node)) return false;
      return wrap.contains(e.target);
    };
    const onWheel = (e: WheelEvent): void => {
      if (!inWrap(e)) return;
      onWheelRef.current(e);
    };
    // macOS trackpad pinch SHOULD dispatch synthetic ctrl+wheel
    // events (when setVisualZoomLevelLimits is set to a
    // non-degenerate range, which preload/main both do). On some
    // Chromium configurations the synthesis is silently dropped —
    // diagnostic logs from PR #91 verified that on the test
    // machine, pinch fires nothing while regular wheel fires
    // normally. Gesture event handlers (gesturestart/change/end)
    // are wired here as a fallback for the WebKit-style native
    // gesture path Chromium uses on some macOS configs. We leave
    // them in because they're harmless when they don't fire and
    // load-bearing when they do — pinch dispatch is unreliable
    // enough across machines that defense in depth is worth it.
    // The Figma-style ctrl/⌘+scroll fallback (in useZoomPan's
    // onWheel) is what gets the user a working zoom regardless.
    const onGestureStart = (e: Event): void => {
      if (!inWrap(e)) return;
      onGestureStartRef.current(e);
    };
    const onGestureChange = (e: Event): void => {
      if (!inWrap(e)) return;
      onGestureChangeRef.current(e);
    };
    const onGestureEnd = (e: Event): void => {
      if (!inWrap(e)) return;
      onGestureEndRef.current(e);
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    // macOS trackpad pinch — primary signal on Mac. Capture-phase
    // on the window so we catch them no matter where they're
    // dispatched. Note: gesturestart/change/end aren't in the
    // standard DOM event map; we use string event names.
    window.addEventListener("gesturestart", onGestureStart, { passive: false, capture: true });
    window.addEventListener("gesturechange", onGestureChange, { passive: false, capture: true });
    window.addEventListener("gestureend", onGestureEnd, { passive: false, capture: true });
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("gesturestart", onGestureStart, { capture: true });
      window.removeEventListener("gesturechange", onGestureChange, { capture: true });
      window.removeEventListener("gestureend", onGestureEnd, { capture: true });
    };
  }, [canvasWrapRef]);

  // When zoomed in or space-held, the canvas-wrap absorbs pan-drag
  // pointer events instead of the canvas's drawing handlers.
  // Single-finger drag arbitration on the canvas wrap:
  //   • Space held → always pan (Photoshop convention: hold Space
  //     to grab + drag regardless of active tool).
  //   • Pointer tool + zoomed in → pan (Pointer is the "no-op on
  //     drag" tool, so we repurpose its drag for navigation).
  //   • Any drawing tool (arrow, rect, highlight, blur, text) →
  //     pointer events go to the canvas so the user can DRAW. Pan
  //     stays accessible via Space+drag and via two-finger scroll
  //     (which doesn't conflict with tool drag — it's a separate
  //     gesture handled by useZoomPan's wheel handler).
  //
  // Crop is excluded from the pan arbitration — its overlay catches
  // all pointer events directly via its own element handlers.
  const wantPan = zoom.spaceHeld || (tool === "pointer" && zoom.state.scale > 1);

  // -------------------- Canvas DOMRect for CropTool ----------------
  //
  // CropTool needs the canvas's bounding rect in viewport coords so it
  // can translate pointer events into source-pixel coords. Track it as
  // state so a window resize / zoom change re-renders the overlay with
  // the new rect. ResizeObserver fires on size changes; scroll +
  // zoom-induced layout shifts get picked up via the deps below.
  const [canvasRect, setCanvasRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el === null) return;
    const update = (): void => {
      setCanvasRect(el.getBoundingClientRect());
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
    // Use the primitive components of canvasStyle, NOT the object
    // reference itself. `useZoomPan` rebuilds the canvasStyle object
    // on every render (no useMemo); depending on the object reference
    // here would tick the effect on every parent re-render, which
    // calls setCanvasRect with a fresh DOMRect, which forces another
    // render → React's "Maximum update depth exceeded" loop. Primitive
    // string deps stay reference-stable across renders that don't
    // actually change the canvas layout.
  }, [
    canvasRef,
    zoom.canvasStyle?.width,
    zoom.canvasStyle?.height,
    zoom.canvasStyle?.transform
  ]);

  // -------------------- ToolStylePopover anchor + open state -------
  //
  // The popover anchors to a DOM ref provided by the toolbar's active
  // tool button. The toolbar populates `popoverAnchorRef.current` when
  // it mounts the active styled tool button.
  const popoverAnchorRef = useRef<HTMLElement | null>(null);
  const [popoverOpen, setPopoverOpen] = useState<boolean>(false);
  const styledActiveTool: StyledToolKind | null = isStyledToolKind(tool)
    ? tool
    : null;
  // If the active tool changes off the styled set (e.g. user switches
  // to pointer), close the popover.
  useEffect(() => {
    if (styledActiveTool === null) {
      setPopoverOpen(false);
    }
  }, [styledActiveTool]);
  // Expose the open action to the parent's keyboard handler.
  useEffect(() => {
    openActivePopoverRef.current = (): void => {
      if (styledActiveTool !== null) {
        setPopoverOpen(true);
      }
    };
    return () => {
      openActivePopoverRef.current = null;
    };
  }, [openActivePopoverRef, styledActiveTool]);

  // -------------------- Crop commit handler ------------------------
  //
  // On ↵ inside CropTool, persist a CropOverlay via overlays:upsert.
  // Crop is sticky — DO NOT change tools after commit; the user can
  // re-position by re-entering the crop tool or move on by picking
  // another tool themselves.
  const onCropCommit = useCallback(
    (rect: { x: number; y: number; w: number; h: number }): void => {
      const overlay: Overlay = { kind: "crop", rect };
      void (async (): Promise<void> => {
        // v1 path only. The v2 adapter (`overlayToBundleLayerNode`)
        // explicitly refuses crop with `crop_not_supported_on_v2` —
        // there's no per-layer crop in v2, the canvas-side equivalent
        // mutates `canvas_dimensions` and is Phase 4+. For v2 captures
        // we log and no-op so the user gets a quiet failure rather
        // than a doomed `overlays:upsert` rejection. The crop button
        // itself stays clickable in the toolbar; future work hides
        // it for v2 captures.
        // TODO(phase-4): v2-native crop via canvas_dimensions mutation.
        if (record.bundle_format_version >= 2) {
          // eslint-disable-next-line no-console
          console.warn(
            "crop overlay skipped: v2 capture has no per-layer crop; Phase 4 ships canvas-side crop"
          );
          return;
        }
        const result = await dispatch("overlays:upsert", {
          captureId: record.id,
          overlay
        });
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error("overlays:upsert (crop) failed", result.error);
          return;
        }
        if (!undoApplyingRef.current) {
          recordCreateRef.current?.(result.value);
        }
        if (!isControlled) {
          toolState.onAnnotationPlaced({ tool: "crop" });
        }
      })();
    },
    [isControlled, record, recordCreateRef, toolState, undoApplyingRef]
  );

  const onCropCancel = useCallback((): void => {
    // Switching to pointer feels like "I'm done cropping" without
    // wedging the user on the crop tool. Mirrors Photoshop's behavior.
    setTool("pointer");
  }, [setTool]);

  // ------------------------------------------------------------------
  // Render — three modes:
  //   • chrome === "full" → wrap viewport in <EditorChrome> with the
  //     four right-sidebar panels.
  //   • chrome === "embedded" → standalone-style root, no chrome.
  //   • chrome === "chromeless" → Library Focus / Reel; canvas-only.
  // ------------------------------------------------------------------

  const viewport = (
    <div
      className={
        "editor-root" +
        (chrome === "embedded" ? " is-embedded" : "") +
        (chrome === "chromeless" ? " is-chromeless" : "") +
        (chrome === "full" ? " is-in-chrome" : "")
      }
      data-testid="editor-root"
      data-bundle-format-version={record.bundle_format_version}
    >
      {chrome === "full" && (
        <header className="editor-titlebar">
          <span className="editor-title">
            PwrSnap Editor · {record.source_app_name ?? "Capture"} ·{" "}
            <span className="editor-title-meta">
              {record.width_px}×{record.height_px}
            </span>
          </span>
        </header>
      )}

      <div
        ref={canvasWrapRef}
        className={
          "editor-canvas-wrap" +
          (wantPan ? " is-pannable" : "") +
          (zoom.isPanning ? " is-panning" : "")
        }
        onPointerDown={wantPan ? zoom.onPanPointerDown : undefined}
        onPointerMove={wantPan ? zoom.onPanPointerMove : undefined}
        onPointerUp={wantPan ? zoom.onPanPointerUp : undefined}
      >
        <div
          ref={canvasRef}
          className={
            "editor-canvas" +
            // Until useZoomPan's layout effect measures the wrap and
            // emits explicit CSS px for the canvas, `.is-pre-measured`
            // applies max-width/max-height:100% as a safety net so the
            // canvas can't size up to the <img>'s intrinsic
            // dimensions (which would force scrollbars on the wrap
            // and start the resize feedback loop).
            (zoom.canvasStyle === null ? " is-pre-measured" : "")
          }
          style={
            // After first layout, useZoomPan returns explicit CSS px
            // for width/height. Before the wrap measures (rare; only
            // on the first frame between commit and useLayoutEffect),
            // fall back to aspect-ratio so the canvas has a sane
            // intrinsic shape.
            zoom.canvasStyle ?? { aspectRatio: `${record.width_px} / ${record.height_px}` }
          }
          onPointerDown={wantPan ? undefined : onPointerDown}
          onPointerMove={wantPan ? undefined : onPointerMove}
          onPointerUp={wantPan ? undefined : onPointerUp}
          data-tool={tool}
        >
          <img
            src={captureSrcUrl(record.id)}
            alt={record.source_app_name ?? "Capture"}
            draggable={false}
            className="editor-image"
            data-testid="editor-image"
          />
          {/* HTML blur layer between the <img> and the SVG so
              backdrop-filter on each blur rect actually obscures
              the image behind. Lives separately from OverlaySvg
              because SVG <filter> can blur SVG content but not a
              sibling raster <img>. */}
          <BlurOverlays overlays={overlays} draft={draft} blurStyle={blurStyle} />
          <OverlaySvg
            overlays={overlays}
            draft={draft}
            imageWidthPx={record.width_px}
            imageHeightPx={record.height_px}
            selectedLayerId={selectedLayerId}
          />
          {draft?.kind === "text" && (
            <TextDraftInput
              draft={draft}
              inputRef={textInputRef}
              imageWidthPx={record.width_px}
              imageHeightPx={record.height_px}
              canvasRef={canvasRef}
              onChange={(body) => setDraft({ ...draft, body })}
              onCommit={() => void commitText()}
              onCancel={() => setDraft(null)}
            />
          )}
          {tool === "crop" && (
            <CropTool
              captureId={record.id}
              sourceWidth={record.width_px}
              sourceHeight={record.height_px}
              canvasRect={canvasRect}
              onCommit={onCropCommit}
              onCancel={onCropCancel}
            />
          )}
          {/* Matching-text affordance — only in standalone mode (the
              hook is dormant when controlled). Positioned relative to
              the canvas so the anchor coords (canvas-px) line up
              directly. */}
          {!isControlled && toolState.matchingText.kind === "available" && (
            <button
              type="button"
              className="pse-affordance"
              data-testid="matching-text-affordance"
              style={{
                position: "absolute",
                left: toolState.matchingText.anchorPoint.x,
                top: toolState.matchingText.anchorPoint.y + 8,
                transform: "translate(-50%, 0)"
              }}
              onClick={() => {
                toolState.clickMatchingTextAffordance();
              }}
            >
              + Add label
            </button>
          )}
        </div>
        {/* v1 → v2 lazy doctor banner. Anchored to the canvas-wrap so
            it overlays the editor canvas; returns null in
            irrelevant/ready states. */}
        <V1ToV2DoctorBanner
          state={ensureV2State}
          onRetry={onEnsureV2Retry}
        />
      </div>

      {chrome !== "chromeless" && (
        <EditorToolbar
          tool={tool}
          onChange={(next, options) => {
            // Toolbar click: also clear the double-tap shortcut latch
            // so a "click-then-press-key" sequence doesn't accidentally
            // count as a double-tap. `options.singleShot` carries the
            // ⌥-click escape hatch through to setTool → useEditorTool-
            // State so it actually arms single-shot for one placement.
            setTool(next, options);
            // Close popover on tool change.
            setPopoverOpen(false);
          }}
          appliedCount={overlays.length}
          canUndo={undo.canUndo}
          canRedo={undo.canRedo}
          zoom={{
            mode: zoom.mode,
            displayPct: zoom.displayPct,
            fitPct: zoom.fitPct,
            resetToFit: zoom.resetToFit,
            actualSize: zoom.actualSize,
            setCustomPct: zoom.setCustomPct,
            zoomBy: zoom.zoomBy
          }}
          onUndo={() => void undo.undo()}
          onRedo={() => void undo.redo()}
          onReveal={() => {
            void dispatch("capture:reveal", { captureId: record.id });
          }}
          // v2 wiring — only meaningful in standalone (chrome === "full");
          // EditorToolbar still works without these props for embedded
          // mode (no carets, no popover anchor wiring).
          enableStyleCaret={chrome === "full" && !isControlled}
          onCaretClick={(t) => {
            if (t === tool && isStyledToolKind(t)) {
              setPopoverOpen((prev) => !prev);
            }
          }}
          popoverAnchorRef={popoverAnchorRef}
          // Disable while the v1 → v2 doctor is running or has parked
          // (Phase 3) — annotations on a v1 capture mid-migration
          // would conflict with the doctor's atomic write ordering,
          // and a parked capture is read-only by design until Retry.
          disabled={
            ensureV2State.status === "upgrading" ||
            ensureV2State.status === "view_only"
          }
        />
      )}

      {/* Popover anchored to the active styled tool's button. Re-mounted
          on tool change so the popover internals rebind to the new
          anchor + style shape. */}
      {chrome === "full" &&
        !isControlled &&
        popoverOpen &&
        styledActiveTool !== null &&
        toolState.activeStyle.tool === styledActiveTool && (
          <ToolStylePopover
            anchorRef={popoverAnchorRef}
            tool={styledActiveTool}
            style={
              // Discriminated narrowing: the guard above ensures
              // activeStyle.tool === styledActiveTool so `.style` is
              // present on the union member.
              (toolState.activeStyle as Extract<
                ActiveStyle,
                { tool: StyledToolKind }
              >).style
            }
            onClose={() => setPopoverOpen(false)}
            onStyleFieldChange={(field, value) => {
              // The popover's signature is (field, value); we close over
              // `styledActiveTool` to fan out to the hook's
              // (tool, field, value) shape. The runtime invariant is
              // that the popover only emits fields valid for its
              // current tool — the cast bridges the generic gap.
              (
                toolState.setStyleField as unknown as (
                  t: StyledToolKind,
                  f: string,
                  v: unknown
                ) => void
              )(styledActiveTool, field, value);
            }}
          />
        )}
    </div>
  );

  if (chrome !== "full") {
    return viewport;
  }

  // Standalone-window mode: wrap in EditorChrome and provide the four
  // right-sidebar panels. Library Focus + embedded modes don't get the
  // chrome — they're hosted inside the Library shell.
  return (
    <EditorChrome
      panels={{
        info: <InfoPanel captureId={record.id} />,
        chat: (
          <div className="pse-panel-stub" data-testid="panel-chat-stub">
            Chat with AI lands in Phase 7.
          </div>
        ),
        toolConfig: (
          <ToolConfigPanel
            captureId={record.id}
            activeTool={isControlled ? tool : toolState.activeTool}
            activeStyle={
              isControlled
                ? // In controlled mode the hook stays at default
                  // "pointer" — but `chrome === "full"` is never
                  // controlled in current callers (Library uses
                  // chromeless). Defensive fallback only.
                  ({ tool: "pointer" } as ActiveStyle)
                : toolState.activeStyle
            }
            onStyleFieldChange={
              isControlled
                ? // Controlled mode has no hook to write into.
                  (<T extends StyledTool, K extends keyof StyleFor<T>>(
                    _tool: T,
                    _field: K,
                    _value: StyleFor<T>[K]
                  ): void => {
                    /* no-op */
                  })
                : toolState.setStyleField
            }
          />
        ),
        help: (
          <div className="pse-panel-stub" data-testid="panel-help-stub">
            <p>
              Editor shortcuts: V/A/R/H/B/T/C — tools · ⌘Z — undo · ⌘⇧Z — redo ·
              ⌘\ — toggle sidebar · ⌘1/⌘2/⌘3 — panels · ⌘+ / ⌘− — zoom · ⌘0 —
              fit · ⌘1 — actual size · Esc — cancel · ↵ — commit text/crop
            </p>
            <p>
              Tip: press a tool&apos;s shortcut twice in a row to open its
              style options.
            </p>
          </div>
        )
      }}
    >
      {viewport}
    </EditorChrome>
  );
}

// EditorToolbar: bottom-row toolbar attached to Editor's own chrome
// (full + embedded modes). The new <EditToolbar> at
// features/library/EditToolbar.tsx is a SEPARATE component used by
// Library's Stage component (chromeless Editor + floating bottom-
// center toolbar, Phase C). Renamed from `Toolbar` to avoid the
// name collision flagged by pattern-recognition-specialist.
//
// Phase 1 v2 wiring: when `enableStyleCaret` is true (standalone
// window in non-controlled mode), styled tools render a small ▾
// caret on the right edge of the button — click opens
// ToolStylePopover via `onCaretClick`. The caret is rendered as a
// nested <span> with role="button" (NOT a nested <button>) to keep
// the parent <button> the single focusable target; the click handler
// catches the caret event via target inspection.
function EditorToolbar({
  tool,
  onChange,
  appliedCount,
  canUndo,
  canRedo,
  zoom,
  onUndo,
  onRedo,
  onReveal,
  enableStyleCaret = false,
  onCaretClick,
  popoverAnchorRef,
  disabled = false
}: {
  tool: Tool;
  onChange: (t: Tool, options?: { singleShot?: boolean }) => void;
  appliedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  zoom: NonNullable<ZoomApi>;
  onUndo: () => void;
  onRedo: () => void;
  onReveal: () => void;
  enableStyleCaret?: boolean;
  onCaretClick?: (tool: Tool) => void;
  popoverAnchorRef?: React.MutableRefObject<HTMLElement | null>;
  /** When true, every tool / undo / redo button is disabled. Used by
   *  the Phase 3 v1 → v2 doctor wiring to lock out edits while the
   *  doctor is migrating or after it parks. ZoomMenu + Reveal stay
   *  enabled — they're navigation / debugging, not edits. */
  disabled?: boolean;
}) {
  return (
    <div
      className={
        "editor-toolbar" + (disabled ? " is-disabled" : "")
      }
      role="toolbar"
      aria-label="Annotation tools"
      aria-disabled={disabled ? "true" : undefined}
      data-testid="editor-toolbar"
    >
      <div className="editor-toolbar-tools">
        {TOOLS.map((t) => {
          const isActive = tool === t.id;
          const hasCaret = enableStyleCaret && STYLED_TOOLS.has(t.id);
          return (
            <button
              key={t.id}
              type="button"
              // data-testid is for E2E spec selectors only — added per
              // the v2 editor refresh task #11 (editor-tool-styles,
              // editor-sticky-tool specs). Stable identifier survives
              // label/icon refactors.
              data-testid={`editor-tool-button-${t.id}`}
              className={isActive ? "is-active" : ""}
              disabled={disabled}
              ref={
                isActive && popoverAnchorRef !== undefined
                  ? (el) => {
                      popoverAnchorRef.current = el;
                    }
                  : undefined
              }
              onClick={(e) => {
                // If the user clicked the caret glyph specifically, the
                // intent is "open the popover" — not "select the tool
                // again." Catch that by checking the event target.
                const tgt = e.target as HTMLElement | null;
                if (
                  hasCaret &&
                  tgt !== null &&
                  tgt.closest(".pse-tool-caret") !== null
                ) {
                  e.stopPropagation();
                  onCaretClick?.(t.id);
                  return;
                }
                // ⌥-click (Option on macOS / Alt elsewhere) flips this
                // tool into single-shot mode for one annotation — places
                // one and snaps back to Pointer. Lets a user override
                // sticky-tool mode on a per-click basis without leaving
                // the toolbar. See useEditorToolState `setActiveTool`
                // options + plan §"⌥-click toolbar tool → single-shot
                // mode (legacy behavior)".
                onChange(t.id, e.altKey ? { singleShot: true } : undefined);
              }}
              title={`${t.label} (${t.key})`}
            >
              <span className="editor-tool-key">{t.key}</span>
              <span>{t.label}</span>
              {hasCaret && isActive && (
                <span
                  className="pse-tool-caret"
                  role="button"
                  aria-label={`Open ${t.label} style options`}
                  data-testid={`tool-caret-${t.id}`}
                  // Stop the propagation here too so a stray pointerdown
                  // on the caret can't double-fire the select.
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    aria-hidden="true"
                    fill="currentColor"
                  >
                    <path d="M1 2.5 L4 5.5 L7 2.5 Z" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="editor-toolbar-meta">
        <span>
          {appliedCount} overlay{appliedCount === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          data-testid="editor-undo"
          disabled={disabled || !canUndo}
          onClick={onUndo}
          title="Undo (⌘Z)"
        >
          ↶ Undo
        </button>
        <button
          type="button"
          data-testid="editor-redo"
          disabled={disabled || !canRedo}
          onClick={onRedo}
          title="Redo (⌘⇧Z)"
        >
          ↷ Redo
        </button>
        <ZoomMenu zoom={zoom} />
        <button type="button" onClick={onReveal} title="Reveal in Finder">
          Reveal
        </button>
      </div>
    </div>
  );
}
