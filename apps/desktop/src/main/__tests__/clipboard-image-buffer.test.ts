import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import sharp from "sharp";
import {
  clipboardImageBufferFormats,
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
