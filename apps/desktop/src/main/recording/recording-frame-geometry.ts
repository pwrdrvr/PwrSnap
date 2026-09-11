// Where to put the recording-frame window, and how much of the glow
// band survived on each side. Pure — no Electron import, no
// `process.platform` read — so every branch is exercisable on every CI
// platform, which matters because the Windows branch is the one that
// keeps us out of the user's file and macOS CI would never run it.
//
// COORDINATE SPACES: `rect` is DISPLAY-LOCAL (what `RecordingState.rect`
// carries), `bounds` comes back GLOBAL (what `BrowserWindow.setBounds`
// wants). See the canonical note at the head of `capture/rect-overlap.ts`
// before touching the arithmetic here.

import type { RecordingFrameMode } from "@pwrsnap/shared";

/**
 * Outward extent of the glow in logical px — how far past the rect the
 * falloff still puts ink on screen. The window is inflated by this on
 * every side; anything the band needs beyond it is clipped by the
 * window, not by the display.
 *
 * Derived from the largest outer shadow in `recording-frame.css`
 * (`0 0 30px 9px` → spread 9 + blur/2 15 = 24), plus 2px of slack.
 * **Keep the two in step** — a CSS change that widens the falloff past
 * this silently gets a hard edge where the window ends.
 */
export const RECORDING_FRAME_BAND_PX = 26;

/**
 * Below this the frame is more obstruction than information: the four
 * corner ticks would meet and the glow would swamp the content.
 */
const MIN_RECT_PX = 16;

export type RecordingFrameDisplay = {
  bounds: { x: number; y: number; width: number; height: number };
};

export type RecordingFramePlan = {
  /** GLOBAL logical px, ready for `BrowserWindow.setBounds`. */
  bounds: { x: number; y: number; width: number; height: number };
  /** CSS px from each window edge to the recorded rect. */
  inset: { left: number; top: number; right: number; bottom: number };
  mode: RecordingFrameMode;
};

/**
 * `null` means **draw nothing** — either the rect is too small to frame,
 * or we are on an outset platform with no room outside it (a
 * full-display recording), where the only remaining option would be to
 * paint inside the capture.
 */
export function planRecordingFrame(input: {
  /** Display-local logical px. `w`/`h` of 0 means "the whole display",
   *  which is what `subjectToPhysicalRect` emits for a display subject. */
  rect: { x: number; y: number; w: number; h: number };
  display: RecordingFrameDisplay;
  platform: NodeJS.Platform;
}): RecordingFramePlan | null {
  const { display, platform } = input;
  const fullDisplay = input.rect.w <= 0 || input.rect.h <= 0;
  const rect = fullDisplay
    ? { x: 0, y: 0, w: display.bounds.width, h: display.bounds.height }
    : {
        x: Math.round(input.rect.x),
        y: Math.round(input.rect.y),
        w: Math.round(input.rect.w),
        h: Math.round(input.rect.h)
      };

  if (rect.w < MIN_RECT_PX || rect.h < MIN_RECT_PX) return null;

  // macOS is the only platform that can hide a window from the recorder
  // it is running, so it is the only one allowed to paint inside the
  // rect. Everything else gets the strictly-outside posture.
  const mode: RecordingFrameMode = platform === "darwin" ? "straddle" : "outset";

  const globalX = display.bounds.x + rect.x;
  const globalY = display.bounds.y + rect.y;

  // Inflate by the band, then clamp to THIS display. Clamping matters
  // twice over: a neighbouring display would otherwise get a stripe of
  // orange along its edge, and on a single display the band would
  // extend past the virtual screen and be dropped by the window server
  // anyway.
  const left = Math.max(display.bounds.x, globalX - RECORDING_FRAME_BAND_PX);
  const top = Math.max(display.bounds.y, globalY - RECORDING_FRAME_BAND_PX);
  const right = Math.min(
    display.bounds.x + display.bounds.width,
    globalX + rect.w + RECORDING_FRAME_BAND_PX
  );
  const bottom = Math.min(
    display.bounds.y + display.bounds.height,
    globalY + rect.h + RECORDING_FRAME_BAND_PX
  );

  const inset = {
    left: globalX - left,
    top: globalY - top,
    right: right - (globalX + rect.w),
    bottom: bottom - (globalY + rect.h)
  };

  // No band on any side and no permission to paint inward — a
  // full-display recording on Windows or Linux. Drawing the frame here
  // would put tangerine in every frame of the user's MP4, so we draw
  // nothing and let the HUD carry the signal alone.
  if (
    mode === "outset" &&
    inset.left === 0 &&
    inset.top === 0 &&
    inset.right === 0 &&
    inset.bottom === 0
  ) {
    return null;
  }

  return {
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    inset,
    mode
  };
}

/** Collapse the recording lifecycle onto the three states the frame has. */
export function recordingFramePhaseFor(
  phase: string
): "arming" | "recording" | "stopping" | null {
  switch (phase) {
    case "preflight":
    case "countdown":
    case "starting":
      return "arming";
    case "recording":
      return "recording";
    case "stopping":
    case "processing":
      return "stopping";
    default:
      return null;
  }
}
