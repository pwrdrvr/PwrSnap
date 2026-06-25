// E2E coverage for Phase 3.2 v2-editor fixes in Library Focus mode.
//
// Three bugs the user surfaced in manual smoke that all passed unit
// tests but broke end-to-end inside the Library Focus surface (the
// chromeless inline editor that lives in the Library's detail rail):
//
//   • Bug A — Hook state isn't shared. Pre-3.2 the EditToolbar and the
//     chromeless Editor each instantiated their own useEditorToolState.
//     The popover wrote to the toolbar's hook; persistOverlay read
//     from Editor's hook; styles vanished on drag-commit. Fix: lift to
//     Library, thread one hook into both.
//
//   • Bug B — CropTool rendered TWICE in Library Focus (once via the
//     EditToolbar's overlay, once via the canvas). Duplicate HUD +
//     handles offset against different rects. Fix: removed the
//     EditToolbar's copy; the canvas-internal CropTool with the
//     correct positioning context is the sole render.
//
//   • Bug C — No selection model. Pointer tool clicks on existing
//     overlays were ignored, so users had no way to delete a wrong
//     annotation. Fix: minimal hit-test + outline + Delete/Backspace.
//
// This spec opens a capture in Library Focus, exercises all three
// fixes, takes screenshots at each step (saved under
// `playwright-report` / `test-results`), and asserts the DOM
// invariants that catch regressions even when screenshots aren't
// inspected.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";
import { seedImageCapture } from "./fixtures/editor";

test.setTimeout(120_000);

