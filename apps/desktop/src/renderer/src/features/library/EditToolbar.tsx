// Floating bottom-center edit toolbar for the Library's Stage
// component (Focus + Reel modes). Shares tool state with the
// chromeless Editor via lifted React state — Library's Library.tsx
// owns `tool` + `setTool` and passes them to both <Stage> (which
// forwards to <Editor chrome="chromeless" tool onToolChange />) and
// to this component.
//
// v1 editor polish (this round) adds:
//   • Drag handle on the left edge of the toolbar. Click-drag the
//     grip to reposition the floating toolbar. Position persists for
//     the current app instance (module-level state) — resets to the
//     default bottom-center on next app launch. Double-click the
//     grip to snap back to default mid-session.
//   • Reset button at the right end. Two-click confirm pattern (the
//     button morphs to "Confirm?" for ~3s on first click; second
//     click within the window wipes every overlay on the capture).
//     Reveal-in-Finder is intentionally NOT in this toolbar — it's
//     a file-management action, not an editing tool, and DetailRail's
//     "File" button already covers it.
//
// v2 editor refresh (Phase 1, task #10) adds:
//   • `useEditorToolState` — drives sticky tool mode, per-tool style
//     memory and the armed tool-bag slot. The hook is window-scoped:
//     this Library window's EditToolbar owns its own hook instance, the
//     standalone Editor window owns its own. Style memory persists
//     across both via Settings; the active-tool state stays local.
//   • Crop tool — renders `<CropTool>` over the chromeless Editor's
//     canvas when activeTool === "crop". On ↵ commit, dispatches a
//     `crop` overlay through the same `overlays:upsert` IPC.
//   • ⌥-click on a tool button → single-shot mode (place one
//     annotation, return to pointer).
//
// Tool bag (2026-09):
//   • Nine slots on the left of the toolbar, each a complete saved
//     style (see ToolBagSlots.tsx; keys 1–9 live in the editor). The
//     tool family buttons stay for "draw a fresh one", icon-only.
//   • A property bar docked above the toolbar (EditPropertyBar.tsx)
//     shows the selected layer's style, or else the active tool's. It
//     replaced the per-tool caret popovers, which hid the controls
//     behind a click most users never found.
//
// Library Focus is intentionally chromeless — we do NOT wrap in
// `EditorChrome`. The activity bar / Info / Chat / Tool Config panels
// belong to the standalone Editor window only; Library has its own
// `DetailRail` for capture metadata and we don't want two competing
// surfaces. Per the v2 editor plan §"Library Focus is chromeless".
//
// ⌘Z / ⌘⇧Z undo+redo bindings are wired by the chromeless Editor's
// useUndoRedo hook (window-level keydown listener) — no visible
// buttons in this floating toolbar yet because the undo state lives
// inside Editor and exposing it here would need a Library-level lift.

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from "react";
import type { BlurStyle, OverlayRow, ToolBagSlot } from "@pwrsnap/shared";
import { TOOLS, type Tool } from "../editor/editor-tools";
import type { LayersPanelApi, ZoomApi } from "../editor/Editor";
import { ZoomMenu } from "../editor/ZoomMenu";
import {
  useEditorToolState,
  isStyledTool,
  type UseEditorToolStateReturn
} from "../editor/useEditorToolState";
import type { StyledToolKind } from "../editor/ToolStylePopover";
import { useCaptureModel } from "../editor/useCaptureModel";
import { bagSlotForStyle } from "../editor/tool-bag";
import { EditPropertyBar, type PropertyBarTarget } from "./EditPropertyBar";
import { styledLayerStyle } from "./styled-layer-style";
import { ToolBagSlots } from "./ToolBagSlots";
import { useHideDanglingSeparators } from "./useHideDanglingSeparators";
import { dispatch } from "../../lib/pwrsnap";
import { nanoid } from "nanoid";

const RESET_CONFIRM_WINDOW_MS = 3_000;

/** Sentinel passed to `useEditorToolState` when no capture is selected
 *  yet. The hook only uses captureId to disarm the bag slot on capture
 *  switches; a stable sentinel keeps it from re-firing on every render
 *  before a capture loads. */
const NO_CAPTURE_SENTINEL = "__no_capture__";

const NO_SELECTION: readonly string[] = [];

