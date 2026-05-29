// Off-main-thread composite-thumbnail encoder.
//
// Runs the bundle's `composite_thumbnail.jpg` sharp pipeline (PNG
// decode → resize → mozjpeg encode) on a worker_thread so the Chromium
// main thread never blocks on libvips. This matters most during the
// boot-time v1→v2 sweep, which builds a thumbnail per capture across the
// whole library; running that decode on the main thread concurrently
// with renderer/GPU bring-up was crashing the process (native abort in
// CrBrowserMain). Mirrors `paste-image-worker.ts`.
//
// Protocol (parent → worker on construction via workerData):
//
//   { pngBytes: Uint8Array }
//
// On success the worker postMessage's:
//
//   { ok: true; jpegBytes: Uint8Array }
//
// On failure:
//
//   { ok: false; message: string }
//
// A malformed source that makes libvips abort takes down THIS worker
// (exit ≠ 0), not the main process — the client surfaces that as a
// rejection and the caller (the v1→v2 doctor) records it against the
// per-capture retry budget.

import { parentPort, workerData } from "node:worker_threads";
import { buildCompositeThumbnailInProcess } from "../image/composite-thumbnail";

export type CompositeThumbnailWorkerInput = { pngBytes: Uint8Array };

export type CompositeThumbnailWorkerResult =
  | { ok: true; jpegBytes: Uint8Array }
  | { ok: false; message: string };

export async function encodeCompositeThumbnail(
  input: CompositeThumbnailWorkerInput
): Promise<CompositeThumbnailWorkerResult> {
  try {
    const jpeg = await buildCompositeThumbnailInProcess(Buffer.from(input.pngBytes));
    return { ok: true, jpegBytes: new Uint8Array(jpeg) };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

// Worker entrypoint. The parent constructs us with `workerData` set to
// the input; we run once and postMessage the result. No transfer list —
// the thumbnail is small (≤ ~150 KB JPEG) so the structured-clone copy
// is negligible, and it keeps the typing clean (matches paste worker).
if (parentPort !== null) {
  const input = workerData as CompositeThumbnailWorkerInput;
  void encodeCompositeThumbnail(input).then((result) => {
    if (parentPort === null) return;
    parentPort.postMessage(result);
  });
}