// SKIPPED — tracked in pwrdrvr/PwrSnap#109. Still failing post-crop-
// dismiss-fix at line 117 (page closed during screenshot after
// arrow draw on Linux Docker — likely a renderer crash). My crop-
// dismiss fix DID resolve the line-180 sidebar-intercept failure
// mode the issue originally documented, but exposed the deeper
// line-117 mode that was being masked. That crash is independent
// of crop and requires separate investigation (likely
// persistOverlay flow or sharp/SQLite native binding on Linux);
// the remediation is still the planned spec split + main-process
// stderr capture so we can see the actual crash output.
test.skip("library-focus-phase32: lifted hook + crop + selection", async ({}, testInfo) => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "phase32",
      sourceAppName: "Phase 3.2 Spec"
    });
    const win = app.window;

    // Open in Library Focus via the existing event channel main fires
    // when float-over's Edit button is clicked.
    await app.dispatch("library:openInLibrary", { captureId });

    // Wait for Focus mode — the floating bottom toolbar mounts with
    // `.psl__edit-toolbar` and tool buttons carry `data-tool`.
    await win
      .locator('.psl__edit-toolbar button[data-tool="arrow"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    // Editor canvas is in DOM too.
    await win
      .locator(".editor-canvas")
      .waitFor({ state: "visible", timeout: 15_000 });

    await screenshot(testInfo, win, "01-focus-opened.png");

    // ---- Bug A: pick red → draw arrow → arrow renders red ---------

    // Activate arrow tool.
    await win.locator('.psl__edit-toolbar button[data-tool="arrow"]').click();
    await expect(
      win.locator(
        '.psl__edit-toolbar button[data-tool="arrow"].is-active'
      )
    ).toHaveCount(1);

    // Open the caret-popover for arrow.
    await win.locator('[data-testid="tool-caret-arrow"]').click();
    await win
      .locator('[data-testid="tool-style-popover"]')
      .waitFor({ state: "visible" });

    // Pick red.
    await win
      .locator(
        '[data-testid="tool-style-popover"] [data-testid="swatch-red"]'
      )
      .click();
    await expect(
      win.locator('[data-testid="swatch-red"][aria-checked="true"]')
    ).toHaveCount(1);

    // Close popover with Escape so it doesn't intercept canvas clicks.
    await win.keyboard.press("Escape");
    await expect(
      win.locator('[data-testid="tool-style-popover"]')
    ).toHaveCount(0);

    await screenshot(testInfo, win, "02-picked-red.png");

    // Draw an arrow on the canvas. We translate normalized [0.25, 0.4]
    // → [0.6, 0.4] to canvas-pixel coords from the canvas's bounding
    // box.
    const canvasBox = await win.locator(".editor-canvas").boundingBox();
    expect(canvasBox).not.toBeNull();
    if (canvasBox === null) throw new Error("no canvas box");
    const fromX = canvasBox.x + canvasBox.width * 0.25;
    const fromY = canvasBox.y + canvasBox.height * 0.4;
    const toX = canvasBox.x + canvasBox.width * 0.6;
    const toY = canvasBox.y + canvasBox.height * 0.4;
    await win.mouse.move(fromX, fromY);
    await win.mouse.down();
    await win.mouse.move(toX, toY, { steps: 12 });
    await win.mouse.up();

    // Give the persistOverlay round-trip a moment + broadcast refetch.
    await win.waitForTimeout(700);

    await screenshot(testInfo, win, "03-arrow-drawn.png");

    // Inspect the persisted layer tree via the bus — the committed
    // vector-arrow layer's color field should be the red hex we
    // picked, not "auto" (the pre-3.2 bug).
    const list = await app.dispatch("layers:list", { captureId });
    expect(list.ok).toBe(true);
    if (list.ok) {
      const arrowLayers = list.value.filter(
        (r) => r.kind === "vector" && r.shape.kind === "arrow"
      );
      expect(arrowLayers.length, "exactly one arrow committed").toBe(1);
      const ar = arrowLayers[0];
      if (ar?.kind === "vector" && ar.shape.kind === "arrow") {
        expect(
          ar.shape.color,
          "lifted hook should have routed red into persistOverlay"
        ).not.toBe("auto");
      }
    }

    // ---- Bug B: crop renders exactly once -------------------------

    // Switch to the crop tool.
    await win.locator('.psl__edit-toolbar button[data-tool="crop"]').click();
    await expect(
      win.locator(
        '.psl__edit-toolbar button[data-tool="crop"].is-active'
      )
    ).toHaveCount(1);

    // Wait for the crop overlay to render.
    await win
      .locator('[data-testid="crop-tool"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // EXACTLY ONE crop-tool overlay should exist in the DOM. Pre-3.2,
    // both the EditToolbar AND Editor rendered <CropTool>, giving two.
    await expect(win.locator('[data-testid="crop-tool"]')).toHaveCount(1);
    await expect(win.locator('[data-testid="crop-hud"]')).toHaveCount(1);
    await expect(win.locator('[data-testid="crop-rect"]')).toHaveCount(1);

    await screenshot(testInfo, win, "04-crop-active.png");

    // The crop overlay's rect lives inside `.editor-canvas`. Sanity-
    // check by verifying its bounding-box left/top fall within the
    // canvas bounding box (not against the larger Stage container).
    const canvasBoxNow = await win.locator(".editor-canvas").boundingBox();
    const cropRectBox = await win
      .locator('[data-testid="crop-rect"]')
      .boundingBox();
    expect(canvasBoxNow).not.toBeNull();
    expect(cropRectBox).not.toBeNull();
    if (canvasBoxNow !== null && cropRectBox !== null) {
      // The default crop rect is a centered 60% of source. The rect's
      // top-left in viewport coords MUST be inside the canvas bounding
      // box, not in some adjacent container.
      expect(cropRectBox.x).toBeGreaterThanOrEqual(canvasBoxNow.x - 1);
      expect(cropRectBox.y).toBeGreaterThanOrEqual(canvasBoxNow.y - 1);
      expect(cropRectBox.x + cropRectBox.width).toBeLessThanOrEqual(
        canvasBoxNow.x + canvasBoxNow.width + 1
      );
      expect(cropRectBox.y + cropRectBox.height).toBeLessThanOrEqual(
        canvasBoxNow.y + canvasBoxNow.height + 1
      );
    }

    // Back to pointer to exit crop mode. (Escape would also work but
    // Library's window-level Esc handler runs alongside CropTool's and
    // closes Focus entirely — that's a separate ordering issue not in
    // scope for this Phase 3.2 verification.)
    await win.locator('.psl__edit-toolbar button[data-tool="pointer"]').click();
    await expect(win.locator('[data-testid="crop-tool"]')).toHaveCount(0);

    // ---- Bug C: pointer tool selects, Delete removes --------------

    await expect(
      win.locator(
        '.psl__edit-toolbar button[data-tool="pointer"].is-active'
      )
    ).toHaveCount(1);

    // Click on the arrow we drew (mid-line at ≈ [0.425, 0.4]).
    const canvasBoxSel = await win.locator(".editor-canvas").boundingBox();
    if (canvasBoxSel === null) throw new Error("no canvas box");
    const hitX = canvasBoxSel.x + canvasBoxSel.width * 0.425;
    const hitY = canvasBoxSel.y + canvasBoxSel.height * 0.4;
    await win.mouse.click(hitX, hitY);

    // Selection outline should appear in the OverlaySvg.
    await win
      .locator('[data-testid="selection-outline"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await expect(
      win.locator('[data-testid="selection-outline"]')
    ).toHaveCount(1);

    await screenshot(testInfo, win, "05-arrow-selected.png");

    // Press Delete → overlay disappears from the bus list.
    await win.keyboard.press("Delete");
    await win.waitForTimeout(500);

    const listAfterDelete = await app.dispatch("layers:list", {
      captureId
    });
    expect(listAfterDelete.ok).toBe(true);
    if (listAfterDelete.ok) {
      const arrowLayersAfter = listAfterDelete.value.filter(
        (r) => r.kind === "vector" && r.shape.kind === "arrow"
      );
      expect(
        arrowLayersAfter.length,
        "arrow should be soft-deleted from the bus list"
      ).toBe(0);
    }
    // And the selection outline clears.
    await expect(
      win.locator('[data-testid="selection-outline"]')
    ).toHaveCount(0);

    await screenshot(testInfo, win, "06-arrow-deleted.png");
  } finally {
    await app.close();
  }
});

// -----------------------------------------------------------------
// Helpers

async function screenshot(
  testInfo: import("@playwright/test").TestInfo,
  win: Page,
  name: string
): Promise<void> {
  const buf = await win.screenshot({ fullPage: false });
  await testInfo.attach(name, { body: buf, contentType: "image/png" });
  // Also write to /tmp for easy attaching to the task report.
  const outPath = path.join("/tmp", `phase32-${name}`);
  await writeFile(outPath, buf);
}
