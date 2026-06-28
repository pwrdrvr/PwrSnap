// Shared E2E helpers for editor / Layers-panel specs: seed a v2 image,
// open it in Library Focus, pick a tool, and draw annotations. Extracted
// so a fixture bug or bridge-shape change is fixed in ONE place rather
// than copy-pasted across editor-drag-undo / library-layers-panel specs.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import sharp from "sharp";
import type { LaunchedApp } from "./electron-app";

/** Primary modifier for the platform (⌘ on macOS, Ctrl elsewhere). */
export function accel(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

/** Poll `layers:list` until the capture has exactly `count` layers. */
export async function expectLayerCount(
  app: LaunchedApp,
  captureId: string,
  count: number
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await app.dispatch("layers:list", { captureId });
      if (!result.ok) return -1;
      return result.value.length;
    })
    .toBe(count);
}

/** Seed a v2 image capture via the test bridge. Returns the capture id. */
export async function seedImageCapture(
  app: LaunchedApp,
  opts: { idPrefix?: string; sourceName?: string } = {}
): Promise<string> {
  const { idPrefix = "img", sourceName = "Editor Spec" } = opts;
  const dir = await mkdtemp(path.join(os.tmpdir(), `pwrsnap-${idPrefix}-spec-`));
  const pngPath = path.join(dir, "fixture.png");
  // 1×1 transparent PNG — loaded via pwrsnap-capture://, never decoded.
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `${idPrefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await app.electronApp.evaluate(
    (_electron, payload: { id: string; pngPath: string; sourceName: string }) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            seedCapture: (input: {
              id: string;
              kind: "image" | "video";
              captured_at: string;
              source_app_bundle_id: string | null;
              source_app_name: string | null;
              legacy_src_path: string | null;
              width_px: number;
              height_px: number;
              device_pixel_ratio: number;
              byte_size: number;
              sha256: string;
              bundle_format_version?: number;
            }) => unknown;
          };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.id,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.spec",
        source_app_name: payload.sourceName,
        legacy_src_path: payload.pngPath,
        width_px: 800,
        height_px: 600,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id,
        bundle_format_version: 2
      });
    },
    { id: captureId, pngPath, sourceName }
  );
  return captureId;
}

/** Seed a REAL raster-backed v2 capture (root group + raster at the PNG's
 *  natural dims) through the production persistCaptureFromTempV2 pipeline —
 *  for specs that need an actual base image layer (crop / source-hide),
 *  which the record-only `seedImageCapture` doesn't create. The output dir
 *  is pinned under a tmpdir so the bundle never lands in the host's real
 *  ~/Documents/PwrSnap. */
export async function seedRasterCapture(
  app: LaunchedApp,
  opts: { widthPx?: number; heightPx?: number; appName?: string } = {}
): Promise<string> {
  const { widthPx = 800, heightPx = 600, appName = "Raster Spec" } = opts;
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-raster-src-"));
  const pngPath = path.join(dir, "fixture.png");
  const buf = await sharp({
    create: { width: widthPx, height: heightPx, channels: 3, background: { r: 30, g: 144, b: 255 } }
  })
    .png()
    .toBuffer();
  await writeFile(pngPath, buf);
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-raster-out-"));
  return await app.electronApp.evaluate(
    async (_electron, payload: { tempPath: string; outputDir: string; appName: string }) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            persistBundleCapture: (input: {
              tempPath: string;
              sourceApp: { bundleId: string | null; appName: string | null } | null;
              outputDir?: string;
            }) => Promise<{ record: { id: string } }>;
          };
        }
      ).__PWRSNAP_TEST__;
      const { record } = await bridge.persistBundleCapture({
        tempPath: payload.tempPath,
        sourceApp: { bundleId: "com.test.raster", appName: payload.appName },
        outputDir: payload.outputDir
      });
      return record.id;
    },
    { tempPath: pngPath, outputDir, appName }
  );
}

/** Flip a layer's `visible` flag by kind (raster / vector-crop) via the
 *  bridge — mirrors the Layers panel's setLayerVisibility → layers:update. */
export async function setLayerVisibleByKind(
  app: LaunchedApp,
  captureId: string,
  match: "raster" | "crop",
  visible: boolean
): Promise<void> {
  await app.electronApp.evaluate(
    async (_electron, payload: { captureId: string; match: string; visible: boolean }) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            dispatch: (n: string, r: unknown) => Promise<{ ok: boolean; value?: unknown }>;
          };
        }
      ).__PWRSNAP_TEST__;
      const listed = await bridge.dispatch("layers:list", { captureId: payload.captureId });
      const layers = (listed.value ?? []) as Array<{
        id: string;
        kind: string;
        shape?: { kind: string };
      }>;
      const target =
        payload.match === "crop"
          ? layers.find((l) => l.kind === "vector" && l.shape?.kind === "crop")
          : layers.find((l) => l.kind === "raster");
      if (target === undefined) throw new Error(`no ${payload.match} layer to toggle`);
      const up = await bridge.dispatch("layers:update", {
        captureId: payload.captureId,
        layer: { ...target, visible: payload.visible }
      });
      if (!up.ok) throw new Error("layers:update failed");
    },
    { captureId, match, visible }
  );
}

/** Open a capture in Library Focus and wait for the editor toolbar. */
export async function openEditorFocus(
  app: LaunchedApp,
  captureId: string
): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok, "editor:open should succeed").toBe(true);
  const page = app.window;
  await page.locator(".psl__focus").waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('.psl__edit-toolbar button[data-tool="arrow"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

/** Open a capture in Library Focus and wait for the source `<img>` to
 *  render — the variant the crop/source specs use (they measure or toggle
 *  the rendered image, not the toolbar). */
export async function openEditorImage(
  app: LaunchedApp,
  captureId: string
): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok, "editor:open should succeed").toBe(true);
  const page = app.window;
  await page.locator(".psl__focus").waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('[data-testid="editor-image"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

/** Click a tool in the floating edit toolbar and confirm it's active. */
export async function selectTool(win: Page, tool: string): Promise<void> {
  await win.locator(`.psl__edit-toolbar button[data-tool="${tool}"]`).click();
  await expect(
    win.locator(`.psl__edit-toolbar button[data-tool="${tool}"].is-active`)
  ).toHaveCount(1);
}

/** Draw an annotation by dragging across the canvas in normalized coords.
 *  Two-step move so the renderer's pointermove fires and the drag clears
 *  MIN_DRAG_LENGTH. */
export async function drawAnnotation(
  win: Page,
  fromXn: number,
  fromYn: number,
  toXn: number,
  toYn: number
): Promise<void> {
  const canvas = win.locator(".editor-canvas");
  await canvas.waitFor({ state: "visible" });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  const from = { x: box.x + box.width * fromXn, y: box.y + box.height * fromYn };
  const to = { x: box.x + box.width * toXn, y: box.y + box.height * toYn };
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await win.mouse.move(to.x, to.y, { steps: 5 });
  await win.mouse.up();
}

/** Draw one annotation in a default central region. */
export async function drawOnCanvas(win: Page): Promise<void> {
  await drawAnnotation(win, 0.25, 0.25, 0.55, 0.55);
}