export type EditToolbarProps = {
  readonly tool: Tool;
  readonly onChange: (next: Tool) => void;
  /** Phase 3.2 lift: optional shared hook from Library. When passed,
   *  this toolbar uses the parent's `useEditorToolState` instance
   *  instead of instantiating its own — popover style picks land in
   *  the same hook that the chromeless Editor's persistOverlay reads
   *  from. The tests still mount EditToolbar standalone (no parent
   *  hook) and rely on the internal-hook fallback. */
  readonly toolState?: UseEditorToolStateReturn;
  /** Required for the Reset button. Optional in the type so Stage
   *  can still render the toolbar before a record selects (rare;
   *  Reset is disabled when undefined). */
  readonly captureId?: string;
  /** Source image pixel dimensions. Kept for callsite compatibility
   *  (Stage still passes them); EditToolbar no longer renders its
   *  own <CropTool> overlay — the chromeless Editor owns that, with
   *  the correct canvas coordinate space. See Phase 3.2 fix in
   *  Stage.tsx + Editor.tsx. */
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  /** Editor's current zoom snapshot — `null` until the Editor mounts
   *  and reports its first scale, or after unmount. When null the
   *  zoom indicator is hidden (no useful state to show). */
  readonly zoom?: ZoomApi;
  /** Current blur style + setter. Legacy v1-string-shaped mode
   *  (gaussian / pixelate / redact). Library owns the state so the
   *  choice survives Focus ↔ Reel ↔ Grid transitions; Editor reads
   *  it for the live drag draft and the v1 commit pipeline. Post-
   *  BlurMenu-fold the toolbar no longer mutates this directly —
   *  the unified ToolStylePopover writes to `toolState`'s blur
   *  block and an effect mirrors `toolState.activeStyle.style.mode`
   *  back into `onBlurStyleChange` so the prop pair stays in sync.  */
  readonly blurStyle: BlurStyle;
  readonly onBlurStyleChange: (style: BlurStyle) => void;
  /** The editor's canvas selection (Library's mirror of it) and the
   *  editor's layers API. Together they let the property bar show and
   *  edit the selected layer, and a ⇧-clicked slot restyle it. Absent
   *  (tests, pre-mount), the bar follows the active tool only. */
  readonly selectedLayerIds?: readonly string[];
  readonly layersApi?: LayersPanelApi | null;
};

/** Module-level position store. Lives across mounts (Stage may
 *  unmount the toolbar when the user toggles into Reel/Grid view),
 *  but resets each app launch because the module is fresh. `null`
 *  means "use the default CSS bottom-center position."
 *
 *  The point stored is the dock's BOTTOM-CENTER, the same anchor the
 *  default position uses. The property bar sits above the toolbar in
 *  the dock and comes and goes with the selection and the active tool;
 *  pinned by its top-left, the dock moved the toolbar down and sideways
 *  every time the bar appeared. Pinned by its bottom-center, the bar
 *  grows upward and the toolbar stays under the cursor.
 *
 *  Coordinate space is stage-relative — offsets in pixels from the
 *  top-left of `.psl__stage-wrap`, NOT the viewport. Storing stage-
 *  relative coords means a saved position automatically survives
 *  sidebar resizes, window resizes, and Focus ↔ Reel transitions
 *  (each shifts the stage origin in viewport coords but leaves the
 *  toolbar's intent — "X pixels inside the stage" — intact). The
 *  re-clamp effect (useLayoutEffect below) re-evaluates against
 *  current stage dimensions on every resize so a position that
 *  fitted in a wide stage gets pulled back into a narrower one
 *  instead of stranding the toolbar off-screen. */
let savedPosition: { x: number; y: number } | null = null;

/** Minimum gap between the toolbar's edges and the stage's edges
 *  during drag + re-clamp. Small enough that the user can park the
 *  toolbar pretty much anywhere inside the stage, large enough that
 *  the rounded-corner toolbar doesn't visually kiss the stage's
 *  scroll-shadow / border. */
