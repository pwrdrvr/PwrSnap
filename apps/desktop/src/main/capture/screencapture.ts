// Thin wrapper around `/usr/sbin/screencapture` for region capture.
// CLI stays the right call for one-shot stills even after Phase 5
// switches video to ScreenCaptureKit — the CLI is faster cold (~70ms)
// than SCKit's framework load (~120ms) and handles HDR tone-mapping +
// retina backing-scale + cursor exclusion for free.
//
// Validates rect+displayId against `screen.getAllDisplays()` before
// shelling out — never lets unvalidated renderer-supplied geometry
// reach a child_process invocation.
//
// Uses execFile (NOT exec / shell:true) so user-controlled coords
// can never inject shell metacharacters.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { desktopCapturer, screen, type Display } from "electron";
import sharp from "sharp";
import { getMainLogger } from "../log";
import { classifyCaptureError } from "./permissions";

const log = getMainLogger("pwrsnap:screencapture");

const execFileAsync = promisify(execFile);

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Grab a whole display as a PNG buffer via Electron's `desktopCapturer`
 * — the cross-platform screen-grab path used on Windows/Linux where the
 * macOS `/usr/sbin/screencapture` CLI doesn't exist. Returns physical
 * pixels (the monitor's native resolution). Throws on failure.
 *
 * desktopCapturer runs in the main process and, like the macOS path,
 * needs no native helper. On Windows there's no TCC-style permission
 * gate, so a failure here is a plain error rather than a "revoked".
 */
async function captureDisplayPng(display: Display): Promise<Buffer> {
  // Request the display's physical size so we don't downscale a HiDPI
  // monitor. desktopCapturer treats this as a max and returns the
  // screen's native pixels (so the actual buffer may differ slightly —
  // callers derive the crop scale from the returned dimensions, not
  // from scaleFactor, to stay robust).
  const width = Math.max(1, Math.round(display.bounds.width * display.scaleFactor));
  const height = Math.max(1, Math.round(display.bounds.height * display.scaleFactor));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height }
  });
  // Electron tags screen sources with `display_id` (the string form of
  // Display.id). Match on it; fall back to display index, then first.
  let source = sources.find((s) => s.display_id === String(display.id));
  if (source === undefined) {
    const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
    source = (idx >= 0 ? sources[idx] : undefined) ?? sources[0];
  }
  if (source === undefined) {
    throw new Error("desktopCapturer returned no screen sources");
  }
  const png = source.thumbnail.toPNG();
  if (png.length === 0) {
    throw new Error("desktopCapturer screen thumbnail was empty");
  }
  return png;
}

/**
 * Result of a region capture attempt. Caller awaits `tempPath` and
 * passes it into `source-store.putCaptureSource`. On success, the
 * file at `tempPath` is owned by the caller — they should rename or
 * delete it.
 */
export type CaptureRegionResult =
  | { ok: true; tempPath: string; displayId: number }
  | { ok: false; reason: "revoked" | "cancelled" | "error" | "validation"; message: string };

/**
 * Validate a renderer-supplied rect against the current display
 * configuration. Rejects:
 *   • non-finite numbers
 *   • zero or negative dimensions
 *   • rects outside the named display's bounds
 *   • unknown display ids
 */
function validateRect(rect: Rect, displayId: number): { valid: boolean; message: string } {
  for (const key of ["x", "y", "w", "h"] as const) {
    const v = rect[key];
    if (!Number.isFinite(v)) {
      return { valid: false, message: `rect.${key} is not finite: ${v}` };
    }
  }
  if (rect.w <= 0 || rect.h <= 0) {
    return { valid: false, message: `rect.w and rect.h must be positive` };
  }

  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) {
    return { valid: false, message: `unknown display id: ${displayId}` };
  }
  const { bounds } = display;
  // screencapture -R takes coordinates in the global virtual coordinate
  // space (top-left origin), so we need rect to fit inside display.bounds.
  if (
    rect.x < bounds.x ||
    rect.y < bounds.y ||
    rect.x + rect.w > bounds.x + bounds.width ||
    rect.y + rect.h > bounds.y + bounds.height
  ) {
    return {
      valid: false,
      message: `rect ${JSON.stringify(rect)} outside display bounds ${JSON.stringify(bounds)}`
    };
  }
  return { valid: true, message: "" };
}

