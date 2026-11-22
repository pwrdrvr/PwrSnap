import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getVideoFrameSamples, prepareEnrichmentImage } from "../enrichment-image";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = join(tmpdir(), `pwrsnap-enrichment-image-test-${process.pid}-${Date.now()}`);
  await mkdir(tempRoot, { recursive: true });
});

describe("getVideoFrameSamples", () => {
  it("samples videos at 15, 50, and 85 percent", () => {
    expect(getVideoFrameSamples(10)).toEqual([
      { positionPct: 15, timestampSec: 1.5 },
      { positionPct: 50, timestampSec: 5 },
      { positionPct: 85, timestampSec: 8.5 }
    ]);
  });

  it("falls back to the first frame for invalid durations", () => {
    expect(getVideoFrameSamples(0)).toEqual([
      { positionPct: 15, timestampSec: 0 },
      { positionPct: 50, timestampSec: 0 },
      { positionPct: 85, timestampSec: 0 }
    ]);
  });
});

afterEach(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

describe("prepareEnrichmentImage", () => {
  it("downscales to the requested long edge and strips metadata", async () => {
    const sourcePath = join(tempRoot, "source.png");
    await sharp({
      create: {
        width: 2000,
        height: 1000,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 0.5 }
      }
    })
      .png()
      .toFile(sourcePath);

    const prepared = await prepareEnrichmentImage(sourcePath, {
      maxEdgePx: 512,
      tempRoot
    });

    const metadata = await sharp(await readFile(prepared.path)).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(256);
    expect(metadata.exif).toBeUndefined();
    expect(prepared.byteSize).toBe((await stat(prepared.path)).size);
    expect(prepared).toMatchObject({
      sourceWidth: 2000,
      sourceHeight: 1000,
      sourceMimeType: "image/png",
      sentMimeType: "image/jpeg",
      format: "jpeg",
      encoder: "sharp mozjpeg",
      quality: 75,
      maxEdgePx: 512,
      maxBytes: 1_000_000,
      scaleRatio: 0.256
    });

    await prepared.cleanup();
    await expect(access(prepared.path)).rejects.toThrow();
  });

  it("does not upscale small images", async () => {
    const sourcePath = join(tempRoot, "small.png");
    await sharp({
      create: {
        width: 320,
        height: 200,
        channels: 3,
        background: "#eeeeee"
      }
    })
      .png()
      .toFile(sourcePath);

    const prepared = await prepareEnrichmentImage(sourcePath, {
      maxEdgePx: 1024,
      tempRoot
    });

    expect(prepared.width).toBe(320);
    expect(prepared.height).toBe(200);
    expect(prepared.scaleRatio).toBe(1);
    await prepared.cleanup();
  });

  it("encodes an opaque, metadata-free WebP that fits the cap at every tested orientation", async () => {
    const sourceNames: string[] = [];
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 64, max: 1800 }),
      fc.integer({ min: 64, max: 1800 }),
      fc.constantFrom(1, 6, 8),
      async (width, height, orientation) => {
        const sourceName = `oriented-${sourceNames.length}.png`;
        sourceNames.push(sourceName);
        const sourcePath = join(tempRoot, sourceName);
        await sharp({ create: { width, height, channels: 3, background: "#102436" } })
          .png().withMetadata({ orientation }).toFile(sourcePath);
        const prepared = await prepareEnrichmentImage(sourcePath, { format: "webp", tempRoot });
        try {
          const bytes = await readFile(prepared.path);
          const encoded = await sharp(bytes).metadata();
          const longest = Math.max(width, height);
          expect(encoded).toMatchObject({ format: "webp", hasAlpha: false });
          expect(encoded.exif).toBeUndefined();
          expect(encoded.icc).toBeUndefined();
          expect(Math.max(encoded.width, encoded.height)).toBe(Math.min(longest, 1024));
          const scale = Math.min(1, 1024 / longest);
          const orientedWidth = orientation === 1 ? width : height;
          const orientedHeight = orientation === 1 ? height : width;
          expect(Math.abs(encoded.width - Math.round(orientedWidth * scale))).toBeLessThanOrEqual(1);
          expect(Math.abs(encoded.height - Math.round(orientedHeight * scale))).toBeLessThanOrEqual(1);
          expect(prepared).toMatchObject({ width: encoded.width, height: encoded.height, byteSize: bytes.length });
          expect(prepared.byteSize).toBeLessThanOrEqual(1_000_000);
        } finally {
          await prepared.cleanup();
        }
      }
    ), { numRuns: 24 });
    expect((await readdir(tempRoot)).sort()).toEqual(sourceNames.sort());
  });

  it.each(["jpeg", "webp"] as const)("cleans up if %s exceeds the byte cap", async (format) => {
    const sourcePath = join(tempRoot, "source.png");
    await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: "#123456"
      }
    })
      .png()
      .toFile(sourcePath);

    await expect(
      prepareEnrichmentImage(sourcePath, {
        format,
        maxBytes: 12,
        tempRoot
      })
    ).rejects.toThrow(/byte limit/);
    expect(await readdir(tempRoot)).toEqual(["source.png"]);
  });
});
