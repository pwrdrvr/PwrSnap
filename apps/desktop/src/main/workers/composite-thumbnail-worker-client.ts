// Main-side client for the off-thread composite-thumbnail encoder
// (composite-thumbnail-worker.ts). Wraps the `Worker` lifecycle so
// callers can `await runCompositeThumbnailWorker(png)` without thread
// management. One worker per call — the work is one-shot and we want to
// fail-isolate (a malformed PNG that aborts libvips shouldn't leave a
// long-lived worker in a bad state, and must never abort the main
// process). Mirrors `paste-image-worker-client.ts`.
//
// Resolution path for the worker bundle:
//
//   • Packaged builds: out/main/composite-thumbnail-worker.js sits
//     alongside out/main/index.js (electron-vite multi-entry rollup
//     input — see electron.vite.config.ts).
//   • Dev (electron-vite serve): the same path under apps/desktop/out.
//   • Unit tests (vitest): the .js is not built, so the bundle is
//     absent — `isCompositeThumbnailWorkerAvailable()` returns false and
//     bundle-store falls back to the in-process pipeline.

import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type {
  CompositeThumbnailWorkerInput,
  CompositeThumbnailWorkerResult
} from "./composite-thumbnail-worker";

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
 * tests don't need a built worker.
 */
export function isCompositeThumbnailWorkerAvailable(): boolean {
  return existsSync(getWorkerPath());
}

/**
 * Encode a composite-thumbnail JPEG on a worker thread. Rejects on
 * spawn failure, worker error, non-zero exit, timeout, or a sharp
 * decode failure reported by the worker — callers translate the
 * rejection into their own failure path (the v1→v2 doctor records it
 * against the per-capture retry budget).
 */
export async function runCompositeThumbnailWorker(
  pngBytes: Buffer,
  options: { timeoutMs?: number } = {}
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const workerPath = getWorkerPath();
  const input: CompositeThumbnailWorkerInput = {
    pngBytes: new Uint8Array(pngBytes)
  };

  return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
    let settled = false;
    const resolve = (buf: Buffer): void => {
      if (settled) return;
      settled = true;
      resolvePromise(buf);
    };
    const reject = (err: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(err);
    };

    let worker: Worker;
    try {
      worker = new Worker(workerPath, { workerData: input });
    } catch (cause) {
      reject(
        new Error(
          `composite-thumbnail worker spawn failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        )
      );
      return;
    }

    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`composite-thumbnail worker timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.once("message", (msg: CompositeThumbnailWorkerResult) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok) {
        resolve(Buffer.from(msg.jpegBytes));
      } else {
        reject(new Error(msg.message));
      }
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !settled) {
        reject(new Error(`composite-thumbnail worker exited with code ${code}`));
      }
    });
  });
}