/**
 * Capture a specific on-screen window by its CGWindowID, getting
 * the window's ACTUAL content even when occluded by other windows.
 *
 * Implementation: Electron's `desktopCapturer.getSources({ types:
 * ["window"] })`. Under the hood this goes through the same SCKit /
 * WindowServer path as a standalone Swift helper would — but
 * runs in the Electron MAIN process. Crucial difference: the TCC
 * Screen Recording grant attaches to the calling binary, and
 * Electron (a real GUI app) is recognized by macOS where a CLI
 * Swift helper is not. So this works in dev without ad-hoc
 * signing acrobatics + the user only has to grant Screen Recording
 * to the Electron / .app once (already done if regular captures
 * have ever worked).
 *
 * Source id format from desktopCapturer is `window:<cgWindowID>:N`
 * — we match by the numeric prefix to find our snap target. The
 * thumbnail returned is at the requested size (we ask for a
 * generously-sized one so we don't accidentally downscale a
 * Retina window).
 *
 * Fallback: if desktopCapturer doesn't surface the window
 * (uncommon — usually means the window has gone away between
 * pickRegion and capture), fall back to `screencapture -l <id>`.
 * Won't ignore occlusion but at least produces SOMETHING.
 *
 * Caller path: when the user holds ⇧ at commit time on a window
 * snap target, pickRegion sets both `snappedWindowId` and
 * `fullWindow: true`; capture-handlers routes here. The default
 * (no ⇧) goes through `captureRegion`.
 */
