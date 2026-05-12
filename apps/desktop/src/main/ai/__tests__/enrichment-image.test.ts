import { access, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareEnrichmentImage } from "../enrichment-image";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = join(tmpdir(), `pwrsnap-enrichment-image-test-${process.pid}-${Date.now()}`);
  await mkdir(tempRoot, { recursive: true });
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

    const metadata = await sharp(prepared.path).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(256);
    expect(metadata.exif).toBeUndefined();
    expect(prepared.byteSize).toBe((await stat(prepared.path)).size);

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
    await prepared.cleanup();
  });

  it("cleans up if the derivative exceeds the byte cap", async () => {
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
        maxBytes: 12,
        tempRoot
      })
    ).rejects.toThrow(/byte limit/);
  });
});
