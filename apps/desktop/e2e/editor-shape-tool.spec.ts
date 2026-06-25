// E2E coverage for the Shape tool — verifies the popover's shape-kind
// picker actually writes through to `settings.editor.toolStyles.shape`,
// the parallelogram skew slider gates correctly + persists, and a
// committed overlay round-trips as a ShapeOverlay with the right
// discriminant.
//
// Why E2E: the unit tests cover the popover in isolation, but the
// commit + persistence + Settings-substrate round-trip only behave
// correctly when the real renderer, real `settings:write` debounce,
// real broadcast, and real `layers:upsert` all run together. This
// file is the contract for "the user picks Circle, draws on the
// canvas, closes the editor — and on reopen, the same Circle row is
// there, with the popover still set to Circle."
//
// Mirrors `editor-tool-styles.spec.ts` for the harness shape; shares
// the same seedCapture + openEditor + closeEditorWindow + selectTool
// + openPopoverForActiveTool patterns.

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";
import { openEditor, seedImageCapture, selectTool } from "./fixtures/editor";

test.setTimeout(90_000);

test("editor-shape-tool: picking a shape kind in the popover persists across reopen", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "shape", sourceAppName: "Shape Tool Spec" });

    // FIRST OPEN: pick Circle.
    {
      const editorWindow = await openEditor(app, captureId);
      await selectTool(editorWindow, "shape");
      await openPopoverForActiveTool(editorWindow, "shape");

      // The shape-kind picker is a `role="radiogroup"` of 5 buttons;
      // each carries `data-testid="shape-kind-${id}"`. Default is
      // Rectangle — Circle's `aria-checked` should flip after click.
      await editorWindow
        .locator('[data-testid="shape-kind-circle"]')
        .click();
      await expect(
        editorWindow.locator(
          '[data-testid="shape-kind-circle"][aria-checked="true"]'
        )
      ).toHaveCount(1);

      // 500ms write debounce in useEditorToolState — wait it out
      // before closing.
      await editorWindow.waitForTimeout(800);
      await closeEditorWindow(app, editorWindow);
    }

    // Sanity check via the settings:read bus — the choice should
    // be in `editor.toolStyles.shape.shape`.
    const readBack = await app.dispatch("settings:read", {});
    expect(readBack.ok).toBe(true);
    if (readBack.ok) {
      expect(readBack.value.editor.toolStyles.shape.shape).toBe("circle");
    }

    // SECOND OPEN: same capture; Circle should still be picked.
    {
      const editorWindow = await openEditor(app, captureId);
      await selectTool(editorWindow, "shape");
      await openPopoverForActiveTool(editorWindow, "shape");
      await expect(
        editorWindow.locator(
          '[data-testid="shape-kind-circle"][aria-checked="true"]'
        )
      ).toHaveCount(1);
    }
  } finally {
    await app.close();
  }
});

test("editor-shape-tool: parallelogram skew slider gates on shape kind + persists", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "shape", sourceAppName: "Shape Tool Spec" });
    const editorWindow = await openEditor(app, captureId);

    await selectTool(editorWindow, "shape");
    await openPopoverForActiveTool(editorWindow, "shape");

    // Default shape is Rectangle — skew slider should NOT be visible.
    await expect(
      editorWindow.locator('[data-testid="shape-skew"]')
    ).toHaveCount(0);

    // Switch to Parallelogram — skew slider appears.
    await editorWindow
      .locator('[data-testid="shape-kind-parallelogram"]')
      .click();
    const skewInput = editorWindow.locator(
      '[data-testid="shape-skew-input"]'
    );
    await skewInput.waitFor({ state: "visible", timeout: 5_000 });

    // Default skew is 15° (DEFAULT_PARALLELOGRAM_SKEW_DEG).
    await expect(skewInput).toHaveValue("15");

    // Drive the slider to 30. Playwright's <input type="range"> can
    // be driven via fill().
    await skewInput.fill("30");
    // The label rendered above the slider also reflects the value
    // via FieldGroup's `label` prop (rounded for display).
    await expect(skewInput).toHaveValue("30");

    // Switch back to Rectangle — slider should disappear (but the
    // skewDeg value should be retained in settings so picking
    // Parallelogram later restores 30°).
    await editorWindow
      .locator('[data-testid="shape-kind-rect"]')
      .click();
    await expect(
      editorWindow.locator('[data-testid="shape-skew"]')
    ).toHaveCount(0);

    // Re-pick Parallelogram — skew slider returns at 30°.
    await editorWindow
      .locator('[data-testid="shape-kind-parallelogram"]')
      .click();
    await expect(
      editorWindow.locator('[data-testid="shape-skew-input"]')
    ).toHaveValue("30");

    // Settings round-trip.
    await editorWindow.waitForTimeout(800);
    const readBack = await app.dispatch("settings:read", {});
    expect(readBack.ok).toBe(true);
    if (readBack.ok) {
      expect(readBack.value.editor.toolStyles.shape.shape).toBe(
        "parallelogram"
      );
      expect(readBack.value.editor.toolStyles.shape.skewDeg).toBe(30);
    }
  } finally {
    await app.close();
  }
});

