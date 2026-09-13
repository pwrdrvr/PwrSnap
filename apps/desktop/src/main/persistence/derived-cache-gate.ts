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
// writer: four lanes write `<cacheRoot>/video/<id>/` and three paths delete
// it, and pairing those off one at a time is twelve places to get right.
//
// ## What it covers, and what it does not
//
// GATED — the four per-capture derived-video lanes, each an ffmpeg run whose
// output is published by `rename` and can be source-sized:
//   • the playback rendition   (`ensureVideoPlaybackAsset`)
//   • the waveform asset       (`ensureVideoAudioAsset`)
//   • the contact strip        (`ensureVideoFrames`)
//   • the poster frame         (`ensureVideoPoster`)
//
// NOT GATED, on purpose:
//   • MP4/GIF exports (`recording-exporter.ts`), which also write this
//     directory. They carry their own cancellation and progress, and a user
//     who asked for an export should not have it killed by a background
//     cache trim. An orphaned export is the better outcome.
//   • Render bakes (`compose-tree.ts`) and the other `<cacheRoot>` buckets.
//     A bake re-derives on demand in milliseconds and is small, so an
//     orphan costs little and the next Clear collects it — not worth
//     putting a cleanup in the way of the editor's paint path.
//
// The rule for anything NEW: a writer that spends seconds under
// `<cacheRoot>` and publishes by `rename` belongs behind the gate.
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

import { AsyncLocalStorage } from "node:async_hooks";
import { getMainLogger } from "../log";
import { getRuntimeProcessRole } from "../process-role";

const log = getMainLogger("pwrsnap:derived-cache-gate");

/**
 * How long a cleanup waits for aborted writes before giving up on them.
 *
 * Generous on purpose: `runAudioFfmpeg` falls back to SIGKILL 5s after an
 * abort, so anything approaching this bound means a child is wedged in
 * uninterruptible I/O, not merely slow.
 *
 * The bound exists because the alternative is unrecoverable. Without it one
 * write that never settles leaves the admission counters incremented and
 * `cleanupTail` pending forever: every later write is rejected and every
 * later cleanup queues behind a promise that never resolves, for the life of
 * the process. Timing out re-opens admission and lets the next cleanup run;
 * the cost is that the undrained write may still publish afterwards, which is
 * the orphan this module prevents — recoverable (the next Clear removes it)
 * where the wedge was not.
 */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Marks the async context of a running `cleanup()` body.
 *
 * A cleanup that transitively calls another gated cleanup would chain onto a
 * `cleanupTail` it is itself holding, and hang forever with admission closed.
 * A plain boolean cannot catch that — it could not tell a NESTED call from a
 * merely CONCURRENT one, which must queue rather than fail — so the flag
 * rides the async context instead.
 */
const runningCleanup = new AsyncLocalStorage<true>();

/** A cleanup's blast radius: one capture's derivatives, or all of them. */
export type DerivedCacheCleanupScope = { captureId: string } | "all";

type GatedWrite = {
  captureId: string;
  controller: AbortController;
  pending: Promise<unknown>;
};

/** Keyed by capture AND artifact identity, so two callers wanting the same
 *  file share one encode — the coalescing the writers used to do for
 *  themselves. The capture is part of the key, not just of the value: an
 *  entry adopted across two capture ids would keep the FIRST caller's id, and
 *  a cleanup scoped to the second would then neither abort nor drain it.
 *  Callers pass paths that already embed the capture id, so this changes no
 *  behavior today — it removes the way it could stop being true. */
const writes = new Map<string, GatedWrite>();

const writeKey = (captureId: string, key: string): string => `${captureId}\u0000${key}`;

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
  const mapKey = writeKey(captureId, key);
  const existing = writes.get(mapKey);
  // Safe because `mapKey` pins both the capture and the artifact, and callers
  // derive `key` from the output path: same key, same bytes, same `T`.
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
      if (writes.get(mapKey)?.controller === controller) writes.delete(mapKey);
    });
  writes.set(mapKey, { captureId, controller, pending });
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
  // Before the counters move, so a refused re-entry leaks no admission.
  if (runningCleanup.getStore() === true) {
    throw new Error(
      "derived cache cleanup re-entered from inside another cleanup; this would deadlock on cleanupTail"
    );
  }
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
      await drainWithin(drained, scope === "all" ? "all captures" : scope.captureId);
      await runningCleanup.run(true, cleanup);
    })
    .finally(() => {
      // Clamped: `resetDerivedCacheGateForTests` can zero these while this
      // cleanup is still queued, and a negative `globalCleanups` would make
      // `cleanupInProgressFor` report admission OPEN during a later cleanup.
      if (captureId === null) globalCleanups = Math.max(0, globalCleanups - 1);
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

/** Wait for aborted writes, but never forever — see `DRAIN_TIMEOUT_MS`. */
async function drainWithin(drained: Promise<unknown>, scope: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`derived cache cleanup timed out draining writes for ${scope}`)
      );
    }, DRAIN_TIMEOUT_MS);
    // Never hold the event loop open on a cleanup's behalf; quitting while a
    // drain is pending must not wait out the bound.
    timer.unref?.();
  });
  try {
    await Promise.race([drained, expiry]);
  } catch (cause) {
    log.error("derived cache cleanup abandoned an undrained write", {
      scope,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    throw cause;
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Test seam. Production never needs this — the maps empty themselves.
 *
 * Aborts what it drops rather than merely forgetting it: a write left
 * pending outlives the reset, keeps its `abort` listener, and would report
 * as outstanding on every subsequent reset. A queued cleanup's `.finally`
 * still runs after this, which is why the decrement above is clamped.
 */
export function resetDerivedCacheGateForTests(): void {
  if (writes.size > 0 || captureCleanups.size > 0 || globalCleanups > 0) {
    log.warn("derived cache gate reset with work outstanding", {
      writes: writes.size,
      captureCleanups: captureCleanups.size,
      globalCleanups
    });
  }
  for (const write of writes.values()) write.controller.abort();
  writes.clear();
  captureCleanups.clear();
  globalCleanups = 0;
  cleanupTail = Promise.resolve();
}
