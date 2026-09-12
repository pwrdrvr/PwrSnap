// Admission control between the things that WRITE `<cacheRoot>` and the
// things that DELETE it.
//
// The writers publish through a staging file and a final `rename` (see
// `publishMedia` in sizzle/audio-extract.ts). The deleters — `library:purge`,
// boot GC, and Settings → Storage → Clear/Trim — `rm -rf` whole directories
// underneath them. Nothing sequenced the two, so a `rename` could land after
// the `rm -rf` and recreate the tree it was just deleted from:
//
//   - purging a capture while its stage was opening left an orphaned
//     `<cacheRoot>/video/<deleted-id>/playback-*.mp4` with no DB row, which
//     nothing would ever collect — the capture is gone, so no future
//     `purgeCacheForCapture` for that id will ever run;
//   - "Clear cache" during preparation did not actually clear, and reported
//     a `clearedBytes` that was wrong by the size of a whole recording.
//
// The existing in-flight maps do not help. They coalesce DUPLICATE WORK; they
// have no idea a deletion happened.
//
// The gate is deliberately at the cache boundary rather than inside any one
// writer. There are four writers under `<cacheRoot>` today (playback
// renditions, the waveform asset, video frames, render bakes) and three
// deleters, and pairing them off one at a time is twelve places to get right.
// One gate that both sides pass through is one place.
//
// ## The ordering that makes it correct
//
// A cleanup must close admission SYNCHRONOUSLY — before its first `await` —
// or a write registered in the gap runs against a directory the cleanup is
// about to remove. Writers must likewise register synchronously, before their
// own first `await`, which is why `runGatedCacheWrite` takes the work as a
// callback instead of a promise: by the time a caller could hand us a promise
// it has already started.
//
// Then: abort the matching writes, DRAIN them, and only then touch the
// filesystem — with admission still closed for the whole of it. Aborting
// without draining just moves the race later, because an aborted ffmpeg is
// still holding a staging file open when `abort()` returns.
//
// ## Why cleanups serialize with each other
//
// Clear/Trim walk all of `<cacheRoot>` and a per-capture purge walks part of
// it, so two concurrent cleanups race on the same directories — `rm -rf`
// against a `readdir` that has already listed the entries. `cleanupTail`
// chains them. The tail is kept as a `.catch`-ed promise so one failed
// cleanup does not poison every later one.

import { getMainLogger } from "../log";
import { getRuntimeProcessRole } from "../process-role";

const log = getMainLogger("pwrsnap:derived-cache-gate");

/** A cleanup's blast radius: one capture's derivatives, or all of them. */
export type DerivedCacheCleanupScope = { captureId: string } | "all";

type GatedWrite = {
  captureId: string;
  controller: AbortController;
  pending: Promise<unknown>;
};

/** Keyed by artifact identity, so two callers wanting the same file share
 *  one encode — the coalescing the writers used to do for themselves. */
const writes = new Map<string, GatedWrite>();
/** Ref-counted rather than boolean: purges of the same capture can overlap
 *  (a `library:purge` and a boot GC sweep), and the first to finish must not
 *  reopen admission while the second is still deleting. */
const captureCleanups = new Map<string, number>();
let globalCleanups = 0;
let cleanupTail: Promise<void> = Promise.resolve();

function cleanupInProgressFor(captureId: string): boolean {
  return globalCleanups > 0 || captureCleanups.has(captureId);
}

/**
 * Run `work` as a gated write against `<cacheRoot>`, coalescing on `key`.
 *
 * `key` identifies the ARTIFACT, not the capture — two callers that would
 * produce byte-identical output share one run, and callers wanting different
 * output do not adopt each other's result.
 *
 * Rejects with an `AbortError` when a cleanup covering `captureId` is already
 * underway. That is the correct answer, not a failure: the caller is asking
 * to derive something from a capture that is being deleted, or into a cache
 * that is being emptied. Callers that can fall back to the original should.
 *
 * The `AbortSignal` handed to `work` fires when a cleanup arrives mid-flight.
 * Honouring it is what makes draining bounded — `runAudioFfmpeg` already
 * kills its child on abort, so threading the signal through is enough.
 */
export async function runGatedCacheWrite<T>(
  captureId: string,
  key: string,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  // Synchronous, before any await: a cleanup cannot slip in behind this
  // check and find no write registered.
  if (cleanupInProgressFor(captureId)) {
    throw new DOMException(`derived cache cleanup in progress for ${captureId}`, "AbortError");
  }
  const existing = writes.get(key);
  if (existing !== undefined) return existing.pending as Promise<T>;

  const controller = new AbortController();
  const pending = Promise.resolve()
    .then(async () => {
      controller.signal.throwIfAborted();
      const result = await work(controller.signal);
      // A cleanup that arrived while `work` was publishing has already
      // deleted what we just wrote. Do not report it as available.
      controller.signal.throwIfAborted();
      return result;
    })
    .finally(() => {
      if (writes.get(key)?.controller === controller) writes.delete(key);
    });
  writes.set(key, { captureId, controller, pending });
  return pending;
}

