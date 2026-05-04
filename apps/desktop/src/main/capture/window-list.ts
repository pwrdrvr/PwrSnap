// TypeScript wrapper around the bundled `window-list` Swift helper.
//
// The helper enumerates on-screen windows (across every app) with
// their bounds in global virtual coords + their app's bundle id. We
// use it for two things:
//
//   1. Snap-to-window in the region selector (⇧ hover) — main pre-
//      fetches the list when the selector is shown and ships it to
//      the renderer so hit-testing happens locally with no IPC
//      round-trip per mouse move.
//   2. Source-app metadata at capture time — the capture handler
//      finds the window that owns the captured rect's center and
//      backfills `captures.source_app_bundle_id` + `source_app_name`.
//
// The helper is a tiny Swift CLI compiled at install time by
// `apps/desktop/scripts/build-native.mjs`. In dev it lives at
// `<desktopRoot>/build/native/window-list`; in a packaged .app it's
// shipped under `Contents/Resources/PwrSnapWindowList` via the
// `extraResources` entry in `electron-builder.yml`. Resolver below
// tries production path first, falls back to dev path.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { getMainLogger } from "../log";

const execFileAsync = promisify(execFile);
const log = getMainLogger("pwrsnap:window-list");

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type WindowInfo = {
  windowId: number;
  pid: number;
  bundleId: string | null;
  appName: string | null;
  title: string | null;
  bounds: WindowBounds;
  layer: number;
  alpha: number;
};

let cachedHelperPath: string | null = null;

function resolveHelperPath(): string | null {
  if (cachedHelperPath !== null) return cachedHelperPath;
  if (process.platform !== "darwin") return null;

  // Production: shipped under Contents/Resources/.
  const productionPath = join(process.resourcesPath, "PwrSnapWindowList");
  if (existsSync(productionPath)) {
    cachedHelperPath = productionPath;
    return productionPath;
  }
  // Dev: built into apps/desktop/build/native/.
  // __dirname at runtime (after electron-vite build) is
  // apps/desktop/out/main; the native build dir is two levels up.
  const devPath = join(__dirname, "..", "..", "build", "native", "window-list");
  if (existsSync(devPath)) {
    cachedHelperPath = devPath;
    return devPath;
  }
  // Last-ditch: when running tests directly via Playwright we may
  // be in apps/desktop already (cwd-based).
  const cwdPath = join(app.getAppPath(), "build", "native", "window-list");
  if (existsSync(cwdPath)) {
    cachedHelperPath = cwdPath;
    return cwdPath;
  }
  return null;
}

let warned = false;

/**
 * Enumerate the live on-screen windows. Returns an empty array when
 * the helper isn't available (Linux/Windows, or a dev environment
 * where build-native.mjs hasn't run). Logs once at warn level so
 * we notice in dev but don't spam the log on every call.
 *
 * Latency: ~30-50ms cold per call. Caller should cache for the
 * duration of a single user interaction (e.g. one ⌘⇧P session).
 */
export async function listWindows(): Promise<WindowInfo[]> {
  const helper = resolveHelperPath();
  if (helper === null) {
    if (!warned) {
      log.warn("native window-list helper not found — features dependent on it will degrade", {
        platform: process.platform
      });
      warned = true;
    }
    return [];
  }
  try {
    const { stdout } = await execFileAsync(helper, [], {
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as WindowInfo[];
  } catch (cause) {
    log.warn("window-list helper failed", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return [];
  }
}

/**
 * Find the topmost window that contains the given point.
 * `windows` is expected to be the result of `listWindows()` — the
 * helper returns windows in z-order (frontmost first), so a
 * straightforward linear scan finds the topmost owner.
 */
export function findWindowAt(
  windows: readonly WindowInfo[],
  x: number,
  y: number
): WindowInfo | null {
  for (const w of windows) {
    const { bounds: b } = w;
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      return w;
    }
  }
  return null;
}
