// The seeder's synthetic source image. Two properties matter beyond
// "it decodes": every row's bytes are unique (the index block), and the
// PNG has NO alpha channel. The second one is a speed contract: with an
// alpha channel, `persistCaptureFromTempV2` runs a full `stats()` decode
// per row to probe transparency (source-alpha.ts), which measured
// ~7–11 ms a row and was the largest single cost of seeding.

import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, test } from "vitest";

import { SYNTHETIC_BUNDLE_IDS } from "../profiles";
import { composeSyntheticPng, SYNTHETIC_PNG_SIZE_PX } from "../synthetic-png";

const bundleId = SYNTHETIC_BUNDLE_IDS[0]!;

describe("composeSyntheticPng", () => {
  test("is a 64×64 opaque RGB PNG with no alpha channel", async () => {
    const png = await composeSyntheticPng({ index: 0, bundleId });
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(SYNTHETIC_PNG_SIZE_PX);
    expect(meta.height).toBe(SYNTHETIC_PNG_SIZE_PX);
    expect(meta.channels).toBe(3);
    expect(meta.hasAlpha).toBe(false);
  });

  test("paints the row index into the top-left block and the hue elsewhere", async () => {
    const index = 0x030201;
    const png = await composeSyntheticPng({ index, bundleId });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number): number[] => {
      const o = (y * info.width + x) * info.channels;
      return [data[o]!, data[o + 1]!, data[o + 2]!];
    };
    expect(at(0, 0)).toEqual([0x01, 0x02, 0x03]);
    expect(at(7, 7)).toEqual([0x01, 0x02, 0x03]);
    const background = at(63, 63);
    expect(background).not.toEqual([0x01, 0x02, 0x03]);
    expect(at(8, 0)).toEqual(background);
    expect(at(0, 8)).toEqual(background);
  });

  test("gives every row distinct bytes, and the same row the same bytes", async () => {
    const hashes = new Set<string>();
    for (let index = 0; index < 50; index++) {
      const png = await composeSyntheticPng({ index, bundleId });
      hashes.add(createHash("sha256").update(png).digest("hex"));
    }
    expect(hashes.size).toBe(50);

    const a = await composeSyntheticPng({ index: 7, bundleId });
    const b = await composeSyntheticPng({ index: 7, bundleId });
    expect(a.equals(b)).toBe(true);
  });
});
