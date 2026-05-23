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
import type { BlurStyle, CaptureRecord, Overlay, OverlayRow } from "@pwrsnap/shared";
import { DEFAULT_BLUR_STYLE } from "@pwrsnap/shared";
import { dispatch, subscribe, captureSrcUrl } from "../../lib/pwrsnap";
import { TOOLS, type Tool } from "./editor-tools";
import { useZoomPan, type ZoomMode } from "./useZoomPan";
import { useUndoRedo } from "./useUndoRedo";
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
  type StyleFor
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

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; record: CaptureRecord; overlays: OverlayRow[] }
  | { kind: "error"; message: string };

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

export function Editor({
  captureId,
  chrome = "full",
  tool: toolProp,
  onToolChange,
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
  const [state, setState] = useState<LoadState>({ kind: "loading" });

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
  const toolState = useEditorToolState({ captureId });
  const tool: Tool = isControlled ? toolProp : toolState.activeTool;
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
        toolState.setActiveTool(next, options);
      }
    },
    [isControlled, onToolChange, toolState]
  );

  // Blur style for the commit pipeline:
  //   • Library (controlled) → use the `blurStyle` prop the parent
  //     threads in (EditToolbar's BlurMenu owns it there).
  //   • Standalone → take the live blur-tool-style mode from the hook,
  //     falling back to the default until settings resolve.
  const blurStyle: BlurStyle = useMemo(() => {
    if (blurStyleProp !== undefined) return blurStyleProp;
    if (toolState.activeStyle.tool === "blur") {
      return toolState.activeStyle.style.mode;
    }
    // For non-blur active tools in standalone mode, we still need a
    // mode for the rare ad-hoc shortcut commit. Read the blur block
    // through a temporary tool switch is overkill — the hook's
    // activeStyle only carries the active tool's block. Fall back to
    // the persisted default; the popover/panel writes will update this
    // path on the next blur-tool selection.
    return DEFAULT_BLUR_STYLE;
  }, [blurStyleProp, toolState.activeStyle]);

  const [draft, setDraft] = useState<Draft | null>(null);
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

  // refetch accepts a "cancelled" predicate so the caller can opt-out
  // of post-await setState if the component has moved on. Critical for
  // the rapid mode-flip cases the Library plan introduces (Grid →
  // Focus[A] → Esc → Focus[B]): without this guard, A's library:byId
  // can resolve AFTER B has mounted and stomp B's state with A's
  // record. Plan reference: docs/plans/2026-05-05-001-feat-library-
  // three-state-view-model-plan.md, Phase A.7.
  const refetch = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const recordResult = await dispatch("library:byId", { id: captureId });
      if (isCancelled()) return;
      if (!recordResult.ok) {
        setState({ kind: "error", message: recordResult.error.message });
        return;
      }
      if (recordResult.value === null) {
        setState({ kind: "error", message: `capture not found: ${captureId}` });
        return;
      }
      const overlaysResult = await dispatch("overlays:list", { captureId });
      if (isCancelled()) return;
      const overlays = overlaysResult.ok ? overlaysResult.value : [];
      setState({ kind: "loaded", record: recordResult.value, overlays });
    },
    [captureId]
  );

  useEffect(() => {
    let cancelled = false;
    void refetch(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refetch]);

  // Re-fetch when overlays change for this capture.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribe("events:overlays:changed", (payload) => {
      const p = payload as { captureId?: string };
      if (p.captureId !== undefined && p.captureId !== captureId) return;
      void refetch(() => cancelled);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId, refetch]);

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
    // Pointer / crop are no-op on canvas drag — pointer is the "no-op"
    // tool, crop has its own overlay element that owns its drags.
    if (tool === "pointer") return;
    if (tool === "crop") return;
    // If we're mid-text and the user clicks elsewhere, commit/cancel
    // the text first (the input's blur handler will fire).
    if (draft?.kind === "text") return;

    const start = clientToNormalized(event.clientX, event.clientY);
    if (start === null) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);

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

    if (draft.kind === "arrow") {
      const dx = draft.toXn - draft.fromXn;
      const dy = draft.toYn - draft.fromYn;
      if (Math.hypot(dx, dy) < MIN_DRAG_LENGTH) {
        setDraft(null);
        return;
      }
      const overlay: Overlay = {
        kind: "arrow",
        from: { x: draft.fromXn, y: draft.fromYn },
        to: { x: draft.toXn, y: draft.toYn },
        color: "auto"
      };
      // Capture the arrow tail in canvas-px so the matching-text
      // affordance can position itself; this lookup needs the live
      // canvas rect, so do it BEFORE the await.
      const tailCanvasPx = normalizedToCanvasPx(draft.toXn, draft.toYn);
      setDraft(null);
      const wrote = await persistOverlay(overlay);
      if (wrote && !isControlled) {
        toolState.onAnnotationPlaced(
          tailCanvasPx !== null
            ? { tool: "arrow", anchorPoint: tailCanvasPx }
            : { tool: "arrow" }
        );
      }
      return;
    }

    if (draft.kind === "rect-drag") {
      const rect = rectFromDrag(draft);
      if (rect === null) {
        setDraft(null);
        return;
      }
      const placedKind = draft.tool;
      const overlay: Overlay =
        placedKind === "rect"
          ? { kind: "rect", rect, color: "auto" }
          : placedKind === "highlight"
          ? { kind: "highlight", rect }
          : { kind: "blur", rect, style: blurStyle };
      setDraft(null);
      const wrote = await persistOverlay(overlay);
      if (wrote && !isControlled) {
        toolState.onAnnotationPlaced({ tool: placedKind });
      }
      return;
    }
  }

  /** Returns true if the overlay was written successfully. */
  async function persistOverlay(overlay: Overlay): Promise<boolean> {
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
    const overlay: Overlay = {
      kind: "text",
      point: { x: draft.xn, y: draft.yn },
      body,
      size: "small",
      color: "auto"
    };
    setDraft(null);
    const wrote = await persistOverlay(overlay);
    if (wrote && !isControlled) {
      toolState.onAnnotationPlaced({ tool: "text" });
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
  }, [draft, isControlled, setTool, tool]);

  if (state.kind === "loading") {
    return <div className="editor-loading">Loading capture…</div>;
  }
  if (state.kind === "error") {
    return <div className="editor-error">{state.message}</div>;
  }

  return (
    <EditorLoaded
      record={state.record}
      overlays={state.overlays}
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      commitText={commitText}
      onZoomChange={onZoomChange}
      blurStyle={blurStyle}
      isControlled={isControlled}
      toolState={toolState}
      openActivePopoverRef={openActivePopoverRef}
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
  onPointerDown,
  onPointerMove,
  onPointerUp,
  commitText,
  onZoomChange,
  blurStyle,
  isControlled,
  toolState,
  openActivePopoverRef
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
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => Promise<void>;
  commitText: () => Promise<void>;
  onZoomChange: ((api: ZoomApi) => void) | undefined;
  blurStyle: BlurStyle;
  isControlled: boolean;
  toolState: ReturnType<typeof useEditorToolState>;
  openActivePopoverRef: React.RefObject<(() => void) | null>;
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
    [isControlled, record.id, recordCreateRef, toolState, undoApplyingRef]
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
  popoverAnchorRef
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
}) {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Annotation tools">
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
        <button type="button" disabled={!canUndo} onClick={onUndo} title="Undo (⌘Z)">
          ↶ Undo
        </button>
        <button type="button" disabled={!canRedo} onClick={onRedo} title="Redo (⌘⇧Z)">
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
