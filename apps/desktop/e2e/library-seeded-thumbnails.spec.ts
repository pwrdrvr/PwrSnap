// Seeded image captures must render in the Library grid.
//
// The bridge's `seedCapture` / `seedCaptures` used to insert bare rows
// stamped `bundle_format_version: 2` with no `.pwrsnap` behind them. The
// render coordinator is v2-only and throws for such a row, so every
// `pwrsnap-cache://r/<id>/400w.webp` failed and the grid showed broken-
// image icons for the whole suite. Nothing noticed, because every spec
// asserted rows and layout, never pixels. This one asserts that the
// thumbnail actually decoded (naturalWidth > 0), for both seeders, and
// that the seeded row has the production layer tree behind it.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { type Page } from "@playwright/test";
import { expect, type LaunchedApp, launchPwrSnap, test } from "./fixtures/electron-app";

type SeedInput = {
  id: string;
  kind: "image";
  captured_at: string;
  source_app_bundle_id: string;
  source_app_name: string;
  legacy_src_path: string;
  width_px: number;
  height_px: number;
  device_pixel_ratio: number;
  byte_size: number;
  sha256: string;
};

function seedInput(id: string, pngPath: string, offsetMs: number): SeedInput {
  return {
    id,
    kind: "image",
    captured_at: new Date(Date.now() - offsetMs).toISOString(),
    source_app_bundle_id: "com.test.seeded-thumbnails",
    source_app_name: "Seeded Thumbnails Spec",
    legacy_src_path: pngPath,
    // Declared dims differ from the fixture's on purpose: specs size
    // their rows for layout, and the seeder must honour that.
    width_px: 800,
    height_px: 600,
    device_pixel_ratio: 1,
    byte_size: 70,
    sha256: id
  };
}

async function broadcastCapturesChanged(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate((electronModule) => {
    for (const win of electronModule.BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("events:captures:changed", { changedIds: [] });
    }
  });
}

async function thumbnailNaturalWidth(window: Page, id: string): Promise<number> {
  return window.evaluate((targetId) => {
    const img = document.querySelector<HTMLImageElement>(
      `.psl__cell[data-cell-id="${targetId}"] img`
    );
    return img !== null && img.complete ? img.naturalWidth : 0;
  }, id);
}

test("seeded image captures render real thumbnails in the Library grid", async () => {
  const app = await launchPwrSnap({ windowSize: { width: 1440, height: 900 } });
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-seeded-thumbs-"));
    const pngPath = path.join(dir, "fixture.png");
    await writeFile(
      pngPath,
      await sharp({
        create: { width: 4, height: 3, channels: 3, background: { r: 40, g: 160, b: 90 } }
      })
        .png()
        .toBuffer()
    );

    const singleId = "seeded-thumb-single";
    const batchIds = ["seeded-thumb-batch-0", "seeded-thumb-batch-1", "seeded-thumb-batch-2"];
    await app.electronApp.evaluate(
      async (
        _electron,
        payload: { single: SeedInput; batch: SeedInput[] }
      ) => {
        const bridge = (
          globalThis as unknown as {
            __PWRSNAP_TEST__: {
              seedCapture: (input: SeedInput) => Promise<unknown>;
              seedCaptures: (inputs: SeedInput[]) => Promise<unknown>;
            };
          }
        ).__PWRSNAP_TEST__;
        await bridge.seedCapture(payload.single);
        await bridge.seedCaptures(payload.batch);
      },
      {
        single: seedInput(singleId, pngPath, 0),
        batch: batchIds.map((id, index) => seedInput(id, pngPath, (index + 1) * 1000))
      }
    );

    // The production shape: a root group plus one Source raster at the
    // declared canvas dims.
    const layers = await app.dispatch("layers:list", { captureId: singleId });
    expect(layers.ok).toBe(true);
    if (layers.ok) {
      expect(layers.value.map((layer) => layer.kind).sort()).toEqual(["group", "raster"]);
      const raster = layers.value.find((layer) => layer.kind === "raster");
      expect(raster?.kind === "raster" ? raster.natural_width_px : null).toBe(800);
    }

    await broadcastCapturesChanged(app);
    const window = app.window;
    for (const id of [singleId, ...batchIds]) {
      await expect
        .poll(() => thumbnailNaturalWidth(window, id), {
          message: `thumbnail for ${id} should decode (naturalWidth > 0)`,
          timeout: 15_000
        })
        .toBeGreaterThan(0);
    }
  } finally {
    await app.close();
  }
});
