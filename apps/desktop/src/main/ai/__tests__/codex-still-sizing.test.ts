import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import sharp from "sharp";
import { expect, test } from "vitest";
import { prepareEnrichmentImage } from "../enrichment-image";
import { DISPLAY_POINT_LIMITS, displayPointEdge, fitInside } from "./still-sizing/policy";

test("chooses the largest rounded aspect-preserving raster inside every display-point bound", () => {
  const side = fc.integer({ min: 1, max: 20_000 });
  const density = fc.constantFrom(null, NaN, Infinity, 0, 0.75, 1, 1.25, 1.5, 2, 3, 4);
  fc.assert(fc.property(side, side, density, (width, height, dpr) => {
    const longest = Math.max(width, height);
    const shortest = Math.min(width, height);
    const ratio = dpr !== null && Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
    const edge = displayPointEdge(width, height, dpr);
    // The exhaustive oracle descends from the display-point ceiling. Model
    // the short side with rational half-up rounding, independently of fitInside.
    const ceiling = Math.max(1, Math.min(DISPLAY_POINT_LIMITS.maxEdgePx, Math.floor(longest / ratio)));
    let expected = ceiling;
    while (expected * Math.max(1, Math.floor((2 * shortest * expected + longest) / (2 * longest))) >
      DISPLAY_POINT_LIMITS.maxPixels) {
      expected--;
    }
    expect(edge).toBe(expected);
    expect(edge).toBeLessThanOrEqual(longest);
  }), { numRuns: 1_000 });
});

test.each([
  { width: 2880, height: 1866, dpr: 2, expected: [1440, 933] },
  { width: 1351, height: 1801, dpr: 2, expected: [675, 900] },
  { width: 1210, height: 803, dpr: 1, expected: [1210, 803] },
  { width: 1900, height: 803, dpr: null, expected: [1820, 769] },
  { width: 890, height: 1800, dpr: 1.5, expected: [593, 1200] },
  { width: 2416, height: 2416, dpr: 2, expected: [1183, 1183] },
  { width: 6000, height: 7, dpr: 1, expected: [2048, 2] }
])("encodes one bounded WebP raster from $width×$height at $dpr", async ({ width, height, dpr, expected }) => {
  const root = await mkdtemp(join(tmpdir(), "pwrsnap-sizing-policy-"));
  try {
    const source = join(root, "source.png");
    await sharp({ create: { width, height, background: "#326d90", channels: 3 } }).png().toFile(source);
    const maxEdgePx = displayPointEdge(width, height, dpr);
    const prepared = await prepareEnrichmentImage(source, {
      format: "webp", maxEdgePx, maxBytes: DISPLAY_POINT_LIMITS.maxBytes, tempRoot: root
    });
    expect(fitInside(width, height, maxEdgePx)).toEqual({ width: expected[0], height: expected[1] });
    expect([prepared.width, prepared.height]).toEqual(expected);
    expect(prepared.width * prepared.height).toBeLessThanOrEqual(DISPLAY_POINT_LIMITS.maxPixels);
    expect(prepared.byteSize).toBeLessThanOrEqual(DISPLAY_POINT_LIMITS.maxBytes);
    await prepared.cleanup();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
