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
// Spec-specific helpers (openLayersTab, layerRowIds, firstLayerVisible) live
// at the bottom; the shared seed/open/draw machinery comes from
// ./fixtures/editor-helpers so a bridge-shape change is fixed in one place.

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";
import {
  drawAnnotation,
  drawOnCanvas,
  expectLayerCount,
  openEditorFocus,
  seedImageCapture,
  selectTool
} from "./fixtures/editor-helpers";

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

test("library-layers-panel: a resting committed annotation clips to the canvas (overflow hidden)", async () => {
  // Regression guard for the crop-clip fix: committed glyphs render with
  // overflow:hidden so an annotation outside a cropped viewport doesn't
  // bleed past the canvas edge (matching the bake/export). An actively-
  // dragged glyph stays overflow:visible — not exercised here.
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openFocus(app, captureId);

    await selectTool(win, "arrow");
    await drawOnCanvas(win);
    await expectLayerCount(app, captureId, 1);

    const glyph = win.locator('[data-testid="persisted-glyph-svg"]').first();
    await glyph.waitFor({ state: "attached", timeout: 5_000 });
    await expect(glyph).toHaveAttribute("overflow", "hidden");
  } finally {
    await app.close();
  }
});

test("library-layers-panel: keyboard reorder moves the focused layer", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openLayersTab(app, captureId, 2);

    const before = await layerRowIds(win);
    expect(before.length).toBe(2);

    // Focus the TOP row and press ArrowDown → it moves to the bottom.
    await win.locator(`[data-testid="layer-row-${before[0]}"]`).focus();
    await win.keyboard.press("ArrowDown");
    await expect
      .poll(async () => (await layerRowIds(win)).join(","))
      .toBe([before[1], before[0]].join(","));
  } finally {
    await app.close();
  }
});

test("library-layers-panel: drag-and-drop reorders a layer", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openLayersTab(app, captureId, 2);

    const before = await layerRowIds(win);
    expect(before.length).toBe(2);

    // Drag the TOP row's grip down past the bottom row → they swap.
    const grip = win.locator(`[data-testid="layer-grip-${before[0]}"]`);
    const bottom = win.locator(`[data-testid="layer-row-${before[1]}"]`);
    const gb = await grip.boundingBox();
    const bb = await bottom.boundingBox();
    expect(gb).not.toBeNull();
    expect(bb).not.toBeNull();
    if (gb === null || bb === null) return;
    await win.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await win.mouse.down();
    await win.mouse.move(bb.x + bb.width / 2, bb.y + bb.height * 0.5, { steps: 4 });
    await win.mouse.move(bb.x + bb.width / 2, bb.y + bb.height + 6, { steps: 4 });
    await win.mouse.up();

    await expect
      .poll(async () => (await layerRowIds(win)).join(","))
      .toBe([before[1], before[0]].join(","));
  } finally {
    await app.close();
  }
});

// ---- Shared helpers --------------------------------------------------

/** Seed a v2 image, draw `count` arrows in SEPARATE regions (so a later
 *  draw doesn't land on an earlier arrow's transform-handle body and
 *  move it instead of drawing a new one), then open the Layers tab. */
async function openLayersTab(
  app: LaunchedApp,
  captureId: string,
  count: number
): Promise<Page> {
  const win = await openFocus(app, captureId);
  // Diagonal, non-overlapping bands across the canvas.
  for (let i = 0; i < count; i++) {
    const a = 0.1 + (i * 0.8) / Math.max(1, count);
    // eslint-disable-next-line no-await-in-loop
    await selectTool(win, "arrow");
    // eslint-disable-next-line no-await-in-loop
    await drawAnnotation(win, a, a, a + 0.08, a + 0.08);
  }
  await expectLayerCount(app, captureId, count);
  await win.locator('[data-testid="psl-right-tab-layers"]').click();
  await win
    .locator('[data-testid="psl-layers"]')
    .waitFor({ state: "visible", timeout: 5_000 });
  return win;
}

/** The layer ids in the panel's current top-to-bottom row order. */
async function layerRowIds(win: Page): Promise<string[]> {
  return win.locator('[data-testid^="layer-row-"]').evaluateAll((nodes) =>
    nodes.map((n) =>
      (n.getAttribute("data-testid") ?? "").replace("layer-row-", "")
    )
  );
}

async function firstLayerVisible(
  app: LaunchedApp,
  captureId: string
): Promise<boolean | null> {
  const result = await app.dispatch("layers:list", { captureId });
  if (!result.ok || result.value.length === 0) return null;
  return result.value[0]!.visible !== false;
}

/** Seed a v2 image tagged for the Layers-panel specs. */
function seedCapture(app: LaunchedApp): Promise<string> {
  return seedImageCapture(app, {
    idPrefix: "layers",
    sourceName: "Layers Panel Spec"
  });
}

const openFocus = openEditorFocus;
