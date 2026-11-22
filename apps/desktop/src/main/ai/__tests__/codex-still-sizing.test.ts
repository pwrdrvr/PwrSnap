import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import sharp from "sharp";
import { expect, test } from "vitest";
import { prepareEnrichmentImage } from "../enrichment-image";
import {
  BALANCED_DISPLAY_POINT_LIMITS, INITIAL_DISPLAY_POINT_LIMITS, displayPointEdge, fitInside
} from "./still-sizing/policy";

test.each([INITIAL_DISPLAY_POINT_LIMITS, BALANCED_DISPLAY_POINT_LIMITS])(
  "chooses the largest rounded aspect-preserving raster within $maxPixels pixels", (limits) => {
    const side = fc.integer({ min: 1, max: 20_000 });
    const density = fc.constantFrom(null, NaN, Infinity, 0, 0.75, 1, 1.25, 1.5, 2, 3, 4);
    fc.assert(fc.property(side, side, density, (width, height, dpr) => {
      const longest = Math.max(width, height);
      const shortest = Math.min(width, height);
      const ratio = dpr !== null && Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
      const edge = displayPointEdge(width, height, dpr, limits);
      // The exhaustive oracle descends from the display-point ceiling. Model
      // the short side with rational half-up rounding, independently of fitInside.
      const ceiling = Math.max(1, Math.min(limits.maxEdgePx, Math.floor(longest / ratio)));
      let expected = ceiling;
      while (expected * Math.max(1, Math.floor((2 * shortest * expected + longest) / (2 * longest))) >
        limits.maxPixels) {
        expected--;
      }
      expect(edge).toBe(expected);
      expect(edge).toBeLessThanOrEqual(longest);
    }), { numRuns: 1_000 });
  }
);

const initialCases = [
  { width: 2880, height: 1866, dpr: 2, expected: [1440, 933] },
  { width: 1351, height: 1801, dpr: 2, expected: [675, 900] },
  { width: 1210, height: 803, dpr: 1, expected: [1210, 803] },
  { width: 1900, height: 803, dpr: null, expected: [1820, 769] },
  { width: 890, height: 1800, dpr: 1.5, expected: [593, 1200] },
  { width: 2416, height: 2416, dpr: 2, expected: [1183, 1183] },
  { width: 6000, height: 7, dpr: 1, expected: [2048, 2] }
];

const balancedCases = [
  { width: 1900, height: 803, dpr: 1, expected: [1900, 803] },
  { width: 2400, height: 1600, dpr: 1, expected: [2400, 1600] },
  { width: 4480, height: 2520, dpr: 2, expected: [2240, 1260] },
  { width: 4800, height: 3200, dpr: 2, expected: [2400, 1600] },
  { width: 5120, height: 2880, dpr: 2, expected: [2400, 1350] },
  { width: 3624, height: 3612, dpr: 1, expected: [1962, 1956] },
  { width: 2400, height: 2400, dpr: null, expected: [1959, 1959] }
];

test.each([
  ...initialCases.map((sample) => ({ ...sample, limits: INITIAL_DISPLAY_POINT_LIMITS })),
  ...balancedCases.map((sample) => ({ ...sample, limits: BALANCED_DISPLAY_POINT_LIMITS }))
])(
  "encodes one bounded WebP raster from $width×$height at $dpr",
  async ({ width, height, dpr, expected, limits }) => {
    const root = await mkdtemp(join(tmpdir(), "pwrsnap-sizing-policy-"));
    try {
      const source = join(root, "source.png");
      await sharp({ create: { width, height, background: "#326d90", channels: 3 } }).png().toFile(source);
      const maxEdgePx = displayPointEdge(width, height, dpr, limits);
      const prepared = await prepareEnrichmentImage(source, {
        format: "webp", maxEdgePx, maxBytes: limits.maxBytes, tempRoot: root
      });
      expect(fitInside(width, height, maxEdgePx)).toEqual({ width: expected[0], height: expected[1] });
      expect([prepared.width, prepared.height]).toEqual(expected);
      expect(prepared.width * prepared.height).toBeLessThanOrEqual(limits.maxPixels);
      expect(prepared.byteSize).toBeLessThanOrEqual(limits.maxBytes);
      await prepared.cleanup();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
);
