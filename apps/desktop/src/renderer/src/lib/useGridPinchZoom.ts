import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// Trackpad / mouse pinch-to-zoom for the Library grid. Translates the
// macOS pinch event streams into discrete +/-1 "snap" steps, which the
// caller maps onto adjacent GRID_ZOOM_LEVELS (see ./gridZoom.ts).
//
// macOS delivers pinch two ways, and which one fires depends on Chromium
// version + system settings (the same uncertainty the editor's useZoomPan
// documents):
//   • `gesturestart` / `gesturechange` / `gestureend` — WebKit-style,
//     usually the PRIMARY signal; `event.scale` is the cumulative pinch
//     factor since gesturestart.
//   • `wheel` with ctrlKey/metaKey — Chromium synthesizes these from
//     trackpad pinch on some configs; ctrl/cmd+wheel is also a mouse path.
//
// We handle BOTH, but source-lock to the gesture stream while it's active
// (plus a short grace window after it ends) so a machine that fires both
// for one physical pinch doesn't double-count and skip levels.
//
// This hook only EMITS steps; it never page-zooms. The browser's own
// visual zoom is suppressed app-wide by usePreventBrowserZoom; we also
// preventDefault here so the hook is self-sufficient if used in isolation.
// Un-modified wheel (plain two-finger scroll) is left completely alone so
// the grid still scrolls.

/** Accumulated `-deltaY` (zoom-in positive) needed to advance one level
 *  on the wheel path. Tuned for trackpad pinch, where each synthesized
 *  ctrl+wheel event carries a small delta. */
const WHEEL_PINCH_STEP_PX = 20;

/** Cumulative gesture `scale` ratio needed to advance one level on the
 *  gesture path. 1.15 ≈ a modest pinch per level. */
const GESTURE_PINCH_RATIO = 1.15;

/** After `gestureend`, ignore wheel pinch for this long to swallow any
 *  trailing synthesized ctrl+wheel momentum from the same gesture. */
const GESTURE_TAIL_GRACE_MS = 200;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/**
 * Attach pinch-to-zoom handlers to `scrollElement`. `onStep(+1)` means
 * zoom in (bigger thumbnails / fewer columns); `onStep(-1)` means zoom
 * out. The handler is read through a ref, so passing a fresh closure each
 * render does NOT re-attach listeners.
 */
export function useGridPinchZoom(
  scrollElement: RefObject<HTMLElement | null>,
  onStep: (direction: 1 | -1) => void
): void {
  const onStepRef = useRef(onStep);
  useEffect(() => {
    onStepRef.current = onStep;
  }, [onStep]);

  useEffect(() => {
    const el = scrollElement.current;
    if (el === null) return;

    let wheelAcc = 0;
    let gestureActive = false;
    let gestureBaselineScale = 1;
    let gestureEndedAt = -Infinity;

    const emit = (direction: 1 | -1): void => {
      onStepRef.current(direction);
    };

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return; // plain scroll — ignore
      // Don't double-count: the gesture stream owns the pinch while it's
      // active and briefly after it ends.
      if (gestureActive || now() - gestureEndedAt < GESTURE_TAIL_GRACE_MS) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const inc = -event.deltaY; // zoom-in positive
      // Reset on direction reversal so flipping pinch direction responds
      // immediately rather than first draining the opposite accumulation.
      if (wheelAcc !== 0 && Math.sign(inc) !== Math.sign(wheelAcc)) {
        wheelAcc = 0;
      }
      wheelAcc += inc;
      while (wheelAcc >= WHEEL_PINCH_STEP_PX) {
        wheelAcc -= WHEEL_PINCH_STEP_PX;
        emit(1);
      }
      while (wheelAcc <= -WHEEL_PINCH_STEP_PX) {
        wheelAcc += WHEEL_PINCH_STEP_PX;
        emit(-1);
      }
    };

    const onGestureStart = (event: Event): void => {
      event.preventDefault();
      gestureActive = true;
      gestureBaselineScale = readScale(event);
      wheelAcc = 0;
    };
    const onGestureChange = (event: Event): void => {
      event.preventDefault();
      const scale = readScale(event);
      // Step while the cumulative scale has moved a full ratio from the
      // last-stepped baseline. A fast pinch fires many change events, so
      // multi-level moves happen naturally without per-event multi-step.
      while (scale / gestureBaselineScale >= GESTURE_PINCH_RATIO) {
        gestureBaselineScale *= GESTURE_PINCH_RATIO;
        emit(1);
      }
      while (gestureBaselineScale / scale >= GESTURE_PINCH_RATIO) {
        gestureBaselineScale /= GESTURE_PINCH_RATIO;
        emit(-1);
      }
    };
    const onGestureEnd = (event: Event): void => {
      event.preventDefault();
      gestureActive = false;
      gestureEndedAt = now();
      gestureBaselineScale = 1;
    };

    // passive: false so preventDefault is honored. Listeners attach in
    // the bubble phase (default); we never stopPropagation, so nothing
    // downstream is starved.
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    el.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [scrollElement]);
}

/** Read the WebKit `scale` off a gesture event (not in the standard DOM
 *  lib). Falls back to 1 (no movement) when absent. */
function readScale(event: Event): number {
  const s = (event as Event & { scale?: number }).scale;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1;
}
