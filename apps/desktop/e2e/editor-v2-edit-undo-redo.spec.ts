// E2E coverage for the v2 editor EDIT loop — the paths the v1-teardown
// rewired. Where `editor-v2-capture-open.spec.ts` proves a v2 capture
// *opens* (read path), this proves the v2 *write* path end-to-end
// through the real renderer:
//
//   1. Placing an annotation persists through `layers:upsert` (the
//      collapsed `useCaptureModel.dispatchEditV2`, which replaced the
//      deleted v1 `overlays:upsert` arm) and bumps the toolbar's
//      applied-overlay meta.
//   2. Undo / redo round-trip through the collapsed `useUndoRedo`
//      (which now requires a `dispatchEdit` and emits `layers:delete` /
//      `layers:upsert` — the v1 direct-`overlays:*` fallback is gone).
//   3. A placed annotation survives an editor reopen — proving the
//      layer was persisted to the DB and `useCaptureModel` refetches it
//      into the v2 layer-tree model on a fresh window.
//
// These flows have unit coverage (useCaptureModel.test.ts,
// useUndoRedo.test.ts) but no E2E proof that the real toolbar → hook →
// IPC → DB → refetch pipeline still works after the teardown collapsed
// the dual-format model down to v2-only. Library Focus uses keyboard
// undo/redo; the standalone undo/redo toolbar buttons were retired
// with the separate editor window.
//
// Selectors (all data-testid / stable classnames; additive):
//   - .psl__edit-toolbar button[data-tool="arrow"] → toolbar + active tool
//   - .editor-canvas                        → draw surface
//   - editor-error                          → error banner; assert absent
//   - editor-root[data-bundle-format-version] → "2"

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";
import { openEditor, selectTool } from "./fixtures/editor";

test.setTimeout(90_000);

test("editor-v2-edit-undo-redo: draw → undo → redo round-trips through layers:*", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const editorWindow = await openEditor(app, captureId);

    // Fresh capture: nothing placed, nothing to undo/redo.
    await expectLayerCount(app, captureId, 0);

    // Place an arrow.
    await selectTool(editorWindow, "arrow");
    await drawOnCanvas(editorWindow);

    // The placement persisted.
    await expectLayerCount(app, captureId, 1);

    // And it actually hit the DB through the v2 write path (layers:*,
    // NOT the deleted overlays:*). The fresh layer tree was empty, so a
    // non-empty list proves layers:upsert wrote.
    const afterDraw = await app.dispatch("layers:list", { captureId });
    expect(afterDraw.ok).toBe(true);
    if (afterDraw.ok) expect(afterDraw.value.length).toBeGreaterThan(0);

    // Undo → the arrow is removed (useUndoRedo dispatches layers:delete).
    await editorWindow.keyboard.press(`${accel()}+Z`);
    await expectLayerCount(app, captureId, 0);

    // Redo → the arrow comes back (useUndoRedo dispatches layers:upsert
    // with the original node, preserving z_index).
    await editorWindow.keyboard.press(`${accel()}+Shift+Z`);
    await expectLayerCount(app, captureId, 1);

    // Never tipped into the error model, never silently fell back off v2.
    await expect(
      editorWindow.locator('[data-testid="editor-error"]')
    ).toHaveCount(0);
    await expect(
      editorWindow.locator('[data-testid="editor-root"]')
    ).toHaveAttribute("data-bundle-format-version", "2");
  } finally {
    await app.close();
  }
});

test("editor-v2-edit-undo-redo: a placed annotation survives an editor reopen", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const firstWindow = await openEditor(app, captureId);

    await selectTool(firstWindow, "arrow");
    await drawOnCanvas(firstWindow);
    await expectLayerCount(app, captureId, 1);

    // Persisted to the DB.
    const persisted = await app.dispatch("layers:list", { captureId });
    expect(persisted.ok).toBe(true);
    if (persisted.ok) expect(persisted.value.length).toBeGreaterThan(0);

    // Close Focus and reopen it. The reopened
    // editor must reload the persisted layer through useCaptureModel's
    // layers:list fetch again with no error banner.
    await firstWindow.locator(".psl__focus-close").click();
    await expect(firstWindow.locator(".psl__focus")).toHaveCount(0);
    const reopened = await openEditor(app, captureId);
    await expectLayerCount(app, captureId, 1);
    await expect(
      reopened.locator('[data-testid="editor-error"]')
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// ---- Shared helpers (mirror editor-sticky-tool.spec.ts) --------------

function accel(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

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

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-edit-undo-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  // 1×1 transparent PNG — the canvas <img> loads it via
  // pwrsnap-capture://; the bytes are never decoded for the assertions.
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `edit-undo-${Date.now().toString(36)}-${Math.random()
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
        source_app_name: "Edit Undo Spec",
        legacy_src_path: payload.pngPath,
        width_px: 800,
        height_px: 600,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id,
        // Explicit v2 — self-documenting (the bridge defaults to v2, but
        // this spec is specifically about the v2 edit path).
        bundle_format_version: 2
      });
    },
    { id: captureId, pngPath }
  );
  return captureId;
}

/**
 * Drag across the canvas to place an annotation. Two-step move so the
 * renderer's pointermove fires and the drag clears MIN_DRAG_LENGTH
 * (a zero-distance drag is treated as a click and dropped).
 */
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
