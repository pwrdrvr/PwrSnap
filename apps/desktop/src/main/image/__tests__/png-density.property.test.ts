import fc from "fast-check";
import sharp from "sharp";
import { expect, test } from "vitest";
import { pngWithDensity } from "../png-density";

function chunks(png: Buffer): Array<{ type: string; bytes: Buffer }> {
  const result = [];
  for (let start = 8; start < png.length; ) {
    const end = start + 12 + png.readUInt32BE(start);
    result.push({ type: png.toString("ascii", start + 4, start + 8), bytes: png.subarray(start, end) });
    start = end;
  }
  return result;
}

function moveExif(png: Buffer, before: "IDAT" | "IEND"): Buffer {
  const all = chunks(png);
  const exif = all.find(({ type }) => type === "eXIf")!;
  const rest = all.filter(({ type }) => type !== "eXIf");
  rest.splice(rest.findIndex(({ type }) => type === before), 0, exif);
  return Buffer.concat([png.subarray(0, 8), ...rest.map(({ bytes }) => bytes)]);
}

async function checkTrailingExif(sourceDpi: number, copiedDpi: number, keepPhys: boolean): Promise<void> {
  const encoded = await sharp({
    create: { width: 16, height: 9, channels: 3, background: "orange" }
  }).withMetadata({ density: sourceDpi, orientation: 6 }).png().toBuffer();
  const source = moveExif(keepPhys ? encoded : Buffer.concat([
    encoded.subarray(0, 8),
    ...chunks(encoded).filter(({ type }) => type !== "pHYs").map(({ bytes }) => bytes)
  ]), "IEND");
  const copied = pngWithDensity(source, copiedDpi);
  const unrelated = (png: Buffer) => chunks(png).filter(({ type }) => type !== "pHYs" && type !== "eXIf");
  expect(unrelated(copied)).toEqual(unrelated(source));
  const copiedChunks = chunks(copied);
  const order = copiedChunks.map(({ type }) => type);
  expect(order.filter((type) => type === "pHYs")).toHaveLength(1);
  expect(order.indexOf("pHYs")).toBeLessThan(order.indexOf("IDAT"));
  expect(order.indexOf("eXIf")).toBeGreaterThan(order.lastIndexOf("IDAT"));
  const pngWithoutExif = Buffer.concat([
    copied.subarray(0, 8),
    ...copiedChunks.filter(({ type }) => type !== "eXIf").map(({ bytes }) => bytes)
  ]);
  expect((await sharp(pngWithoutExif).metadata()).density).toBe(copiedDpi);

  // Some readers ignore trailing EXIF. Put the same chunk before IDAT so
  // sharp can tell us the EXIF resolution independently of its location.
  const metadata = await sharp(moveExif(copied, "IDAT")).metadata();
  expect(metadata.orientation).toBe(6);
  expect(metadata.density).toBe(copiedDpi);
}

test("rewrites 216 DPI EXIF after IDAT when copying at 144 DPI", async () => {
  await checkTrailingExif(216, 144, true);
});

test("legacy trailing EXIF agrees with the copy density and keeps image chunks verbatim", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(72, 144, 216),
    fc.constantFrom(72, 144, 216),
    fc.boolean(),
    checkTrailingExif
  ), { numRuns: 20 });
});
