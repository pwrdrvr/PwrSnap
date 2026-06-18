// E2E coverage for the Library DetailRail "Layers" tab. Verifies the
// panel ↔ canvas ↔ IPC loop end-to-end:
//
//   • The Layers tab appears for a v2 image capture opened in Focus
//     (the chromeless editor publishes its LayersPanelApi, which gates
//     the tab in DetailRail).
//   • Drawing an annotation surfaces a row in the panel.
//   • The row's trash button deletes the layer (layers:list drops to 0).
//   • The row's eye button toggles the layer's `visible` flag.
//
// NOTE: the crop → uncrop path is covered at the unit level
// (inverseCropRect round-trip in useCaptureModel.test.ts + the
// crop-routes-to-uncrop assertion in LayersPanel.test.tsx). A full
// E2E uncrop needs a seeded root-group + raster tree (a freshly seeded
// v2 capture has neither, so no crop layer is created and uncrop's
// grow-back hits the natural-dims ceiling) — deferred as a fixture
// follow-up.
//
// Helpers mirror editor-v2-edit-undo-redo.spec.ts.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

test.setTimeout(120_000);

test("library-layers-panel: Layers tab appears for a v2 image and a drawn annotation shows a row that deletes", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openFocus(app, captureId);

    // The Layers tab is gated on the editor publishing its API — wait
    // for it to appear, then open it.
    await win
      .locator('[data-testid="psl-right-tab-layers"]')
      .waitFor({ state: "visible", timeout: 15_000 });

    // Fresh capture: nothing placed yet.
    await expectLayerCount(app, captureId, 0);

    // Draw an arrow → one vector layer.
    await selectTool(win, "arrow");
    await drawOnCanvas(win);
    await expectLayerCount(app, captureId, 1);

    // Open the Layers tab; the arrow shows up as a row.
    await win.locator('[data-testid="psl-right-tab-layers"]').click();
    await win
      .locator('[data-testid="psl-layers"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await expect(win.locator('[data-testid^="layer-row-"]')).toHaveCount(1);

    // Trash the row → the layer is removed via layers:delete.
    await win.locator('[data-testid^="layer-delete-"]').first().click();
    await expectLayerCount(app, captureId, 0);
  } finally {
    await app.close();
  }
});

test("library-layers-panel: the eye toggle flips a layer's visible flag", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openFocus(app, captureId);

    await win
      .locator('[data-testid="psl-right-tab-layers"]')
      .waitFor({ state: "visible", timeout: 15_000 });

    await selectTool(win, "arrow");
    await drawOnCanvas(win);
    await expectLayerCount(app, captureId, 1);

    await win.locator('[data-testid="psl-right-tab-layers"]').click();
    await win
      .locator('[data-testid="psl-layers"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // Layer starts visible.
    expect(await firstLayerVisible(app, captureId)).toBe(true);

    // Click the eye → visible flips to false (the live canvas drops it;
    // here we assert the persisted flag, which is the source of truth).
    await win.locator('[data-testid^="layer-visibility-"]').first().click();
    await expect.poll(async () => firstLayerVisible(app, captureId)).toBe(false);

    // Click again → back to visible.
    await win.locator('[data-testid^="layer-visibility-"]').first().click();
    await expect.poll(async () => firstLayerVisible(app, captureId)).toBe(true);
  } finally {
    await app.close();
  }
});

// ---- Shared helpers --------------------------------------------------

async function expectLayerCount(
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

async function firstLayerVisible(
  app: LaunchedApp,
  captureId: string
): Promise<boolean | null> {
  const result = await app.dispatch("layers:list", { captureId });
  if (!result.ok || result.value.length === 0) return null;
  return result.value[0]!.visible !== false;
}

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-layers-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  // 1×1 transparent PNG — loaded via pwrsnap-capture://, never decoded
  // for the assertions.
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `layers-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await app.electronApp.evaluate(
    (_electron, payload: { id: string; pngPath: string }) => {
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
        source_app_name: "Layers Panel Spec",
        legacy_src_path: payload.pngPath,
        width_px: 800,
        height_px: 600,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id,
        bundle_format_version: 2
      });
    },
    { id: captureId, pngPath }
  );
  return captureId;
}

async function openFocus(app: LaunchedApp, captureId: string): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok, "editor:open should succeed").toBe(true);
  const page = app.window;
  await page.locator(".psl__focus").waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('.psl__edit-toolbar button[data-tool="arrow"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

async function selectTool(win: Page, tool: string): Promise<void> {
  await win.locator(`.psl__edit-toolbar button[data-tool="${tool}"]`).click();
  await expect(
    win.locator(`.psl__edit-toolbar button[data-tool="${tool}"].is-active`)
  ).toHaveCount(1);
}

/** Drag across the canvas to place an annotation. Two-step move so the
 *  renderer's pointermove fires and the drag clears MIN_DRAG_LENGTH. */
async function drawOnCanvas(win: Page): Promise<void> {
  const canvas = win.locator(".editor-canvas");
  await canvas.waitFor({ state: "visible" });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  const from = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.2 };
  const to = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 };
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(
    from.x + (to.x - from.x) / 2,
    from.y + (to.y - from.y) / 2,
    { steps: 5 }
  );
  await win.mouse.move(to.x, to.y, { steps: 5 });
  await win.mouse.up();
}
