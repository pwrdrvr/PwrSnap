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
// The helper is a tiny native CLI compiled at install time by
// `apps/desktop/scripts/build-native.mjs`:
//   - macOS: a Swift binary `window-list` (full surface — list,
//     --activate-pid, --capture-window, --extract-app-icon).
//   - Windows: a C++ binary `window-list.exe`
//     (native/window-list-win/main.cpp) that implements only the
//     default LIST command. The macOS-only subcommands (window capture,
//     app-icon extraction, activate-pid) are not supported there and
//     their wrappers short-circuit before shelling out (see
//     `helperSupportsMacSubcommands`).
//
// In dev it lives at `<desktopRoot>/build/native/window-list[.exe]`; in
// a packaged build it's shipped under `Contents/Resources/
// PwrSnapWindowList` (macOS) / `resources\PwrSnapWindowList.exe`
// (Windows) via the `extraResources` entry in `electron-builder.yml`.
// Resolver below tries production path first, falls back to dev path.

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

/**
 * Platform-specific helper file names.
 *   - production resource: `PwrSnapWindowList` on macOS,
 *     `PwrSnapWindowList.exe` on Windows.
 *   - dev / build-native output: `window-list` on macOS,
 *     `window-list.exe` on Windows.
 */
const PRODUCTION_HELPER_NAME =
  process.platform === "win32" ? "PwrSnapWindowList.exe" : "PwrSnapWindowList";
const DEV_HELPER_NAME =
  process.platform === "win32" ? "window-list.exe" : "window-list";

/**
 * True when the resolved helper supports the macOS-only subcommands
 * (--capture-window / --extract-app-icon / --activate-pid). Only the
 * Swift helper implements them; the Windows C++ helper is list-only.
 * Callers of those features short-circuit on non-darwin so we never
 * shell the Windows .exe with an argument it doesn't understand.
 */
function helperSupportsMacSubcommands(): boolean {
  return process.platform === "darwin";
}

function resolveHelperPath(): string | null {
  if (cachedHelperPath !== null) return cachedHelperPath;
  // macOS (Swift) + Windows (C++) both ship a window-list helper; other
  // platforms have none.
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return null;
  }

  // Production: shipped under Contents/Resources/ (macOS) or
  // resources\ (Windows) via extraResources.
  const productionPath = join(process.resourcesPath, PRODUCTION_HELPER_NAME);
  if (existsSync(productionPath)) {
    cachedHelperPath = productionPath;
    return productionPath;
  }
  // Dev: built into apps/desktop/build/native/.
  // __dirname at runtime (after electron-vite build) is
  // apps/desktop/out/main; the native build dir is two levels up.
  const devPath = join(__dirname, "..", "..", "build", "native", DEV_HELPER_NAME);
  if (existsSync(devPath)) {
    cachedHelperPath = devPath;
    return devPath;
  }
  // Last-ditch: when running tests directly via Playwright we may
  // be in apps/desktop already (cwd-based).
  const cwdPath = join(app.getAppPath(), "build", "native", DEV_HELPER_NAME);
  if (existsSync(cwdPath)) {
    cachedHelperPath = cwdPath;
    return cwdPath;
  }
  return null;
}

let warned = false;

/**
 * Capture the named window's actual content to a PNG. Goes through
 * the Swift helper which uses `SCScreenshotManager.captureImage`
 * with an `SCContentFilter(desktopIndependentWindow:)` — that asks
 * WindowServer for the window's backing buffer regardless of
 * occlusion. Different from `screencapture -l <id>`, which captures
 * the SCREEN RECT around the window (including overlapping
 * windows in front).
 *
 * Returns the destination path on success or null on failure (the
 * helper exits non-zero — the caller is expected to fall back to
 * a rect capture). Requires macOS 14+ at runtime.
 */
