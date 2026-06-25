// E2E: the text selection outline must hug the REAL rendered glyph.
//
// This is the only layer that exercises actual text layout. The unit
// tests (OverlaySvg.test.tsx / text-measure-registry.test.ts) prove the
// wiring — that the outline consumes a published measured box and falls
// back to the analytic estimate — but jsdom has no layout, so
// `offsetWidth` is always 0 there and the real measurement path never
// runs. Only a real Chromium editor can confirm the fix end-to-end:
// create text, select it, and assert the selection-outline `<rect>`
// tracks the rendered glyph `<div>` instead of a re-derived font-metric
// guess.
//
// Regression target: the outline used to size itself via
// `canvas.measureText` with the `-apple-system` stack, which a 2D canvas
// context resolves to a fallback font — so the box drifted from the
// glyph (usually too wide on the right). See
// docs/solutions/2026-06-25-text-selection-outline-measure-real-glyph.md.

import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";
import { openEditor, seedImageCapture, selectTool } from "./fixtures/editor";

// First spec cold-starts Electron; mirror the 90s bump used by the other
// editor specs.
test.setTimeout(90_000);

test("editor-text-outline: selection outline hugs the rendered glyph", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "text-outline",
      sourceAppName: "Text Outline Spec"
    });
    const win = await openEditor(app, captureId);

    // 1) Create a text annotation. The text tool turns a canvas
    //    pointerdown into a draft at that point; the draft textarea
    //    auto-focuses, so we can type immediately. Use mixed-width
    //    content (wide caps + lowercase) — the exact case the old
    //    char-count / fallback-font estimate mis-sized.
    await selectTool(win, "text");
    const canvas = win.locator(".editor-canvas");
    await canvas.waitFor({ state: "visible", timeout: 15_000 });
    // Click left-of-center so the text has room to extend rightward
    // inside the canvas.
    await canvas.click({ position: { x: 60, y: 110 } });

    const draft = win.locator('textarea[aria-label="Edit text annotation"]');
    await draft.waitFor({ state: "visible", timeout: 5_000 });
    const body = "Inject WWWW message yqg";
    await win.keyboard.type(body);
    await win.keyboard.press("Enter");

    // 2) The committed glyph renders via TextHtml (data-testid added for
    //    this test). Wait for the round-trip (persist → broadcast →
    //    refetch) to paint it.
    const glyph = win.locator('[data-testid="text-glyph"]', { hasText: body });
    await glyph.waitFor({ state: "visible", timeout: 15_000 });

    // 3) Select it. The text tool is sticky, so switch to the pointer
    //    tool first; then click the glyph's center on the canvas (the
    //    glyph itself is pointer-events:none, so the click falls through
    //    to the canvas hit-test, which selects the layer).
    await selectTool(win, "pointer");
    const gb = await glyph.boundingBox();
    expect(gb, "glyph should have a bounding box").not.toBeNull();
    if (gb === null) return;
    await win.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2);

    const outline = win.locator(
      '[data-testid="chrome-svg"] [data-testid="selection-outline"]'
    );
    await outline.waitFor({ state: "visible", timeout: 5_000 });

    // 4) Read both boxes in screen px. The outline is the glyph box plus
    //    a SYMMETRIC pad (SelectionOutline does `x - pad`, `w + 2·pad`
    //    with the same pad on every edge), so the two boxes share a
    //    center. Comparing CENTERS is the load-bearing assertion: it's
    //    independent of the exact pad value, robust to subpixel rounding
    //    (half the noise of a per-edge inset), AND exactly what the old
    //    bug broke — a mis-measured width pushed the RIGHT edge out while
    //    the left edge stayed anchored, shifting the center sideways.
    const m = await win.evaluate(() => {
      const g = document.querySelector('[data-testid="text-glyph"]');
      const r = document.querySelector(
        '[data-testid="chrome-svg"] [data-testid="selection-outline"] rect'
      );
      if (g === null || r === null) return null;
      const gr = g.getBoundingClientRect();
      const rr = r.getBoundingClientRect();
      return {
        glyph: { left: gr.left, right: gr.right, top: gr.top, bottom: gr.bottom, w: gr.width, h: gr.height },
        outline: { left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom }
      };
    });
    expect(m, "should read both boxes").not.toBeNull();
    if (m === null) return;

    // Sanity: a real, non-degenerate glyph.
    expect(m.glyph.w).toBeGreaterThan(20);
    expect(m.glyph.h).toBeGreaterThan(8);

    const leftInset = m.glyph.left - m.outline.left;
    const rightInset = m.outline.right - m.glyph.right;
    const topInset = m.glyph.top - m.outline.top;
    const bottomInset = m.outline.bottom - m.glyph.bottom;

    // The outline encloses the glyph on every edge (allow ~1.5px of
    // subpixel slack).
    for (const inset of [leftInset, rightInset, topInset, bottomInset]) {
      expect(inset).toBeGreaterThan(-1.5);
    }
    // Centers coincide — the outline hugs the glyph with no directional
    // drift. A mis-measured width (the old bug) shifts the outline center
    // off the glyph center by half the width error (tens of px); subpixel
    // rounding keeps the real delta ~1px, so 3px is tight but stable.
    const glyphCx = (m.glyph.left + m.glyph.right) / 2;
    const glyphCy = (m.glyph.top + m.glyph.bottom) / 2;
    const outlineCx = (m.outline.left + m.outline.right) / 2;
    const outlineCy = (m.outline.top + m.outline.bottom) / 2;
    expect(Math.abs(outlineCx - glyphCx)).toBeLessThan(3);
    expect(Math.abs(outlineCy - glyphCy)).toBeLessThan(3);
    // Sanity: the pad is a small affordance, not a giant box (guards a
    // uniform over-size that the center check alone would miss).
    for (const inset of [leftInset, rightInset, topInset, bottomInset]) {
      expect(inset).toBeLessThan(40);
    }
  } finally {
    await app.close();
  }
});
