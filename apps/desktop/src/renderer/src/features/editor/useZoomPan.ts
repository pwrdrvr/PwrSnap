// Zoom + pan state for the Editor canvas — "canvas grows" model.
//
// Mental model: the canvas element has explicit CSS width/height that
// scale with the zoom factor. The wrap is `overflow: auto`, so the
// canvas can be larger than the visible area; the user pans by
// scrolling the wrap. When the canvas is smaller than the wrap (fit
// or zoomed out), it's centered via `margin: auto`. This is the
// standard photo-editor model — Preview.app, Photos, Photoshop. The
// alternative (transform: scale inside overflow:hidden) keeps the
// canvas the same DOM size and scales the pixels visually, which
// nobody else does and which the user explicitly rejected.
//
// Default: fit-to-window (scale = 1). At scale=1, the canvas is sized
// to fit the wrap with object-fit:contain semantics. Larger scales
// grow the canvas past the wrap; smaller scales shrink it.
//
// Pinch-to-zoom on macOS trackpads arrives as `wheel` events with
// `event.ctrlKey === true` (Chromium/Cocoa convention — the OS
// rewrites the gesture into a synthetic ctrl+wheel). That's the only
// way the renderer sees a trackpad pinch.
//
// Drag-to-pan is enabled when scale > 1 (canvas overflows the wrap)
// or when Space is held (Photoshop convention).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const KEYBOARD_STEP = 1.25;
const WHEEL_STEP_BASE = 1.0025;

export type ZoomPanState = {
  /** Multiplier on the canvas's fit-to-wrap CSS size. 1 = fit, 2 =
   *  twice as big as fit, etc. NOT a multiplier on the source image
   *  pixels — that depends on the wrap's current size. */
  scale: number;
};

export const FIT_TO_WINDOW: ZoomPanState = { scale: 1 };

export type UseZoomPanResult = {
  state: ZoomPanState;
  /** Apply as inline style on the canvas element. `null` when the
   *  wrap hasn't laid out yet (first paint); caller should render a
   *  fallback canvas sized by aspect-ratio + max-width/max-height
   *  until the ResizeObserver fires. */
  canvasStyle: { width: string; height: string } | null;
  /** Fit-to-window reset (⌘0). */
  resetToFit: () => void;
  /** 1:1 pixel mapping (⌘1). Accounts for devicePixelRatio so a
   *  Retina capture renders at OS-1:1 inside the viewport. */
  actualSize: () => void;
  /** ⌘+ */
  zoomIn: () => void;
  /** ⌘- */
  zoomOut: () => void;
  /** Whether space is held — caller uses this to suppress the active
   *  tool's drag handler and pan instead. */
  spaceHeld: boolean;
  /** Whether a pan drag is in progress. Caller can show grabbing cursor. */
  isPanning: boolean;
  /** Wheel handler — attach to the wrap. Handles pinch (ctrlKey=true)
   *  or meta+wheel; lets plain wheel-scroll pass through to native
   *  scrollbar pan. */
  onWheel: (event: WheelEvent) => void;
  /** Pan handlers — attach to the wrap when `scale > 1 || spaceHeld`.
   *  Drives `wrap.scrollLeft/scrollTop` directly; no React state for
   *  pan position. */
  onPanPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPanPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPanPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
};

