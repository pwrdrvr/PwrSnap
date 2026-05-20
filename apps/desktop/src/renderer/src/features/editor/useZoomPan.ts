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
  /** Pan offset in CSS pixels, added to the canvas's flex-centered
   *  position via `transform: translate(panX, panY)`. With the wrap
   *  at `overflow: hidden` (not auto — overflow:auto disrupts macOS
   *  trackpad pinch routing), we drive pan ourselves: drag and
   *  cursor-anchored zoom both update panX/panY. */
  panX: number;
  panY: number;
};

export const FIT_TO_WINDOW: ZoomPanState = { scale: 1, panX: 0, panY: 0 };

/** Which zoom anchor the user last selected. Determines how the
 *  toolbar button labels the current state — "Fit (62%)" vs "100%"
 *  vs "150%" — and tracks intent across resize / pinch / typed
 *  values. Pinch-zoom and the +/- buttons both flip to "custom". */
export type ZoomMode = "fit" | "actual" | "custom";

export type UseZoomPanResult = {
  state: ZoomPanState;
  /** Which anchor the current scale corresponds to. */
  mode: ZoomMode;
  /** What percentage the canvas's current CSS size represents
   *  relative to the image's "actual size" CSS dimensions
   *  (imageWidth / devicePixelRatio). Null until the wrap is first
   *  measured. */
  displayPct: number | null;
  /** What displayPct *would* be at fit (scale=1). Lets the toolbar
   *  show "Fit (XX%)" without having to flip into fit mode to
   *  measure. Null until wrap is measured. */
  fitPct: number | null;
  /** Apply as inline style on the canvas element. `null` when the
   *  wrap hasn't laid out yet (first paint); caller should render a
   *  fallback canvas sized by aspect-ratio + max-width/max-height
   *  until the ResizeObserver fires. */
  canvasStyle: { width: string; height: string; transform: string } | null;
  /** Fit-to-window reset (⌘0). Sets mode="fit". */
  resetToFit: () => void;
  /** 100% / 1:1 — one image pixel per screen pixel (DPR-aware). Sets
   *  mode="actual" and re-tracks on wrap resize so it stays at 100%
   *  even as the wrap grows or shrinks. (⌘1) */
  actualSize: () => void;
  /** Jump to a specific displayPct (e.g. the user typed "175"). Sets
   *  mode="custom". */
  setCustomPct: (pct: number) => void;
  /** Multiply the current scale by `factor`. Sets mode="custom" so
   *  the menu reflects "user is hand-tweaking the zoom." Used by
   *  the +/- buttons and keyboard ⌘+ / ⌘-. */
  zoomBy: (factor: number) => void;
  /** Whether space is held — caller uses this to suppress the active
   *  tool's drag handler and pan instead. */
  spaceHeld: boolean;
  /** Whether a pan drag is in progress. Caller can show grabbing cursor. */
  isPanning: boolean;
  /** Wheel handler — attach to the wrap. Handles pinch (ctrlKey=true)
   *  or meta+wheel; lets plain wheel-scroll pass through to native
   *  scrollbar pan. */
  onWheel: (event: WheelEvent) => void;
  /** macOS gesture handlers — primary pinch-zoom signal on macOS
   *  trackpads. Attach as `gesturestart`/`gesturechange`/`gestureend`
   *  on the wrap (or window). */
  onGestureStart: (event: Event) => void;
  onGestureChange: (event: Event) => void;
  onGestureEnd: (event: Event) => void;
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
  const [mode, setMode] = useState<ZoomMode>("fit");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [fitSize, setFitSize] = useState<{ width: number; height: number } | null>(null);
  const panStart = useRef<{
    x: number;
    y: number;
    basePanX: number;
    basePanY: number;
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
  // the actual-size scale when mode==="actual", so the canvas stays
  // at one image-pixel-per-screen-pixel as the wrap grows/shrinks.
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
      if (mode === "actual") {
        const targetScale = imageWidthPx / devicePixelRatio / fit.width;
        setState((prev) => {
          const next = clamp(targetScale, MIN_SCALE, MAX_SCALE);
          return Math.abs(prev.scale - next) < 0.001 ? prev : { ...prev, scale: next };
        });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrapRef, computeFit, mode, imageWidthPx, devicePixelRatio]);

  const resetToFit = useCallback(() => {
    setMode("fit");
    setState(FIT_TO_WINDOW);
  }, []);

  const actualSize = useCallback(() => {
    const fit = computeFit();
    if (fit === null) return;
    const targetScale = imageWidthPx / devicePixelRatio / fit.width;
    setMode("actual");
    setState({ scale: clamp(targetScale, MIN_SCALE, MAX_SCALE), panX: 0, panY: 0 });
  }, [computeFit, imageWidthPx, devicePixelRatio]);

  // displayPct = scale × (fit.width × DPR / imageWidth) × 100
  // ⇒ scale    = (pct / 100) × imageWidth / (DPR × fit.width)
  const setCustomPct = useCallback(
    (pct: number) => {
      const fit = computeFit();
      if (fit === null) return;
      const targetScale = (pct / 100) * (imageWidthPx / devicePixelRatio) / fit.width;
      setMode("custom");
      setState({ scale: clamp(targetScale, MIN_SCALE, MAX_SCALE), panX: 0, panY: 0 });
    },
    [computeFit, imageWidthPx, devicePixelRatio]
  );

  const zoomBy = useCallback((factor: number) => {
    setMode("custom");
    setState((prev) => ({
      ...prev,
      scale: clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE)
    }));
  }, []);

  // Shared cursor-anchored zoom — driven by onWheel (mouse +
  // ctrl+wheel) and onGestureChange (macOS trackpad pinch). The
  // canvas is laid out by flex centering on the wrap; we add
  // `transform: translate(panX, panY)` on top. So the canvas's
  // top-left in wrap-content coords is:
  //   topLeft = (wrapContentSize - canvasSize) / 2 + pan
  // (this holds whether canvas is smaller OR larger than wrap —
  // when larger, the (wrap-canvas)/2 term is negative and the
  // canvas's left edge ends up to the LEFT of the wrap's content
  // origin, with the right edge protruding past wrap's right
  // edge.)
  //
  // To keep the cursor's content point fixed during zoom:
  //   fx = (cursorInWrap - prevTopLeft) / prevCanvasW   // in [0, 1]
  //   nextTopLeft = cursorInWrap - fx * nextCanvasW
  //   nextPan     = nextTopLeft - (wrapContent - nextCanvas) / 2
  const zoomAtCursor = useCallback(
    (factor: number, clientX: number, clientY: number): void => {
      const wrap = wrapRef.current;
      if (wrap === null) return;
      const fit = computeFit();
      if (fit === null) return;
      const wrapRect = wrap.getBoundingClientRect();
      // Inner content-area dimensions (clientWidth/Height minus the
      // wrap's CSS padding — same math as computeFit).
      const cs = getComputedStyle(wrap);
      const padL = parseFloat(cs.paddingLeft);
      const padT = parseFloat(cs.paddingTop);
      const padX = padL + parseFloat(cs.paddingRight);
      const padY = padT + parseFloat(cs.paddingBottom);
      const wrapW = Math.max(0, wrap.clientWidth - padX);
      const wrapH = Math.max(0, wrap.clientHeight - padY);
      // Cursor in wrap-content coords (relative to content-area
      // top-left, NOT wrap border-box).
      const cursorInWrapX = clientX - wrapRect.left - padL;
      const cursorInWrapY = clientY - wrapRect.top - padT;
      setState((prev) => {
        const targetScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
        if (targetScale === prev.scale) return prev;
        const prevCanvasW = fit.width * prev.scale;
        const prevCanvasH = fit.height * prev.scale;
        const nextCanvasW = fit.width * targetScale;
        const nextCanvasH = fit.height * targetScale;
        const prevTopLeftX = (wrapW - prevCanvasW) / 2 + prev.panX;
        const prevTopLeftY = (wrapH - prevCanvasH) / 2 + prev.panY;
        const cursorInCanvasX = cursorInWrapX - prevTopLeftX;
        const cursorInCanvasY = cursorInWrapY - prevTopLeftY;
        const fx = prevCanvasW > 0 ? clamp(cursorInCanvasX / prevCanvasW, 0, 1) : 0.5;
        const fy = prevCanvasH > 0 ? clamp(cursorInCanvasY / prevCanvasH, 0, 1) : 0.5;
        const nextTopLeftX = cursorInWrapX - fx * nextCanvasW;
        const nextTopLeftY = cursorInWrapY - fy * nextCanvasH;
        const nextPanX = nextTopLeftX - (wrapW - nextCanvasW) / 2;
        const nextPanY = nextTopLeftY - (wrapH - nextCanvasH) / 2;
        return { scale: targetScale, panX: nextPanX, panY: nextPanY };
      });
    },
    [wrapRef, computeFit]
  );

  // Wheel dispatch — Figma-style:
  //   • ctrl/meta + wheel  → zoom (cursor-anchored)
  //   • wheel (no modifier) → pan (deltaX, deltaY shift canvas)
  //
  // macOS trackpad pinch dispatches synthetic ctrl+wheel events on
  // some Chromium configurations and silently drops them on others
  // (depends on system trackpad settings, macOS accessibility, and
  // Chromium version — we can't control any of that from JS). So
  // we never rely on pinch as the ONLY zoom path; Cmd+wheel and the
  // ⌘+/⌘- keyboard shortcuts and the zoom-menu buttons are all
  // first-class. When pinch DOES dispatch as ctrl+wheel, this same
  // handler runs.
  const onWheel = useCallback(
    (event: WheelEvent): void => {
      // Only preventDefault when we're actually handling the event
      // as a zoom. Unconditional preventDefault on every wheel event
      // signals Chromium that the page "owns" wheel handling, and
      // Chromium then stops synthesizing the pinch-as-ctrl+wheel
      // events for macOS trackpad pinch — the gesture pipeline goes
      // silent. (Confirmed by user: regular wheel events fire but
      // pinch dispatches nothing while we were preventDefault'ing
      // unconditionally.)
      //
      // Default behavior on un-modified wheel events:
      //   • Pan branch: we update panX/panY ourselves; default
      //     wheel behavior on overflow:hidden wrap is a no-op, so
      //     no visible conflict.
      //   • Page-level wheel scroll: the editor-root is grid-row
      //     1fr inside a height-bounded container, no document
      //     scroll exists for the wheel to navigate.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setMode("custom");
        const factor = WHEEL_STEP_BASE ** -event.deltaY;
        zoomAtCursor(factor, event.clientX, event.clientY);
      } else {
        // Two-finger scroll: pan the canvas. At scale ≤ 1 the canvas
        // is centered with no room to pan, so this is a visual no-op;
        // at scale > 1 the user can two-finger-scroll to navigate
        // the zoomed canvas. Matches Figma's interaction model.
        setState((prev) => ({
          ...prev,
          panX: prev.panX - event.deltaX,
          panY: prev.panY - event.deltaY
        }));
      }
    },
    [zoomAtCursor]
  );

  // macOS trackpad pinch dispatches gesturestart/change/end events
  // (WebKit-style, also implemented by Chromium on macOS). These are
  // the PRIMARY pinch-zoom signal on macOS — wheel-with-ctrlKey is
  // a Chromium synthesis that may or may not happen depending on
  // setVisualZoomLevelLimits state and other settings, but gesture
  // events fire reliably.
  //
  // GestureEvent isn't in the standard DOM type lib (WebKit
  // extension), so the parameter is typed minimally and accessed
  // through casts. `event.scale` is the cumulative scale factor
  // since gesturestart; we track it across changes so each
  // gesturechange applies an INCREMENTAL factor.
  const gestureScaleRef = useRef(1);
  const onGestureStart = useCallback((event: Event): void => {
    event.preventDefault();
    setMode("custom");
    gestureScaleRef.current = 1;
  }, []);
  const onGestureChange = useCallback(
    (event: Event): void => {
      event.preventDefault();
      const ge = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const cumulative = typeof ge.scale === "number" ? ge.scale : 1;
      const factor = cumulative / gestureScaleRef.current;
      gestureScaleRef.current = cumulative;
      const cx = typeof ge.clientX === "number" ? ge.clientX : 0;
      const cy = typeof ge.clientY === "number" ? ge.clientY : 0;
      zoomAtCursor(factor, cx, cy);
    },
    [zoomAtCursor]
  );
  const onGestureEnd = useCallback((event: Event): void => {
    event.preventDefault();
    gestureScaleRef.current = 1;
  }, []);

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
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      setIsPanning(true);
      panStart.current = {
        x: event.clientX,
        y: event.clientY,
        basePanX: state.panX,
        basePanY: state.panY
      };
    },
    [state.scale, state.panX, state.panY, spaceHeld]
  );

  const onPanPointerMove = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (panStart.current === null) return;
    const dx = event.clientX - panStart.current.x;
    const dy = event.clientY - panStart.current.y;
    setState((prev) => ({
      ...prev,
      panX: (panStart.current?.basePanX ?? 0) + dx,
      panY: (panStart.current?.basePanY ?? 0) + dy
    }));
  }, []);

  const onPanPointerUp = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (panStart.current === null) return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    panStart.current = null;
    setIsPanning(false);
  }, []);

  const canvasStyle: { width: string; height: string; transform: string } | null =
    fitSize === null
      ? null
      : {
          width: `${fitSize.width * state.scale}px`,
          height: `${fitSize.height * state.scale}px`,
          transform: `translate(${state.panX}px, ${state.panY}px)`
        };

  // fitPct = canvas-CSS-width-at-fit / actual-CSS-width × 100
  //        = fit.width / (imageWidth / DPR) × 100
  // displayPct = fitPct × scale
  const fitPct =
    fitSize === null ? null : (fitSize.width * devicePixelRatio) / imageWidthPx * 100;
  const displayPct = fitPct === null ? null : fitPct * state.scale;

  return {
    state,
    mode,
    fitPct,
    displayPct,
    canvasStyle,
    resetToFit,
    actualSize,
    setCustomPct,
    zoomBy,
    spaceHeld,
    isPanning,
    onWheel,
    onGestureStart,
    onGestureChange,
    onGestureEnd,
    onPanPointerDown,
    onPanPointerMove,
    onPanPointerUp
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
