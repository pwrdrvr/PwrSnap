// Shared E2E helpers for editor / Layers-panel specs: seed a v2 image,
// open it in Library Focus, pick a tool, and draw annotations. Extracted
// so a fixture bug or bridge-shape change is fixed in ONE place rather
// than copy-pasted across editor-drag-undo / library-layers-panel specs.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
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
