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
//     memory, the shared COLOR slot, and the matching-text affordance
//     lifecycle. The hook is window-scoped: this Library window's
//     EditToolbar owns its own hook instance, the standalone Editor
//     window owns its own. Style memory persists across both via
//     Settings; the active-tool state stays local.
//   • Caret button on each styled tool button (arrow / text / rect /
//     blur / highlight) → opens the unified `ToolStylePopover`
//     anchored to that button. Blur was folded into the same popover
//     in the v2 editor refresh (Phase 3.2 follow-up); the bespoke
//     <BlurMenu> with its labeled rows + hint copy is gone.
//   • Crop tool — renders `<CropTool>` over the chromeless Editor's
//     canvas when activeTool === "crop". On ↵ commit, dispatches a
//     `crop` overlay through the same `overlays:upsert` IPC.
//   • Matching-text affordance — when the user places an arrow and
//     Settings has matchingText.enabled = true, a "+ Add label" chip
//     pops near the arrow's tail. Click it → tool flips to text with
//     the arrow's color preserved (shared COLOR slot already covers
//     the propagation).
//   • ⌥-click on a tool button → single-shot mode (place one
//     annotation, return to pointer).
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
import type { BlurStyle, OverlayRow } from "@pwrsnap/shared";
import { TOOLS, type Tool } from "../editor/editor-tools";
import type { ZoomApi } from "../editor/Editor";
import { ZoomMenu } from "../editor/ZoomMenu";
import {
  useEditorToolState,
  isStyledTool,
  type UseEditorToolStateReturn
} from "../editor/useEditorToolState";
import {
  ToolStylePopover,
  type StyledToolKind,
  type ToolStylePopoverStyle
} from "../editor/ToolStylePopover";
import { useCaptureModel } from "../editor/useCaptureModel";
import { dispatch } from "../../lib/pwrsnap";

const RESET_CONFIRM_WINDOW_MS = 3_000;

/** Sentinel passed to `useEditorToolState` when no capture is selected
 *  yet. The hook only uses captureId to reset the matching-text
 *  affordance on capture switches; a stable sentinel keeps the hook
 *  from re-firing its cleanup on every render before a capture loads. */
const NO_CAPTURE_SENTINEL = "__no_capture__";

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
};

/** Module-level position store. Lives across mounts (Stage may
 *  unmount the toolbar when the user toggles into Reel/Grid view),
 *  but resets each app launch because the module is fresh. `null`
 *  means "use the default CSS bottom-center position." */
