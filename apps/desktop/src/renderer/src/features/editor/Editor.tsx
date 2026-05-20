// Phase 2 Editor — full tool palette.
//
// Tools (Slice B):
//   • Arrow      — drag from→to. Smart geometry shared with bake.
//   • Rect       — drag a rectangle. Stroked outline + white halo.
//   • Highlight  — drag a rectangle. Semi-transparent yellow fill.
//   • Blur       — drag a rectangle. Mask-style blur per region in bake.
//   • Text       — click to anchor; inline input; Enter commits.
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureRecord, Overlay, OverlayRow } from "@pwrsnap/shared";
import { dispatch, subscribe, captureSrcUrl } from "../../lib/pwrsnap";
import { TOOLS, type Tool } from "./editor-tools";
import { useZoomPan, type ZoomMode } from "./useZoomPan";
import { useUndoRedo } from "./useUndoRedo";
import { OverlaySvg } from "./OverlaySvg";
import { TextDraftInput } from "./TextDraftInput";
import { ZoomMenu } from "./ZoomMenu";
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
 *                    toolbar. Default when no chrome prop is passed.
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
export type EditorChrome = "full" | "embedded" | "chromeless";

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

export function Editor({
  captureId,
  chrome = "full",
  tool: toolProp,
  onToolChange,
  onZoomChange
}: {
  captureId: string;
  /** Chrome shape — see `EditorChrome` above. Defaults to `"full"`
   *  (standalone editor window). */
  chrome?: EditorChrome;
  /** Optional controlled tool state. If both `tool` and `onToolChange`
   *  are passed, Editor is fully controlled — Library owns the tool
   *  state and drives the floating EditToolbar. If neither is passed,
   *  Editor falls back to internal `useState` (standalone-window
   *  path). Mixed (one without the other) is not supported and will
   *  fall back to internal state. */
  tool?: Tool;
  onToolChange?: (tool: Tool) => void;
  /** Called whenever the editor's zoom state changes. Library uses
   *  this to render the zoom indicator in the floating EditToolbar
   *  (so the indicator doesn't float over the image). Called with
   *  `null` on unmount so the parent can clear its cached api. */
  onZoomChange?: (api: ZoomApi) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Controlled-or-uncontrolled tool state. When the parent passes
  // both `tool` and `onToolChange`, we mirror their value as the
  // single source of truth. Otherwise we fall back to internal
  // useState (the standalone-window invariant).
  const isControlled = toolProp !== undefined && onToolChange !== undefined;
  const [internalTool, setInternalTool] = useState<Tool>("pointer");
  const tool = isControlled ? toolProp : internalTool;
  const setTool = useCallback(
    (next: Tool) => {
      if (isControlled) onToolChange(next);
      else setInternalTool(next);
    },
    [isControlled, onToolChange]
  );
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

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    // Pointer tool is no-op on drag — lets the user click on the
    // canvas without accidentally drawing. They have to explicitly
    // select a drawing tool first.
    if (tool === "pointer") return;
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
      setDraft(null);
      await persistOverlay(overlay);
      return;
    }

    if (draft.kind === "rect-drag") {
      const rect = rectFromDrag(draft);
      if (rect === null) {
        setDraft(null);
        return;
      }
      const overlay: Overlay =
        draft.tool === "rect"
          ? { kind: "rect", rect, color: "auto" }
          : draft.tool === "highlight"
          ? { kind: "highlight", rect }
          : { kind: "blur", rect };
      setDraft(null);
      await persistOverlay(overlay);
      return;
    }
  }

  async function persistOverlay(overlay: Overlay): Promise<void> {
    const result = await dispatch("overlays:upsert", { captureId, overlay });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error("overlays:upsert failed", result.error);
      return;
    }
    // Record the create on the undo stack so ⌘Z reverts it.
    // Suppressed when we ARE the undo/redo replay path
    // (undoApplyingRef === true).
    if (!undoApplyingRef.current) {
      recordCreateRef.current?.(result.value);
    }
    // events:overlays:changed broadcast triggers refetch.
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
    await persistOverlay(overlay);
  }

  // Keyboard shortcuts: tool selection + Esc cancels drag.
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
      const upper = event.key.toUpperCase();
      const matched = TOOLS.find((t) => t.key === upper);
      if (matched !== undefined) {
        event.preventDefault();
        setTool(matched.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft]);

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
  onZoomChange
}: {
  record: CaptureRecord;
  overlays: OverlayRow[];
  chrome: EditorChrome;
  tool: Tool;
  setTool: (t: Tool) => void;
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
    // TEMP DIAGNOSTIC — keep until pinch is confirmed working.
    // eslint-disable-next-line no-console
    console.warn("[Editor] zoom listeners attached");
    const inWrap = (e: Event): boolean => {
      const wrap = canvasWrapRef.current;
      if (wrap === null) return false;
      if (!(e.target instanceof Node)) return false;
      return wrap.contains(e.target);
    };
    const onWheel = (e: WheelEvent): void => {
      // eslint-disable-next-line no-console
      console.warn("[wheel]", {
        ctrlKey: e.ctrlKey, metaKey: e.metaKey,
        deltaY: e.deltaY, deltaX: e.deltaX,
        inWrap: inWrap(e)
      });
      if (!inWrap(e)) return;
      onWheelRef.current(e);
    };
    const onGestureStart = (e: Event): void => {
      // eslint-disable-next-line no-console
      console.warn("[gesturestart]", { scale: (e as Event & { scale?: number }).scale, inWrap: inWrap(e) });
      if (!inWrap(e)) return;
      onGestureStartRef.current(e);
    };
    const onGestureChange = (e: Event): void => {
      // eslint-disable-next-line no-console
      console.warn("[gesturechange]", { scale: (e as Event & { scale?: number }).scale, inWrap: inWrap(e) });
      if (!inWrap(e)) return;
      onGestureChangeRef.current(e);
    };
    const onGestureEnd = (e: Event): void => {
      // eslint-disable-next-line no-console
      console.warn("[gestureend]");
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
  const wantPan = zoom.state.scale > 1 || zoom.spaceHeld;

  return (
    <div
      className={
        "editor-root" +
        (chrome === "embedded" ? " is-embedded" : "") +
        (chrome === "chromeless" ? " is-chromeless" : "")
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
        </div>
      </div>

      {chrome !== "chromeless" && (
        <EditorToolbar
          tool={tool}
          onChange={setTool}
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
        />
      )}
    </div>
  );
}

// EditorToolbar: bottom-row toolbar attached to Editor's own chrome
// (full + embedded modes). The new <EditToolbar> at
// features/library/EditToolbar.tsx is a SEPARATE component used by
// Library's Stage component (chromeless Editor + floating bottom-
// center toolbar, Phase C). Renamed from `Toolbar` to avoid the
// name collision flagged by pattern-recognition-specialist.
function EditorToolbar({
  tool,
  onChange,
  appliedCount,
  canUndo,
  canRedo,
  zoom,
  onUndo,
  onRedo,
  onReveal
}: {
  tool: Tool;
  onChange: (t: Tool) => void;
  appliedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  zoom: NonNullable<ZoomApi>;
  onUndo: () => void;
  onRedo: () => void;
  onReveal: () => void;
}) {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Annotation tools">
      <div className="editor-toolbar-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tool === t.id ? "is-active" : ""}
            onClick={() => onChange(t.id)}
            title={`${t.label} (${t.key})`}
          >
            <span className="editor-tool-key">{t.key}</span>
            <span>{t.label}</span>
          </button>
        ))}
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

