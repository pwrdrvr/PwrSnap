// Main-side client for the off-thread login-shell env resolver
// (shell-env-refresh-worker.ts). Same lifecycle shape as the other
// one-shot worker clients in this directory: spawn, await the single
// result message, terminate.
//
// Resolution path for the worker bundle mirrors paste-image-worker-client:
// electron-vite emits out/main/shell-env-refresh-worker.js next to the
// main bundle in both dev and packaged builds, so a sibling join from
// import.meta.url's directory resolves in every mode.

import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "shell-env-refresh-worker.js");
}

let cachedPath: string | null = null;
function getWorkerPath(): string {
  if (cachedPath === null) cachedPath = resolveWorkerPath();
  return cachedPath;
}

/** Test-only — lets unit tests inject a source path without rebuilding. */
export function __setShellEnvWorkerPathForTest(path: string | null): void {
  cachedPath = path;
}

/**
 * Resolve the interactive login shell's env off-thread. Returns the
 * resolved env, or null when the shell couldn't be queried, the worker
 * failed, or `timeoutMs` elapsed. Never throws.
 */
export async function runShellEnvRefreshWorker(
  options: { timeoutMs?: number } = {}
): Promise<NodeJS.ProcessEnv | null> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const workerPath = getWorkerPath();

  return await new Promise<NodeJS.ProcessEnv | null>((resolvePromise) => {
    let settled = false;
    const resolve = (result: NodeJS.ProcessEnv | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let worker: Worker;
    try {
      worker = new Worker(workerPath);
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(null);
    }, timeoutMs);

    worker.once("message", (msg: NodeJS.ProcessEnv | null) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(msg);
    });
    worker.once("error", () => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(null);
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
