// Regression E2E for the live-drag override masking undo.
//
// Repro: move a layer with the mouse, then ⌘Z. The bug — v2
// `updateGeometry` PRESERVES the layer id, so the old "clear the live
// override once its row id disappears" cleanup never fired; the stale
// override kept painting the dragged position, so the glyph stayed put
// after undo (while the selection outline / hit-test reverted). This
// asserts the rendered glyph returns to its original position on undo.
//
// The unit-level guard for the cleanup logic itself lives in
// draft-geometry.test.ts (pruneLandedDraftGeometry); this is the
// end-to-end "the glyph actually moves back" check.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

test.setTimeout(120_000);

function accel(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

test("editor-drag-undo: moving a layer then ⌘Z returns the glyph to its original position", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openFocus(app, captureId);

    // A filled highlight gives a big, reliable click/drag target and
    // renders as a single <rect> we can measure.
    await selectTool(win, "highlight");
    await drawOnCanvas(win);
    await expectLayerCount(app, captureId, 1);

    const glyph = win.locator('[data-testid="persisted-glyph-svg"] rect').first();
    await glyph.waitFor({ state: "attached", timeout: 5_000 });
    const boxA = await stableBox(glyph);

    // Select, then body-drag the highlight to a new spot.
    const canvas = win.locator(".editor-canvas");
    const cbox = await canvas.boundingBox();
    expect(cbox).not.toBeNull();
    if (cbox === null) return;
    const cx = cbox.x + cbox.width * 0.4;
    const cy = cbox.y + cbox.height * 0.4;
    await win.mouse.click(cx, cy); // select (handles appear)
    await win.mouse.move(cx, cy);
    await win.mouse.down();
    await win.mouse.move(cx + cbox.width * 0.12, cy + cbox.height * 0.1, { steps: 6 });
    await win.mouse.move(cx + cbox.width * 0.22, cy + cbox.height * 0.16, { steps: 6 });
    await win.mouse.up();

    const boxB = await stableBox(glyph);
    // The move actually happened (glyph shifted right by a real margin).
    expect(boxB.x - boxA.x).toBeGreaterThan(8);

    // Undo. The glyph must snap back to ~its original position — not stay
    // at the moved position because a stale override masked the revert.
    await win.keyboard.press(`${accel()}+Z`);
    const boxUndo = await stableBox(glyph);
    expect(Math.abs(boxUndo.x - boxA.x)).toBeLessThan(6);
    expect(boxB.x - boxUndo.x).toBeGreaterThan(8);
  } finally {
    await app.close();
  }
});

/** Read an element's bounding box, polling until two consecutive reads
 *  agree — so we measure AFTER the dispatch → broadcast → refetch (and
 *  the override cleanup) have settled. */
async function stableBox(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  let prev = await locator.boundingBox();
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    await locator.page().waitForTimeout(50);
    // eslint-disable-next-line no-await-in-loop
    const next = await locator.boundingBox();
    if (prev !== null && next !== null && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5) {
      return next;
    }
    prev = next;
  }
  if (prev === null) throw new Error("glyph never measured");
  return prev;
}

// ---- Shared helpers (mirror library-layers-panel.spec.ts) ------------

async function expectLayerCount(app: LaunchedApp, captureId: string, count: number): Promise<void> {
  await expect
    .poll(async () => {
      const result = await app.dispatch("layers:list", { captureId });
      if (!result.ok) return -1;
      return result.value.length;
    })
    .toBe(count);
}

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-drag-undo-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `dragundo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
        source_app_name: "Drag Undo Spec",
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
  await page.locator('.psl__edit-toolbar button[data-tool="highlight"]').waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

async function selectTool(win: Page, tool: string): Promise<void> {
  await win.locator(`.psl__edit-toolbar button[data-tool="${tool}"]`).click();
  await expect(win.locator(`.psl__edit-toolbar button[data-tool="${tool}"].is-active`)).toHaveCount(1);
}

async function drawOnCanvas(win: Page): Promise<void> {
  const canvas = win.locator(".editor-canvas");
  await canvas.waitFor({ state: "visible" });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  const from = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.25 };
  const to = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.55 };
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await win.mouse.move(to.x, to.y, { steps: 5 });
  await win.mouse.up();
}