export async function captureWindowImage(
  windowId: number,
  outputPath: string
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const helper = resolveHelperPath();
  if (helper === null || !helperSupportsMacSubcommands()) {
    // Windows helper is list-only; the caller falls back to a rect
    // capture, which is the same degraded path as a missing helper.
    return { ok: false, message: "native helper not available" };
  }
  if (!Number.isInteger(windowId) || windowId <= 0) {
    return { ok: false, message: `invalid windowId: ${windowId}` };
  }
  try {
    await execFileAsync(
      helper,
      ["--capture-window", String(windowId), outputPath],
      { timeout: 12_000, maxBuffer: 1024 }
    );
    return { ok: true, path: outputPath };
  } catch (cause) {
    const stderr = (cause as { stderr?: Buffer | string }).stderr;
    const stderrStr =
      typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
    log.warn("captureWindowImage helper failed", {
      windowId,
      message: stderrStr || (cause instanceof Error ? cause.message : String(cause))
    });
    return {
      ok: false,
      message: stderrStr || (cause instanceof Error ? cause.message : String(cause))
    };
  }
}

/**
 * Resolve `bundleId` to its installed .app via NSWorkspace, extract
 * its icon at `size`×`size`, and write a PNG to `outputPath`. Returns
 * the resolved `.app` POSIX path on success — the caller can stat the
 * bundle's `Info.plist` mtime to invalidate cached extracts when the
 * app updates.
 *
 * Returns `{ ok: false }` on:
 *   - native helper missing (Linux/Windows or dev pre-build)
 *   - bundle id not installed locally (exit 3)
 *   - icon render / encode failure (exit 4)
 *
 * Callers should treat all failures uniformly — emit no icon and let
 * the renderer fall back to procedural initials.
 */
