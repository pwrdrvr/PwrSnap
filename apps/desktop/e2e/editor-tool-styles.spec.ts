// E2E coverage for the v2 editor Phase 1 tool-style surface (task #11).
//
// Exercises cross-tool COLOR slot sharing, per-tool field independence,
// and Settings substrate round-trip via two consecutive editor opens
// against the same capture. The state being exercised lives in
// `useEditorToolState` + `ToolStylePopover` + the Settings substrate's
// `editor.toolStyles` block — see
// `apps/desktop/src/renderer/src/features/editor/useEditorToolState.ts`
// and `ToolStylePopover.tsx`.
//
// Why E2E and not unit: the unit tests cover the hook + popover in
// isolation, but the persistence + 500ms debounce + cross-popover state
// fan-out only behave correctly when the real `settings:write`
// substrate, real broadcast, and real renderer-mount-on-second-window
// all run together. This file is the contract for "the user picks red
// in arrow, closes the editor, reopens it, and red is still selected."

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

// First spec in the file cold-starts Electron; later specs benefit from
// the warm pnpm-store cache. Same 60s bump as settings.spec.ts.
test.setTimeout(90_000);

test("editor-tool-styles: shared COLOR slot fans out across tools", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const editorWindow = await openEditor(app, captureId);

    // Select arrow → its caret should appear → click caret to open popover.
    await selectTool(editorWindow, "arrow");
    await openPopoverForActiveTool(editorWindow, "arrow");

    // Click the red swatch. Note: the popover is per-tool; clicking
    // red here writes through to every styled tool's color via the
    // shared-COLOR-slot fan-out in `useEditorToolState.setStyleField`.
    await clickSwatch(editorWindow, "red");

    // Close popover (Escape).
    await editorWindow.keyboard.press("Escape");
    await expect(
      editorWindow.locator('[data-testid="tool-style-popover"]')
    ).toHaveCount(0);

    // Switch to text tool → open its popover via the caret → assert
    // its color swatch is the same "red" that was just chosen in arrow.
    await selectTool(editorWindow, "text");
    await openPopoverForActiveTool(editorWindow, "text");

    await expect(
      editorWindow.locator('[data-testid="swatch-red"][aria-checked="true"]')
    ).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("editor-tool-styles: per-tool thickness does NOT share across tools", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const editorWindow = await openEditor(app, captureId);

    // Set arrow thickness to "small" via the popover.
    await selectTool(editorWindow, "arrow");
    await openPopoverForActiveTool(editorWindow, "arrow");
    // The Segmented control renders <button role="radio" aria-label="S">
    // for the "small" preset. Use it directly.
    await editorWindow
      .locator(
        '[data-testid="arrow-thickness"] button[role="radio"][aria-label="S"]'
      )
      .click();
    // Verify it took.
    await expect(
      editorWindow.locator(
        '[data-testid="arrow-thickness"] button[aria-label="S"][aria-checked="true"]'
      )
    ).toHaveCount(1);

    // Switch to text. Text uses `text-font-size` for its size control,
    // and the default value is "auto" — the per-tool independence
    // guarantee says picking arrow.thickness=small must NOT bleed into
    // text.fontSize.
    await editorWindow.keyboard.press("Escape");
    await selectTool(editorWindow, "text");
    await openPopoverForActiveTool(editorWindow, "text");
    await expect(
      editorWindow.locator(
        '[data-testid="text-font-size"] button[aria-label="Auto"][aria-checked="true"]'
      )
    ).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("editor-tool-styles: COLOR persists across editor reopen", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);

    // FIRST OPEN: pick blue in arrow.
    {
      const editorWindow = await openEditor(app, captureId);
      await selectTool(editorWindow, "arrow");
      await openPopoverForActiveTool(editorWindow, "arrow");
      await clickSwatch(editorWindow, "blue");
      // Confirm the swatch is selected before close.
      await expect(
        editorWindow.locator(
          '[data-testid="swatch-blue"][aria-checked="true"]'
        )
      ).toHaveCount(1);

      // The hook debounces settings writes for 500ms — give the
      // dispatch time to land in the substrate before we close.
      await editorWindow.waitForTimeout(800);
      await closeEditorWindow(app, editorWindow);
    }

    // Sanity check via the settings:read bus — the blue color should
    // have been fanned out to every color-bearing tool's block.
    const readBack = await app.dispatch("settings:read", {});
    expect(readBack.ok).toBe(true);
    if (readBack.ok) {
      expect(readBack.value.editor.toolStyles.arrow.color).toBe("blue");
    }

    // SECOND OPEN: same capture; arrow should still be blue.
    {
      const editorWindow = await openEditor(app, captureId);
      await selectTool(editorWindow, "arrow");
      await openPopoverForActiveTool(editorWindow, "arrow");
      await expect(
        editorWindow.locator(
          '[data-testid="swatch-blue"][aria-checked="true"]'
        )
      ).toHaveCount(1);
    }
  } finally {
    await app.close();
  }
});

// ---- Shared helpers (kept inline; mirror editor.spec.ts pattern) -----

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-toolstyles-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  // 1×1 transparent PNG.
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `tool-styles-${Date.now().toString(36)}-${Math.random()
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
        source_app_name: "Tool Styles Spec",
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
  expect(result.ok, "editor:open should succeed").toBe(true);
  const page = app.window;
  await page.locator(".psl__focus").waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('[data-testid="editor-tool-button-arrow"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  await expect(page.locator(`[data-cell-id="${captureId}"]`)).toHaveClass(/is-selected/);
  return page;
}

async function closeEditorWindow(app: LaunchedApp, win: Page): Promise<void> {
  void app;
  await win.locator(".psl__focus-close").click();
  await expect(win.locator(".psl__focus")).toHaveCount(0);
}

async function selectTool(win: Page, tool: string): Promise<void> {
  await win.locator(`[data-testid="editor-tool-button-${tool}"]`).click();
  // Wait for the active styling to flip — the button gets `is-active`
  // immediately, and the caret only renders for active styled tools.
  await expect(
    win.locator(`[data-testid="editor-tool-button-${tool}"].is-active`)
  ).toHaveCount(1);
}

async function openPopoverForActiveTool(win: Page, tool: string): Promise<void> {
  // The caret only renders when the tool is active. Click it.
  const caret = win.locator(`[data-testid="tool-caret-${tool}"]`);
  await caret.waitFor({ state: "visible", timeout: 5_000 });
  await caret.click();
  await win
    .locator('[data-testid="tool-style-popover"]')
    .waitFor({ state: "visible", timeout: 5_000 });
}

async function clickSwatch(win: Page, color: string): Promise<void> {
  await win
    .locator(`[data-testid="tool-style-popover"] [data-testid="swatch-${color}"]`)
    .click();
}
