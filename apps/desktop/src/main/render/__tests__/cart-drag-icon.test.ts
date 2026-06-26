// Integration test for the cart Zip drag-cursor composer. Uses REAL sharp
// (like the other render bake tests) to confirm the composite actually
// produces a 160×112 rounded RGBA tile with the orange count badge painted —
// i.e. the SVG overlay + dest-in rounding pipeline works end to end, not just
// that the function returns.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, test } from "vitest";

import { composeCartDragIcon } from "../cart-drag-icon";

let dir: string;
let srcPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pwrsnap-drag-icon-test-"));
  srcPath = join(dir, "src.png");
  // A wide "screenshot" in a flat blue so we can tell the orange badge apart.
  const src = await sharp({
    create: { width: 1200, height: 800, channels: 4, background: { r: 60, g: 90, b: 140, alpha: 1 } }
  })
    .png()
    .toBuffer();
  await writeFile(srcPath, src);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function pixelsOf(path: string): Promise<{
  at: (x: number, y: number) => [number, number, number, number];
  width: number;
  height: number;
  hasAlpha: boolean;
}> {
  const meta = await sharp(path).metadata();
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    hasAlpha: meta.hasAlpha === true,
    at: (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
    }
  };
}

test("composes a 160×112 rounded RGBA tile with the orange count badge", async () => {
  const dest = join(dir, "drag.png");
  await composeCartDragIcon({ imagePath: srcPath, count: 3, destPath: dest });

  const px = await pixelsOf(dest);
  expect(px.width).toBe(160);
  expect(px.height).toBe(112);
  expect(px.hasAlpha).toBe(true);

  // Rounded corner → transparent.
  expect(px.at(0, 0)[3]).toBeLessThan(20);

  // Badge center (cx = 160-8-18, cy = 112-8-18), sampled above the digit so we
  // hit the fill, not the dark glyph — should be tangerine ~#ff8a1f.
  const [r, g, b] = px.at(134, 80);
  expect(r).toBeGreaterThan(200);
  expect(g).toBeGreaterThan(90);
  expect(g).toBeLessThan(180);
  expect(b).toBeLessThan(80);
});

test("survives a 3-digit count via the 99+ clamp", async () => {
  const dest = join(dir, "drag-big.png");
  await composeCartDragIcon({ imagePath: srcPath, count: 250, destPath: dest });
  const meta = await sharp(dest).metadata();
  expect(meta.width).toBe(160);
  expect(meta.height).toBe(112);
});
