// E2E coverage for the v2 editor Phase 1 tool-style surface (task #11).
//
// Exercises per-tool style independence (color included — the shared
// COLOR slot is gone, the tool bag replaced it), the tool bag's keys,
// and Settings substrate round-trip via two consecutive editor opens
// against the same capture. The state being exercised lives in
// `useEditorToolState` + the docked property bar + the Settings substrate's
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

import { type Page } from "@playwright/test";
import { expect, type LaunchedApp, launchPwrSnap, test } from "./fixtures/electron-app";
import { openEditor, openToolStyleBar, seedImageCapture, selectTool } from "./fixtures/editor";

// First spec in the file cold-starts Electron; later specs benefit from
// the warm pnpm-store cache. Same 60s bump as settings.spec.ts.
test.setTimeout(90_000);

test("editor-tool-styles: a color picked for arrows does not recolor text", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "tool-styles",
      sourceAppName: "Tool Styles Spec"
    });
    const editorWindow = await openEditor(app, captureId);

    await selectTool(editorWindow, "arrow");
    await openToolStyleBar(editorWindow);
    await clickSwatch(editorWindow, "red");

    // Text keeps its own color. (A shared COLOR slot used to fan every
    // pick out to every tool.)
    await selectTool(editorWindow, "text");
    await openToolStyleBar(editorWindow);
    await expect(
      editorWindow.locator('[data-testid="swatch-red"][aria-checked="true"]')
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("editor-tool-styles: 1 arms a bag slot, a drawing is selected on release, shift+3 restyles it, undo takes it back", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "tool-bag",
      sourceAppName: "Tool Bag Spec"
    });
    const editorWindow = await openEditor(app, captureId);
    const arrows = async (): Promise<Array<{ color: string; endStyle: string | undefined }>> => {
      const list = await app.dispatch("layers:list", { captureId });
      if (!list.ok) return [];
      return list.value.flatMap((layer) =>
        layer.kind === "vector" && layer.shape.kind === "arrow"
          ? [{ color: layer.shape.color, endStyle: layer.shape.endStyle }]
          : []
      );
    };

    await editorWindow.keyboard.press("Digit1");
    await expect(editorWindow.getByTestId("bag-slot-1")).toHaveAttribute("aria-pressed", "true");

    const canvas = editorWindow.locator(".editor-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("canvas has no bbox");
    await editorWindow.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 10 });
    await editorWindow.mouse.up();

    // Factory slot 1 is a red arrow; the new arrow is now the selection.
    await expect.poll(arrows, { timeout: 15_000 }).toEqual([
      { color: "#ff5f57", endStyle: "filled-triangle" }
    ]);
    await expect(
      editorWindow.locator('[data-testid="edit-property-bar"][data-target="layer"]')
    ).toBeVisible();

    // Shift+3 pastes factory slot 3 (yellow arrow) onto it.
    await editorWindow.keyboard.press("Shift+Digit3");
    await expect.poll(arrows, { timeout: 15_000 }).toEqual([
      { color: "#facc15", endStyle: "filled-triangle" }
    ]);

    // One undo step for the whole paste.
    await editorWindow.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+z`);
    await expect.poll(arrows, { timeout: 15_000 }).toEqual([
      { color: "#ff5f57", endStyle: "filled-triangle" }
    ]);
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

    // Set arrow thickness to "small" via the property bar.
    await selectTool(editorWindow, "arrow");
    await openToolStyleBar(editorWindow);
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
    await selectTool(editorWindow, "text");
    await openToolStyleBar(editorWindow);
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
      await openToolStyleBar(editorWindow);
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

    // Sanity check via the settings:read bus.
    const readBack = await app.dispatch("settings:read", {});
    expect(readBack.ok).toBe(true);
    if (readBack.ok) {
      expect(readBack.value.editor.toolStyles.arrow.color).toBe("blue");
    }

    // SECOND OPEN: same capture; arrow should still be blue.
    {
      const editorWindow = await openEditor(app, captureId);
      await selectTool(editorWindow, "arrow");
      await openToolStyleBar(editorWindow);
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
  await win.getByTestId("focus-back").click();
  await expect(win.locator(".psl__focus")).toHaveCount(0);
}

async function clickSwatch(win: Page, color: string): Promise<void> {
  await win
    .locator(`[data-testid="edit-property-bar"] [data-testid="swatch-${color}"]`)
    .click();
}