export async function captureWindow(
  windowId: number
): Promise<CaptureRegionResult> {
  if (!Number.isInteger(windowId) || windowId <= 0) {
    return {
      ok: false,
      reason: "validation",
      message: `invalid windowId: ${windowId}`
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-"));
  const tempPath = join(dir, `${Date.now()}.png`);

  // Primary: desktopCapturer in the main process. Inherits
  // Electron's Screen Recording TCC grant — no separate helper
  // TCC entry needed. With the ScreenCaptureKitMac feature flag
  // (enabled in bootstrap), the captures go through SCKit's
  // backing-buffer pipeline and ignore occlusion.
  try {
    // Generous thumbnail size — we want native-pixel resolution
    // for retina windows. desktopCapturer downscales if necessary
    // but won't upscale.
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 4096, height: 4096 }
    });
    const source = sources.find((s) => {
      // Format: `window:<cgWindowID>:<N>`
      const match = /^window:(\d+):/.exec(s.id);
      return match !== null && Number(match[1]) === windowId;
    });
    log.info("desktopCapturer attempt", {
      windowId,
      sourceCount: sources.length,
      matchedSourceId: source?.id ?? null,
      thumbnailSize: source?.thumbnail.getSize() ?? null,
      thumbnailEmpty: source?.thumbnail.isEmpty() ?? null,
      sourceIds: sources.slice(0, 10).map((s) => ({ id: s.id, name: s.name }))
    });
    if (source !== undefined) {
      const png = source.thumbnail.toPNG();
      if (png.length > 0) {
        await writeFile(tempPath, png);
        log.info("desktopCapturer wrote PNG", {
          windowId,
          tempPath,
          byteSize: png.length
        });
        return { ok: true, tempPath, displayId: 0 };
      }
    }
    log.warn("desktopCapturer didn't surface the requested window — falling back", {
      windowId
    });
  } catch (cause) {
    log.warn("desktopCapturer threw — falling back", {
      windowId,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }

  // Fallback: `screencapture -l <id>`. Captures the screen rect
  // around the window — overlaps included. Functionally similar
  // to a default rect capture, but at least the user gets the
  // window's bounds reflected in the output.
  const fallbackArgs = ["-x", "-l", String(windowId), "-o", "-t", "png", tempPath];
  try {
    await execFileAsync("/usr/sbin/screencapture", fallbackArgs, {
      timeout: 5_000
    });
    return { ok: true, tempPath, displayId: 0 };
  } catch (err) {
    const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const stderrStr = typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
    const reason = classifyCaptureError(
      typeof exitCode === "number" ? exitCode : 1,
      stderrStr
    );
    return {
      ok: false,
      reason,
      message: stderrStr || (err instanceof Error ? err.message : String(err))
    };
  }
}

/**
 * Capture an entire display to a temp PNG. The selector uses this on
 * show() to grab a frozen-in-time backing snapshot — the renderer
 * paints it as a full-window background, the user drags against the
 * snapshot, and the commit crops the snapshot rather than re-shooting
 * the live screen. This is the SnagIt-style "freeze the screen and
 * draw on top" model: immune to apps starting/stopping or windows
 * popping in/out during the selection.
 *
 * Bypasses validateRect — by definition we capture the whole display
 * the cursor is on, no user-supplied coords are involved.
 *
 * Returns the path to a PNG sized in PHYSICAL pixels (logical * scale).
 * Caller owns deletion via `releaseScreenSnapshot` once the selector
 * dismisses.
 */
export async function captureScreen(displayId: number): Promise<CaptureRegionResult> {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) {
    return { ok: false, reason: "validation", message: `unknown display id: ${displayId}` };
  }
  const { bounds } = display;

  // Non-macOS: grab the whole display via desktopCapturer (no screencapture CLI).
  if (process.platform !== "darwin") {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-screen-"));
    const tempPath = join(dir, `${Date.now()}.png`);
    try {
      await writeFile(tempPath, await captureDisplayPng(display));
      return { ok: true, tempPath, displayId };
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-screen-"));
  const tempPath = join(dir, `${Date.now()}.png`);
  // -R covers exactly this display's logical bounds. The output PNG
  // ends up at physical resolution (logical * device-pixel-ratio).
  const args = [
    "-x",
    "-R",
    `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
    "-t",
    "png",
    tempPath
  ];

  try {
    await execFileAsync("/usr/sbin/screencapture", args, { timeout: 5_000 });
    return { ok: true, tempPath, displayId };
  } catch (err) {
    const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const stderrStr = typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
    const reason = classifyCaptureError(typeof exitCode === "number" ? exitCode : 1, stderrStr);
    return {
      ok: false,
      reason,
      message: stderrStr || (err instanceof Error ? err.message : String(err))
    };
  }
}

/**
 * Capture a region. Returns a temp file path on success; caller is
 * responsible for moving / deleting the file.
 */
export async function captureRegion(
  rect: Rect,
  displayId: number
): Promise<CaptureRegionResult> {
  const validation = validateRect(rect, displayId);
  if (!validation.valid) {
    return { ok: false, reason: "validation", message: validation.message };
  }

  // Non-macOS: grab the display via desktopCapturer and crop the rect with
  // sharp. The rect is in global virtual *logical* coords (validateRect kept
  // it inside display.bounds); the captured PNG is physical pixels. Derive the
  // physical-per-logical scale from the actual returned dimensions rather than
  // assuming display.scaleFactor, then clamp the extract box to the image.
  if (process.platform !== "darwin") {
    const display = screen.getAllDisplays().find((d) => d.id === displayId);
    if (display === undefined) {
      return { ok: false, reason: "validation", message: `unknown display id: ${displayId}` };
    }
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-"));
    const tempPath = join(dir, `${Date.now()}.png`);
    try {
      const png = await captureDisplayPng(display);
      const meta = await sharp(png).metadata();
      const imgW = meta.width ?? Math.round(display.bounds.width * display.scaleFactor);
      const imgH = meta.height ?? Math.round(display.bounds.height * display.scaleFactor);
      const sx = imgW / display.bounds.width;
      const sy = imgH / display.bounds.height;
      const rawLeft = Math.round((rect.x - display.bounds.x) * sx);
      const rawTop = Math.round((rect.y - display.bounds.y) * sy);
      const left = Math.max(0, Math.min(rawLeft, imgW - 1));
      const top = Math.max(0, Math.min(rawTop, imgH - 1));
      const width = Math.max(1, Math.min(Math.round(rect.w * sx), imgW - left));
      const height = Math.max(1, Math.min(Math.round(rect.h * sy), imgH - top));
      await writeFile(
        tempPath,
        await sharp(png).extract({ left, top, width, height }).png().toBuffer()
      );
      return { ok: true, tempPath, displayId };
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-"));
  const tempPath = join(dir, `${Date.now()}.png`);
  // -x suppresses the system shutter sound. -t png is explicit format.
  // -R x,y,w,h takes integer coords in display coord space.
  const args = [
    "-x",
    "-R",
    `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`,
    "-t",
    "png",
    tempPath
  ];

  try {
    await execFileAsync("/usr/sbin/screencapture", args, { timeout: 5_000 });
    return { ok: true, tempPath, displayId };
  } catch (err) {
    const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const stderrStr = typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
    const reason = classifyCaptureError(typeof exitCode === "number" ? exitCode : 1, stderrStr);
    return { ok: false, reason, message: stderrStr || (err instanceof Error ? err.message : String(err)) };
  }
}
