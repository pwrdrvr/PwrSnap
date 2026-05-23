// Crop tool overlay — Phase 1 of the v2 editor refresh.
//
// Renders a v1-compatible crop selection on top of the editor's
// canvas SVG. The user sees: a dimmed area outside the crop rect, a
// 1px white border around the crop rect, 8 resize handles (4 corners
// + 4 edges), rule-of-thirds guides (visible only while a drag is in
// flight), and a top-left HUD showing W×H + aspect ratio in source-
// pixel terms.
//
// Coordinate spaces:
//   • Component state holds the crop rect in SOURCE-PIXEL coords
//     (`{ x, y, w, h }` where x+w ≤ sourceWidth, y+h ≤ sourceHeight).
//     This is the natural space for the HUD readout (which is in
//     source pixels) and for the min-size constraint (16x16 source
//     pixels independent of canvas display size).
//   • Pointer events arrive in viewport coords. They get translated
//     to source-pixel coords via the canvasRect → source scale.
//   • onCommit is handed a NORMALIZED rect (each value ∈ [0,1]) so
//     the caller can write a CropOverlay through the existing
//     overlays:upsert IPC without further conversion.
//
// Lifecycle / commit model:
//   • Component does NOT dispatch IPC. The parent (task #9) wires
//     `onCommit` to overlays:upsert and `onCancel` to clearing the
//     active tool. Keeping IPC out of this file lets the test suite
//     stay in-process without mocking the renderer's dispatch.
//
// Key handling:
//   • Escape → onCancel
//   • Enter → onCommit(normalized)
//   • Click outside canvas (and not on a handle) → onCancel
//
// See plan: docs/plans/2026-05-23-001-feat-v2-editor-plan.md §"Phase 1".

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from "react";

// editor.css is loaded once by Editor.tsx at the editor-window root
// (`./editor.css` at the top of that file). CropTool consumes those
// .pse-crop* rules through that single import — no per-component
// stylesheet load here so we keep one source of truth for editor CSS.

// ----------------------------------------------------------------- types

export interface CropToolProps {
  captureId: string;
  /** Source image pixel dimensions. Used to normalize coords to
   *  [0,1] before persisting through CropOverlay. */
  sourceWidth: number;
  sourceHeight: number;
  /** Element rectangle the canvas is rendered into. Coords used for
   *  pointer math. `null` while the canvas is still measuring; the
   *  component renders nothing until non-null. */
  canvasRect: DOMRect | null;
  /** Commit (↵). Caller dispatches the overlays:upsert. */
  onCommit(rect: { x: number; y: number; w: number; h: number }): void;
  /** Cancel (Esc, or click outside the canvas + not on a handle). */
  onCancel(): void;
}

type Rect = { x: number; y: number; w: number; h: number };

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: ReadonlyArray<HandleId> = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const HANDLE_LABELS: Record<HandleId, string> = {
  nw: "Resize top-left",
  n: "Resize top",
  ne: "Resize top-right",
  e: "Resize right",
  se: "Resize bottom-right",
  s: "Resize bottom",
  sw: "Resize bottom-left",
  w: "Resize left"
};

const MIN_CROP_SIZE = 16; // source-pixel minimum (per spec)

// ----------------------------------------------------------------- math

/** Greatest common divisor — Euclidean. Returns 0 only when both
 *  args are 0; we guard the caller against that. */
function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/** Format the aspect-ratio segment of the HUD. Tries Euclidean GCD
 *  first; if the reduced ratio fits within numerator ≤ 50 (so the
 *  display stays human-readable), use it. Otherwise fall back to
 *  the decimal-`:1` form rounded to 3 places. */
export function formatAspectRatio(w: number, h: number): string {
  const wi = Math.max(1, Math.round(w));
  const hi = Math.max(1, Math.round(h));
  const g = gcd(wi, hi);
  const rw = wi / g;
  const rh = hi / g;
  if (rw <= 50 && rh <= 50) {
    return `${rw}:${rh}`;
  }
  const ratio = wi / hi;
  return `${ratio.toFixed(3)}:1`;
}

