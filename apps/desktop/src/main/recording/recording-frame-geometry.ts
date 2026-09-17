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

import type { RecordingFrameMode, RecordingFramePhase, RecordingState } from "@pwrsnap/shared";

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
  /**
   * GLOBAL logical px with the menu bar / Dock / taskbar removed. On
   * macOS this is `NSScreen.visibleFrame`, which is not advice: AppKit
   * runs `-[NSWindow constrainFrameRect:toScreen:]` and MOVES any
   * window whose frame falls outside it. See `clampBox` below.
   */
  workArea: { x: number; y: number; width: number; height: number };
};

export type RecordingFramePlan = {
  /** GLOBAL logical px, ready for `BrowserWindow.setBounds`. */
  bounds: { x: number; y: number; width: number; height: number };
  /**
   * CSS px from each window edge to the recorded rect.
   *
   * **May be NEGATIVE**, and the renderer must keep honouring that: it
   * means the rect extends past the window on that side, because the
   * window was not allowed to reach it (a rect under the menu bar or
   * behind the Dock). The frame's box is still described relative to
   * the true rect and Chromium clips the overhang — which is the only
   * honest answer, and much better than moving the frame off the rect
   * to make every inset non-negative.
   */
  inset: { left: number; top: number; right: number; bottom: number };
  mode: RecordingFrameMode;
};

/**
 * The box the frame window may actually occupy, in GLOBAL logical px.
 *
 * **macOS: the work area, not the display.** `BrowserWindow` is not the
 * last word on where a window goes. AppKit runs
 * `-[NSWindow constrainFrameRect:toScreen:]` on show and MOVES any
 * window whose frame falls outside `NSScreen.visibleFrame` — the menu
 * bar at the top, the Dock at the bottom. It moves the ORIGIN and
 * leaves the SIZE alone, so an overlay asked to sit 26px above a
 * maximized window came back 26px below it, hanging off the bottom by
 * the same amount. Measured on macOS 26 / Electron 41.10.7, 30px menu
 * bar: `y=0 -> 30`, `y=4 -> 30`, `y=23 -> 30`, `y=600 h=500 -> y=491`
 * (pulled up off the Dock), `x=-50 -> 0`.
 *
 * Three traps, all of which cost real debugging time:
 *
 *   - `getBounds()` right after the constructor returns what we ASKED
 *     for. The move happens on `show()`, and `recording-frame.ts`
 *     treats the constructor bounds as placed — so nothing in main can
 *     observe the difference. Do not "verify" this with a read-back.
 *   - No window level escapes it. `floating`, `status`, `pop-up-menu`
 *     and `screen-saver` were all measured and all four were moved.
 *     (The region selector covers the menu bar via
 *     `setSimpleFullScreen`, which is a different mechanism entirely
 *     and far too heavy for a small overlay.)
 *   - AppKit only moves a window that FITS. One taller than the work
 *     area is left where it was asked — so a bug here reproduces on a
 *     small region and vanishes on a big one.
 *
 * **Everything else: the display.** There is no `constrainFrameRect`
 * off macOS, and the `outset` posture depends on every pixel of band
 * it can get — clamping to the work area there would cost glow around
 * a region near the taskbar to dodge a constraint that does not exist.
 */
function clampBox(
  display: RecordingFrameDisplay,
  platform: NodeJS.Platform
): { x: number; y: number; width: number; height: number } {
  return platform === "darwin" ? display.workArea : display.bounds;
}

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

  // Inflate by the band, then clamp to the box this window is ALLOWED
  // to occupy. Clamping matters three times over: a neighbouring
  // display would otherwise get a stripe of orange along its edge, a
  // band past the virtual screen is dropped by the window server
  // anyway, and on macOS a window placed outside the work area is not
  // refused — it is silently MOVED (see `clampBox`).
  const clamp = clampBox(display, platform);
  const left = Math.max(clamp.x, globalX - RECORDING_FRAME_BAND_PX);
  const top = Math.max(clamp.y, globalY - RECORDING_FRAME_BAND_PX);
  const right = Math.min(clamp.x + clamp.width, globalX + rect.w + RECORDING_FRAME_BAND_PX);
  const bottom = Math.min(clamp.y + clamp.height, globalY + rect.h + RECORDING_FRAME_BAND_PX);

  // Degenerate: the rect sits so far outside the clamp box that the
  // window would have no area at all. Unreachable with any real menu
  // bar, but a zero/negative-sized BrowserWindow is not something to
  // discover at the window server.
  if (right <= left || bottom <= top) return null;

  // Deliberately signed. A side whose band was clipped gives a smaller
  // inset; a side the window could not reach AT ALL gives a negative
  // one, and the renderer draws the box overhanging the window and lets
  // Chromium clip it. Both keep the drawn box ON the recorded rect,
  // which is the property that matters — see `RecordingFramePlan`.
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

/**
 * Collapse the recording lifecycle onto the three states the frame has.
 *
 * Exhaustive over `RecordingState["phase"]` with no `default` arm, the
 * same shape as `isRecordingActive`: a phase added later must be a
 * compile error here, not a silent "draw nothing" on the one surface
 * whose entire job is to say that pixels are being written.
 */
export function recordingFramePhaseFor(
  phase: RecordingState["phase"]
): RecordingFramePhase | null {
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
    case "idle":
    case "ready":
    case "failed":
      // Terminal. `failed` included on purpose: the HUD becomes an
      // actionable failure card, and a frame still hugging a rect
      // nothing is being written to would be a lie.
      return null;
  }
}
