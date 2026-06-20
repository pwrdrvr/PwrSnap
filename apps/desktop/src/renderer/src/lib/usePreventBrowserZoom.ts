import { useEffect } from "react";

/**
 * Block Chromium's built-in *visual* page zoom across the whole window.
 *
 * Why this exists: the preload calls
 * `webFrame.setVisualZoomLevelLimits(1, 3)` (see preload/index.ts) so
 * that macOS trackpad-pinch gestures are actually delivered to the
 * renderer — Electron drops the gesture stream entirely when visual
 * zoom is fully disabled, and the editor needs those events to drive
 * its own canvas zoom (see features/editor/useZoomPan.ts). The side
 * effect of arming visual zoom is that EVERY surface that does NOT
 * handle the gesture itself — the Library grid, settings, the tray
 * popover — lets a pinch trigger Chromium's *native* visual zoom: the
 * entire viewport magnifies, scrolling the left sidebar and the title
 * bar off-screen, and it does NOT snap back. That's the bug this guard
 * fixes.
 *
 * The editor opts INTO zoom by handling these same events itself and
 * mapping them onto a CSS transform. Everywhere else we want the
 * gesture to do nothing. So this guard sits at the window level and
 * calls `preventDefault` on the browser's visual-zoom triggers:
 *
 *   - `wheel` with ctrlKey/metaKey — Chromium synthesizes these from
 *     trackpad pinch on some configs; ctrl/cmd+wheel is also the
 *     page-zoom shortcut.
 *   - `gesturestart` / `gesturechange` / `gestureend` — the WebKit /
 *     Chromium-on-macOS pinch events, the PRIMARY pinch signal.
 *
 * Two invariants make this safe to mount globally, including over the
 * editor (which lives in the same window in Focus mode):
 *
 *   1. It NEVER calls `stopPropagation`, so the editor's own
 *      capture-phase zoom/pan handlers still receive every event and
 *      drive the canvas transform exactly as before. The editor's zoom
 *      is computed from `event.deltaY` / `event.scale`, not from the
 *      browser's default action, so suppressing the default action does
 *      not affect it.
 *   2. It NEVER touches un-modified `wheel` events, so plain two-finger
 *      scroll (grid scrolling, editor panning) is untouched — AND it
 *      avoids the trap documented in useZoomPan: calling preventDefault
 *      on every wheel event makes Chromium decide the page "owns" wheel
 *      handling and stop synthesizing the pinch gesture stream entirely.
 *
 * Keyboard zoom (Cmd +/-/0) is deliberately left alone — the editor
 * binds those for its own zoom.
 */
export function usePreventBrowserZoom(): void {
  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    };
    const onGesture = (event: Event): void => {
      event.preventDefault();
    };
    // passive: false so preventDefault is honored; capture: true so we
    // run before any non-capture listeners. We never stopPropagation,
    // so registration order vs the editor's capture listeners is
    // irrelevant — both always fire.
    const opts = { passive: false, capture: true } as const;
    window.addEventListener("wheel", onWheel, opts);
    window.addEventListener("gesturestart", onGesture, opts);
    window.addEventListener("gesturechange", onGesture, opts);
    window.addEventListener("gestureend", onGesture, opts);
    return () => {
      window.removeEventListener("wheel", onWheel, opts);
      window.removeEventListener("gesturestart", onGesture, opts);
      window.removeEventListener("gesturechange", onGesture, opts);
      window.removeEventListener("gestureend", onGesture, opts);
    };
  }, []);
}
