// Zoom + pan state for the Editor canvas. Applied as a CSS transform
// on the canvas element so the image + SVG overlays + text-draft
// input all scale together.
//
// Default: fit-to-window (scale = 1, no pan), matching the pre-existing
// "image fills the viewport via aspect-ratio + max-width/height" layout.
// Zooming in lets the user inspect detail; zooming out makes a giant
// capture's overlays easier to place precisely.
//
// Pinch-to-zoom on macOS trackpads arrives as `wheel` events with
// `event.ctrlKey === true` (a Chromium / Cocoa convention — neither
// the user nor any code actually held ctrl; the OS rewrites the
// gesture into a synthetic ctrl+wheel). That's the only way the
// renderer sees a trackpad pinch.
//
// Drag-to-pan is enabled when scale > 1. Space+drag pans regardless
// of the active tool (Photoshop convention) so the user can reposition
// without leaving Arrow / Rect / etc.

import { useCallback, useEffect, useRef, useState } from "react";

export type ZoomPanState = {
  scale: number;
  panX: number;
  panY: number;
};

export const FIT_TO_WINDOW: ZoomPanState = { scale: 1, panX: 0, panY: 0 };
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const KEYBOARD_STEP = 1.25; // ⌘+ / ⌘- multiplier
const WHEEL_STEP_BASE = 1.0025; // exponent base for trackpad wheel; ~1% per tick

export type UseZoomPanResult = {
  state: ZoomPanState;
  /** Apply as inline style on the zoom container. Anchored to center. */
  transformStyle: { transform: string; transformOrigin: string };
  /** Fit-to-window reset (⌘0). */
  resetToFit: () => void;
  /** 1:1 pixel mapping (⌘1). Accounts for devicePixelRatio so a
   *  Retina capture renders at OS-level 1:1 inside the viewport. */
  actualSize: () => void;
  /** ⌘+ */
  zoomIn: () => void;
  /** ⌘- */
  zoomOut: () => void;
  /** Whether space is held — caller uses this to suppress the active
   *  tool's drag handler and pan instead. */
  spaceHeld: boolean;
  /** Whether a pan drag is in progress. Caller can show a grabbing cursor. */
  isPanning: boolean;
  /** Wheel handler — attach to the zoom container. Handles both
   *  pinch (ctrlKey=true) and standard wheel-scroll. */
  onWheel: (event: WheelEvent) => void;
  /** Pan handlers — attach to the zoom container when scale > 1 OR
   *  spaceHeld is true. */
  onPanPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPanPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPanPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
};

export function useZoomPan(opts: {
  /** Multiplier applied to actualSize() output — typically devicePixelRatio
   *  (so Retina captures display at OS-1:1 instead of CSS-1:1). */
  devicePixelRatio?: number;
  /** Image's intrinsic pixel dimensions, used for actualSize math.
   *  Without this we can't compute "1 image pixel = 1 screen pixel". */
  imageWidthPx: number;
  imageHeightPx: number;
  /** Container size in CSS pixels — needed because the image is
   *  rendered via object-fit:contain at the container's natural size.
   *  actualSize() solves for scale such that the rendered image equals
   *  imageWidthPx × imageHeightPx (or × devicePixelRatio for Retina). */
  containerRef: React.RefObject<HTMLElement | null>;
}): UseZoomPanResult {
  const { devicePixelRatio = 1, imageWidthPx, imageHeightPx, containerRef } = opts;
  const [state, setState] = useState<ZoomPanState>(FIT_TO_WINDOW);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);

  const resetToFit = useCallback(() => setState(FIT_TO_WINDOW), []);

  const actualSize = useCallback(() => {
    // Solve for scale such that scale × renderedImageCSSWidth ===
    // imageWidthPx × devicePixelRatio (Retina: image CSS px × dpr =
    // OS device px). renderedImageCSSWidth comes from the container's
    // current size + aspect-ratio + object-fit:contain.
    const container = containerRef.current;
    if (container === null) return;
    const rect = container.getBoundingClientRect();
    // Image renders at: object-fit:contain inside the container, so
    // its CSS dimensions are bounded by the container in the limiting
    // axis. Compute the actual rendered CSS-px width / height:
    const containerAspect = rect.width / rect.height;
    const imageAspect = imageWidthPx / imageHeightPx;
    const renderedCssWidth =
      containerAspect > imageAspect ? rect.height * imageAspect : rect.width;
    if (renderedCssWidth <= 0) return;
    const targetCssWidth = imageWidthPx / devicePixelRatio;
    const targetScale = targetCssWidth / renderedCssWidth;
    setState({
      scale: clamp(targetScale, MIN_SCALE, MAX_SCALE),
      panX: 0,
      panY: 0
    });
  }, [containerRef, imageWidthPx, imageHeightPx, devicePixelRatio]);

  const zoomIn = useCallback(() => {
    setState((prev) => ({
      ...prev,
      scale: clamp(prev.scale * KEYBOARD_STEP, MIN_SCALE, MAX_SCALE)
    }));
  }, []);

  const zoomOut = useCallback(() => {
    setState((prev) => ({
      ...prev,
      scale: clamp(prev.scale / KEYBOARD_STEP, MIN_SCALE, MAX_SCALE)
    }));
  }, []);

  const onWheel = useCallback((event: WheelEvent): void => {
    // macOS pinch arrives as ctrlKey-rewritten wheel deltaY. Standard
    // wheel-scroll (mouse wheel, two-finger trackpad scroll) is NOT
    // a zoom — let it bubble to the container's native scroll. Only
    // intercept when ctrlKey is set (pinch) or when meta+wheel.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setState((prev) => {
      // deltaY is negative when pinching out (zoom in) by Cocoa
      // convention. Use exponential scaling so each tick is a
      // multiplicative delta — feels linear in user perception.
      const factor = WHEEL_STEP_BASE ** -event.deltaY;
      return {
        ...prev,
        scale: clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE)
      };
    });
  }, []);

  // Listen for Space keydown / keyup so the caller can switch to pan
  // mode without changing the active tool.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.code !== "Space") return;
      // Don't grab Space when a text input has focus — the user might
      // be typing in the text-overlay input or the detail rail.
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
      // Pan only when zoomed in OR space is held.
      if (state.scale <= 1 && !spaceHeld) return;
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      setIsPanning(true);
      panStart.current = {
        x: event.clientX,
        y: event.clientY,
        baseX: state.panX,
        baseY: state.panY
      };
    },
    [state.panX, state.panY, state.scale, spaceHeld]
  );

  const onPanPointerMove = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (panStart.current === null) return;
    const dx = event.clientX - panStart.current.x;
    const dy = event.clientY - panStart.current.y;
    setState((prev) => ({
      ...prev,
      panX: panStart.current!.baseX + dx,
      panY: panStart.current!.baseY + dy
    }));
  }, []);

  const onPanPointerUp = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (panStart.current === null) return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    panStart.current = null;
    setIsPanning(false);
  }, []);

  const transformStyle = {
    transform: `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`,
    transformOrigin: "center center"
  };

  return {
    state,
    transformStyle,
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