export async function extractAppIcon(
  bundleId: string,
  outputPath: string,
  size: number
): Promise<{ ok: true; appPath: string } | { ok: false; message: string }> {
  const helper = resolveHelperPath();
  if (helper === null || !helperSupportsMacSubcommands()) {
    // Icon extraction is NSWorkspace-based; the Windows helper has no
    // equivalent subcommand. Callers fall back to procedural initials.
    return { ok: false, message: "native helper not available" };
  }
  if (bundleId.length === 0 || !/^[A-Za-z0-9._-]+$/.test(bundleId)) {
    return { ok: false, message: `invalid bundleId: ${bundleId}` };
  }
  try {
    const { stdout } = await execFileAsync(
      helper,
      ["--extract-app-icon", bundleId, outputPath, String(size)],
      { timeout: 5_000, maxBuffer: 4 * 1024 }
    );
    const appPath = stdout.toString().trim();
    if (appPath.length === 0) {
      return { ok: false, message: "helper returned empty app path" };
    }
    return { ok: true, appPath };
  } catch (cause) {
    const stderr = (cause as { stderr?: Buffer | string }).stderr;
    const stderrStr =
      typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
    return {
      ok: false,
      message: stderrStr || (cause instanceof Error ? cause.message : String(cause))
    };
  }
}

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
  // The Windows C++ helper has no --activate-pid subcommand. Restoring
  // the previously-frontmost app there would need SetForegroundWindow,
  // which the OS heavily restricts for background processes — a no-op is
  // the safe choice and matches the "best-effort, silent on failure"
  // contract. (After the selector hides, Windows naturally returns
  // focus to the previously-active window in the common case.)
  if (!helperSupportsMacSubcommands()) return;
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
 * Snapshot of the on-screen window list plus the system's reported
 * frontmost-app pid (from NSWorkspace.shared.frontmostApplication on
 * macOS; from GetForegroundWindow's owner on Windows). The pid is
 * `null` when no app is reported as frontmost (brief transition
 * states) or on platforms without a helper (Linux).
 *
 * Callers cross-check `windows[0].pid` against `frontmostPid`; a
 * mismatch indicates CGWindowList's z-order disagrees with the
 * system's frontmost-app concept — see the warning in
 * `region-selector.ts/prepareWindowListPayload`.
 */
export type WindowListSnapshot = {
  windows: WindowInfo[];
  frontmostPid: number | null;
  frontmostBundleId: string | null;
};

/**
 * Enumerate the live on-screen windows + the system's frontmost-app
 * pid. Returns an empty snapshot when the helper isn't available
 * (Linux, or a dev environment where build-native.mjs hasn't run).
 * macOS shells the Swift binary; Windows shells the C++ .exe — both
 * emit the same JSON envelope parsed by `parseHelperOutput`. Logs once
 * at warn level so we notice in dev but don't spam the log on every
 * call.
 *
 * Latency: ~30-50ms cold per call. Caller should cache for the
 * duration of a single user interaction (e.g. one ⌘⇧P session).
 */
export async function listWindowsSnapshot(): Promise<WindowListSnapshot> {
  const helper = resolveHelperPath();
  if (helper === null) {
    if (!warned) {
      log.warn("native window-list helper not found — features dependent on it will degrade", {
        platform: process.platform
      });
      warned = true;
    }
    return { windows: [], frontmostPid: null, frontmostBundleId: null };
  }
  try {
    const { stdout } = await execFileAsync(helper, [], {
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024
    });
    return parseHelperOutput(stdout);
  } catch (cause) {
    log.warn("window-list helper failed", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return { windows: [], frontmostPid: null, frontmostBundleId: null };
  }
}

/**
 * Parse the Swift helper's stdout into a `WindowListSnapshot`. Pure;
 * exported for unit testing. Three shapes survive:
 *
 *   1. Envelope (current): `{ windows: [...], frontmostPid: <int|null>,
 *      frontmostBundleId: <string|null> }`. The post-2026-05-25 shape.
 *   2. Bare array (legacy): `[<WindowInfo>, ...]`. Pre-envelope
 *      helpers (and any in-flight ad-hoc Swift CLI tests) emit this.
 *      Parsed for backwards compatibility — frontmost fields come
 *      back as null because the data simply isn't there.
 *   3. Anything else (malformed JSON, non-array non-object,
 *      missing `windows` field): treated as an empty snapshot. The
 *      caller will then have no candidates to hit-test against,
 *      which downgrades gracefully — the user sees the selector
 *      with no snap highlights, and the failure is logged upstream.
 *
 * Returns `frontmostPid` only when it parses to a JS number, and
 * `frontmostBundleId` only when it parses to a JS string. Anything
 * else (`null`, missing, wrong type) collapses to `null` so the
 * downstream warning in `region-selector.ts/prepareWindowListPayload`
 * is gated correctly.
 */
export function parseHelperOutput(stdout: string): WindowListSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { windows: [], frontmostPid: null, frontmostBundleId: null };
  }
  if (Array.isArray(parsed)) {
    return {
      windows: parsed as WindowInfo[],
      frontmostPid: null,
      frontmostBundleId: null
    };
  }
  if (parsed !== null && typeof parsed === "object" && "windows" in parsed) {
    const envelope = parsed as {
      windows: WindowInfo[];
      frontmostPid?: number | null;
      frontmostBundleId?: string | null;
    };
    return {
      windows: Array.isArray(envelope.windows) ? envelope.windows : [],
      frontmostPid: typeof envelope.frontmostPid === "number" ? envelope.frontmostPid : null,
      frontmostBundleId:
        typeof envelope.frontmostBundleId === "string" ? envelope.frontmostBundleId : null
    };
  }
  return { windows: [], frontmostPid: null, frontmostBundleId: null };
}

/**
 * Backwards-compat thin wrapper around `listWindowsSnapshot()` that
 * drops the frontmost-app info. Kept so the headless `capture:region`
 * source-app backfill in `capture-handlers.ts` doesn't need to care
 * about the envelope — it just wants the bounds list.
 */
export async function listWindows(): Promise<WindowInfo[]> {
  const snapshot = await listWindowsSnapshot();
  return snapshot.windows;
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