let savedPosition: { x: number; y: number } | null = null;

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
  onBlurStyleChange
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
  // matching-text + single-shot resets internally. We honor whichever
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
  // single-shot expiry, matching-text → text flip), inform the
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

  // Resolve to a uniform OverlayRow[] view. v1 returns it natively;
  // v2 captures (Phase 2 read-only) get back-projected via the same
  // shape Editor uses. EditToolbar reads `data.kind` to feed
  // describePlacement, which is overlay-shaped — projecting keeps the
  // call site format-agnostic. When the hook is loading / errored /
  // sentinel-mounted, the list is empty.
  const overlayRows: OverlayRow[] = useMemo(() => {
    if (captureId === undefined) return [];
    if (model.kind !== "loaded") return [];
    if (model.format === 1) return model.overlays;
    // v2: re-shape vector + blur-effect layers back into OverlayRow
    // shape. EditToolbar only needs id + data.kind + created_at +
    // source for placement detection, all of which carry through.
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
      }
    }
    return rows;
  }, [captureId, model]);

  // Detect freshly-placed overlays so we can feed the hook's
  // `onAnnotationPlaced` (drives matching-text affordance). Rows
  // unseen since the last render that came from "user" source are
  // placements; we pick the most-recent one chronologically.
  //
  // Initial-load convention: the FIRST model resolution after mount
  // (or after a capture switch) is the seed — its rows go into the
  // seen-set silently. Subsequent updates compare against the seed
  // and any rows that appear after that point are placements.
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
  useEffect(() => {
    if (captureId === undefined) {
      lastSeenRowIdsRef.current = new Set();
      seededCaptureRef.current = null;
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
  }, [captureId, overlayRows]);

  const overlayCount = overlayRows.length;
  // v2 cropped-state detector for the Reset button. For v1 captures
  // a crop is a CropOverlay row — already counted in `overlayCount`
  // via `overlayRows` above — so Reset enables naturally when only
  // a crop exists. For v2 the crop has TWO representations (both
  // written by the v2 crop dispatcher in useCaptureModel.ts):
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
  //      legacy v2 captures cropped BEFORE the crop-as-layer dispatch
  //      landed only have this representation (no VectorLayer).
  //
  // We check both: if EITHER is true the capture is cropped and
  // Reset should be enabled. New captures cropped on this PR's code
  // have both signals; legacy captures have only the dim shrink.
  const isV2Cropped = useMemo(() => {
    if (model.kind !== "loaded" || model.format !== 2) return false;
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

  // Drag tracking. We compute the new position from clientX/clientY +
  // the original offset of the toolbar at drag-start, so the grip
  // stays under the cursor regardless of where the user clicked
  // within it.
  const dragStart = useRef<{
    pointerX: number;
    pointerY: number;
    toolbarLeft: number;
    toolbarTop: number;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  function onGripPointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    const rect = toolbar.getBoundingClientRect();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      toolbarLeft: rect.left,
      toolbarTop: rect.top
    };
  }
  function onGripPointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    if (dragStart.current === null) return;
    const dx = event.clientX - dragStart.current.pointerX;
    const dy = event.clientY - dragStart.current.pointerY;
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    // Clamp so at least HOLD_MARGIN_PX of the toolbar (containing the
    // grip) stays visible on every edge. Otherwise the user could
    // drag it entirely off-screen and have to know "double-click the
    // grip to reset" — but they can't see the grip to do that.
    const rect = toolbar.getBoundingClientRect();
    const HOLD_MARGIN_PX = 32;
    const minX = HOLD_MARGIN_PX - rect.width;
    const maxX = window.innerWidth - HOLD_MARGIN_PX;
    const minY = 0;
    const maxY = window.innerHeight - HOLD_MARGIN_PX;
    setPosition({
      x: clamp(dragStart.current.toolbarLeft + dx, minX, maxX),
      y: clamp(dragStart.current.toolbarTop + dy, minY, maxY)
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

  // When a custom position is in effect, switch from `position:
  // absolute` (default, positioned-ancestor-relative) to `position:
  // fixed` (viewport-relative). The drag math uses
  // `getBoundingClientRect()` which produces viewport-relative coords;
  // applying those as `left`/`top` under `position: absolute` would
  // double-offset the toolbar by the Stage wrapper's distance from
  // the viewport (the sidebar width + any topbar height), making the
  // toolbar jump away from the cursor at drag-start. Fixed positioning
  // matches the coordinate space and keeps the grip directly under
  // the pointer.
  const style: React.CSSProperties =
    position === null
      ? {}
      : {
          position: "fixed",
          left: position.x,
          top: position.y,
          bottom: "auto",
          transform: "none"
        };

  // ---- Tool button anchors + popover state ----------------------
  //
  // Each styled tool button holds a ref so its caret can anchor the
  // ToolStylePopover. We keep refs in a Map keyed by tool id so the
  // single useState for `popoverTool` resolves to the correct anchor
  // at render time. Blur is included since the v2 editor refresh
  // folded the bespoke <BlurMenu> into the unified popover.
  const buttonRefs = useRef<Map<Tool, HTMLButtonElement | null>>(new Map());
  const [popoverTool, setPopoverTool] = useState<StyledToolKind | null>(null);
  // Pinned ref for whichever button currently anchors the popover.
  // Updated when popoverTool changes; the popover reads from it via
  // its `anchorRef` prop.
  const popoverAnchorRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (popoverTool === null) {
      popoverAnchorRef.current = null;
      return;
    }
    popoverAnchorRef.current = buttonRefs.current.get(popoverTool) ?? null;
  }, [popoverTool]);
  // Close the popover when the active tool stops matching the
  // popover's tool (e.g. user clicked a different tool). Keep it
  // open while only `tool` changes via prop sync that matches.
  useEffect(() => {
    if (popoverTool === null) return;
    if (toolState.activeTool !== popoverTool) {
      setPopoverTool(null);
    }
  }, [toolState.activeTool, popoverTool]);

  // ---- Tool click + caret handlers ------------------------------

  const handleToolClick = (
    t: Tool,
    event: React.MouseEvent<HTMLButtonElement>
  ): void => {
    // ⌥-click → single-shot mode (legacy affordance: place ONE
    // annotation, then return to pointer). Holding Option signals
    // "I just want this one, don't stick."
    const singleShot = event.altKey;
    toolState.setActiveTool(t, { singleShot });
    // Selecting a different tool while the popover is open closes it.
    // Selecting the SAME tool again toggles the popover (matches the
    // VS Code "click the active tab to peek details" affordance).
    if (popoverTool !== null && popoverTool !== t) {
      setPopoverTool(null);
    }
  };

  const handleCaretClick = (
    t: StyledToolKind,
    event: React.MouseEvent<HTMLButtonElement>
  ): void => {
    event.stopPropagation();
    // Activate the tool and open the popover. If the popover is
    // already open for this tool, the caret click is a toggle (close).
    toolState.setActiveTool(t);
    setPopoverTool((prev) => (prev === t ? null : t));
  };

  // ---- Matching-text affordance positioning ---------------------
  //
  // The hook stores the affordance's anchorPoint in normalized [0,1]
  // image coords (the same space overlay rects use). We translate to
  // viewport coords via the canvas rect so the chip can be positioned
  // with `position: fixed`. The chip auto-dismisses inside the hook
  // after 8s.
  const matchingTextStyle = useMemo<React.CSSProperties | null>(() => {
    if (toolState.matchingText.kind !== "available") return null;
    const canvas = document.querySelector<HTMLElement>(".editor-canvas");
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const { x, y } = toolState.matchingText.anchorPoint;
    // Anchor 10px BELOW the arrow tail (matches the design's offset).
    const left = rect.left + x * rect.width;
    const top = rect.top + y * rect.height + 10;
    return {
      position: "fixed",
      left,
      top,
      transform: "translate(-50%, 0)",
      zIndex: 6
    };
  }, [toolState.matchingText]);

  return (
    <>
      <div
        ref={toolbarRef}
        className={"psl__edit-toolbar" + (position === null ? "" : " is-positioned")}
        role="toolbar"
        aria-label="Annotation tools"
        style={style}
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
          title="Drag to move · double-click to reset"
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
        {TOOLS.map((t, i) => (
          <Fragment key={t.id}>
            {/* Vertical separator after the first tool (Pointer) —
                divides the "select / inspect" tool from the "draw"
                tools. Mirrors the design's separator placement; the
                design also has a separator before color swatches +
                magic wand + undo, but those clusters aren't rendered
                in this phase. */}
            {i === 1 && <span className="psl__et-sep" aria-hidden="true" />}
            {/* Blur uses the SAME ToolButton + caret pattern as every
                other styled tool. Earlier shape branched blur through
                a bespoke <BlurMenu> with labeled rows and hint copy —
                folded into the unified ToolStylePopover (Phase 3.2
                follow-up) so a single popover shell drives every
                styled tool. The popover's BlurBody covers the same
                gaussian / pixelate / redact choice as the old menu,
                plus the Auto / Custom radius control that the menu
                never exposed. */}
            <ToolButton
              tool={t}
              active={toolState.activeTool === t.id}
              popoverOpen={popoverTool === t.id}
              onClick={(e) => handleToolClick(t.id, e)}
              onCaretClick={(e) => {
                // Pointer + crop have no style block; suppress the
                // caret button entirely (handled inside ToolButton).
                if (!isStyledTool(t.id)) return;
                handleCaretClick(t.id as StyledToolKind, e);
              }}
              showCaret={isStyledTool(t.id)}
              buttonRef={(el) => {
                buttonRefs.current.set(t.id, el);
              }}
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
            // Format-branch — Phase 3 doctor migrates captures to v2 on
            // first edit-open, and the bus-side gates refuse cross-
            // format IPC (v2 captures → `overlays:list` returns
            // Result.err `v2_capture_use_layers_ipc`). Before this fix
            // Reset silently no-op'd on every doctored capture.
            const recordRes = await dispatch("library:byId", { id: captureId });
            if (!recordRes.ok || recordRes.value === null) return;
            const isV2 = recordRes.value.bundle_format_version >= 2;
            if (isV2) {
              const list = await dispatch("layers:list", { captureId });
              if (!list.ok) return;
              // Find the raster's natural dims BEFORE we delete layers
              // — we need them to restore canvas dimensions if the user
              // had previously cropped. v2 crop writes to the captures
              // row's width_px/height_px (non-destructively, the raster
              // source bytes are preserved) via
              // `bundle:updateCanvasDimensions`; without restoring those
              // here, Reset would only clear annotations and leave the
              // capture in its cropped state forever. The user's
              // intuition is "Reset = full original" so we restore both.
              let rasterDims: { width: number; height: number } | null = null;
              for (const node of list.value) {
                if (
                  node.kind === "raster" &&
                  node.parent_id !== null
                ) {
                  rasterDims = {
                    width: node.natural_width_px,
                    height: node.natural_height_px
                  };
                  break;
                }
              }
              // Skip the synthesized root group + raster source; just
              // delete user-facing annotation layers. Sequential per
              // the same broadcast / edits_version reasoning as v1.
              for (const node of list.value) {
                if (node.kind === "group" || node.kind === "raster") continue;
                // eslint-disable-next-line no-await-in-loop
                await dispatch("layers:delete", { id: node.id });
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
            } else {
              const list = await dispatch("overlays:list", { captureId });
              if (!list.ok) return;
              // Sequentially — the overlays handler updates app_stats /
              // edits_version per row + broadcasts. Parallel deletes
              // would race those side-effects.
              for (const row of list.value) {
                // eslint-disable-next-line no-await-in-loop
                await dispatch("overlays:delete", { id: row.id });
              }
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

      {/* Tool style popover — anchored to whichever button last
          opened it. ToolStylePopover handles its own click-outside /
          Escape dismissal. */}
      {popoverTool !== null && toolState.activeStyle.tool === popoverTool && (
        <ToolStylePopover
          anchorRef={popoverAnchorRef}
          tool={popoverTool}
          style={
            // activeStyle is a discriminated union; we've gated on
            // tool ≡ popoverTool above so the cast is sound.
            (toolState.activeStyle as { style: ToolStylePopoverStyle }).style
          }
          onClose={() => setPopoverTool(null)}
          onStyleFieldChange={(field, value) => {
            // The hook's generic signature is type-safe; the popover's
            // string-keyed callback is necessarily looser. Cast via
            // unknown so TS doesn't have to prove every field/value
            // pair across the 5 tool kinds.
            (
              toolState.setStyleField as unknown as (
                tool: StyledToolKind,
                field: string,
                value: unknown
              ) => void
            )(popoverTool, field, value);
          }}
        />
      )}

      {/* Crop overlay used to render here too — Phase 3.2 fix:
          removed the duplicate. The chromeless Editor renders <CropTool>
          inside its own .editor-canvas via canvasRef (positioned
          absolute; inset: 0). That's the correct coord space; the
          EditToolbar's old copy was anchored to a window-level
          querySelector of `.editor-canvas` and re-renders made it
          drift, AND it duplicated the HUD because both copies were
          mounted. The toolbar still owns the user-facing "click Crop"
          tool button — but the OVERLAY itself stays inside the editor
          where the canvas's positioning context lives. */}

      {/* Matching-text affordance — "+ Add label" chip that pops near
          a just-placed arrow's tail. Clicking it transitions the hook
          to "armed" + flips tool to text; placing one text overlay
          returns the tool to arrow with style preserved. */}
      {toolState.matchingText.kind === "available" && matchingTextStyle !== null && (
        <button
          type="button"
          className="psl__et-matching-text"
          data-testid="matching-text-affordance"
          style={matchingTextStyle}
          onClick={() => {
            toolState.clickMatchingTextAffordance();
          }}
        >
          <span aria-hidden="true">+</span>
          <span>Add label</span>
        </button>
      )}
    </>
  );
}

/** Tool button + optional caret affordance. Caret is rendered for
 *  styled tools (arrow / text / rect / highlight); pointer + crop
 *  have no style block so no caret. Click the body → activate tool.
 *  Click the caret → activate + open ToolStylePopover. */
function ToolButton({
  tool,
  active,
  popoverOpen = false,
  onClick,
  onCaretClick,
  showCaret,
  buttonRef
}: {
  tool: { id: Tool; label: string; key: string; icon: ReactElement };
  active: boolean;
  /** True when this tool's style popover is currently open. Rotates
   *  the caret ▲ to indicate the open state — matches the convention
   *  every dropdown menu in the OS UI follows. */
  popoverOpen?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onCaretClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  showCaret: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
}): ReactElement {
  return (
    <span
      className={
        "psl__et-tool-wrap" +
        (active ? " is-active" : "") +
        (popoverOpen ? " is-popover-open" : "")
      }
    >
      <button
        type="button"
        ref={buttonRef}
        className={"psl__et-btn" + (active ? " is-active" : "")}
        onClick={onClick}
        title={`${tool.label} (${tool.key})`}
        data-tool={tool.id}
      >
        {tool.icon}
        <span>{tool.label}</span>
        <span className="psl__et-btn-key">{tool.key}</span>
      </button>
      {showCaret && (
        <button
          type="button"
          className={
            "psl__et-caret" +
            (active ? " is-tool-active" : "") +
            (popoverOpen ? " is-open" : "")
          }
          aria-label={`${tool.label} style options`}
          aria-expanded={popoverOpen}
          data-testid={`tool-caret-${tool.id}`}
          onClick={onCaretClick}
          // Stop pointerdown so the toolbar's own
          // stopPropagation->canvas guard doesn't have to special-case
          // this child; otherwise React's event ordering puts the
          // click handler on the toolbar root after this one.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <svg width="8" height="6" viewBox="0 0 8 6" fill="currentColor" aria-hidden="true">
            <path d="M0 0h8L4 6z" />
          </svg>
        </button>
      )}
    </span>
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
      title={
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
 *  `useEditorToolState.onAnnotationPlaced` expects. For arrows we
 *  hand the hook the tail point (`from`) in normalized coords so the
 *  matching-text affordance can anchor below the arrow's origin —
 *  that's where users instinctively want the label, per the design.
 *  Returns null for overlay kinds the hook doesn't recognize (e.g.
 *  legacy `step` overlays). */
function describePlacement(
  row: OverlayRow
): { tool: Tool; anchorPoint?: { x: number; y: number } } | null {
  const o = row.data;
  switch (o.kind) {
    case "arrow":
      return { tool: "arrow", anchorPoint: { x: o.from.x, y: o.from.y } };
    case "rect":
      return { tool: "rect" };
    case "highlight":
      return { tool: "highlight" };
    case "blur":
      return { tool: "blur" };
    case "text":
      return { tool: "text" };
    case "crop":
      return { tool: "crop" };
    case "step":
      // Step overlays don't map to a v2 tool — ignore.
      return null;
  }
}
