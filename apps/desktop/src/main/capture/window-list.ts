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
  /** True when this entry is the frontmost-in-z-order window owned by
   *  its pid. Helper-side flag — the first hit per pid in the front-
   *  to-back walk. Used to demote auxiliary panels (toolbars,
   *  popovers) that share the pid of the user-visible main window. */
  isFrontmostInApp: boolean;
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
 * Activate (bring to front) the running application identified by
 * `pid`. Used by the region selector to restore the previously-
 * frontmost app after a cancel or commit, without resorting to
 * `app.hide()` (which has the side effect of unhiding ALL our
 * windows on the next show — popping the library on top of the
 * user's actual workspace).
 *
 * Best-effort. If the pid is no longer running or activation is
 * refused by the OS, the helper exits 0 quietly. The caller path
 * has nothing useful to do with the failure either way.
 */
export async function activateApp(pid: number): Promise<void> {
  const helper = resolveHelperPath();
  if (helper === null) return;
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    await execFileAsync(helper, ["--activate-pid", String(pid)], {
      timeout: 1_500,
      maxBuffer: 1024
    });
  } catch (cause) {
    log.warn("activateApp helper failed", {
      pid,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

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

/**
 * Process IDs belonging to PwrSnap itself (main process + every
 * renderer process spawned by Electron).
 *
 * NOTE: pid-based exclusion is too coarse on macOS — CGWindow's
 * `kCGWindowOwnerPID` is the app's main process pid for ALL its
 * NSWindows, including DevTools and any helper / inspector / modal.
 * Filtering everything with our pid means the user can't snap to
 * DevTools (which they'd legitimately want to capture for bug
 * reports). Use `selfWindowBoundsList()` instead — it yields the
 * bounds of just our user-facing BrowserWindows so we can match by
 * bounds, leaving DevTools and other auxiliary windows snappable.
 */
export function selfPidSet(): Set<number> {
  return new Set<number>([process.pid]);
}

/**
 * Bounds of every user-facing BrowserWindow PwrSnap owns. Used as
 * the canonical "these specific windows are ours" filter — anything
 * with the same pid but DIFFERENT bounds is something we don't
 * directly control (DevTools, system modals attached to our app)
 * and is fair game as a snap target.
 *
 * We compare bounds with a small tolerance (±2 px) because
 * CGWindowList sometimes returns sub-pixel rounded values and
 * `BrowserWindow.getBounds()` returns CSS-rounded ones.
 */
export function selfWindowBoundsList(): { x: number; y: number; width: number; height: number }[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as typeof import("electron");
    return electron.BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.isVisible())
      .map((w) => w.getBounds());
  } catch {
    return [];
  }
}

/** True when bounds `a` matches `b` within ±tol pixels on every edge. */
export function boundsApproxEqual(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  tol = 2
): boolean {
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol &&
    Math.abs(a.height - b.height) <= tol
  );
}
