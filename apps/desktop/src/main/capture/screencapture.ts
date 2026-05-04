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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { screen } from "electron";
import { classifyCaptureError } from "./permissions";
import { captureWindowImage } from "./window-list";

const execFileAsync = promisify(execFile);

export type Rect = { x: number; y: number; w: number; h: number };

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
 * Primary path: shells to our Swift helper which uses
 * SCScreenshotManager + SCContentFilter(desktopIndependentWindow:).
 * Why not `screencapture -l <id>`: empirically tested on macOS 14/15,
 * `-l` captures the SCREEN RECT around the window, including
 * anything visually on top of it. SCContentFilter goes through
 * WindowServer for the window's actual backing buffer, so the
 * captured PNG contains exactly the content the owning app
 * rendered — overlapping apps disappear from the image.
 *
 * Fallback path: `screencapture -l <id>`. SCKit needs Screen
 * Recording TCC granted to the HELPER binary specifically (not
 * just to the parent Electron). First run on a fresh dev build
 * usually fails until the user grants perms in System Settings.
 * We fall back to legacy capture so ⇧+click always produces an
 * image — it just won't have the occlusion magic until the user
 * grants the perm. Logged at warn level so dev mode notices.
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
  const sckitResult = await captureWindowImage(windowId, tempPath);
  if (sckitResult.ok) {
    return { ok: true, tempPath, displayId: 0 };
  }

  // SCKit fallback to `screencapture -l`. Won't ignore occlusion
  // (the user'll see overlapping windows in the image) but at
  // least ⇧+click produces SOMETHING while the user goes to
  // System Settings → Screen Recording to grant the helper.
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
      message:
        stderrStr ||
        (err instanceof Error ? err.message : String(err)) ||
        sckitResult.message
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