test("editor-shape-tool: drawing a circle paints an <ellipse> in the persisted glyph layer", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "shape", sourceAppName: "Shape Tool Spec" });
    const editorWindow = await openEditor(app, captureId);

    // Pick Circle in the popover.
    await selectTool(editorWindow, "shape");
    await openPopoverForActiveTool(editorWindow, "shape");
    await editorWindow
      .locator('[data-testid="shape-kind-circle"]')
      .click();
    await editorWindow.keyboard.press("Escape");

    // Drag on the actual drawable canvas to commit the shape. The
    // wrapper can be larger than the fitted canvas under Linux/xvfb
    // sizing, so coordinates must come from `.editor-canvas` itself.
    const canvas = editorWindow.locator(".editor-canvas");
    await canvas.waitFor({ state: "visible", timeout: 5_000 });
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("canvas has no bbox");

    await editorWindow.mouse.move(
      box.x + box.width * 0.25,
      box.y + box.height * 0.25
    );
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(
      box.x + box.width * 0.55,
      box.y + box.height * 0.55,
      { steps: 10 }
    );
    await editorWindow.mouse.up();

    await expect
      .poll(async () => {
        const list = await app.dispatch("layers:list", { captureId });
        if (!list.ok) return false;
        return list.value.some(
          (layer) =>
            layer.kind === "vector" &&
            layer.shape.kind === "shape" &&
            layer.shape.shape === "circle"
        );
      })
      .toBe(true);

    // After commit, the renderer paints a persisted-glyph mini-SVG
    // containing an <ellipse> (the primitive ShapeGlyph emits for
    // `shape: "circle"`). This is a UI-level assertion that doesn't
    // depend on the v1/v2 storage format the commit landed in
    // (overlays:upsert vs layers:upsert) — the renderer renders the
    // same SVG primitive in both paths, branching on the projected
    // OverlayRow's `data.kind / data.shape`.
    //
    // toHaveCount waits up to an extended timeout so a slight commit
    // + refetch delay doesn't cause a Linux/xvfb flake.
    await expect(
      editorWindow.locator(
        '[data-testid="persisted-glyph-svg"] ellipse'
      )
    ).toHaveCount(2, { timeout: 15_000 });
    // ShapeGlyph emits TWO ellipses for the stroked branch: a wider
    // white halo (under-stroke for legibility on busy backgrounds)
    // and the colored stroke on top. Filled mode would emit one;
    // the popover default is unfilled, so two is the expected count.

    // And no <rect> overlays — proves the per-shape branch picked
    // ellipse over rect, not just "default rendering". (The chrome
    // SVG renders selection outlines as <rect>, but it sits in a
    // separate `data-testid="chrome-svg"`.)
    await expect(
      editorWindow.locator(
        '[data-testid="persisted-glyph-svg"] rect'
      )
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// ---- Shared helpers (mirror editor-tool-styles.spec.ts) --------------

async function closeEditorWindow(app: LaunchedApp, win: Page): Promise<void> {
  void app;
  await win.locator(".psl__focus-close").click();
  await expect(win.locator(".psl__focus")).toHaveCount(0);
}

async function openPopoverForActiveTool(win: Page, tool: string): Promise<void> {
  const caret = win.locator(`[data-testid="tool-caret-${tool}"]`);
  await caret.waitFor({ state: "visible", timeout: 5_000 });
  await caret.click();
  await win
    .locator('[data-testid="tool-style-popover"]')
    .waitFor({ state: "visible", timeout: 5_000 });
}
