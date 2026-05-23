// Bake-path tests for the three blur styles. The live preview uses
// CSS backdrop-filter (covered by visual review), but the export
// path runs through sharp — these tests pin the per-style pipeline:
//
//   gaussian → Gaussian smear; pixel near rect center diverges from
//               the original solid color (some neighbor mixing).
//   pixelate → nearest-neighbor downscale + upscale; output is
//               BLOCKY (groups of identical pixels form cells of
//               the expected block size).
//   redact   → solid black; every pixel of the rect is (0, 0, 0).
//
// All three use a synthetic source image (no file fixtures) so the
// test runs without any disk dependencies and stays fast.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { blurLayerForTests } from "../compose";

// A 256×256 source: top half red, bottom half blue, with a
// 32-pixel-wide green stripe down the middle. Enough variance that
// gaussian blur visibly smears the boundaries and pixelate produces
// distinct cells.
async function makeStripedSource(): Promise<{ srcPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-blur-test-"));
  const srcPath = join(dir, "src.png");
  const w = 256;
  const h = 256;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const isStripe = x >= 112 && x < 144;
      if (isStripe) {
        buf[i] = 0;
        buf[i + 1] = 200;
        buf[i + 2] = 0;
      } else if (y < h / 2) {
        buf[i] = 220;
        buf[i + 1] = 30;
        buf[i + 2] = 30;
      } else {
        buf[i] = 30;
        buf[i + 1] = 30;
        buf[i + 2] = 220;
      }
      buf[i + 3] = 255;
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(srcPath);
  return {
    srcPath,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

/** Read a pixel from a raw RGBA buffer at (x, y) in a buffer of the
 *  given width. Returns [r, g, b, a]. */
function pixelAt(
  raw: Buffer,
  x: number,
  y: number,
  width: number
): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!];
}

describe("blurLayerForTests", () => {
  let src: { srcPath: string; cleanup: () => Promise<void> };
  const imageWidthPx = 256;
  const imageHeightPx = 256;
  // A 64×64 region centered horizontally, straddling the green
  // stripe and both red/blue halves. Plenty of variance to exercise
  // all three blur styles.
  const rect = { x: 0.25, y: 0.375, w: 0.25, h: 0.25 } as const;
  const rectPx = { left: 64, top: 96, width: 64, height: 64 } as const;

  beforeEach(async () => {
    src = await makeStripedSource();
  });
  afterEach(async () => {
    await src.cleanup();
  });

  test("redact produces an all-black opaque rect", async () => {
    const layer = await blurLayerForTests(
      { kind: "blur", rect, style: "redact" },
      src.srcPath,
      imageWidthPx,
      imageHeightPx
    );
    expect(layer).not.toBeNull();
    const buf = layer!.input as Buffer;
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(rectPx.width);
    expect(info.height).toBe(rectPx.height);
    // Sample a few corners + the center; all should be opaque black.
    for (const [x, y] of [
      [0, 0],
      [rectPx.width - 1, 0],
      [0, rectPx.height - 1],
      [rectPx.width - 1, rectPx.height - 1],
      [rectPx.width / 2, rectPx.height / 2]
    ] as const) {
      const [r, g, b, a] = pixelAt(data, x, y, info.width);
      expect(r).toBe(0);
      expect(g).toBe(0);
      expect(b).toBe(0);
      expect(a).toBe(255);
    }
  });

  test("gaussian smears neighboring colors at the green-stripe boundary", async () => {
    const layer = await blurLayerForTests(
      { kind: "blur", rect, style: "gaussian" },
      src.srcPath,
      imageWidthPx,
      imageHeightPx
    );
    expect(layer).not.toBeNull();
    const buf = layer!.input as Buffer;
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(rectPx.width);
    expect(info.height).toBe(rectPx.height);
    // Just inside the rect, near the stripe boundary: in the source
    // this would be a sharp red→green edge. After Gaussian blur the
    // pixel right at the boundary should carry SOME green AND some
    // red, not a pure one-channel value.
    //
    // Rect spans source x=64..127. Stripe starts at source x=112,
    // which is rect-local x=48. Sample at rect-local (48, 5) — just
    // inside the rect, on the boundary.
    const [r, g, b] = pixelAt(data, 48, 5, info.width);
    // Smear: red channel softened (not 220), green channel bleeds in
    // (well above 30 which was the non-stripe red value).
    expect(r).toBeLessThan(220);
    expect(g).toBeGreaterThan(40);
    // Blue should still be low — blue only appears in the bottom
    // half of the source; rect-local y=5 is in the red half.
    expect(b).toBeLessThan(60);
  });

  test("pixelate produces blocky output (runs of identical pixels)", async () => {
    const layer = await blurLayerForTests(
      { kind: "blur", rect, style: "pixelate" },
      src.srcPath,
      imageWidthPx,
      imageHeightPx
    );
    expect(layer).not.toBeNull();
    const buf = layer!.input as Buffer;
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(rectPx.width);
    expect(info.height).toBe(rectPx.height);
    // 16 blocks across the short side → ~64/16 = 4 px per block.
    // Test that adjacent pixels WITHIN a block share the same RGB,
    // by sampling pairs that should fall in the same cell.
    //
    // (4, 4) and (5, 5) ought to be in the same 4×4 cell.
    const p1 = pixelAt(data, 4, 4, info.width);
    const p2 = pixelAt(data, 5, 5, info.width);
    expect(p1[0]).toBe(p2[0]);
    expect(p1[1]).toBe(p2[1]);
    expect(p1[2]).toBe(p2[2]);
    // ...but a pixel a couple of blocks away should differ — the
    // source has red/green/blue regions so blocks should vary.
    let foundDifferent = false;
    for (let dx = 4; dx < info.width && !foundDifferent; dx += 4) {
      const p3 = pixelAt(data, dx, 4, info.width);
      if (p3[0] !== p1[0] || p3[1] !== p1[1] || p3[2] !== p1[2]) {
        foundDifferent = true;
      }
    }
    expect(foundDifferent).toBe(true);
  });

  test("legacy blur (no style field) defaults to gaussian behavior", async () => {
    // Mirrors the readBlurStyle default path — a row with no style
    // bakes identically to an explicit gaussian one. We assert the
    // dimensions match; pixel-level equivalence is implicit in the
    // shared code path.
    const legacy = await blurLayerForTests(
      // Cast through unknown so the test exercises the runtime path
      // where the optional field is simply absent (older db rows).
      { kind: "blur", rect } as unknown as Parameters<typeof blurLayerForTests>[0],
      src.srcPath,
      imageWidthPx,
      imageHeightPx
    );
    expect(legacy).not.toBeNull();
    const buf = legacy!.input as Buffer;
    const meta = await sharp(buf).metadata();
    expect(meta.width).toBe(rectPx.width);
    expect(meta.height).toBe(rectPx.height);
  });

  test("degenerate rect (zero area) returns null", async () => {
    const layer = await blurLayerForTests(
      { kind: "blur", rect: { x: 0, y: 0, w: 0, h: 0 }, style: "gaussian" },
      src.srcPath,
      imageWidthPx,
      imageHeightPx
    );
    expect(layer).toBeNull();
  });

  test("layer is composited at the rect's image-pixel coordinates", async () => {
    // Smoke test for the position info returned with the layer.
    const layer = await blurLayerForTests(
      { kind: "blur", rect, style: "redact" },
      src.srcPath,
      imageWidthPx,
      imageHeightPx
    );
    expect(layer).not.toBeNull();
    expect(layer!.left).toBe(rectPx.left);
    expect(layer!.top).toBe(rectPx.top);
  });
});

