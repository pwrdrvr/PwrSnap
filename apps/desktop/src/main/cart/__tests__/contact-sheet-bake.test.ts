// The baked sheet IS the plan: real sharp, real PNGs. Each tile's pixels
// land where planContactSheet put them, the background between tiles is the
// one asked for, and the hatch tile is seamless.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import { bakeContactSheet, hatchTile } from "../contact-sheet-bake";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function solidPng(dir: string, name: string, width: number, height: number, rgb: [number, number, number]): Promise<string> {
  const path = join(dir, name);
  await sharp({ create: { width, height, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } } })
    .png()
    .toFile(path);
  return path;
}

async function pixel(path: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

describe("bakeContactSheet", () => {
  test("tiles land where the plan says, in cart order, over the chosen background", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-sheet-"));
    roots.push(dir);
    const colors: Array<[number, number, number]> = [
      [230, 40, 40],
      [40, 200, 60],
      [40, 80, 230]
    ];
    const paths = [
      await solidPng(dir, "a.png", 900, 600, colors[0]!),
      await solidPng(dir, "b.png", 900, 600, colors[1]!),
      await solidPng(dir, "c.png", 600, 900, colors[2]!)
    ];
    const dest = join(dir, "sheet.png");
    const { plan } = await bakeContactSheet({
      imagePaths: paths,
      size: "s",
      layout: { columns: 2, spacing: "roomy", background: "white" },
      destPath: dest
    });
    const meta = await sharp(dest).metadata();
    expect([meta.width, meta.height]).toEqual([plan.width, plan.height]);
    for (const [index, tile] of plan.tiles.entries()) {
      const center = await pixel(dest, tile.x + Math.floor(tile.width / 2), tile.y + Math.floor(tile.height / 2));
      expect(center).toEqual([...colors[index]!, 255]);
    }
    // The padding corner is background.
    expect(await pixel(dest, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  test("clear leaves the background transparent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-sheet-"));
    roots.push(dir);
    const dest = join(dir, "sheet.png");
    await bakeContactSheet({
      imagePaths: [await solidPng(dir, "a.png", 400, 300, [10, 20, 30])],
      size: "s",
      layout: { columns: "auto", spacing: "roomy", background: "clear" },
      destPath: dest
    });
    expect((await pixel(dest, 0, 0))[3]).toBe(0);
  });

  test("hatch paints the gutters with the hatch tile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-sheet-"));
    roots.push(dir);
    const dest = join(dir, "sheet.png");
    await bakeContactSheet({
      imagePaths: [await solidPng(dir, "a.png", 400, 300, [250, 250, 250])],
      size: "s",
      layout: { columns: "auto", spacing: "roomy", background: "hatch" },
      destPath: dest
    });
    const tile = hatchTile();
    expect(await pixel(dest, 0, 0)).toEqual([...tile.subarray(0, 4)]);
    expect((await pixel(dest, 0, 0))[3]).toBe(255);
  });

  test("the hatch tile is seamless: color depends only on (x + y) mod period", () => {
    const period = 16;
    const tile = hatchTile(period);
    const at = (x: number, y: number): string => {
      const offset = ((y % period) * period + (x % period)) * 4;
      return [...tile.subarray(offset, offset + 4)].join(",");
    };
    for (let y = 0; y < period * 2; y++) {
      for (let x = 0; x < period * 2; x++) {
        // Moving one step down-left stays on the same stripe, across tile edges too.
        if (x > 0) expect(at(x - 1, y + 1)).toBe(at(x, y));
      }
    }
  });

  test("an abort before the write leaves no sheet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-sheet-"));
    roots.push(dir);
    const controller = new AbortController();
    controller.abort();
    await expect(
      bakeContactSheet({
        imagePaths: [await solidPng(dir, "a.png", 40, 30, [1, 2, 3])],
        size: "s",
        layout: { columns: "auto", spacing: "tight", background: "black" },
        destPath: join(dir, "sheet.png"),
        signal: controller.signal
      })
    ).rejects.toThrow();
    await expect(sharp(join(dir, "sheet.png")).metadata()).rejects.toThrow();
  });
});
