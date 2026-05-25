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
//   { kind: "decode-path"; path: string }
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
import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import { MAX_IMAGE_DIM_PX, PASTE_IMAGE_MAX_BYTES } from "@pwrsnap/shared";

export type PasteWorkerInput =
  | { kind: "decode-buffer"; bytes: Uint8Array }
  | { kind: "decode-path"; path: string };

export type PasteWorkerErrorCode =
  | "size_cap_exceeded"
  | "read_failed"
  | "decode_failed"
  | "invalid_dimensions";

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
  let inputBytes: Buffer;
  try {
    if (input.kind === "decode-buffer") {
      inputBytes = Buffer.from(input.bytes);
    } else {
      inputBytes = await readFile(input.path);
    }
  } catch (cause) {
    return fail(
      "read_failed",
      cause instanceof Error ? cause.message : String(cause)
    );
  }

  if (inputBytes.byteLength === 0) {
    return fail("read_failed", "input was empty");
  }
  if (inputBytes.byteLength > PASTE_IMAGE_MAX_BYTES) {
    return fail(
      "size_cap_exceeded",
      `input exceeds ${PASTE_IMAGE_MAX_BYTES} byte cap (${inputBytes.byteLength})`
    );
  }

  // Decode-probe + re-encode to PNG in one pass. sharp throws on
  // malformed input; metadata() alone would catch corruption but
  // doesn't guarantee the bytes are encodable as PNG (some sharp
  // input parsers tolerate broken streams that fail re-encode).
  let pngBytes: Buffer;
  let widthPx: number;
  let heightPx: number;
  try {
    const pipeline = sharp(inputBytes);
    const meta = await pipeline.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w === 0 || h === 0 || w > MAX_IMAGE_DIM_PX || h > MAX_IMAGE_DIM_PX) {
      return fail(
        "invalid_dimensions",
        `dimensions ${w}x${h} invalid or exceed ${MAX_IMAGE_DIM_PX}`
      );
    }
    pngBytes = await pipeline.png().toBuffer();
    widthPx = w;
    heightPx = h;
  } catch (cause) {
    return fail(
      "decode_failed",
      cause instanceof Error ? cause.message : String(cause)
    );
  }

  // sha256 of the canonical PNG bytes — what we'll store at
  // sources/<sha>.png. Streaming-style update for symmetry with the
  // bundle reader's verify path even though the buffer's already
  // resident; the cost is negligible vs the decode above.
  const hash = createHash("sha256");
  hash.update(pngBytes);
  const sha256 = hash.digest("hex");

  return { ok: true, sha256, widthPx, heightPx, pngBytes };
}

// Worker entrypoint. The parent constructs us with `workerData` set
// to the PasteWorkerInput; we run once and postMessage the result.
//
// We post a plain message (no transfer list). Node's structured-clone
// boundary copies the pngBytes ArrayBuffer — at the 32 MiB cap this
// costs ~5-10ms on a modern Mac, which is comfortably inside the
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