/** Compose the HUD text: `W × H · ratio`. Uses U+00D7 (multiplication
 *  sign) per typographic convention, not the ASCII `x`. */
export function formatHud(w: number, h: number): string {
  const wi = Math.max(1, Math.round(w));
  const hi = Math.max(1, Math.round(h));
  return `${wi} × ${hi} · ${formatAspectRatio(wi, hi)}`;
}

/** Centered 60% crop rect in source-pixel coords. */
function defaultRect(sourceWidth: number, sourceHeight: number): Rect {
  const w = sourceWidth * 0.6;
  const h = sourceHeight * 0.6;
  const x = (sourceWidth - w) / 2;
  const y = (sourceHeight - h) / 2;
  return { x, y, w, h };
}

/** Apply a handle resize delta in source-pixel coords. Mirrors the
 *  region-selector's `applyResize` (different handle ids) so the
 *  behavior matches Quick Capture's selection model the user
 *  already knows. */
function applyHandleResize(
  start: Rect,
  handle: HandleId,
  dx: number,
  dy: number
): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle === "nw" || handle === "w" || handle === "sw") left += dx;
  if (handle === "ne" || handle === "e" || handle === "se") right += dx;
  if (handle === "nw" || handle === "n" || handle === "ne") top += dy;
  if (handle === "sw" || handle === "s" || handle === "se") bottom += dy;
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    w: Math.abs(right - left),
    h: Math.abs(bottom - top)
  };
}

/** Clamp a rect to canvas bounds AND enforce min-size. Order
 *  matters: we clamp into bounds first (which may shrink w/h), then
 *  enforce the min, then re-clamp x/y so the min-sized rect still
 *  fits. */
function clampRect(r: Rect, sw: number, sh: number): Rect {
  let x = Math.max(0, Math.min(sw - MIN_CROP_SIZE, r.x));
  let y = Math.max(0, Math.min(sh - MIN_CROP_SIZE, r.y));
  let w = Math.max(MIN_CROP_SIZE, Math.min(sw - x, r.w));
  let h = Math.max(MIN_CROP_SIZE, Math.min(sh - y, r.h));
  // Re-check x/y in case width/height bumped them.
  if (x + w > sw) x = sw - w;
  if (y + h > sh) y = sh - h;
  return { x, y, w, h };
}

/** Translate the rect by (dx, dy) in source-pixel coords, clamped to
 *  the canvas. Unlike `clampRect`, this preserves w/h exactly — only
 *  the offset is adjusted. */
function clampTranslate(r: Rect, sw: number, sh: number): Rect {
  const x = Math.max(0, Math.min(sw - r.w, r.x));
  const y = Math.max(0, Math.min(sh - r.h, r.y));
  return { x, y, w: r.w, h: r.h };
}

// ----------------------------------------------------------------- drag state

type DragState =
  | { kind: "none" }
  | {
      kind: "handle";
      handle: HandleId;
      pointerId: number;
      startPointerX: number;
      startPointerY: number;
      startRect: Rect;
    }
  | {
      kind: "interior";
      pointerId: number;
      startPointerX: number;
      startPointerY: number;
      startRect: Rect;
    };

// ----------------------------------------------------------------- component

