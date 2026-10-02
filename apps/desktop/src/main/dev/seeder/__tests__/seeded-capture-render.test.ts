// A seeded capture must render. Since v1 was removed, the coordinator
// renders only v2 layer-tree bundles and THROWS for anything else, and
// the seeder used to write bare v1 rows (no bundle_path): every grid
// thumbnail of a seeded library was a broken image, and the seed run
// logged one `thumb-render` error per row.
//
// This drives the same path a seed run does, with no mocks below the
// Electron app paths: the synthetic PNG → the `capture:ingest` body →
// a real DB → `renderViaCoordinator` at the Library's grid width. Then
// it decodes the cached render and checks the pixels came from the
// seeded image. A last case pins the bus wiring, so the verb cannot
// quietly go back to inserting a row by hand.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

let userDataRoot = "";

vi.mock("electron", () => ({
  app: {
    getPath: (): string => userDataRoot,
    isPackaged: false,
    on: () => undefined
  },
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

vi.mock("../../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const { openDatabase, closeDatabase } = await import("../../../persistence/db");
const { getCaptureById } = await import("../../../persistence/captures-repo");
const { listLayerTree } = await import("../../../persistence/layers-repo");
const { renderViaCoordinator } = await import("../../../render/coordinator");
const { ingestSyntheticCapture } = await import("../../../capture/synthetic-ingest");
const { composeSyntheticPng } = await import("../synthetic-png");
const { planRows, PROFILES } = await import("../profiles");

let workDir = "";
let dataRoot = "";
const originalDataRoot = process.env.PWRSNAP_DATA_ROOT;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-seeded-render-"));
  // The seeder's layout: a data root that is NOT userData, so every
  // persistence path (captures, render cache) lands under it.
  userDataRoot = join(workDir, "userData");
  dataRoot = join(workDir, "data");
  await mkdir(userDataRoot, { recursive: true });
  process.env.PWRSNAP_DATA_ROOT = dataRoot;
  await openDatabase();
});

afterAll(async () => {
  closeDatabase();
  if (originalDataRoot === undefined) delete process.env.PWRSNAP_DATA_ROOT;
  else process.env.PWRSNAP_DATA_ROOT = originalDataRoot;
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("a seeded capture", () => {
  test("is a v2 bundle that renders through the coordinator", async () => {
    const row = planRows(PROFILES["100"])[5]!;
    const tempPngPath = join(workDir, "seed-row.png");
    await writeFile(tempPngPath, await composeSyntheticPng(row));

    const record = await ingestSyntheticCapture({
      tempPngPath,
      capturedAt: row.capturedAt,
      sourceAppBundleId: row.bundleId,
      sourceAppName: row.appName
    });

    // A real v2 bundle under the seeder's data root, not a bare row.
    expect(record.bundle_format_version).toBe(2);
    expect(record.bundle_path).not.toBeNull();
    expect(resolve(dirname(record.bundle_path!))).toBe(resolve(dataRoot, "captures"));
    expect(existsSync(record.bundle_path!)).toBe(true);
    expect(record.legacy_src_path).toBeNull();
    expect(record.captured_at).toBe(row.capturedAt);
    expect(record.source_app_bundle_id).toBe(row.bundleId);
    expect(record.source_app_name).toBe(row.appName);
    expect(record.width_px).toBe(64);
    expect(record.height_px).toBe(64);
    // Opaque, so the persist skipped the transparency decode.
    expect(record.has_alpha).toBe(false);
    expect(getCaptureById(record.id)?.bundle_path).toBe(record.bundle_path);
    expect(listLayerTree(record.id).some((layer) => layer.kind === "raster")).toBe(true);
    // The verb consumes its temp PNG.
    expect(existsSync(tempPngPath)).toBe(false);

    // Exactly what the seeder's thumb pre-render and the Library's
    // `pwrsnap-cache://r/<id>/400w.webp` request ask for.
    const result = await renderViaCoordinator({
      captureId: record.id,
      srcPath: "",
      imageWidthPx: record.width_px,
      imageHeightPx: record.height_px,
      width: 400,
      format: "webp"
    });
    expect(result.cachePath.startsWith(resolve(dataRoot))).toBe(true);

    const rendered = await readFile(result.cachePath);
    const meta = await sharp(rendered).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBe(meta.width);

    // The pixels are the seeded image's: the index block's color in
    // the top-left, the background hue in the bottom-right.
    const source = await sharp(await composeSyntheticPng(row))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const out = await sharp(rendered).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (
      img: { data: Buffer; info: { width: number; channels: number } },
      x: number,
      y: number
    ): number[] => {
      const o = (y * img.info.width + x) * img.info.channels;
      return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
    };
    const near = (a: number[], b: number[]): boolean =>
      a.every((v, i) => Math.abs(v - b[i]!) <= 12);
    const w = out.info.width;
    expect(near(pixel(out, 1, 1), pixel(source, 1, 1))).toBe(true);
    expect(near(pixel(out, w - 2, w - 2), pixel(source, 62, 62))).toBe(true);
  });

  test("capture:ingest dispatches to ingestSyntheticCapture and inserts no row by hand", async () => {
    const handlersPath = fileURLToPath(
      new URL("../../../handlers/capture-handlers.ts", import.meta.url)
    );
    const source = await readFile(handlersPath, "utf8");
    const start = source.indexOf('bus.register("capture:ingest"');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("bus.register(", start + 1);
    const block = source.slice(start, end === -1 ? undefined : end);
    expect(block).toContain("ingestSyntheticCapture(req)");
    expect(block).not.toMatch(/insertCapture|putCaptureSource/);
  });
});
