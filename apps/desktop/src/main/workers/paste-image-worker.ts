// Phase 5 multi-image paste/drop — off-main-thread image probe.
//
// Runs sharp's metadata probe + sha256 streaming hash on a worker
// thread so the IPC main thread doesn't block on 5-25 MiB PNG
// decode. The plan's performance budget is < 300ms end-to-end for a
// ≤5 MB image; main-thread sharp routinely costs 80-150ms for a 4K
// PNG, which by itself would chew most of the budget.
//
// Protocol (parent → worker on construction via workerData):
//
//   { kind: "decode-buffer"; bytes: Uint8Array }
//
// On success the worker postMessage's:
//
//   { ok: true; sha256: string; widthPx: number; heightPx: number;
//     pngBytes: Uint8Array }
//
// On failure:
//
//   { ok: false; code: WorkerErrorCode; message: string }
//
// Errors carry a stable `code` discriminant the parent translates
// into a sanitized Result error. The worker never logs the file
// path — it sees only the bytes/buffer; the parent sanitizes.

import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { PASTE_IMAGE_MAX_BYTES } from "@pwrsnap/shared";
import {
  canonicalizeSafeRasterToPng,
  SafeRasterError
} from "../image/safe-raster-decode";

export type PasteWorkerInput = { kind: "decode-buffer"; bytes: Uint8Array };

export type PasteWorkerErrorCode =
  | "size_cap_exceeded"
  | "read_failed"
  | "decode_failed"
  | "invalid_dimensions"
  | "raster_limit_exceeded"
  | "unsupported_multi_page";

export type PasteWorkerResult =
  | {
      ok: true;
      sha256: string;
      widthPx: number;
      heightPx: number;
      pngBytes: Uint8Array;
    }
  | { ok: false; code: PasteWorkerErrorCode; message: string };

function fail(
  code: PasteWorkerErrorCode,
  message: string
): PasteWorkerResult {
  return { ok: false, code, message };
}

/**
 * Decode + hash + dimension-probe the input. Re-encodes the input as
 * a normalized PNG via sharp so:
 *   • Bundles always store PNG bytes (callers downstream rely on
 *     `sources/<sha>.png`).
 *   • The sha256 is computed over the post-encode bytes — eliminates
 *     malformed metadata, EXIF, or extra chunks that would otherwise
 *     re-hash differently when read back.
 *   • sharp's encode pipeline acts as a decode-probe + sanitizer in
 *     one pass. If the input doesn't decode, sharp throws and we
 *     return decode_failed before any bytes hit disk.
 */
export async function processImageInput(
  input: PasteWorkerInput
): Promise<PasteWorkerResult> {
  const inputBytes = Buffer.from(input.bytes);

  if (inputBytes.byteLength === 0) {
    return fail("read_failed", "input was empty");
  }
  if (inputBytes.byteLength > PASTE_IMAGE_MAX_BYTES) {
    return fail(
      "size_cap_exceeded",
      `input exceeds ${PASTE_IMAGE_MAX_BYTES} byte cap (${inputBytes.byteLength})`
    );
  }

  // Probe metadata before decoding, enforce pixel/channel/raw-byte/page caps,
  // then stream the canonical PNG through a separate encoded-output cap.
  try {
    const { pngBytes, metadata } = await canonicalizeSafeRasterToPng(inputBytes);

    // sha256 of the canonical PNG bytes — what we'll store at
    // sources/<sha>.png.
    const hash = createHash("sha256");
    hash.update(pngBytes);
    const sha256 = hash.digest("hex");

    return {
      ok: true,
      sha256,
      widthPx: metadata.widthPx,
      heightPx: metadata.heightPx,
      pngBytes
    };
  } catch (cause) {
    if (cause instanceof SafeRasterError) {
      switch (cause.code) {
        case "input_size_cap_exceeded":
          return fail("size_cap_exceeded", cause.message);
        case "invalid_dimensions":
          return fail("invalid_dimensions", cause.message);
        case "unsupported_multi_page":
          return fail("unsupported_multi_page", cause.message);
        case "pixel_cap_exceeded":
        case "channel_cap_exceeded":
        case "decoded_size_cap_exceeded":
        case "output_size_cap_exceeded":
          return fail("raster_limit_exceeded", cause.message);
        case "decode_failed":
          return fail("decode_failed", cause.message);
      }
    }
    return fail(
      "decode_failed",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}

// Worker entrypoint. The parent constructs us with `workerData` set
// to the PasteWorkerInput; we run once and postMessage the result.
//
// We post a plain message (no transfer list). Node's structured-clone
// boundary copies the pngBytes ArrayBuffer — bounded independently by the
// canonical PNG output cap. Typical screenshot payloads cost ~5-10ms on a
// modern Mac, which is comfortably inside the
// 300ms budget. Skipping the transferList keeps the typing clean
// (DOM lib's `Transferable` type doesn't include SharedArrayBuffer-
// shaped ArrayBufferLikes that Node's Buffer.buffer is typed as).
if (parentPort !== null) {
  const input = workerData as PasteWorkerInput;
  void processImageInput(input).then((result) => {
    if (parentPort === null) return;
    parentPort.postMessage(result);
  });
}
