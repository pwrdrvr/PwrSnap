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

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";
import { openEditor, seedImageCapture, selectTool } from "./fixtures/editor";

// First spec in the file cold-starts Electron; later specs benefit from
// the warm pnpm-store cache. Same 60s bump as settings.spec.ts.
test.setTimeout(90_000);

test("editor-tool-styles: shared COLOR slot fans out across tools", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "tool-styles",
      sourceAppName: "Tool Styles Spec"
    });
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
    const captureId = await seedImageCapture(app, {
      idPrefix: "tool-styles",
      sourceAppName: "Tool Styles Spec"
    });
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
    const captureId = await seedImageCapture(app, {
      idPrefix: "tool-styles",
      sourceAppName: "Tool Styles Spec"
    });

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

// ---- Spec-specific helpers (shared ones live in fixtures/editor.ts) --

async function closeEditorWindow(app: LaunchedApp, win: Page): Promise<void> {
  void app;
  await win.locator(".psl__focus-close").click();
  await expect(win.locator(".psl__focus")).toHaveCount(0);
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
