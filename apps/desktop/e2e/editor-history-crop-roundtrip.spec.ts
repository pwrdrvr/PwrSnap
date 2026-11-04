// Real Electron coverage for PR #793's history/crop review findings. Synthetic
// captures use the isolated E2E HOME; no operator captures or desktop are used.
import type { Page, TestInfo } from "@playwright/test";
import { expect, launchPwrSnap, test, type LaunchedApp } from "./fixtures/electron-app";
import { accel, drawAnnotation, openEditorImage, seedRasterCapture, selectTool } from "./fixtures/editor-helpers";

test.setTimeout(90_000);

async function arrows(app: LaunchedApp, captureId: string) {
  const result = await app.dispatch("layers:list", { captureId });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.filter((node) => node.kind === "vector" && node.shape.kind === "arrow");
}

async function dimensions(app: LaunchedApp, captureId: string) {
  const result = await app.dispatch("library:byId", { id: captureId });
  if (!result.ok || result.value === null) throw new Error("missing capture");
  return [result.value.width_px, result.value.height_px];
}

async function screenshot(win: Page, info: TestInfo, name: string): Promise<void> {
  await info.attach(name, { body: await win.screenshot(), contentType: "image/png" });
}

async function drawArrow(win: Page, app: LaunchedApp, captureId: string): Promise<void> {
  await selectTool(win, "arrow");
  await drawAnnotation(win, 0.333, 0.417, 0.731, 0.683);
  await expect.poll(async () => (await arrows(app, captureId)).length).toBe(1);
}

test("history roundtrip: visibility change does not block create redo", async ({}, info) => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedRasterCapture(app, { widthPx: 1001, heightPx: 803 });
    const win = await openEditorImage(app, captureId);
    await drawArrow(win, app, captureId);
    const original = (await arrows(app, captureId))[0]!;
    await screenshot(win, info, "drawn");
    await win.getByTestId("psl-right-tab-layers").click();
    await win.getByTestId(`layer-visibility-${original.id}`).click();
    await expect.poll(async () => (await arrows(app, captureId))[0]?.visible).toBe(false);
    await win.keyboard.press(`${accel()}+Z`);
    await expect.poll(async () => (await arrows(app, captureId)).length).toBe(0);
    await win.keyboard.press(`${accel()}+Shift+Z`);
    await screenshot(win, info, "after-redo");
    await expect.poll(async () => (await arrows(app, captureId))[0]).toEqual(original);
    await expect(win.getByTestId("persisted-glyph-svg")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("history roundtrip: crop, undo crop, undo create, redo create", async ({}, info) => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedRasterCapture(app, { widthPx: 1001, heightPx: 803 });
    const win = await openEditorImage(app, captureId);
    await drawArrow(win, app, captureId);
    const original = (await arrows(app, captureId))[0]!;
    await screenshot(win, info, "original");
    await selectTool(win, "crop");
    await win.getByTestId("crop-apply").click();
    await expect(win.getByTestId("crop-tool")).toHaveCount(0);
    await expect.poll(async () => dimensions(app, captureId)).toEqual([601, 482]);
    await screenshot(win, info, "cropped");
    await win.keyboard.press(`${accel()}+Z`);
    await expect.poll(async () => dimensions(app, captureId)).toEqual([1001, 803]);
    await win.keyboard.press(`${accel()}+Z`);
    await expect.poll(async () => (await arrows(app, captureId)).length).toBe(0);
    await win.keyboard.press(`${accel()}+Shift+Z`);
    await screenshot(win, info, "after-create-redo");
    await expect.poll(async () => (await arrows(app, captureId))[0]).toEqual(original);
    await expect(win.getByTestId("persisted-glyph-svg")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("history roundtrip: odd right-bottom crop Reset restores the full image", async ({}, info) => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedRasterCapture(app, { widthPx: 1001, heightPx: 803 });
    const win = await openEditorImage(app, captureId);
    await drawArrow(win, app, captureId);
    await screenshot(win, info, "original");
    // Exact fractional edge fixture; the restore is driven by the real Layers
    // panel so it receives main's verified IPC document context.
    const crop = await app.dispatch("bundle:cropCanvas", { captureId, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
    expect(crop.ok).toBe(true);
    await expect.poll(async () => dimensions(app, captureId)).toEqual([501, 402]);
    await win.getByTestId("psl-right-tab-layers").click();
    await screenshot(win, info, "edge-cropped");
    await win.getByRole("button", { name: "Remove crop (restore full image)", exact: true }).click();
    await screenshot(win, info, "after-reset");
    await expect.poll(async () => dimensions(app, captureId)).toEqual([1001, 803]);
    await expect(win.getByRole("button", { name: "Remove crop (restore full image)", exact: true })).toHaveCount(0);
    await expect(win.getByTestId("persisted-glyph-svg")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("history roundtrip: computer-use smoke fixture", async ({}, info) => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedRasterCapture(app, { widthPx: 1001, heightPx: 803 });
    const win = await openEditorImage(app, captureId);
    await drawArrow(win, app, captureId);
    await win.getByTestId("psl-right-tab-layers").click();
    if (process.env.PWRSNAP_E2E_INTERACTIVE === "1") {
      test.setTimeout(10 * 60_000);
      // A deliberate interactive lab checkpoint, never an elapsed-time
      // assertion. F8 hands control back after the Screen Sharing smoke test.
      await win.evaluate(() => new Promise<void>((resolve) => {
        const done = (event: KeyboardEvent): void => {
          if (event.key !== "F8") return;
          window.removeEventListener("keydown", done);
          resolve();
        };
        window.addEventListener("keydown", done);
      }));
    }
    await expect(win.getByTestId("editor-error")).toHaveCount(0);
    await screenshot(win, info, "computer-use-final");
  } finally {
    await app.close();
  }
});
