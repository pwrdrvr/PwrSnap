import { rm } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

type PlaybackJob = {
  captureId: string;
  controller: AbortController;
  pending: Promise<string>;
};

const jobs = new Map<string, PlaybackJob>();
const captureCleanups = new Map<string, number>();
let allCacheCleanups = 0;
let cleanupTail: Promise<void> = Promise.resolve();

/**
 * Register before any source stat/probe awaits, including coalesced callers.
 * Callers must recheck that the DB capture exists immediately before starting
 * preparation: the per-capture gate covers purge, not stale DB snapshots.
 */
export function runVideoPlaybackPreparation(
  captureId: string,
  sourceKey: string,
  prepare: (signal: AbortSignal) => Promise<string>
): Promise<string> {
  if (allCacheCleanups > 0 || captureCleanups.has(captureId)) {
    return Promise.reject(new DOMException("Video playback cache cleanup in progress", "AbortError"));
  }
  const key = JSON.stringify([captureId, sourceKey]);
  const existing = jobs.get(key);
  if (existing !== undefined) return existing.pending;

  const controller = new AbortController();
  const pending = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    const path = await prepare(controller.signal);
    // Cancellation can arrive while preparation removes its staging file.
    controller.signal.throwIfAborted();
    return path;
  }).finally(() => { jobs.delete(key); });
  jobs.set(key, { captureId, controller, pending });
  return pending;
}

/**
 * Close admission synchronously, cancel and drain matching work, then remove
 * files. Keep admission closed through the entire filesystem cleanup. Cleanup
 * operations serialize because Clear/Trim and capture purges share directories.
 * An undefined captureId means all playback jobs (Clear/Trim).
 */
export function withVideoPlaybackCacheCleanup(
  captureId: string | undefined,
  cleanup: () => Promise<void>
): Promise<void> {
  if (captureId === undefined) allCacheCleanups += 1;
  else captureCleanups.set(captureId, (captureCleanups.get(captureId) ?? 0) + 1);

  const cancelled = [...jobs.values()].filter((job) => captureId === undefined || job.captureId === captureId);
  for (const job of cancelled) job.controller.abort();
  // Attach rejection handlers now, even while an earlier cleanup is pending.
  const drained = Promise.allSettled(cancelled.map((job) => job.pending));
  const pending = cleanupTail.then(async () => {
    await drained;
    await cleanup();
  }).finally(() => {
    if (captureId === undefined) allCacheCleanups -= 1;
    else {
      const remaining = captureCleanups.get(captureId)! - 1;
      if (remaining === 0) captureCleanups.delete(captureId);
      else captureCleanups.set(captureId, remaining);
    }
  });
  cleanupTail = pending.catch(() => undefined);
  return pending;
}

/**
 * The obsolete full-MP4 bucket used userData directly, even with a data-root
 * override. Remove that exact app-owned derivative bucket, leaving native
 * audio, silence, music and every other sizzle asset intact. Idempotent at boot
 * and during purge/Clear/Trim; new preparations never write this location.
 */
export async function removeLegacyVideoPlaybackCache(): Promise<void> {
  await rm(join(app.getPath("userData"), "sizzle-cache", "video-playback"), {
    recursive: true,
    force: true
  });
}
