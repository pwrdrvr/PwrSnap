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
// Two regressions live here.
//
//   1. The outline used to size itself analytically via
//      `canvas.measureText` instead of the glyph's real measured box.
//      See docs/solutions/2026-06-25-text-selection-outline-measure-real-glyph.md.
//   2. The measured box was then divided by a STALE CSS:image scale,
//      because EditorLoaded read the canvas height from a post-transform
//      `getBoundingClientRect()` while `.psl__focus` was mid-entrance-
//      animation. See docs/solutions/2026-08-28-text-outline-stale-canvas-scale.md.
//
// (2) is why this assertion could only ever fail on macOS: it is a race
// against a 180ms CSS animation, not a font-metric difference.

import { expect, launchPwrSnap, test } from "./fixtures/electron-app";
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
    //    auto-focuses, so we can populate it immediately. Use mixed-width
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
    await draft.fill(body);
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
    // drift. Comparing CENTERS is what makes this sensitive: the outline
    // is anchored at the glyph's LEFT edge and only its WIDTH can be
    // wrong, so any width error shows up here at exactly half its size.
    //
    // 1px absolute. Once the outline consumes the published measurement
    // AND that measurement is divided by a layout-derived (not
    // post-transform) canvas scale, the only residual error is rounding:
    // `offsetWidth` is an integer (≤0.25px of center error) and
    // `canvasCssHeight` ignores sub-0.5px changes by design (~0.15px on
    // this fixture's glyph). Measured on macOS after the fix: 0.00px.
    //
    // Do not loosen this to a percentage of the glyph width. It was
    // `max(3, w * 0.02)` while the stale-scale bug was open, because that
    // bug scaled with the glyph — which is exactly the property that let
    // it hide. A real regression here is a systematic mis-scale, and an
    // absolute bound names the actual tolerance instead of tracking the
    // defect.
    const glyphCx = (m.glyph.left + m.glyph.right) / 2;
    const glyphCy = (m.glyph.top + m.glyph.bottom) / 2;
    const outlineCx = (m.outline.left + m.outline.right) / 2;
    const outlineCy = (m.outline.top + m.outline.bottom) / 2;
    expect(
      Math.abs(outlineCx - glyphCx),
      `outline center drifted ${Math.abs(outlineCx - glyphCx).toFixed(2)}px on a ${m.glyph.w.toFixed(0)}px-wide glyph`
    ).toBeLessThan(1);
    // Vertical stays absolute: height is `fontSizePx × lineCount` in both
    // the measured and the analytic path, so there is no font-metric
    // divergence to scale with.
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
