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
// Discoverable commit/cancel:
//   • The overlay also renders a visible button cluster (Apply Crop +
//     Cancel) anchored to the rect — for users who don't know the
//     keyboard shortcuts or whose focus is somewhere else when they
//     finish dragging. Clicking the buttons fires the same callbacks
//     as the keyboard shortcuts. The buttons stop pointerdown
//     propagation so clicking them does not start a rect drag.
//   • Position: inside the rect's top-right when there's room, else
//     anchored just below the rect (bottom-right). Keeps the cluster
//     visible regardless of how small / how-near-the-top-edge the
//     selection becomes.
//   • The overlay root is `tabIndex=-1` and is focused on mount so
//     the window-level keydown listener catches Enter / Escape even
//     when the user hasn't clicked anywhere yet. Without this, focus
//     stays on the canvas SVG (or wherever it was when the tool was
//     activated) and IME / form-control / menubar focus consumers
//     would swallow Enter before the document-level listener saw it.
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

  // -------------------- focus the overlay on mount
  //
  // The window-level keydown listener above catches Enter / Escape
  // regardless of focus in theory — but in practice, focus on a text
  // input, a contenteditable region, or a focused menubar item routes
  // Enter through that consumer first and the keydown can be
  // `preventDefault`'d before bubbling. The CropTool's job is to feel
  // committable right after the user activates it, so we own focus
  // explicitly on mount.
  //
  // `tabIndex={-1}` on the overlay root + `.focus()` here parks focus
  // on a non-interactive element that has no native key bindings of
  // its own. The user's next Enter / Escape reliably hits the window
  // listener; the cluster's buttons can still be clicked or
  // tab-focused independently.
  useEffect(() => {
    overlayRef.current?.focus({ preventScroll: true });
  }, []);

  // -------------------- button click handlers (commit / cancel)
  //
  // Mirror the keyboard handlers but read from current state (not
  // `propsRef`) so React batches the click → state-update path the
  // same as it does for other interactions. Stop propagation on
  // pointerdown so the click doesn't initiate a rect drag.
  const commitNormalized = useCallback((): void => {
    const { rect: r, sourceWidth: sw, sourceHeight: sh, canvasRect: cr } = propsRef.current;
    if (sw <= 0 || sh <= 0) return;
    // Observability for pwrdrvr/PwrSnap#110 "right-edge drift" — the
    // user reports their drawn rect's right edge ends up further
    // right than they intended. Three quantities determine whether
    // the drag → source-pixel translation is correct:
    //
    //   • sourceWidth / sourceHeight (props from Editor — should be
    //     record.width_px / record.height_px)
    //   • canvasRect.width / canvasRect.height (the canvas's display
    //     CSS dims at drag time)
    //   • rect (the user's drawn rect in source-pixel coords)
    //
    // If canvasRect's aspect doesn't match sourceWidth/sourceHeight's
    // aspect, viewportToSource's scaling is non-uniform and the user's
    // perceived drag end differs from the committed coords. Logging
    // all three lets us see if there's an aspect mismatch.
    // eslint-disable-next-line no-console
    console.log("[crop-tool] commit", {
      rect: r,
      source: { w: sw, h: sh, aspect: sw / sh },
      canvasRect: cr === null ? null : {
        w: cr.width,
        h: cr.height,
        aspect: cr.width / cr.height,
        left: cr.left,
        top: cr.top
      },
      committedNorm: { x: r.x / sw, y: r.y / sh, w: r.w / sw, h: r.h / sh },
      committedSourcePx: {
        rightEdge: r.x + r.w,
        bottomEdge: r.y + r.h
      }
    });
    propsRef.current.onCommit({
      x: r.x / sw,
      y: r.y / sh,
      w: r.w / sw,
      h: r.h / sh
    });
  }, []);

  const onActionPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>): void => {
      // Don't let the parent rect's onPointerDown start a drag.
      e.stopPropagation();
    },
    []
  );

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

  // Action-cluster placement: inside the rect's top-right when the
  // rect is large enough to comfortably host the cluster, otherwise
  // anchored just below the rect (bottom-right corner). Final fallback
  // if the rect is near the canvas's bottom edge and there's no room
  // below either: pin above the rect instead.
  //
  // Numbers tuned to the cluster's intrinsic height (~32px) + a small
  // breathing margin. Kept here (not in CSS) so the renderer makes the
  // anchor decision based on the geometry it already computed.
  const CLUSTER_MIN_RECT_WIDTH = 200;
  const CLUSTER_MIN_RECT_HEIGHT = 80;
  const CLUSTER_OUTSIDE_GAP = 8;
  const CLUSTER_APPROX_HEIGHT = 32;
  const fitsInside =
    dispW >= CLUSTER_MIN_RECT_WIDTH && dispH >= CLUSTER_MIN_RECT_HEIGHT;
  const hasRoomBelow =
    dispY + dispH + CLUSTER_OUTSIDE_GAP + CLUSTER_APPROX_HEIGHT <= ch;
  const hasRoomAbove = dispY - CLUSTER_OUTSIDE_GAP - CLUSTER_APPROX_HEIGHT >= 0;
  const clusterStyle: CSSProperties = fitsInside
    ? {
        // Inside top-right of the rect, indented by the same gap used
        // outside so the cluster doesn't hug the border or overlap the
        // HUD (which sits at top-left).
        right: cw - (dispX + dispW) + CLUSTER_OUTSIDE_GAP,
        top: dispY + CLUSTER_OUTSIDE_GAP
      }
    : hasRoomBelow
      ? {
          right: cw - (dispX + dispW),
          top: dispY + dispH + CLUSTER_OUTSIDE_GAP
        }
      : hasRoomAbove
        ? {
            right: cw - (dispX + dispW),
            top: dispY - CLUSTER_OUTSIDE_GAP - CLUSTER_APPROX_HEIGHT
          }
        : {
            // Worst case (tiny canvas, rect spans nearly the full
            // height): pin inside top-right anyway — handles + dim
            // remain functional, the cluster overlays a sliver of the
            // crop area but stays clickable.
            right: cw - (dispX + dispW) + CLUSTER_OUTSIDE_GAP,
            top: dispY + CLUSTER_OUTSIDE_GAP
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
      // Non-tabbable but programmatically focusable so the mount-time
      // .focus() lands on this element (and not on the canvas or some
      // ambient focused control), which ensures the window-level
      // keydown listener above sees Enter / Escape before any other
      // consumer can preventDefault them.
      tabIndex={-1}
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
        style={{
          ...rectStyle,
          // pwrdrvr/PwrSnap#110: visible boundary is drawn OUTSIDE
          // the rect's pixel bounds via CSS outline (which doesn't
          // consume any of the layout box). The rect's left/top/
          // width/height encode EXACTLY the kept region — the
          // dashed outline sits on top of the dim layer just past
          // the boundary. Pre-fix used `border: 1px solid` with
          // box-sizing: border-box, which drew the line INSIDE the
          // rect and made the outermost 1px ambiguously "kept" or
          // "cropped" (the source of the user's "Hi Mom" vs
          // "Hi Mom, w" perception drift).
          outline: "1px dashed rgba(255, 255, 255, 0.9)",
          outlineOffset: "0px"
        }}
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

        <div
          className="pse-crop-hud"
          data-testid="crop-hud"
          style={{
            // pwrdrvr/PwrSnap#110: theme-independent high-contrast
            // colors so the W×H readout stays legible against ANY
            // image content. Pre-fix used `--bg-overlay` +
            // `--text-primary` which resolved to ~32% black scrim +
            // near-black text in light theme — invisible on a black
            // screenshot. White-on-dark-scrim works regardless.
            backgroundColor: "rgba(0, 0, 0, 0.85)",
            color: "rgb(255, 255, 255)",
            boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.4)"
          }}
        >
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

      {/* Visible commit / cancel cluster — discoverable alternative
          to the ⌘↩ / Esc keyboard shortcuts. Anchored by `clusterStyle`
          (computed above based on rect geometry). Buttons stop
          pointerdown propagation so clicking them doesn't initiate a
          rect drag on the parent. */}
      <div
        className="pse-crop-actions"
        data-testid="crop-actions"
        style={clusterStyle}
      >
        <button
          type="button"
          className="pse-crop-action is-cancel"
          data-testid="crop-cancel"
          onPointerDown={onActionPointerDown}
          onClick={onCancel}
          aria-label="Cancel crop"
        >
          <span className="pse-crop-action-label">Cancel</span>
          <span className="pse-crop-action-kbd" aria-hidden="true">
            Esc
          </span>
        </button>
        <button
          type="button"
          className="pse-crop-action is-apply"
          data-testid="crop-apply"
          onPointerDown={onActionPointerDown}
          onClick={commitNormalized}
          aria-label="Apply crop"
        >
          <span className="pse-crop-action-label">Apply Crop</span>
          <span className="pse-crop-action-kbd" aria-hidden="true">
            {"⌘↵"}
          </span>
        </button>
      </div>
    </div>
  );
}
