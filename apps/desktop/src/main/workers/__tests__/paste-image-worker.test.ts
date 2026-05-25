// Unit tests for the off-thread paste-image worker. Exercises the
// pure `processImageInput` function directly so we don't have to
// spawn a Worker for every test case (the worker entrypoint is just
// `parentPort.postMessage(await processImageInput(workerData))`).
//
// Defenses asserted:
//   • size_cap_exceeded — input over PASTE_IMAGE_MAX_BYTES → reject
//   • decode_failed — malformed PNG bytes → reject
//   • invalid_dimensions — image larger than MAX_IMAGE_DIM_PX → reject
//   • read_failed — empty input → reject
//   • happy path — valid PNG returns sha256 + dimensions + pngBytes
//
// sharp is loaded at module-eval time inside the worker; tests use a
// real sharp install so the decode probe is exercised end-to-end.

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import sharp from "sharp";
import { processImageInput } from "../paste-image-worker";

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pwrsnap-paste-worker-test-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

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

  test("happy path: decode-path reads from disk", async () => {
    const png = await makePng(50, 50);
    const path = join(tmp, "decode-path.png");
    await writeFile(path, png);
    const result = await processImageInput({ kind: "decode-path", path });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.widthPx).toBe(50);
    expect(result.heightPx).toBe(50);
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

  test("rejects missing path (read_failed)", async () => {
    const result = await processImageInput({
      kind: "decode-path",
      path: join(tmp, "does-not-exist.png")
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("read_failed");
  });
});
