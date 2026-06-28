// Unit coverage for `sourceBufferHasAlpha` — the sharp transparency probe
// that feeds `captures.has_alpha`. Real sharp, real PNG bytes, three
// cases that matter:
//   1. RGBA with genuinely transparent pixels → true.
//   2. RGB, no alpha channel → false (cheap path, no stats() decode).
//   3. RGBA but fully opaque (the macOS-screenshot trap) → false. This is
//      the case `metadata().hasAlpha` gets WRONG, so it's the one worth
//      pinning: a normal screenshot must NOT show the grid checker.

import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { sourceBufferHasAlpha } from "../source-alpha";

async function transparentPng(): Promise<Buffer> {
  // A 4×4 RGBA image, fully transparent (alpha 0 everywhere).
  return await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0 }
    }
  })
    .png()
    .toBuffer();
}

async function opaqueRgbPng(): Promise<Buffer> {
  // 3-channel RGB — no alpha channel at all.
  return await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 30, g: 144, b: 255 }
    }
  })
    .png()
    .toBuffer();
}

async function opaqueRgbaPng(): Promise<Buffer> {
  // 4-channel RGBA but alpha 1 (255) everywhere — the screenshot trap.
  return await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 30, g: 144, b: 255, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

describe("sourceBufferHasAlpha", () => {
  test("RGBA with transparent pixels → true", async () => {
    expect(await sourceBufferHasAlpha(await transparentPng())).toBe(true);
  });

  test("RGB with no alpha channel → false", async () => {
    expect(await sourceBufferHasAlpha(await opaqueRgbPng())).toBe(false);
  });

  test("RGBA that is fully opaque → false (not fooled by the alpha channel)", async () => {
    expect(await sourceBufferHasAlpha(await opaqueRgbaPng())).toBe(false);
  });

  test("reuses caller-supplied metadata (no second decode needed)", async () => {
    const buf = await transparentPng();
    const meta = await sharp(buf).metadata();
    expect(await sourceBufferHasAlpha(buf, meta)).toBe(true);
  });
});
