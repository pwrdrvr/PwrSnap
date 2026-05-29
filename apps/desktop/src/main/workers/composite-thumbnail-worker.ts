// Long-lived off-main-thread composite-thumbnail encoder.
//
// ── PwrSnap's reference pattern for migration-time image work ─────────
// This is the template for moving repeated libvips/sharp work off the
// Chromium main thread during a bulk migration sweep. A SINGLE worker is
// spawned once and reused for the whole batch (see
// composite-thumbnail-worker-client.ts), so libvips initializes once per
// worker rather than once per item — the thing that makes a one-shot-
// per-item design pathological on a large library. Requests are
// correlated by `id` so the worker can stream a result back as each
// encode finishes; concurrent in-flight encodes are fine (sharp runs on
// libvips' own threadpool, off this worker's JS thread).
//
// When this particular v1→v2 migration is eventually deleted, keep this
// worker/client pair as the blueprint: a dependency-thin sharp module,
// a reusable worker, and a client that owns lifecycle + crash recovery.
//
// Protocol (parent ⇄ worker, over parentPort):
//   parent → worker:  { id: number; pngBytes: Uint8Array }
//   worker → parent:  { id: number; ok: true;  jpegBytes: Uint8Array }
//                  |  { id: number; ok: false; message: string }
//
// A malformed source that makes libvips abort takes down THIS worker.
// The client observes 'exit'/'error', rejects every in-flight request,
// and discards the worker so the next request spawns a fresh one — so a
// poison image fails its own item without corrupting the rest of the
// batch.

import { parentPort } from "node:worker_threads";
import { buildCompositeThumbnailInProcess } from "../image/composite-thumbnail";

export type CompositeThumbnailWorkerRequest = {
  id: number;
  pngBytes: Uint8Array;
};

export type CompositeThumbnailWorkerResponse =
  | { id: number; ok: true; jpegBytes: Uint8Array }
  | { id: number; ok: false; message: string };

/**
 * Pure encode step — decode a composite PNG and return JPEG-thumbnail
 * bytes. Throws on a sharp decode/encode failure. Exported so it can be
 * unit-tested directly without spawning a worker.
 */
export async function encodeCompositeThumbnail(
  pngBytes: Uint8Array
): Promise<Uint8Array> {
  const jpeg = await buildCompositeThumbnailInProcess(Buffer.from(pngBytes));
  return new Uint8Array(jpeg);
}

// Worker entrypoint — a message loop, not a one-shot. Each request is
// handled independently and its result tagged with the request `id`; a
// per-request try/catch keeps one bad encode from tearing down the
// worker for the rest of the batch.
if (parentPort !== null) {
  const port = parentPort;
  port.on("message", (req: CompositeThumbnailWorkerRequest) => {
    encodeCompositeThumbnail(req.pngBytes).then(
      (jpegBytes) => {
        port.postMessage({ id: req.id, ok: true, jpegBytes });
      },
      (cause: unknown) => {
        port.postMessage({
          id: req.id,
          ok: false,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
    );
  });
}
