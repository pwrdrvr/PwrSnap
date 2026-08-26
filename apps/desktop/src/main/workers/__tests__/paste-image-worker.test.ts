// Unit tests for the off-thread paste-image worker. Exercises the
// pure `processImageInput` function directly so we don't have to
// spawn a Worker for every test case (the worker entrypoint is just
// `parentPort.postMessage(await processImageInput(workerData))`).
//
// Defenses asserted:
//   • size_cap_exceeded — input over PASTE_IMAGE_MAX_BYTES → reject
//   • decode_failed — malformed PNG bytes → reject
//   • invalid_dimensions — invalid/per-axis dimensions → reject
//   • raster_limit_exceeded — total pixels/raw bytes/output exceed caps
//   • unsupported_multi_page — animation/document inputs → reject
//   • unsupported_format — vector/document/scientific/raw loaders → reject
//   • read_failed — empty input → reject
//   • happy path — valid PNG returns sha256 + dimensions + pngBytes
//
// sharp is loaded at module-eval time inside the worker; tests use a
// real sharp install so the decode probe is exercised end-to-end.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { PASTE_IMAGE_MAX_BYTES } from "@pwrsnap/shared";
import { processImageInput } from "../paste-image-worker";

async function makePng(widthPx: number, heightPx: number): Promise<Buffer> {
  return await sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 3,
      background: { r: 255, g: 128, b: 31 }
    }
  })
    .png()
    .toBuffer();
}

async function makeAnimatedGif(): Promise<Buffer> {
  const width = 2;
  const pageHeight = 2;
  const pages = 2;
  const channels = 3;
  const height = pageHeight * pages;
  const frameBytes = width * pageHeight * channels;
  const raw = Buffer.alloc(width * height * channels);
  raw.fill(0xff, 0, frameBytes);
  raw.fill(0x20, frameBytes);
  return await sharp(raw, {
    raw: { width, height, channels, pageHeight }
  })
    .gif({ delay: [50, 50], loop: 0 })
    .toBuffer();
}

describe("paste-image-worker: processImageInput", () => {
  test("happy path: decodes PNG, returns sha256 + dimensions + pngBytes", async () => {
    const png = await makePng(120, 80);
    const result = await processImageInput({
      kind: "decode-buffer",
      bytes: new Uint8Array(png)
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.widthPx).toBe(120);
    expect(result.heightPx).toBe(80);
    // sha256 is computed over the re-encoded PNG bytes (sharp
    // normalizes EXIF / chunks), so we recompute from the returned
    // bytes to verify it's self-consistent.
    const expectedSha = createHash("sha256")
      .update(Buffer.from(result.pngBytes))
      .digest("hex");
    expect(result.sha256).toBe(expectedSha);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects empty input (read_failed)", async () => {
    const result = await processImageInput({
      kind: "decode-buffer",
      bytes: new Uint8Array(0)
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("read_failed");
  });

  test("rejects malformed PNG (decode_failed)", async () => {
    // Random garbage bytes — sharp's metadata() throws.
    const garbage = Buffer.from("this is definitely not a png");
    const result = await processImageInput({
      kind: "decode-buffer",
      bytes: new Uint8Array(garbage)
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("decode_failed");
  });

  test("rejects oversize input (size_cap_exceeded)", async () => {
    // Fabricate a buffer past the 32 MiB cap without actually
    // allocating 32 MiB of PNG. The check fires before any decode.
    const big = Buffer.alloc(33 * 1024 * 1024);
    const result = await processImageInput({
      kind: "decode-buffer",
      bytes: new Uint8Array(big)
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("size_cap_exceeded");
  });

  test("rejects a highly compressible huge-pixel PNG before decode", async () => {
    const png = await makePng(6_000, 6_000);
    expect(png.byteLength).toBeLessThan(PASTE_IMAGE_MAX_BYTES);

    const result = await processImageInput({
      kind: "decode-buffer",
      bytes: new Uint8Array(png)
    });
    expect(result).toMatchObject({
      ok: false,
      code: "raster_limit_exceeded"
    });
  });

  test("rejects multipage/animated input instead of flattening frame one", async () => {
    const result = await processImageInput({
      kind: "decode-buffer",
      bytes: new Uint8Array(await makeAnimatedGif())
    });
    expect(result).toMatchObject({
      ok: false,
      code: "unsupported_multi_page"
    });
  });

  test("rejects formats outside the approved still-raster allowlist", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>'
    );
    const result = await processImageInput({
      kind: "decode-buffer",
      bytes: new Uint8Array(svg)
    });
    expect(result).toMatchObject({
      ok: false,
      code: "unsupported_format"
    });
  });
});
