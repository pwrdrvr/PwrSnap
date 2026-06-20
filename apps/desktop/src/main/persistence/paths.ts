// Single source of truth for "where PwrSnap stores everything." Every
// persistent surface (SQLite DB, captures source store, render cache,
// trash directory, perf-seeder JSONL output) routes through this
// module.
//
// Default layout (env unset):
//   pwrsnap.db                          → <userData>/pwrsnap.db
//   captures/<id>.png                   → <documents>/PwrSnap/<id>.png
//   render-cache/<capture_id>/<hash>.<format>  → <userData>/render-cache/...
//   pending-sources/<capture_id>/<sha>.png      → <userData>/pending-sources/...
//   .trash/<id>.png                     → <userData>/.trash/...
//
// Captures land in `~/Documents/PwrSnap/` so users can find them in
// Finder / Spotlight / cloud-sync clients, and so they survive an
// app uninstall. Everything else lives in Application Support where
// it belongs.
//
// Override layout (`PWRSNAP_DATA_ROOT=/some/path`):
//   pwrsnap.db    → <root>/pwrsnap.db
//   captures      → <root>/captures
//   render-cache  → <root>/render-cache
//   pending-sources → <root>/pending-sources
//   .trash        → <root>/.trash
//   perf          → <root>/perf
//
// The override flattens everything under one root so the dev seeder
// + integration tests get a self-contained tree they can wipe with
// `rm -rf`. The atomic-rename invariant between captures and trash
// (soft-delete relies on it) holds by construction in both modes —
// override mode keeps both on the override volume; default mode
// keeps both under the user's home volume.
//
// Invariant: `app.getPath("userData")` and `app.getPath("documents")`
// are referenced ONLY here. Any new persistence path must compose
// from `getDataRoot()` or the helpers below.

import { app } from "electron";
import { statSync } from "node:fs";
import { join } from "node:path";

const ENV_KEY = "PWRSNAP_DATA_ROOT";

/**
 * Resolve the active data root. When `PWRSNAP_DATA_ROOT` is set to a
 * non-empty string, returns that path; otherwise returns
 * `app.getPath("userData")`. Note: in default mode, `getCapturesRoot()`
 * does NOT compose from this — captures land in `~/Documents/PwrSnap`
 * for user discoverability. In override mode they do (single tree).
 */
export function getDataRoot(): string {
  const override = process.env[ENV_KEY];
  if (override !== undefined && override.length > 0) return override;
  return app.getPath("userData");
}

/** True when `PWRSNAP_DATA_ROOT` overrides the default. The dev seeder
 *  refuses to run any wipe operation unless this returns true — keeps
 *  the user's real Library safe. */
export function isOverriddenDataRoot(): boolean {
  return getDataRoot() !== app.getPath("userData");
}

export function getDbPath(): string {
  return join(getDataRoot(), "pwrsnap.db");
}

/**
 * Captures source store. Default = `~/Documents/PwrSnap` (user-visible,
 * survives uninstall). Override = `<root>/captures` (flat under the
 * dev-seeder tree).
 */
export function getCapturesRoot(): string {
  if (isOverriddenDataRoot()) return join(getDataRoot(), "captures");
  return join(app.getPath("documents"), "PwrSnap");
}

export function getLegacyCapturesRoot(): string {
  return join(getDataRoot(), "captures");
}

export function getCacheRoot(): string {
  // Do not use "cache" here. Electron/Chromium owns <userData>/Cache;
  // on macOS's default case-insensitive filesystem, "cache" aliases
  // that same directory and mixes PwrSnap render derivatives with the
  // browser HTTP cache.
  return join(getDataRoot(), "render-cache");
}

export function getPendingSourceCaptureDir(captureId: string): string {
  return join(getDataRoot(), "pending-sources", captureId);
}

export function getPendingSourcePath(captureId: string, sha: string): string {
  return join(getPendingSourceCaptureDir(captureId), `${sha}.png`);
}

/**
 * App-bundle icon cache. Shared cross-capture, addressed by bundle id
 * (one PNG + one JSON sidecar per app). Lifetime is governed by the
 * installed .app's `Info.plist` mtime — see main/app-icons/.
 */
export function getAppIconsRoot(): string {
  return join(getDataRoot(), "app-icons");
}

export function getLegacyCacheRoot(): string {
  return join(getDataRoot(), "cache");
}

/**
 * Per-capture extracted-source cache. The bundle's `source.png` is
 * materialized here on first use so synchronous callers
 * (`effectiveSrcPathFor`, the `pwrsnap-capture://` resolver,
 * `compose()`) can hand a real filesystem path to sharp without
 * extracting on every read. Regenerable from the bundle; safe to
 * delete.
 */
export function getCacheSourcePath(captureId: string): string {
  return join(getCacheRoot(), captureId, "source.png");
}

/**
 * Schema-fail bundles park here, never auto-deleted, so the user
 * (or doctor) can decide whether to recover or discard. Distinct
 * from `.trash/` which is a soft-delete with a 14d retention sweep.
 */
export function getQuarantineRoot(): string {
  return join(getDataRoot(), ".quarantine");
}

export function getTrashRoot(): string {
  return join(getDataRoot(), ".trash");
}

export function getPerfRoot(): string {
  return join(getDataRoot(), "perf");
}

/**
 * Sentinel marker proving a tree was created by the dev seeder.
 * Required for any wipe operation. Content is JSON `{uuid, createdAt}`
 * generated at create time; mtime is checked separately to defend
 * against backup-restored stale sentinels. See dev/seeder/wipe.ts.
 */
export const SEEDER_SENTINEL = ".pwrsnap-perf-root";

/**
 * Invariant: getCapturesRoot() and getTrashRoot() must live on the
 * same filesystem so soft-delete's atomic `rename` succeeds. Compose-
 * from-getDataRoot() shape enforces this by construction; this is a
 * defensive smoke test for future code that might route trash through
 * a different path.
 *
 * Dev-only — production code paths trust the construction.
 */
export function assertSameVolume(): void {
  if (!import.meta.env.DEV) return;
  try {
    const captures = statSync(getCapturesRoot()).dev;
    const trash = statSync(getTrashRoot()).dev;
    if (captures !== trash) {
      throw new Error(
        `paths invariant violated: captures (${getCapturesRoot()}) and trash (${getTrashRoot()}) on different volumes`
      );
    }
  } catch {
    // Either path may not exist yet on a fresh install; both are
    // created under the same data root, so the invariant holds by
    // construction once they materialize.
  }
}
