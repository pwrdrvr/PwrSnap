// Main-side client for the off-thread composite-thumbnail encoder
// (composite-thumbnail-worker.ts).
//
// Owns a SINGLE long-lived worker that's reused across calls — a
// migration sweep over a large library pays libvips init once, not once
// per item. The client is the lifecycle owner:
//
//   • lazy spawn        — the worker is created on first use
//   • request routing   — each call gets a monotonic id; responses are
//                          matched back by id, so concurrent in-flight
//                          encodes are correct
//   • crash recovery    — on worker 'error'/'exit' (e.g. a poison image
//                          that aborts libvips) every in-flight request
//                          rejects and the worker is discarded; the next
//                          call transparently respawns a clean one
//   • idle teardown     — after a quiet period the worker is terminated
//                          so the sweep doesn't leave a libvips-laden
//                          thread resident for the rest of the session
//
// This is the reference shape for PwrSnap migration workers — see the
// header in composite-thumbnail-worker.ts.
//
// Resolution path for the worker bundle:
//   • Packaged + dev (electron-vite): out/main/composite-thumbnail-worker.js
//     sits alongside out/main/index.js (multi-entry rollup input — see
//     electron.vite.config.ts).
//   • Unit tests (vitest): the .js is not built, so the bundle is absent
//     — `isCompositeThumbnailWorkerAvailable()` returns false and
//     bundle-store falls back to the in-process pipeline.

import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type {
  CompositeThumbnailWorkerRequest,
  CompositeThumbnailWorkerResponse
} from "./composite-thumbnail-worker";

const REQUEST_TIMEOUT_MS = 30_000;

// Terminate the shared worker after this long with no work in flight.
// The next request respawns transparently; this just stops a finished
// sweep from pinning a libvips threadpool for the rest of the session.
const IDLE_SHUTDOWN_MS = 30_000;

function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "composite-thumbnail-worker.js");
}

let cachedPath: string | null = null;
function getWorkerPath(): string {
  if (cachedPath === null) cachedPath = resolveWorkerPath();
  return cachedPath;
}

/** Test-only — inject an explicit worker path (or `null` to reset). */
export function __setWorkerPathForTest(path: string | null): void {
  cachedPath = path;
}

/**
 * Whether the compiled worker bundle exists on disk. False under vitest
 * (the multi-entry rollup output isn't produced for unit tests), which
 * lets the bundle-store wrapper fall back to the in-process pipeline so
 * tests need no built worker.
 */
export function isCompositeThumbnailWorkerAvailable(): boolean {
  return existsSync(getWorkerPath());
}

type Pending = {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ── Module-level singleton state ─────────────────────────────────────
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimerIfQuiet(): void {
  clearIdleTimer();
  if (pending.size > 0 || worker === null) return;
  idleTimer = setTimeout(teardownIdleWorker, IDLE_SHUTDOWN_MS);
}

function teardownIdleWorker(): void {
  idleTimer = null;
  if (pending.size > 0) return;
  const w = worker;
  worker = null;
  if (w !== null) void w.terminate();
}

/**
 * Discard the worker after a fatal event and fail everything in flight.
 * Idempotent — safe to call from overlapping 'error'/'exit'/timeout
 * paths. After this, the next `runCompositeThumbnailWorker` respawns.
 */
function failWorker(err: Error): void {
  clearIdleTimer();
  const w = worker;
  worker = null;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
  if (w !== null) void w.terminate();
}

function getOrSpawnWorker(): Worker {
  if (worker !== null) return worker;

  const w = new Worker(getWorkerPath());

  // Handlers capture `w` and bail if it's no longer the active worker.
  // Without this guard, a late 'exit' from a worker we already discarded
  // could clobber a freshly-spawned replacement and its in-flight work.
  w.on("message", (msg: CompositeThumbnailWorkerResponse) => {
    if (worker !== w) return;
    const p = pending.get(msg.id);
    if (p === undefined) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(Buffer.from(msg.jpegBytes));
    } else {
      p.reject(new Error(msg.message));
    }
    armIdleTimerIfQuiet();
  });
  w.on("error", (err) => {
    if (worker !== w) return;
    failWorker(err instanceof Error ? err : new Error(String(err)));
  });
  w.on("exit", (code) => {
    if (worker !== w) return;
    // code 0 only happens on our own terminate(); anything else is a
    // crash (e.g. libvips aborting on a malformed source).
    if (code !== 0) {
      failWorker(new Error(`composite-thumbnail worker exited with code ${code}`));
    }
  });

  worker = w;
  return w;
}

/**
 * Encode a composite-thumbnail JPEG on the shared worker thread. Rejects
 * on spawn failure, worker error, non-zero exit, timeout, or a sharp
 * decode failure reported by the worker — callers translate the
 * rejection into their own failure path (the v1→v2 doctor records it
 * against the per-capture retry budget).
 */
export async function runCompositeThumbnailWorker(
  pngBytes: Buffer,
  options: { timeoutMs?: number } = {}
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  clearIdleTimer();

  let w: Worker;
  try {
    w = getOrSpawnWorker();
  } catch (cause) {
    worker = null;
    throw new Error(
      `composite-thumbnail worker spawn failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  const id = nextId++;

  return await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pending.get(id);
      pending.delete(id);
      p?.reject(new Error(`composite-thumbnail worker timeout after ${timeoutMs}ms`));
      // A timed-out request means the worker may be wedged — discard it
      // (and fail any siblings) so the next request gets a clean one.
      failWorker(new Error("composite-thumbnail worker discarded after a request timeout"));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });

    const request: CompositeThumbnailWorkerRequest = {
      id,
      pngBytes: new Uint8Array(pngBytes)
    };
    w.postMessage(request);
  });
}

/**
 * Terminate the shared worker now and fail anything in flight. Idempotent
 * — safe to call on app shutdown or from tests between cases.
 */
export function shutdownCompositeThumbnailWorker(): void {
  if (worker === null && pending.size === 0) {
    clearIdleTimer();
    return;
  }
  failWorker(new Error("composite-thumbnail worker shut down"));
}
