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
