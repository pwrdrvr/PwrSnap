// Cursor-capture Phase 3 — persist-level contract for the optional
// cursor layer: `persistCaptureFromTempV2({ cursorLayer })` must
//
//   1. embed the sprite as a second content-addressed bundle source,
//   2. seed a "Cursor" raster layer ABOVE the base Source (z_index 1)
//      whose transform places the sprite at the given canvas position
//      and scales the sprite's natural raster onto its draw box
//      (Retina / enlarged-cursor sprites carry more pixels than their
//      on-screen point size), and
//   3. never fail the capture when the sprite is garbage — the cursor
//      layer is a best-effort nicety; the screenshot must persist.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

let testDataRoot: string;
let testDocumentsRoot: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return testDataRoot;
      if (name === "documents") return testDocumentsRoot;
      if (name === "temp") return testDataRoot;
      return testDataRoot;
    },
    isPackaged: false,
    on: () => undefined
  },
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const { openDatabase, closeDatabase } = await import("../db");
const { persistCaptureFromTempV2 } = await import("../bundle-store");
const { listLayerTree } = await import("../layers-repo");

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-cursor-layer-"));
  testDataRoot = workDir;
  testDocumentsRoot = join(workDir, "documents");
  await mkdir(testDocumentsRoot, { recursive: true });
  process.env.PWRSNAP_DATA_ROOT = workDir;
  await openDatabase();
});

afterAll(async () => {
  closeDatabase();
  delete process.env.PWRSNAP_DATA_ROOT;
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

async function makeTempScreenshot(): Promise<string> {
  const png = await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 30, g: 30, b: 30 }
    }
  })
    .png()
    .toBuffer();
  const p = join(workDir, `shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(p, png);
  return p;
}

/** A 32×48 sprite standing in for a Retina cursor whose natural raster
 *  (32×48 px) is 2× its 16×24-point draw size at 1×. */
async function makeCursorSprite(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 48,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0.9 }
    }
  })
    .png()
    .toBuffer();
}

describe("persistCaptureFromTempV2 — cursor layer", () => {
  test("embeds the sprite and seeds a Cursor raster above the Source", async () => {
    const tempPath = await makeTempScreenshot();
    const sprite = await makeCursorSprite();
    const spriteSha = createHash("sha256").update(sprite).digest("hex");

    const { record } = await persistCaptureFromTempV2({
      tempPath,
      sourceApp: null,
      cursorLayer: {
        pngBytes: sprite,
        xPx: 100,
        yPx: 80,
        drawWidthPx: 16,
        drawHeightPx: 24
      }
    });

    const layers = listLayerTree(record.id);
    const cursor = layers.find((l) => l.kind === "raster" && l.name === "Cursor");
    expect(cursor).toBeDefined();
    if (cursor === undefined || cursor.kind !== "raster") throw new Error("unreachable");
    expect(cursor.source_ref).toEqual({ kind: "embedded", sha256: spriteSha });
    expect(cursor.natural_width_px).toBe(32);
    expect(cursor.natural_height_px).toBe(48);
    // Draw box 16×24 from a 32×48 natural → scale 0.5 on both axes;
    // positioned at the given canvas pixels.
    expect(cursor.transform).toEqual([0.5, 0, 0, 0.5, 100, 80]);
    // Stacked above the base Source (z 0) — deletable annotation, not base.
    expect(cursor.z_index).toBe(1);
    const base = layers.find((l) => l.kind === "raster" && l.name === "Source");
    expect(base).toBeDefined();
    expect(base!.z_index).toBe(0);
  });

  test("a corrupt sprite is dropped without failing the capture", async () => {
    const tempPath = await makeTempScreenshot();
    const { record } = await persistCaptureFromTempV2({
      tempPath,
      sourceApp: null,
      cursorLayer: {
        pngBytes: Buffer.from("not a png"),
        xPx: 10,
        yPx: 10,
        drawWidthPx: 16,
        drawHeightPx: 24
      }
    });
    const layers = listLayerTree(record.id);
    expect(layers.some((l) => l.kind === "raster" && l.name === "Cursor")).toBe(false);
    expect(layers.some((l) => l.kind === "raster" && l.name === "Source")).toBe(true);
  });

  test("no cursorLayer → tree is exactly root group + Source (unchanged baseline)", async () => {
    const tempPath = await makeTempScreenshot();
    const { record } = await persistCaptureFromTempV2({ tempPath, sourceApp: null });
    const layers = listLayerTree(record.id);
    expect(layers).toHaveLength(2);
    expect(layers.map((l) => l.kind).sort()).toEqual(["group", "raster"]);
  });
});