export function CropTool(props: CropToolProps): ReactElement | null {
  const { sourceWidth, sourceHeight, canvasRect, onCommit, onCancel } = props;

  // Initial rect — centered 60% of source. Recomputed when source
  // dims change (e.g. caller swaps captureId).
  const [rect, setRect] = useState<Rect>(() => defaultRect(sourceWidth, sourceHeight));
  useEffect(() => {
    setRect(defaultRect(sourceWidth, sourceHeight));
    // captureId in the dep list catches the rare case where source dims
    // are the same but the underlying image changed.
  }, [sourceWidth, sourceHeight, props.captureId]);

  const dragRef = useRef<DragState>({ kind: "none" });
  const [isDragging, setIsDragging] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Stable refs to props that the window-level keyboard / click
  // handlers need to see the latest value of without re-binding.
  const propsRef = useRef({ onCommit, onCancel, sourceWidth, sourceHeight, canvasRect, rect });
  useLayoutEffect(() => {
    propsRef.current = { onCommit, onCancel, sourceWidth, sourceHeight, canvasRect, rect };
  }, [onCommit, onCancel, sourceWidth, sourceHeight, canvasRect, rect]);

  // -------------------- viewport → source-pixel translation
  const viewportToSource = useCallback(
    (clientX: number, clientY: number): { sx: number; sy: number } | null => {
      const cr = propsRef.current.canvasRect;
      if (cr === null || cr.width === 0 || cr.height === 0) return null;
      const sx = ((clientX - cr.left) / cr.width) * propsRef.current.sourceWidth;
      const sy = ((clientY - cr.top) / cr.height) * propsRef.current.sourceHeight;
      return { sx, sy };
    },
    []
  );

  // -------------------- handle pointer drag
  const onHandlePointerDown = useCallback(
    (handle: HandleId) => (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();
      const src = viewportToSource(e.clientX, e.clientY);
      if (src === null) return;
      dragRef.current = {
        kind: "handle",
        handle,
        pointerId: e.pointerId,
        startPointerX: src.sx,
        startPointerY: src.sy,
        startRect: { ...rect }
      };
      setIsDragging(true);
      // Capture so the drag continues even if the pointer leaves
      // the handle.
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [rect, viewportToSource]
  );

  const onInteriorPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();
      const src = viewportToSource(e.clientX, e.clientY);
      if (src === null) return;
      dragRef.current = {
        kind: "interior",
        pointerId: e.pointerId,
        startPointerX: src.sx,
        startPointerY: src.sy,
        startRect: { ...rect }
      };
      setIsDragging(true);
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [rect, viewportToSource]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (drag.kind === "none" || drag.pointerId !== e.pointerId) return;
      const src = viewportToSource(e.clientX, e.clientY);
      if (src === null) return;
      const dx = src.sx - drag.startPointerX;
      const dy = src.sy - drag.startPointerY;
      const sw = propsRef.current.sourceWidth;
      const sh = propsRef.current.sourceHeight;
      if (drag.kind === "handle") {
        const next = applyHandleResize(drag.startRect, drag.handle, dx, dy);
        setRect(clampRect(next, sw, sh));
      } else {
        const moved: Rect = {
          x: drag.startRect.x + dx,
          y: drag.startRect.y + dy,
          w: drag.startRect.w,
          h: drag.startRect.h
        };
        setRect(clampTranslate(moved, sw, sh));
      }
    },
    [viewportToSource]
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag.kind === "none") return;
    if (drag.pointerId !== e.pointerId) return;
    dragRef.current = { kind: "none" };
    setIsDragging(false);
  }, []);

  // -------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        propsRef.current.onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const { rect: r, sourceWidth: sw, sourceHeight: sh } = propsRef.current;
        // Normalize to [0,1]. Guard against zero source dims (the
        // component renders null in that case but be defensive).
        if (sw <= 0 || sh <= 0) return;
        propsRef.current.onCommit({
          x: r.x / sw,
          y: r.y / sh,
          w: r.w / sw,
          h: r.h / sh
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // -------------------- click outside canvas → cancel
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      const cr = propsRef.current.canvasRect;
      if (cr === null) return;
      // If the click is inside the canvas rect, ignore — handle
      // events on the overlay take care of in-canvas behavior.
      const x = e.clientX;
      const y = e.clientY;
      const insideCanvas =
        x >= cr.left && x <= cr.right && y >= cr.top && y <= cr.bottom;
      if (insideCanvas) return;
      // Also ignore clicks on any handle (handles may visually
      // extend just past the canvas border depending on positioning).
      const target = e.target as Element | null;
      if (
        target !== null &&
        typeof target.closest === "function" &&
        target.closest(".pse-crop-handle") !== null
      ) {
        return;
      }
      propsRef.current.onCancel();
    };
    window.addEventListener("pointerdown", onDocPointerDown);
    return () => window.removeEventListener("pointerdown", onDocPointerDown);
  }, []);

  // -------------------- render
  const hudText = useMemo(() => formatHud(rect.w, rect.h), [rect.w, rect.h]);
  const ariaLabel = useMemo(() => {
    const w = Math.max(1, Math.round(rect.w));
    const h = Math.max(1, Math.round(rect.h));
    return `Crop selection ${w} by ${h} source pixels`;
  }, [rect.w, rect.h]);

  if (canvasRect === null || sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }

  // Translate the source-pixel rect → canvas-pixel rect for layout.
  // The overlay div spans the full canvas (`inset: 0`); positioning
  // inside is in display-pixel coords relative to the overlay's own
  // top-left.
  const cw = canvasRect.width;
  const ch = canvasRect.height;
  const scaleX = cw / sourceWidth;
  const scaleY = ch / sourceHeight;
  const dispX = rect.x * scaleX;
  const dispY = rect.y * scaleY;
  const dispW = rect.w * scaleX;
  const dispH = rect.h * scaleY;

  // Four dim rects covering everything outside the selection.
  // Avoid clip-path so the dim rects compose well with the handles
  // (which need to sit on top of the dim layer).
  const dimTop: CSSProperties = { left: 0, top: 0, width: cw, height: dispY };
  const dimBottom: CSSProperties = {
    left: 0,
    top: dispY + dispH,
    width: cw,
    height: Math.max(0, ch - (dispY + dispH))
  };
  const dimLeft: CSSProperties = {
    left: 0,
    top: dispY,
    width: dispX,
    height: dispH
  };
  const dimRight: CSSProperties = {
    left: dispX + dispW,
    top: dispY,
    width: Math.max(0, cw - (dispX + dispW)),
    height: dispH
  };

  const rectStyle: CSSProperties = {
    left: dispX,
    top: dispY,
    width: dispW,
    height: dispH
  };

  // Handles: position the center of each on the corresponding rect
  // boundary. The CSS rule applies translate(-50%, -50%) so the
  // glyph centers on these coords.
  const handleCenters: Record<HandleId, { left: number; top: number }> = {
    nw: { left: dispX, top: dispY },
    n: { left: dispX + dispW / 2, top: dispY },
    ne: { left: dispX + dispW, top: dispY },
    e: { left: dispX + dispW, top: dispY + dispH / 2 },
    se: { left: dispX + dispW, top: dispY + dispH },
    s: { left: dispX + dispW / 2, top: dispY + dispH },
    sw: { left: dispX, top: dispY + dispH },
    w: { left: dispX, top: dispY + dispH / 2 }
  };

  return (
    <div
      ref={overlayRef}
      className="pse-crop"
      data-testid="crop-tool"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="pse-crop-dim" style={dimTop} />
      <div className="pse-crop-dim" style={dimBottom} />
      <div className="pse-crop-dim" style={dimLeft} />
      <div className="pse-crop-dim" style={dimRight} />

      <div
        className="pse-crop-rect"
        role="img"
        aria-label={ariaLabel}
        data-testid="crop-rect"
        style={rectStyle}
        onPointerDown={onInteriorPointerDown}
      >
        {/* Rule-of-thirds guides — only while dragging. Positioned
            inside the rect at 33%/67%. */}
        {isDragging ? (
          <>
            <div
              className="pse-crop-guide is-h"
              data-testid="crop-guide"
              style={{ top: "33.333%" }}
            />
            <div
              className="pse-crop-guide is-h"
              data-testid="crop-guide"
              style={{ top: "66.667%" }}
            />
            <div
              className="pse-crop-guide is-v"
              data-testid="crop-guide"
              style={{ left: "33.333%" }}
            />
            <div
              className="pse-crop-guide is-v"
              data-testid="crop-guide"
              style={{ left: "66.667%" }}
            />
          </>
        ) : null}

        <div className="pse-crop-hud" data-testid="crop-hud">
          {hudText}
        </div>
      </div>

      {HANDLES.map((h) => (
        <div
          key={h}
          className={`pse-crop-handle is-${h}`}
          role="button"
          aria-label={HANDLE_LABELS[h]}
          data-testid={`crop-handle-${h}`}
          style={{ left: handleCenters[h].left, top: handleCenters[h].top }}
          onPointerDown={onHandlePointerDown(h)}
        />
      ))}
    </div>
  );
}
