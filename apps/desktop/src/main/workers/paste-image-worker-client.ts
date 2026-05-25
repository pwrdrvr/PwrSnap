// Phase 5 multi-image paste/drop — main-side client for the off-thread
// decode worker (paste-image-worker.ts).
//
// Wraps `Worker` lifecycle so handlers can `await runPasteImageWorker(...)`
// without worrying about thread management. One worker per paste — the
// work is one-shot and we want to fail-isolate (a malformed PNG that
// crashes sharp shouldn't leave a long-lived worker in a bad state).
//
// Per-paste workers cost ~5-15ms to spawn — within the 300ms budget
// for the 5 MB target. If we ever ship multi-image batch paste (a
// folder drag with 20 PNGs), revisit with a small worker pool. For
// single-image paste/drop this stays simple.
//
// Resolution path for the worker bundle:
//
//   • Packaged builds: out/main/paste-image-worker.js sits alongside
//     out/main/index.js (electron-vite produces both via multi-entry
//     rollup input — see electron.vite.config.ts).
//   • Dev (electron-vite serve): the same path under apps/desktop/out
//     because electron-vite still writes the multi-entry bundle for
//     dev, just without minification.
//
// `__dirname` is set to the running main bundle's directory in both
// modes, so `join(__dirname, "paste-image-worker.js")` resolves
// without env-specific branching.

import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PasteWorkerInput, PasteWorkerResult } from "./paste-image-worker";

function resolveWorkerPath(): string {
  // import.meta.url is the compiled main bundle's file: URL in
  // production (out/main/index.js) and the dev bundle in dev. Either
  // way, sibling files in out/main/ resolve from this URL's dir.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "paste-image-worker.js");
}

let cachedPath: string | null = null;
function getWorkerPath(): string {
  if (cachedPath === null) cachedPath = resolveWorkerPath();
  return cachedPath;
}

/** Test-only — lets unit tests inject the source TS path (worker_threads
 *  with a ts-loader register can run it directly) without rebuilding. */
export function __setWorkerPathForTest(path: string | null): void {
  cachedPath = path;
}

export async function runPasteImageWorker(
  input: PasteWorkerInput,
  options: { timeoutMs?: number } = {}
): Promise<PasteWorkerResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const workerPath = getWorkerPath();

  return await new Promise<PasteWorkerResult>((resolvePromise) => {
    let settled = false;
    const resolve = (result: PasteWorkerResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    // Transfer the input buffer to the worker without copying for
    // the decode-buffer path. Note: passing through workerData
    // doesn't accept transferList directly in older Node; we use
    // `postMessage` in the worker direction is only available if we
    // open a MessageChannel. workerData copies, which is fine — we
    // already capped the input at 32 MiB so a copy is bounded.
    let worker: Worker;
    try {
      worker = new Worker(workerPath, { workerData: input });
    } catch (cause) {
      resolve({
        ok: false,
        code: "read_failed",
        message: `worker spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`
      });
      return;
    }

    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({
        ok: false,
        code: "decode_failed",
        message: `worker timeout after ${timeoutMs}ms`
      });
    }, timeoutMs);

    worker.once("message", (msg: PasteWorkerResult) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(msg);
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve({
        ok: false,
        code: "decode_failed",
        message: err instanceof Error ? err.message : String(err)
      });
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !settled) {
        resolve({
          ok: false,
          code: "decode_failed",
          message: `worker exited with code ${code}`
        });
      }
    });
  });
}