export function useZoomPan(opts: {
  /** Multiplier applied to actualSize() output — typically devicePixelRatio
   *  (so Retina captures display at OS-1:1 instead of CSS-1:1). */
  devicePixelRatio?: number;
  /** Image's intrinsic pixel dimensions. Used for actualSize math
   *  and for the canvas's intrinsic aspect ratio. */
  imageWidthPx: number;
  imageHeightPx: number;
  /** The scroll container (canvas-wrap). Pan scrolls this element;
   *  fit-to-wrap math reads its clientWidth/clientHeight. */
  wrapRef: React.RefObject<HTMLElement | null>;
}): UseZoomPanResult {
  const { devicePixelRatio = 1, imageWidthPx, imageHeightPx, wrapRef } = opts;
  const [state, setState] = useState<ZoomPanState>(FIT_TO_WINDOW);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [fitSize, setFitSize] = useState<{ width: number; height: number } | null>(null);
  // When the user clicks 1:1, we lock into "actual size" mode and
  // re-compute on wrap resize (rendered CSS-px size depends on the
  // wrap's current dimensions). Cleared by any other zoom op so the
  // user can leave 1:1 freely.
  const [actualSizeLocked, setActualSizeLocked] = useState(false);
  const panStart = useRef<{
    x: number;
    y: number;
    baseScrollLeft: number;
    baseScrollTop: number;
  } | null>(null);

  const imageAspect = imageWidthPx / imageHeightPx;

  // Compute fit-to-wrap dimensions (object-fit:contain semantics
  // relative to the wrap's content box).
  //
  // Subtract the wrap's CSS padding from clientWidth/clientHeight —
  // `clientWidth` INCLUDES padding, but the canvas has to fit inside
  // the padding box. Without this, the canvas was computed slightly
  // larger than the content area, triggering scrollbars, whose
  // appearance shrunk clientHeight/clientWidth, which made fit
  // re-compute smaller, which made scrollbars disappear, which made
  // fit larger again — the rocket-launching-away oscillation.
  //
  // Also subtract a 1-px safety margin to prevent sub-pixel rounding
  // from pushing the canvas just barely over the content edge.
  // Combined with `scrollbar-gutter: stable` on the wrap (CSS), this
  // eliminates the feedback loop entirely.
  const computeFit = useCallback((): { width: number; height: number } | null => {
    const wrap = wrapRef.current;
    if (wrap === null) return null;
    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const w = Math.max(0, wrap.clientWidth - padX - 1);
    const h = Math.max(0, wrap.clientHeight - padY - 1);
    if (w <= 0 || h <= 0) return null;
    const wrapAspect = w / h;
    if (wrapAspect > imageAspect) {
      return { width: h * imageAspect, height: h };
    }
    return { width: w, height: w / imageAspect };
  }, [wrapRef, imageAspect]);

  // Track wrap size; refresh fit whenever it changes. Also recompute
  // 1:1 scale when actualSizeLocked, so the canvas stays at one
  // image-pixel-per-screen-pixel as the wrap grows/shrinks.
  //
  // `useLayoutEffect` (not `useEffect`) for two reasons:
  //   1. The initial fit must be computed BEFORE the browser paints,
  //      otherwise the canvas paints once with the pre-measurement
  //      fallback (aspect-ratio + max-width:100%), then immediately
  //      again with explicit dimensions — visible flash.
  //   2. The async ResizeObserver fire that would normally land the
  //      initial measurement can race the rest of the layout chain,
  //      occasionally seeing transient mid-layout dimensions that
  //      kick off the resize feedback loop. Synchronous read inside
  //      the layout effect avoids that.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    const update = (): void => {
      const fit = computeFit();
      if (fit === null) return;
      // Avoid churn: only commit a fit change when the dimensions
      // shift by more than 0.5px. Sub-pixel jitter from scrollbar
      // appearance/layout reflow used to thrash React state every
      // frame.
      setFitSize((prev) => {
        if (
          prev !== null &&
          Math.abs(prev.width - fit.width) < 0.5 &&
          Math.abs(prev.height - fit.height) < 0.5
        ) {
          return prev;
        }
        return fit;
      });
      if (actualSizeLocked) {
        const targetScale = imageWidthPx / devicePixelRatio / fit.width;
        setState((prev) => {
          const next = clamp(targetScale, MIN_SCALE, MAX_SCALE);
          return Math.abs(prev.scale - next) < 0.001 ? prev : { scale: next };
        });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrapRef, computeFit, actualSizeLocked, imageWidthPx, devicePixelRatio]);

  const resetToFit = useCallback(() => {
    setActualSizeLocked(false);
    setState(FIT_TO_WINDOW);
  }, []);

  const actualSize = useCallback(() => {
    const fit = computeFit();
    if (fit === null) return;
    const targetScale = imageWidthPx / devicePixelRatio / fit.width;
    setActualSizeLocked(true);
    setState({ scale: clamp(targetScale, MIN_SCALE, MAX_SCALE) });
  }, [computeFit, imageWidthPx, devicePixelRatio]);

  const zoomIn = useCallback(() => {
    setActualSizeLocked(false);
    setState((prev) => ({ scale: clamp(prev.scale * KEYBOARD_STEP, MIN_SCALE, MAX_SCALE) }));
  }, []);

  const zoomOut = useCallback(() => {
    setActualSizeLocked(false);
    setState((prev) => ({ scale: clamp(prev.scale / KEYBOARD_STEP, MIN_SCALE, MAX_SCALE) }));
  }, []);

  // Cursor-anchored zoom for pinch/meta+wheel. Math: compute the
  // cursor's content-fraction on the pre-zoom canvas, then choose a
  // new scrollLeft/scrollTop so the same fraction lands under the
  // cursor on the post-zoom canvas.
  //
  // When the canvas is SMALLER than the wrap (fit or zoomed out),
  // margin:auto centers it — `scrollLeft` is meaningless. When the
  // canvas is LARGER than the wrap, it's pinned to (0,0) of the scroll
  // area. The transition between the two regimes is handled by the
  // `canvasOffset` calc below.
  const onWheel = useCallback(
    (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setActualSizeLocked(false);
      const wrap = wrapRef.current;
      if (wrap === null) return;
      const fit = computeFit();
      if (fit === null) return;
      const wrapRect = wrap.getBoundingClientRect();
      const scrollLeftBefore = wrap.scrollLeft;
      const scrollTopBefore = wrap.scrollTop;
      const cursorInWrapX = event.clientX - wrapRect.left;
      const cursorInWrapY = event.clientY - wrapRect.top;
      setState((prev) => {
        const factor = WHEEL_STEP_BASE ** -event.deltaY;
        const targetScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
        if (targetScale === prev.scale) return prev;
        const prevCanvasW = fit.width * prev.scale;
        const prevCanvasH = fit.height * prev.scale;
        const nextCanvasW = fit.width * targetScale;
        const nextCanvasH = fit.height * targetScale;
        // Canvas's offset within the scroll content. When canvas <=
        // wrap, margin:auto inserts (wrap - canvas) / 2 of slack on
        // each side. When canvas > wrap, offset is 0.
        const prevOffsetX = Math.max(0, (wrap.clientWidth - prevCanvasW) / 2);
        const prevOffsetY = Math.max(0, (wrap.clientHeight - prevCanvasH) / 2);
        const contentX = scrollLeftBefore + cursorInWrapX;
        const contentY = scrollTopBefore + cursorInWrapY;
        const cursorInCanvasX = contentX - prevOffsetX;
        const cursorInCanvasY = contentY - prevOffsetY;
        // Fraction in [0,1] of cursor's position over the canvas.
        // Clamp keeps anchor sane when cursor is in the wrap padding
        // (outside the canvas) — anchors at nearest edge.
        const fx = prevCanvasW > 0 ? clamp(cursorInCanvasX / prevCanvasW, 0, 1) : 0.5;
        const fy = prevCanvasH > 0 ? clamp(cursorInCanvasY / prevCanvasH, 0, 1) : 0.5;
        const nextOffsetX = Math.max(0, (wrap.clientWidth - nextCanvasW) / 2);
        const nextOffsetY = Math.max(0, (wrap.clientHeight - nextCanvasH) / 2);
        const newContentX = nextOffsetX + fx * nextCanvasW;
        const newContentY = nextOffsetY + fy * nextCanvasH;
        const newScrollLeft = newContentX - cursorInWrapX;
        const newScrollTop = newContentY - cursorInWrapY;
        // Schedule the scroll AFTER React commits the new canvas size
        // — otherwise `scrollLeft = ...` is clamped to the OLD
        // scrollWidth and we lose the cursor anchor.
        queueMicrotask(() => {
          const el = wrapRef.current;
          if (el === null) return;
          el.scrollLeft = newScrollLeft;
          el.scrollTop = newScrollTop;
        });
        return { scale: targetScale };
      });
    },
    [wrapRef, computeFit]
  );

  // Listen for Space keydown/keyup so the caller can switch to pan
  // mode without changing the active tool.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true
      ) {
        return;
      }
      if (!spaceHeld) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (e.code !== "Space") return;
      setSpaceHeld(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [spaceHeld]);

  const onPanPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return;
      if (state.scale <= 1 && !spaceHeld) return;
      const wrap = wrapRef.current;
      if (wrap === null) return;
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      setIsPanning(true);
      panStart.current = {
        x: event.clientX,
        y: event.clientY,
        baseScrollLeft: wrap.scrollLeft,
        baseScrollTop: wrap.scrollTop
      };
    },
    [state.scale, spaceHeld, wrapRef]
  );

  const onPanPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      if (panStart.current === null) return;
      const wrap = wrapRef.current;
      if (wrap === null) return;
      const dx = event.clientX - panStart.current.x;
      const dy = event.clientY - panStart.current.y;
      wrap.scrollLeft = panStart.current.baseScrollLeft - dx;
      wrap.scrollTop = panStart.current.baseScrollTop - dy;
    },
    [wrapRef]
  );

  const onPanPointerUp = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (panStart.current === null) return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    panStart.current = null;
    setIsPanning(false);
  }, []);

  const canvasStyle: { width: string; height: string } | null =
    fitSize === null
      ? null
      : {
          width: `${fitSize.width * state.scale}px`,
          height: `${fitSize.height * state.scale}px`
        };

  return {
    state,
    canvasStyle,
    resetToFit,
    actualSize,
    zoomIn,
    zoomOut,
    spaceHeld,
    isPanning,
    onWheel,
    onPanPointerDown,
    onPanPointerMove,
    onPanPointerUp
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