/**
 * Close admission, cancel and drain matching writes, then run `cleanup` with
 * admission still closed.
 *
 * `scope` of `"all"` covers every in-flight write (Clear/Trim, which empty
 * the whole root); a `{ captureId }` scope covers only that capture's.
 */
export async function withDerivedCacheCleanup(
  scope: DerivedCacheCleanupScope,
  cleanup: () => Promise<void>
): Promise<void> {
  const captureId = scope === "all" ? null : scope.captureId;
  if (captureId === null) globalCleanups += 1;
  else captureCleanups.set(captureId, (captureCleanups.get(captureId) ?? 0) + 1);

  const cancelled = [...writes.values()].filter(
    (write) => captureId === null || write.captureId === captureId
  );
  for (const write of cancelled) write.controller.abort();
  // Attach the rejection handlers NOW, not inside the `cleanupTail` chain.
  // An aborted write rejects immediately, and if the tail is still busy with
  // an earlier cleanup nothing would be listening yet — an unhandled
  // rejection that crashes the process under Electron's default handler.
  const drained = Promise.allSettled(cancelled.map((write) => write.pending));

  const pending = cleanupTail
    .then(async () => {
      await drained;
      await cleanup();
    })
    .finally(() => {
      if (captureId === null) globalCleanups -= 1;
      else {
        const remaining = (captureCleanups.get(captureId) ?? 1) - 1;
        if (remaining <= 0) captureCleanups.delete(captureId);
        else captureCleanups.set(captureId, remaining);
      }
    });
  // Swallow on the TAIL only. The returned promise still rejects, so the
  // caller sees its own failure; the next cleanup just does not inherit it.
  cleanupTail = pending.catch(() => undefined);
  return pending;
}

/**
 * A whole cleanup operation, in a form that can cross a process boundary.
 *
 * Under `experimental.processSplit` the writer and the deleters sit in
 * DIFFERENT processes — `video:*` routes to the agent (co-located with the
 * recorder that produced the file) while `storage:*` and the library-window
 * verbs route to the library. An in-process gate is no help across that
 * boundary, so the library forwards the whole operation to the agent and
 * awaits it.
 *
 * Forwarding the OPERATION, not a cancellation, is the load-bearing part. A
 * "stop writing" message would leave the library deleting files while the
 * agent is still quiescing, and would need a lease with a release — which a
 * crashed library never sends, wedging the agent forever. One call, one
 * reply, no lease.
 *
 * Boot GC already runs agent-side (`role !== "library"` in index.ts), so the
 * only forwarded callers are `library:purge` / `library:purgeAll` and
 * Settings → Storage.
 */
export type DerivedCacheCleanupRequest =
  | { operation: "purge"; captureId: string }
  | { operation: "clear" }
  | { operation: "trim" };

type CleanupForwarder = (request: DerivedCacheCleanupRequest) => Promise<void>;
let cleanupForwarder: CleanupForwarder | null = null;

/** Installed once during split bootstrap, by the handler layer. Persistence
 *  must not reach for the command bus itself — nothing else under
 *  `persistence/` imports it, and this gate should not be the exception. */
export function installDerivedCacheCleanupForwarder(forward: CleanupForwarder): void {
  if (cleanupForwarder !== null) {
    throw new Error("derived cache cleanup forwarder already installed");
  }
  cleanupForwarder = forward;
}

/**
 * `null` when this process owns the cleanup and should just do it; a promise
 * when it was handed to the owner.
 *
 * Fails closed on a missing forwarder — a startup race, or a library whose
 * bridge is down. The alternative is a local `rm -rf` racing the agent's
 * writes, which is the bug. A caller that cannot clean simply does not:
 * `library:purge` already logs and continues, and Settings → Storage reports
 * the error.
 */
export function forwardDerivedCacheCleanup(
  request: DerivedCacheCleanupRequest
): Promise<void> | null {
  if (getRuntimeProcessRole() !== "library") return null;
  if (cleanupForwarder === null) {
    return Promise.reject(new Error("derived cache cleanup owner unavailable"));
  }
  return cleanupForwarder(request);
}

/** Test seam for the forwarder half. */
export function resetDerivedCacheCleanupForwarderForTests(): void {
  cleanupForwarder = null;
}

/** Test seam. Production never needs this — the maps empty themselves. */
export function resetDerivedCacheGateForTests(): void {
  if (writes.size > 0 || captureCleanups.size > 0 || globalCleanups > 0) {
    log.warn("derived cache gate reset with work outstanding", {
      writes: writes.size,
      captureCleanups: captureCleanups.size,
      globalCleanups
    });
  }
  writes.clear();
  captureCleanups.clear();
  globalCleanups = 0;
  cleanupTail = Promise.resolve();
}
