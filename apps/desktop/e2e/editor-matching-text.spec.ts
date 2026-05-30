// E2E coverage for the v2 editor Phase 1 matching-text affordance
// (task #11).
//
// Behaviors under test:
//   a) An "+ Add label" affordance appears at the arrow's tail after a
//      successful arrow placement.
//   b) Clicking the affordance flips the tool to text for a one-shot
//      placement (the arrow color stays selected via the shared COLOR
//      slot).
//   c) The affordance auto-dismisses after 8 seconds.
//   d) Switching tools cancels the affordance immediately.
//
// State under test: `useEditorToolState.matchingText` state machine +
// its five cancel sites. Unit tests cover the hook in isolation;
// this spec exercises the real arrow-placement → renderer affordance
// element → click → tool flip pipeline.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

test.setTimeout(120_000);

test("editor-matching-text: affordance appears at arrow tail after placement", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const editorWindow = await openEditor(app, captureId);

    await selectTool(editorWindow, "arrow");
    const canvas = editorWindow.locator(".editor-canvas");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;

    const tailX = box.x + box.width * 0.6;
    const tailY = box.y + box.height * 0.5;
    await dragOnCanvas(
      editorWindow,
      { x: box.x + box.width * 0.2, y: box.y + box.height * 0.3 },
      { x: tailX, y: tailY }
    );

    // Wait for the affordance to appear.
    const affordance = editorWindow.locator(
      '[data-testid="matching-text-affordance"]'
    );
    await affordance.waitFor({ state: "visible", timeout: 5_000 });

    // Position assertion — the affordance is anchored at the arrow's
    // tail in canvas-px (+8px y offset, -50% x transform per
    // Editor.tsx). Measure the affordance's center and assert it
    // lands within a generous tolerance of the drag's endpoint.
    const affordanceBox = await affordance.boundingBox();
    expect(affordanceBox).not.toBeNull();
    if (affordanceBox === null) return;
    const cx = affordanceBox.x + affordanceBox.width / 2;
    const cy = affordanceBox.y + affordanceBox.height / 2;
    // 50px tolerance — the y-offset (+8) and any anti-aliasing or
    // sub-pixel rendering should comfortably fit; we just need to
    // catch a "completely wrong place" regression.
    expect(Math.abs(cx - tailX)).toBeLessThanOrEqual(50);
    expect(Math.abs(cy - tailY)).toBeLessThanOrEqual(60);
  } finally {
    await app.close();
  }
});

test("editor-matching-text: clicking affordance flips to text mode", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const editorWindow = await openEditor(app, captureId);

    await selectTool(editorWindow, "arrow");
    const canvas = editorWindow.locator(".editor-canvas");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;

    await dragOnCanvas(
      editorWindow,
      { x: box.x + box.width * 0.2, y: box.y + box.height * 0.3 },
      { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 }
    );

    const affordance = editorWindow.locator(
      '[data-testid="matching-text-affordance"]'
    );
    await affordance.waitFor({ state: "visible", timeout: 5_000 });
    await affordance.click();

    // Tool flipped to text.
    await expect(
      editorWindow.locator('[data-testid="editor-tool-button-text"].is-active')
    ).toHaveCount(1);

    // Affordance gone now that we've armed.
    await expect(affordance).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("editor-matching-text: 8-second auto-dismiss", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const editorWindow = await openEditor(app, captureId);

    await selectTool(editorWindow, "arrow");
    const canvas = editorWindow.locator(".editor-canvas");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;

    await dragOnCanvas(
      editorWindow,
      { x: box.x + box.width * 0.2, y: box.y + box.height * 0.3 },
      { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 }
    );

    const affordance = editorWindow.locator(
      '[data-testid="matching-text-affordance"]'
    );
    await affordance.waitFor({ state: "visible", timeout: 5_000 });

    // 8s timer + slack. waitFor({state: 'detached'}) trumps a fixed
    // sleep + assertion — it short-circuits the moment the element
    // unmounts, which keeps the test snappy on a fast machine while
    // tolerating a slow runner.
    await affordance.waitFor({ state: "detached", timeout: 12_000 });
  } finally {
    await app.close();
  }
});

test("editor-matching-text: affordance cancels when tool changes", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const editorWindow = await openEditor(app, captureId);

    await selectTool(editorWindow, "arrow");
    const canvas = editorWindow.locator(".editor-canvas");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;

    await dragOnCanvas(
      editorWindow,
      { x: box.x + box.width * 0.2, y: box.y + box.height * 0.3 },
      { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 }
    );

    const affordance = editorWindow.locator(
      '[data-testid="matching-text-affordance"]'
    );
    await affordance.waitFor({ state: "visible", timeout: 5_000 });

    // Switch to shape — `setActiveTool` is cancel site #1 for
    // matching-text. Affordance should disappear immediately.
    await selectTool(editorWindow, "shape");
    await expect(affordance).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// ---- Shared helpers --------------------------------------------------

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-matching-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `matching-${Date.now().toString(36)}-${Math.random()
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
            }) => unknown;
          };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.id,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.spec",
        source_app_name: "Matching Text Spec",
        legacy_src_path: payload.pngPath,
        width_px: 800,
        height_px: 600,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id
      });
    },
    { id: captureId, pngPath }
  );
  return captureId;
}

async function openEditor(app: LaunchedApp, captureId: string): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok).toBe(true);
  const page = app.window;
  await page.locator(".psl__focus").waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('[data-testid="editor-tool-button-arrow"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  await expect(page.locator(`[data-cell-id="${captureId}"]`)).toHaveClass(/is-selected/);
  return page;
}

async function selectTool(win: Page, tool: string): Promise<void> {
  await win.locator(`[data-testid="editor-tool-button-${tool}"]`).click();
  await expect(
    win.locator(`[data-testid="editor-tool-button-${tool}"].is-active`)
  ).toHaveCount(1);
}

async function dragOnCanvas(
  win: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
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
