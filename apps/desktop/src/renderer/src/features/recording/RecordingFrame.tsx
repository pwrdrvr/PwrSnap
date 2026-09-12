// The recording frame's renderer. Deliberately dumb: main owns the
// geometry (`main/recording/recording-frame-geometry.ts`) because only
// main knows which display the window was clamped against, so this file
// positions one box at the insets it is handed and flips two data
// attributes. Nothing here needs to know about coordinate spaces,
// displays, or platforms.
//
// Renders nothing until the first layout arrives — main replays it on
// `did-finish-load`, so there is no snapshot fetch to race.

import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { EVENT_CHANNELS, type RecordingFrameLayout } from "@pwrsnap/shared";

/** Corner ticks at their full size. This file is the only authority —
 *  the stylesheet reads `--psrf-corner` with no fallback. */
const CORNER_MAX_PX = 17;
const CORNER_MIN_PX = 8;

/**
 * Ticks are a quarter of the recorded rect's short side, capped. Without
 * the cap a small region gets four ticks that meet in the middle and
 * read as a solid border; without the floor they disappear entirely.
 */
function cornerSizeFor(shortSidePx: number): number {
  return Math.max(CORNER_MIN_PX, Math.min(CORNER_MAX_PX, Math.floor(shortSidePx / 4)));
}

export function RecordingFrame(): ReactElement | null {
  const [layout, setLayout] = useState<RecordingFrameLayout | null>(null);
  // The window's own content box. Derived rather than measured: the rect
  // is `innerWidth - inset.left - inset.right` by construction, and a
  // layout measure here would be the only thing in this file that could
  // be wrong.
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });

  useEffect(() => {
    const off = window.pwrsnapApi?.on(EVENT_CHANNELS.recordingFrame, (payload) => {
      setLayout(payload as RecordingFrameLayout);
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    // Main re-plans and calls setBounds if the recorded display changes
    // resolution mid-session. Re-read rather than trusting the value
    // captured at mount.
    const onResize = (): void => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (layout === null) return null;

  const { inset, mode, phase } = layout;
  const rectWidth = Math.max(0, viewport.width - inset.left - inset.right);
  const rectHeight = Math.max(0, viewport.height - inset.top - inset.bottom);

  const style = {
    "--psrf-left": `${inset.left}px`,
    "--psrf-top": `${inset.top}px`,
    "--psrf-right": `${inset.right}px`,
    "--psrf-bottom": `${inset.bottom}px`,
    "--psrf-corner": `${cornerSizeFor(Math.min(rectWidth, rectHeight))}px`
  } as CSSProperties;

  return (
    <div
      className="psrf"
      style={style}
      data-mode={mode}
      data-phase={phase}
      data-testid="recording-frame"
      // Decorative. The spoken announcement that a recording is running
      // belongs to the HUD, which is the surface that can be focused and
      // acted on; a second live region here would double every
      // transition for a screen-reader user.
      aria-hidden="true"
    >
      <div className="psrf__glow" />
      <div className="psrf__edge" />
      <div className="psrf__corner" data-corner="tl" />
      <div className="psrf__corner" data-corner="tr" />
      <div className="psrf__corner" data-corner="bl" />
      <div className="psrf__corner" data-corner="br" />
    </div>
  );
}
