// Captures-folder access health — detects macOS TCC permission
// denials so they surface instead of rotting silently.
//
// Background: capture bundles live in `~/Documents/PwrSnap` (see
// persistence/paths.ts). On macOS, ~/Documents is TCC-protected
// ("Files & Folders → Documents Folder"). When the app's TCC client
// lacks that grant — for dev runs the client is the TERMINAL that
// launched `pnpm dev`, not Electron itself — `open()` on a user-owned
// file returns EPERM. Two wrinkles make this maddening to spot:
//
//   1. Files the app itself created while running WITHOUT the blanket
//      grant carry a per-file `com.apple.macl` xattr that lets the
//      creating client keep reading them. So most reads still succeed
//      and only files created under a DIFFERENT TCC identity (other
//      terminal, packaged build, pre-grant era) fail. It looks like
//      per-file corruption; it's per-file permission.
//   2. The render cache (App Support, never TCC-gated) hides the
//      problem for every capture that's already baked. Only cache
//      misses touch the bundle, so a handful of thumbnails break while
//      the rest of the Library looks healthy.
//
// This module is the single accounting point: bundle-read chokepoints
// report failures/successes here; the Library banner + a loud log line
// are driven off the snapshot. Counting is per DISTINCT path so render
// retries don't inflate it, and a later successful read of a denied
// path clears it, so the banner self-dismisses if access is restored
// while the app keeps running. (Restoring a TCC grant usually means
// relaunching the responsible terminal — see the solution doc — in
// which case the fresh process simply starts with nothing denied.)

import type { CapturesAccessHealth } from "@pwrsnap/shared";

import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:captures-access");

type Listener = (health: CapturesAccessHealth) => void;

const deniedPaths = new Set<string>();
const listeners = new Set<Listener>();
let samplePath: string | null = null;
let firstDeniedAt: string | null = null;
let lastDeniedAt: string | null = null;

// Boot maintenance touches every bundle, so a denial-heavy library
// (hundreds of files created under a different TCC identity) would
// otherwise emit one warn line and one renderer broadcast per file.
// Cap the per-path warns and trail-debounce the broadcasts; the
// authoritative count lives in the snapshot either way.
const MAX_PER_PATH_WARNS = 5;
const NOTIFY_DEBOUNCE_MS = 250;
let pathWarnCount = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * True when `cause` is a filesystem permission denial. On macOS,
 * EPERM from open() on a user-owned, mode-0600 file is the TCC
 * signature (POSIX denials produce EACCES; both are covered).
 */
export function isPermissionDenial(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES";
}

export function getCapturesAccessHealth(): CapturesAccessHealth {
  return {
    denied: deniedPaths.size > 0,
    deniedPathCount: deniedPaths.size,
    samplePath,
    firstDeniedAt,
    lastDeniedAt
  };
}

/**
 * Subscribe to snapshot transitions (first denial, new distinct path,
 * recovery). Not fired for timestamp-only changes. Returns unsubscribe.
 */
export function onCapturesAccessHealthChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Report a failed read under the captures root. No-op (returns false)
 * unless `cause` is a permission denial. Safe to call from multiple
 * layers for the same failure — paths dedupe.
 */
export function reportCapturesAccessFailure(path: string, cause: unknown): boolean {
  if (!isPermissionDenial(cause)) return false;
  const now = new Date().toISOString();
  lastDeniedAt = now;
  if (deniedPaths.has(path)) return true;

  const firstEver = deniedPaths.size === 0;
  deniedPaths.add(path);
  samplePath = path;
  if (firstDeniedAt === null) firstDeniedAt = now;

  if (firstEver) {
    log.error(
      "macOS is denying reads of the captures folder (TCC). " +
        "The file exists and is user-owned, but open() returns EPERM because this " +
        "process's TCC client lacks Files & Folders → Documents access and the file " +
        "has no per-file com.apple.macl grant. Fix: System Settings → Privacy & " +
        "Security → Files & Folders → enable Documents for PwrSnap — for dev runs, " +
        "for the TERMINAL app that launched it — then relaunch. Until then, any " +
        "capture without a warm render-cache entry shows a broken thumbnail.",
      { path, code: (cause as NodeJS.ErrnoException).code }
    );
  } else if (pathWarnCount < MAX_PER_PATH_WARNS) {
    pathWarnCount += 1;
    log.warn("captures-folder read denied (TCC)", {
      path,
      deniedPathCount: deniedPaths.size,
      ...(pathWarnCount === MAX_PER_PATH_WARNS
        ? { note: "further per-path denial warns suppressed; count continues in snapshot" }
        : {})
    });
  }
  notify();
  return true;
}

/**
 * Report a successful read under the captures root. O(1) no-op while
 * nothing is denied — safe on the hot render path. Clears recovered
 * paths so the banner self-dismisses once access is granted.
 */
export function reportCapturesAccessSuccess(path: string): void {
  if (deniedPaths.size === 0) return;
  if (!deniedPaths.delete(path)) return;
  if (deniedPaths.size === 0) {
    // Full recovery — return the snapshot to the healthy baseline so a
    // `denied: false` reading never carries stale episode metadata, and
    // so the next denial episode re-arms `firstDeniedAt` + the loud
    // first-denial log + the per-path warn budget cleanly.
    samplePath = null;
    firstDeniedAt = null;
    lastDeniedAt = null;
    pathWarnCount = 0;
    log.info("captures-folder access recovered — previously denied paths now readable");
  } else if (samplePath === path) {
    samplePath = deniedPaths.values().next().value ?? null;
  }
  notify();
}

/** Test seam. */
export function resetCapturesAccessHealthForTests(): void {
  deniedPaths.clear();
  samplePath = null;
  firstDeniedAt = null;
  lastDeniedAt = null;
  pathWarnCount = 0;
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}

/**
 * Trailing-debounced listener dispatch. The denied/recovered FLIP is
 * what the banner cares about and it's always included — the debounce
 * only coalesces the count-growth churn of a denial-heavy boot scan.
 */
function notify(): void {
  if (notifyTimer !== null) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const snapshot = getCapturesAccessHealth();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (cause) {
        log.warn("captures-access listener threw", {
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
    }
  }, NOTIFY_DEBOUNCE_MS);
  // Allow the process to exit with a pending debounce (tests, quit).
  notifyTimer.unref?.();
}
