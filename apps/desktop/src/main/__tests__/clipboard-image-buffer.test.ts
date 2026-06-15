import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import sharp from "sharp";
import {
  clipboardImageBufferFormats,
  devicePixelRatioFromDensity,
  ingestImageBufferToTempPng,
  writeFirstDecodableClipboardBufferToPng
} from "../clipboard-image-buffer";

async function makeTempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-clipboard-buffer-test-"));
  return join(dir, `${Date.now()}.png`);
}

async function makeTiff(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 70, b: 210 }
    }
  })
    .tiff()
    .toBuffer();
}

async function makePng(width: number, height: number, density?: number): Promise<Buffer> {
  let pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 20, b: 30 }
    }
  });
  if (density !== undefined) pipeline = pipeline.withMetadata({ density });
  return await pipeline.png().toBuffer();
}

describe("clipboard image buffer helpers", () => {
  test("filters native image-like formats without taking MIME or URL formats", () => {
    expect(
      clipboardImageBufferFormats([
        "image/png",
        "public.file-url",
        "public.jp2",
        "com.apple.pict",
        "public.tiff",
        "text/plain"
      ])
    ).toEqual(["public.jp2", "com.apple.pict", "public.tiff"]);
  });

  test("tries later raw image formats after earlier decode failures", async () => {
    const tiff = await makeTiff(144, 81);
    const result = await writeFirstDecodableClipboardBufferToPng({
      formats: ["public.jp2", "public.tiff"],
      readBuffer: (format) => (format === "public.tiff" ? tiff : Buffer.from("not a jp2")),
      makeTempPath
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const metadata = await sharp(await readFile(result.tempPath)).metadata();
    expect(metadata.width).toBe(144);
    expect(metadata.height).toBe(81);
  });

  test("reports every raw image decode failure when none work", async () => {
    const result = await writeFirstDecodableClipboardBufferToPng({
      formats: ["public.jp2", "com.apple.pict", "text/plain"],
      readBuffer: () => Buffer.from("not an image"),
      makeTempPath
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((failure) => failure.source)).toEqual([
      "public.jp2",
      "com.apple.pict"
    ]);
  });
});

describe("devicePixelRatioFromDensity", () => {
  test("maps macOS DPI conventions to a scale factor", () => {
    expect(devicePixelRatioFromDensity(72)).toBe(1);
    expect(devicePixelRatioFromDensity(144)).toBe(2);
    expect(devicePixelRatioFromDensity(216)).toBe(3);
  });

  test("defaults to 1× for missing / non-Retina / nonsensical density", () => {
    expect(devicePixelRatioFromDensity(undefined)).toBe(1);
    expect(devicePixelRatioFromDensity(0)).toBe(1);
    expect(devicePixelRatioFromDensity(-5)).toBe(1);
    expect(devicePixelRatioFromDensity(96)).toBe(1); // Windows 1× DPI
    expect(devicePixelRatioFromDensity(Number.NaN)).toBe(1);
  });

  test("clamps absurdly high density to 3×", () => {
    expect(devicePixelRatioFromDensity(10_000)).toBe(3);
  });
});

describe("ingestImageBufferToTempPng", () => {
  test("preserves PNG bytes verbatim (no re-encode inflation)", async () => {
    const png = await makePng(120, 80, 144);
    const ingested = await ingestImageBufferToTempPng(png, makeTempPath);
    // The stored file must be byte-identical to the source PNG — the whole
    // point of the fix is that pasting doesn't round-trip through an
    // encoder and grow the file.
    expect(Buffer.compare(await readFile(ingested.tempPath), png)).toBe(0);
  });

  test("infers the device pixel ratio from the PNG density", async () => {
    const png = await makePng(120, 80, 144);
    // Compute the expectation from what sharp actually read back so the
    // test is robust to encoder density rounding.
    const meta = await sharp(png).metadata();
    const ingested = await ingestImageBufferToTempPng(png, makeTempPath);
    expect(ingested.devicePixelRatio).toBe(devicePixelRatioFromDensity(meta.density));
  });

  test("re-encodes non-PNG input to a PNG with the same dimensions", async () => {
    const tiff = await makeTiff(144, 81);
    const ingested = await ingestImageBufferToTempPng(tiff, makeTempPath);
    const meta = await sharp(await readFile(ingested.tempPath)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(144);
    expect(meta.height).toBe(81);
  });

  test("throws on undecodable bytes", async () => {
    await expect(
      ingestImageBufferToTempPng(Buffer.from("not an image"), makeTempPath)
    ).rejects.toThrow();
  });
});