const DRAG_MARGIN_PX = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function EditToolbar({
  tool,
  onChange,
  toolState: toolStateProp,
  captureId,
  // Held in the prop type but no longer consumed — the crop overlay
  // lives in the chromeless Editor now (see EditToolbarProps comment).
  // Discard explicitly so noUnusedParameters doesn't flag them.
  sourceWidth: _sourceWidth,
  sourceHeight: _sourceHeight,
  zoom,
  blurStyle,
  onBlurStyleChange,
  selectedLayerIds = NO_SELECTION,
  layersApi = null
}: EditToolbarProps): ReactElement {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(savedPosition);
  // Two-click confirm state for Reset. `null` = idle; non-null =
  // armed timestamp. Auto-disarms after RESET_CONFIRM_WINDOW_MS so a
  // stale armed state doesn't bite the user later.
  const [resetArmedAt, setResetArmedAt] = useState<number | null>(null);
  useEffect(() => {
    if (resetArmedAt === null) return;
    const t = setTimeout(() => setResetArmedAt(null), RESET_CONFIRM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [resetArmedAt]);
  // Disarm when the user switches captures — an armed state on
  // capture A would otherwise confirm against capture B on next click.
  useEffect(() => {
    setResetArmedAt(null);
  }, [captureId]);

  // ---- v2 tool-state hook ----------------------------------------
  //
  // Phase 3.2 lift: when the parent (Library) provides `toolStateProp`,
  // use it directly so the chromeless Editor and this toolbar share
  // ONE hook instance. Pre-lift, EditToolbar always instantiated its
  // own copy, so popover style picks landed in the toolbar's hook and
  // never reached Editor's persistOverlay (which read its own dormant
  // hook). The standalone fallback hook below preserves the test
  // harness's contract (tests mount EditToolbar without a parent
  // hook) and the legacy non-Library callsite (if any).
  //
  // Always call the hook (rules of hooks) so the fallback is stable
  // across re-renders even when toolStateProp toggles between defined
  // and undefined.
  const fallbackToolState = useEditorToolState({
    captureId: captureId ?? NO_CAPTURE_SENTINEL,
    initialTool: tool
  });
  const toolState = toolStateProp ?? fallbackToolState;

  // Bidirectional sync between the Library-owned `tool` prop and the
  // hook's `activeTool`. Library uses the prop to reset to "pointer"
  // on view.kind change (Focus ↔ Reel ↔ Grid); the hook drives
  // single-shot resets and slot arming internally. We honor whichever
  // side is the most recent source of truth.
  //
  // Prop → hook: when the parent pushes a new tool (e.g. view.kind
  // reset), mirror it into the hook. Guard against feedback loops by
  // skipping when the hook already matches.
  const lastPropToolRef = useRef<Tool>(tool);
  useEffect(() => {
    if (tool === lastPropToolRef.current) return;
    lastPropToolRef.current = tool;
    if (toolState.activeTool !== tool) {
      toolState.setActiveTool(tool);
    }
  }, [tool, toolState]);
  // Hook → prop: when our own UI changes activeTool (button click,
  // single-shot expiry, arming a bag slot), inform the
  // parent so the chromeless Editor receives the new tool too. The
  // initial render's `useEditorToolState` returns the prop's tool,
  // so this only fires on real transitions.
  useEffect(() => {
    if (toolState.activeTool === tool) return;
    lastPropToolRef.current = toolState.activeTool;
    onChange(toolState.activeTool);
  }, [toolState.activeTool, tool, onChange]);

  // After folding BlurMenu into ToolStylePopover, the popover writes
  // blur picks through `toolState.setStyleField("blur", "mode", …)`
  // — but the legacy `blurStyle` / `onBlurStyleChange` prop pair is
  // still threaded through Library → Stage → Editor for the live drag
  // draft (Editor only owns the v1-string-shaped blur style for the
  // commit pipeline + BlurOverlays rendering). Mirror the hook's blur
  // mode out to the legacy prop whenever blur is the active tool so
  // a popover pick lands in both surfaces consistently.
  useEffect(() => {
    if (toolState.activeStyle.tool !== "blur") return;
    const mode = toolState.activeStyle.style.mode;
    if (mode !== blurStyle) onBlurStyleChange(mode);
  }, [toolState.activeStyle, blurStyle, onBlurStyleChange]);

  // Phase 2 task #14: shared data through useCaptureModel. The hook
  // owns the dispatch + cancel-safety + broadcast-driven refetch for
  // both v1 (overlays) and v2 (layers) — EditToolbar reads the result
  // for both `overlayCount` and the fresh-placement detection that
  // feeds `onAnnotationPlaced`. We always call the hook (rules of
  // hooks) with a sentinel when no capture is selected.
  const model = useCaptureModel(captureId ?? NO_CAPTURE_SENTINEL);

  // Resolve to a uniform OverlayRow[] view. v2 captures get
  // back-projected via the same shape Editor uses. EditToolbar reads
  // `data.kind` to feed describePlacement, which is overlay-shaped —
  // projecting keeps the call site format-agnostic. When the hook is
  // loading / errored / sentinel-mounted, the list is empty.
  const overlayRows: OverlayRow[] = useMemo(() => {
    if (captureId === undefined) return [];
    if (model.kind !== "loaded") return [];
    // Re-shape vector + rectangular effect layers back into
    // OverlayRow shape.
    // EditToolbar only needs id + data.kind + created_at + source for
    // placement detection, all of which carry through.
    const rows: OverlayRow[] = [];
    for (const layer of model.layers) {
      if (layer.kind === "vector") {
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
      } else if (
        layer.kind === "effect" &&
        layer.clip_rect !== null &&
        (layer.effect.type === "blur" || layer.effect.type === "highlight")
      ) {
        const rect = {
          x: layer.clip_rect.x / model.record.width_px,
          y: layer.clip_rect.y / model.record.height_px,
          w: layer.clip_rect.w / model.record.width_px,
          h: layer.clip_rect.h / model.record.height_px
        };
        rows.push({
          id: layer.id,
          capture_id: captureId,
          data:
            layer.effect.type === "blur"
              ? {
                  kind: "blur",
                  rect,
                  style: layer.effect.style ?? "gaussian",
                  radiusPx: layer.effect.radius_px,
                  ...(layer.effect.rotation !== undefined
                    ? { rotation: layer.effect.rotation }
                    : {})
                }
              : {
                  kind: "highlight",
                  rect,
                  color: layer.effect.tint_hex,
                  opacity: layer.effect.opacity,
                  ...(layer.effect.blend !== undefined
                    ? { blend: layer.effect.blend }
                    : {}),
                  ...(layer.effect.rotation !== undefined
                    ? { rotation: layer.effect.rotation }
                    : {})
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
    }
    return rows;
  }, [captureId, model]);

  // Detect freshly-placed overlays so we can feed the hook's
  // `onAnnotationPlaced` (ends ⌥-click single-shot mode). Rows
  // unseen since the last render that came from "user" source are
  // placements; we pick the most-recent one chronologically.
  //
  // Initial-load convention: the FIRST model resolution after mount
  // (or after a capture switch) is the seed — its rows go into the
  // seen-set silently. Subsequent updates compare against the seed
  // and any rows that appear after that point are placements.
  //
  // "Resolution" means a loaded snapshot of THIS capture, not the
  // effect's first run: the model starts in `loading` (library:byId +
  // layers:list are async IPC), where overlayRows is []. Seeding from
  // that made every existing user row look freshly placed once the
  // model resolved, ending a single-shot the user had not used yet.
  //
  // Stash a stable reference to onAnnotationPlaced so the effect
  // doesn't re-bind every render (the hook returns a fresh callback
  // when localStyles change).
  const onAnnotationPlacedRef = useRef(toolState.onAnnotationPlaced);
  useLayoutEffect(() => {
    onAnnotationPlacedRef.current = toolState.onAnnotationPlaced;
  });
  const lastSeenRowIdsRef = useRef<Set<string>>(new Set());
  /** Captures we've already seeded (first model resolution recorded).
   *  Comparing against captureId on each effect tick distinguishes:
   *    • capture switch → reset seed
   *    • first load for this capture → seed silently (no placement)
   *    • subsequent loads → diff for placements */
  const seededCaptureRef = useRef<string | null>(null);
  /** Whose rows `overlayRows` holds, or null while it holds none.
   *  NOT `model.captureId` — that is the prop, and on the render right
   *  after a capture switch the model still carries the PREVIOUS
   *  capture's record and layers (its reset to `loading` runs in an
   *  effect). Only the record says whose snapshot this is. */
  const snapshotCaptureId = model.kind === "loaded" ? model.record.id : null;
  useEffect(() => {
    if (captureId === undefined) {
      lastSeenRowIdsRef.current = new Set();
      seededCaptureRef.current = null;
      return;
    }
    // No snapshot of this capture yet (loading, errored, or the stale
    // one above): nothing to seed from and nothing to diff. Leave the
    // seen-set alone so the next real snapshot is compared against the
    // last real one — unless we have moved off the seeded capture, in
    // which case forget the seed: leaving A and coming back before B
    // resolves must reseed A, not diff it against A's old snapshot.
    if (snapshotCaptureId !== captureId) {
      if (seededCaptureRef.current !== captureId) {
        seededCaptureRef.current = null;
      }
      return;
    }
    const nextIds = new Set(overlayRows.map((r) => r.id));
    const isFirstLoadForCapture = seededCaptureRef.current !== captureId;
    if (isFirstLoadForCapture) {
      // Seed silently — whatever the initial load contains is the
      // baseline, not a placement.
      lastSeenRowIdsRef.current = nextIds;
      seededCaptureRef.current = captureId;
      return;
    }
    // Subsequent updates — diff against the seen-set.
    const fresh = overlayRows.filter(
      (r) =>
        !lastSeenRowIdsRef.current.has(r.id) && r.source === "user"
    );
    if (fresh.length > 0) {
      // Pick the most recently created row; created_at is ISO so
      // string comparison sorts chronologically.
      const newest = [...fresh].sort((a, b) =>
        b.created_at.localeCompare(a.created_at)
      )[0];
      if (newest !== undefined) {
        const placement = describePlacement(newest);
        if (placement !== null) {
          onAnnotationPlacedRef.current(placement);
        }
      }
    }
    lastSeenRowIdsRef.current = nextIds;
  }, [captureId, snapshotCaptureId, overlayRows]);

  const overlayCount = overlayRows.length;
  // Cropped-state detector for the Reset button. A crop has TWO
  // representations (both written by the crop dispatcher in
  // useCaptureModel.ts):
  //
  //   1. A VectorLayer with shape.kind === "crop" in the layer tree
  //      — the layer-tree-native signal (post #109/#110's crop-as-
  //      layer work). Detected via the loop below. This is also what
  //      Reset's "delete user-facing layers" loop wipes — see the
  //      delete branch below for the canvas-dim restore that follows
  //      a crop-layer deletion.
  //
  //   2. captures.{width,height}_px < raster.natural_{width,height}_px
  //      — the cached canvas dim shrink. The bake reads this, and
  //      captures cropped BEFORE the crop-as-layer dispatch landed
  //      only have this representation (no VectorLayer).
  //
  // We check both: if EITHER is true the capture is cropped and
  // Reset should be enabled. New captures cropped on this PR's code
  // have both signals; legacy captures have only the dim shrink.
  const isV2Cropped = useMemo(() => {
    if (model.kind !== "loaded") return false;
    // Signal 1 — VectorLayer<crop> in the layer tree.
    for (const layer of model.layers) {
      if (layer.kind === "vector" && layer.shape.kind === "crop") {
        return true;
      }
    }
    // Signal 2 — captures dims shrunk below raster natural dims.
    // Fallback for legacy captures cropped pre-crop-as-layer.
    for (const layer of model.layers) {
      if (layer.kind === "raster" && layer.parent_id !== null) {
        return (
          model.record.width_px < layer.natural_width_px ||
          model.record.height_px < layer.natural_height_px
        );
      }
    }
    return false;
  }, [model]);
  // Persist to module-level on every change so a remount picks up
  // the same position.
  useEffect(() => {
    savedPosition = position;
  }, [position]);

  // Re-clamp the saved position when the stage rect or the toolbar's
  // rendered size changes. Without this, narrowing the window (or
  // expanding the Library sidebar, or flipping the toolbar into its
  // 2-row wrap configuration) could strand the toolbar partly outside
  // the stage. The effect attaches a ResizeObserver to both the stage
  // and the toolbar itself; the setter uses a functional updater +
  // value-equality guard so an observation that doesn't shift the
  // position is a no-op (no extra renders, no observer loop).
  //
  // Dep is `position !== null` (not `position`) so the observer is
  // attached/detached only when the toolbar transitions in and out of
  // its custom-positioned state — every drag tick reuses the same
  // observer rather than thrashing one per render.
  const isPositioned = position !== null;
  useLayoutEffect(() => {
    if (!isPositioned) return;
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    const stageEl = getStageEl();
    if (stageEl === null) return;
    const reclamp = (): void => {
      const sr = stageEl.getBoundingClientRect();
      const tr = toolbar.getBoundingClientRect();
      // Mirror the drag-time clamp: leave DRAG_MARGIN_PX between the
      // toolbar edges and the stage edges, and never invert the
      // clamp interval when the stage is smaller than the toolbar.
      // The anchor is the bottom-center, so the bounds are offset by
      // half the width and the whole height.
      const minX = DRAG_MARGIN_PX + tr.width / 2;
      const maxX = Math.max(minX, sr.width - tr.width / 2 - DRAG_MARGIN_PX);
      const minY = DRAG_MARGIN_PX + tr.height;
      const maxY = Math.max(minY, sr.height - DRAG_MARGIN_PX);
      setPosition((prev) => {
        if (prev === null) return prev;
        const cx = clamp(prev.x, minX, maxX);
        const cy = clamp(prev.y, minY, maxY);
        if (cx === prev.x && cy === prev.y) return prev;
        return { x: cx, y: cy };
      });
    };
    // Initial re-clamp: when the toolbar wraps a moment after mount
    // (Geist swap, late image load, etc.), the rendered size differs
    // from the stored position's original assumption. Run once before
    // the observer attaches.
    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(stageEl);
    ro.observe(toolbar);
    return () => {
      ro.disconnect();
    };
  }, [isPositioned]);

  // Drag tracking. We compute the new position from clientX/clientY +
  // the original offset of the toolbar at drag-start, so the grip
  // stays under the cursor regardless of where the user clicked
  // within it.
  //
  // `stageRect` is captured ONCE at drag-start (the user can't resize
  // the window mid-drag without releasing the grip — pointer capture
  // is exclusive). We clamp the drag to the stage rect so the toolbar
  // can never slide off the canvas onto the Library sidebar or the
  // Detail rail. Falls back to viewport bounds when the stage element
  // can't be found — that path covers the unit test harness, which
  // mounts EditToolbar without a `.psl__stage-wrap` parent.
  const dragStart = useRef<{
    pointerX: number;
    pointerY: number;
    /** The dock's bottom-center at drag-start, viewport px. */
    anchorX: number;
    anchorY: number;
    stageRect: DOMRect | null;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolRowRef = useRef<HTMLDivElement | null>(null);
  useHideDanglingSeparators(toolRowRef);

  function getStageEl(): HTMLElement | null {
    return toolbarRef.current?.closest<HTMLElement>(".psl__stage-wrap") ?? null;
  }

  function onGripPointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    const rect = toolbar.getBoundingClientRect();
    const stageEl = getStageEl();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      anchorX: rect.left + rect.width / 2,
      anchorY: rect.bottom,
      stageRect: stageEl?.getBoundingClientRect() ?? null
    };
  }
  function onGripPointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    if (dragStart.current === null) return;
    const dx = event.clientX - dragStart.current.pointerX;
    const dy = event.clientY - dragStart.current.pointerY;
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    // Read the LIVE toolbar rect (not the drag-start snapshot) so the
    // clamp follows the toolbar's actual current width/height — which
    // can change mid-session as the toolbar wraps to a 2nd row at
    // narrow stage widths.
    const rect = toolbar.getBoundingClientRect();
    const { stageRect } = dragStart.current;
    // Clamp to stage bounds when present, viewport otherwise. The
    // stage path keeps the toolbar entirely inside the editor area —
    // it can't be parked over the Library sidebar or the Detail rail.
    // Viewport fallback preserves the old behavior for the unit test
    // harness (no `.psl__stage-wrap` ancestor there).
    const boundsLeft = stageRect?.left ?? 0;
    const boundsTop = stageRect?.top ?? 0;
    const boundsRight = stageRect?.right ?? window.innerWidth;
    const boundsBottom = stageRect?.bottom ?? window.innerHeight;
    const minViewportX = boundsLeft + DRAG_MARGIN_PX + rect.width / 2;
    const maxViewportX = boundsRight - rect.width / 2 - DRAG_MARGIN_PX;
    const minViewportY = boundsTop + DRAG_MARGIN_PX + rect.height;
    const maxViewportY = boundsBottom - DRAG_MARGIN_PX;
    // Guard against degenerate stage smaller than the toolbar
    // (max < min after subtracting toolbar width/height): clamp to
    // [min, max(min, max)] so we never invert the clamp interval.
    const targetX = dragStart.current.anchorX + dx;
    const targetY = dragStart.current.anchorY + dy;
    const clampedViewportX = clamp(
      targetX,
      minViewportX,
      Math.max(minViewportX, maxViewportX)
    );
    const clampedViewportY = clamp(
      targetY,
      minViewportY,
      Math.max(minViewportY, maxViewportY)
    );
    // Store in stage-relative coords so the position survives
    // sidebar/window resize. The re-clamp effect below re-evaluates
    // against the current stage rect when either the stage or the
    // toolbar's rendered size changes.
    setPosition({
      x: clampedViewportX - boundsLeft,
      y: clampedViewportY - boundsTop
    });
  }
  function onGripPointerUp(event: React.PointerEvent<HTMLButtonElement>): void {
    if (dragStart.current === null) return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    dragStart.current = null;
  }
  function onGripDoubleClick(): void {
    setPosition(null);
  }

  // When a custom position is in effect, override the default
  // bottom-center anchor (`left: 50%; transform: translateX(-50%);
  // bottom: 24px`) with explicit stage-relative `left`/`top` for the
  // dock's bottom-center, and translate the box up and left from it. The
  // toolbar stays on `position: absolute` — parented to
  // `.psl__stage-wrap` — so the offsets are interpreted in the same
  // coord space we store them in. (Earlier versions used
  // `position: fixed` to match the viewport coord space the drag
  // math read from `getBoundingClientRect()`, but viewport storage
  // doesn't survive sidebar/window resize and let the user park the
  // toolbar over the Library / Detail rail; the drag handler now
  // converts to stage-relative before storing.)
  const style: React.CSSProperties =
    position === null
      ? {}
      : {
          left: position.x,
          top: position.y,
          bottom: "auto",
          transform: "translate(-50%, -100%)"
        };

  // ---- Tool clicks ----------------------------------------------

  const handleToolClick = (
    t: Tool,
    event: React.MouseEvent<HTMLButtonElement>
  ): void => {
    // ⌥-click → single-shot mode (legacy affordance: place ONE
    // annotation, then return to pointer). Holding Option signals
    // "I just want this one, don't stick."
    toolState.setActiveTool(t, { singleShot: event.altKey });
  };

  // ---- Property bar target ------------------------------------------
  //
  // A single selected styled layer wins: that is what an edit would
  // change. Several selected layers show a count (a paste restyles them
  // all; per-field editing of a mixed set is not offered). Otherwise
  // the active drawing tool's working style. Pointer + crop with
  // nothing selected show no bar.
  const propertyTarget = useMemo<PropertyBarTarget | null>(() => {
    if (selectedLayerIds.length > 1) {
      return { kind: "multi", count: selectedLayerIds.length };
    }
    if (selectedLayerIds.length === 1 && model.kind === "loaded") {
      const node = model.layers.find((layer) => layer.id === selectedLayerIds[0]);
      const projected =
        node === undefined
          ? null
          : styledLayerStyle(node, {
              width: model.record.width_px,
              height: model.record.height_px
            });
      if (node !== undefined && projected !== null) {
        return {
          kind: "layer",
          layerId: node.id,
          tool: projected.tool,
          label: projected.label,
          style: projected.style
        };
      }
    }
    const active = toolState.activeStyle;
    if (active.tool === "pointer" || active.tool === "crop") return null;
    return {
      kind: "tool",
      tool: active.tool,
      label: TOOLS.find((t) => t.id === active.tool)?.label ?? active.tool,
      style: active.style,
      armedSlot: toolState.armedSlot,
      armedSlotModified: toolState.armedSlotModified
    };
  }, [
    model,
    selectedLayerIds,
    toolState.activeStyle,
    toolState.armedSlot,
    toolState.armedSlotModified
  ]);

  // Null for the eraser too: a slot holds something the next drag draws.
  const currentStyleForBag: ToolBagSlot | null =
    propertyTarget === null || propertyTarget.kind === "multi"
      ? null
      : bagSlotForStyle(propertyTarget.tool, propertyTarget.style);
  const firstEmptySlot = (() => {
    const i = toolState.bag.slots.findIndex((slot) => slot === null);
    return i === -1 ? null : i;
  })();

  const onPropertyFieldChange = (field: string, value: unknown): void => {
    if (propertyTarget === null || propertyTarget.kind === "multi") return;
    if (propertyTarget.kind === "layer") {
      layersApi?.updateLayerStyle(propertyTarget.layerId, field, value);
      return;
    }
    // The hook's generic signature is type-safe; the body's string-keyed
    // callback is necessarily looser. Cast via unknown so TS doesn't
    // have to prove every field/value pair across the 5 tool kinds.
    (
      toolState.setStyleField as unknown as (
        tool: StyledToolKind,
        field: string,
        value: unknown
      ) => void
    )(propertyTarget.tool, field, value);
  };

  // ⇧-click a slot: restyle every selected layer that can take it —
  // the same paste ⇧1–9 runs, which the editor owns.
  const applySlotToSelection = (index: number): void => {
    const slot = toolState.bag.slots[index] ?? null;
    if (slot === null || layersApi === null) return;
    layersApi.applyBagSlot(slot, selectedLayerIds);
  };

  const armSlot = (index: number, singleShot: boolean): void => {
    // Arming is "draw with this next", so let go of the selection —
    // otherwise the property bar keeps showing the selected layer and
    // the slot looks like it did nothing.
    if (selectedLayerIds.length > 0) layersApi?.clearSelection();
    toolState.armSlot(index, { singleShot });
  };

  return (
    <div
      ref={toolbarRef}
      className={"psl__edit-dock" + (position === null ? "" : " is-positioned")}
      style={style}
      // Stop pointer-down from bubbling to the canvas behind — the
      // property bar sits over the canvas just like the toolbar does.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {propertyTarget !== null && (
        <EditPropertyBar
          target={propertyTarget}
          onFieldChange={onPropertyFieldChange}
          firstEmptySlot={firstEmptySlot}
          onSaveToSlot={toolState.setBagSlot}
          {...(layersApi != null
            ? { onAddLabel: (id: string) => void layersApi.addArrowLabel(id) }
            : {})}
        />
      )}
      <div
        ref={toolRowRef}
        className="psl__edit-toolbar"
        role="toolbar"
        aria-label="Annotation tools"
        // Stop pointer-down from bubbling to the canvas behind. Without
        // this, clicking a tool button inside the canvas's pointer-down
        // area would also fire the canvas's drag-to-draw handler — the
        // "I clicked Rect and accidentally drew on the canvas" bug
        // class julik flagged. mousedown (not click) because the canvas
        // listens for pointerdown for drag-start. Plan §5
        // (in-canvas-toolbar pattern).
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="psl__et-grip"
          aria-label="Drag toolbar (double-click to reset)"
          data-tip="Drag to move"
          data-tip-detail="Double-click to put it back"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onDoubleClick={onGripDoubleClick}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
            <circle cx="2.5" cy="2.5" r="1.1" />
            <circle cx="7.5" cy="2.5" r="1.1" />
            <circle cx="2.5" cy="7" r="1.1" />
            <circle cx="7.5" cy="7" r="1.1" />
            <circle cx="2.5" cy="11.5" r="1.1" />
            <circle cx="7.5" cy="11.5" r="1.1" />
          </svg>
        </button>
        <span className="psl__et-sep" aria-hidden="true" />
        <ToolBagSlots
          bag={toolState.bag}
          armedSlot={toolState.armedSlot}
          armedSlotModified={toolState.armedSlotModified}
          hasSelection={selectedLayerIds.length > 0}
          currentStyle={currentStyleForBag}
          onArm={armSlot}
          onApply={applySlotToSelection}
          onSaveSlot={toolState.setBagSlot}
        />
        <span className="psl__et-sep" aria-hidden="true" />
        {TOOLS.map((t, i) => (
          <Fragment key={t.id}>
            {/* Vertical separator after the first tool (Pointer) —
                divides the "select / inspect" tool from the "draw"
                tools. Mirrors the design's separator placement; the
                design also has a separator before color swatches +
                magic wand + undo, but those clusters aren't rendered
                in this phase. */}
            {i === 1 && <span className="psl__et-sep" aria-hidden="true" />}
            <ToolButton
              tool={t}
              // A family reads as active only when no slot is armed —
              // otherwise the armed slot is the thing that is "on".
              active={
                toolState.activeTool === t.id &&
                !(toolState.armedSlot !== null && isStyledTool(t.id))
              }
              onClick={(e) => handleToolClick(t.id, e)}
            />
          </Fragment>
        ))}
        <span className="psl__et-sep" aria-hidden="true" />
        <ResetButton
          captureId={captureId}
          overlayCount={overlayCount}
          isV2Cropped={isV2Cropped}
          armed={resetArmedAt !== null}
          onArm={() => setResetArmedAt(Date.now())}
          onConfirm={async () => {
            if (captureId === undefined) return;
            setResetArmedAt(null);
            const recordRes = await dispatch("library:byId", { id: captureId });
            if (!recordRes.ok || recordRes.value === null) return;
            const list = await dispatch("layers:list", { captureId });
            if (!list.ok) return;
            // Find the raster's natural dims BEFORE we delete layers
            // — we need them to restore canvas dimensions if the user
            // had previously cropped. Crop writes to the captures
            // row's width_px/height_px (non-destructively, the raster
            // source bytes are preserved) via
            // `bundle:updateCanvasDimensions`; without restoring those
            // here, Reset would only clear annotations and leave the
            // capture in its cropped state forever. The user's
            // intuition is "Reset = full original" so we restore both.
            let rasterDims: { width: number; height: number } | null = null;
            // Snapshot the raster layer too — Reset needs to restore
            // its transform to identity if a previous off-origin crop
            // translated it (useCaptureModel.ts Step 0.5 writes
            // raster.transform[4]/[5] when the user drags a non-(0,0)
            // crop rect, per PR #110). Without resetting, the
            // captures-row dim restore below leaves the raster
            // shifted inside the now-full canvas — visible as the
            // image appearing offset from the canvas's top-left with
            // empty space on the opposite edges. (Reproduced live
            // by the user after Reset on lPK1jAx7uXAACf9k.)
            let rasterNeedingReset: (typeof list.value)[number] | null = null;
            for (const node of list.value) {
              if (
                node.kind === "raster" &&
                node.parent_id !== null
              ) {
                rasterDims = {
                  width: node.natural_width_px,
                  height: node.natural_height_px
                };
                if (node.transform[4] !== 0 || node.transform[5] !== 0) {
                  rasterNeedingReset = node;
                }
                break;
              }
            }
            // Skip the synthesized root group + raster source; just
            // delete user-facing annotation layers. Sequential to
            // avoid racing the per-write broadcasts / edits_version.
            for (const node of list.value) {
              if (node.kind === "group" || node.kind === "raster") continue;
              // eslint-disable-next-line no-await-in-loop
              await dispatch("layers:delete", { id: node.id });
            }
            // Restore the raster's identity transform if a previous
            // off-origin crop translated it. Delete + reinsert mirrors
            // the dispatcher's pattern (the IPC surface has no
            // updateLayer verb; edits are delete-plus-insert via
            // `layers:delete` + `layers:upsert`). Skip when transform
            // is already identity so the common case stays churn-free.
            if (rasterNeedingReset !== null) {
              await dispatch("layers:delete", { id: rasterNeedingReset.id });
              await dispatch("layers:upsert", {
                captureId,
                layer: {
                  ...rasterNeedingReset,
                  id: nanoid(16),
                  transform: [1, 0, 0, 1, 0, 0]
                }
              });
            }
            // Restore canvas to raster-natural dims if the capture
            // was cropped. The `updateCanvasDimensions` handler
            // refuses values exceeding the raster's natural dims so
            // this can never grow the canvas past the source — only
            // restore it to what was captured originally. Skip when
            // already at natural dims (no-op writes burn an
            // edits_version bump + a captures:changed broadcast for
            // nothing).
            if (
              rasterDims !== null &&
              (recordRes.value.width_px !== rasterDims.width ||
                recordRes.value.height_px !== rasterDims.height)
            ) {
              await dispatch("bundle:updateCanvasDimensions", {
                captureId,
                widthPx: rasterDims.width,
                heightPx: rasterDims.height
              });
            }
          }}
        />
        {zoom !== null && zoom !== undefined && (
          <>
            <span className="psl__et-sep" aria-hidden="true" />
            <ZoomMenu zoom={zoom} />
          </>
        )}
      </div>
    </div>
  );
}

/** Tool family button — icon-only; the label and key chip stay in the
 *  DOM as the accessible name ("Arrow A") and are hidden by CSS. Its
 *  style is edited in the property bar, not a per-button popover. */
function ToolButton({
  tool,
  active,
  onClick
}: {
  tool: { id: Tool; label: string; key: string; icon: ReactElement };
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={"psl__et-btn psl__et-btn--tool" + (active ? " is-active" : "")}
      // With the label visually hidden, the accent is the only sign
      // of which tool is on; say it to assistive tech too.
      aria-pressed={active}
      onClick={onClick}
      data-tip={tool.label}
      data-tip-keys={tool.key}
      data-tool={tool.id}
    >
      {tool.icon}
      <span>{tool.label}</span>
      <span className="psl__et-btn-key">{tool.key}</span>
    </button>
  );
}

function ResetButton({
  captureId,
  overlayCount,
  isV2Cropped,
  armed,
  onArm,
  onConfirm
}: {
  captureId: string | undefined;
  overlayCount: number;
  /** v2 captures only — true when canvas dims are smaller than the
   *  raster source's natural dims (i.e. the user cropped). v1 crops
   *  are CropOverlay rows already counted in `overlayCount`, so this
   *  is always false for v1. Enabling Reset on `isV2Cropped` lets the
   *  user undo a crop on a capture with zero annotations — without
   *  this the button stays disabled and there's no in-editor way to
   *  reverse the crop once ⌘Z's session-undo window closes. */
  isV2Cropped: boolean;
  armed: boolean;
  onArm: () => void;
  onConfirm: () => void;
}): ReactElement {
  const hasResettableState = overlayCount > 0 || isV2Cropped;
  const disabled = captureId === undefined || !hasResettableState;
  // Confirm label: include the crop suffix when the only resettable
  // state is the crop (overlayCount === 0). Otherwise just show the
  // count — most resets are annotation-driven, and tacking "+ crop"
  // on top of an N-overlay confirm makes the chip too long.
  const confirmLabel =
    overlayCount === 0 && isV2Cropped
      ? "Confirm? · crop"
      : `Confirm? · ${overlayCount}`;
  return (
    <button
      type="button"
      className={"psl__et-btn psl__et-btn--reset" + (armed ? " is-armed" : "")}
      data-tip={
        armed
          ? overlayCount === 0 && isV2Cropped
            ? "Click again to confirm — restores original canvas dimensions"
            : "Click again to confirm — removes every overlay"
          : isV2Cropped && overlayCount === 0
            ? "Reset to original (restore canvas dimensions)"
            : "Reset to original (remove all overlays)"
      }
      disabled={disabled}
      onClick={() => {
        if (armed) onConfirm();
        else onArm();
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        {/* Counter-clockwise arrow circling back — "undo all the way" */}
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
      </svg>
      <span>{armed ? confirmLabel : "Reset"}</span>
    </button>
  );
}

/** Translate a freshly-placed OverlayRow into the placement shape
 *  `useEditorToolState.onAnnotationPlaced` expects. Returns null for
 *  overlay kinds the hook doesn't recognize (e.g. legacy `step`
 *  overlays). */
function describePlacement(row: OverlayRow): { tool: Tool } | null {
  const o = row.data;
  switch (o.kind) {
    case "arrow":
    case "shape":
    case "highlight":
    case "blur":
    case "text":
    case "crop":
      return { tool: o.kind };
    case "stroke":
      return { tool: "draw" };
    case "step":
      // Step overlays don't map to a v2 tool — ignore.
      return null;
  }
}
