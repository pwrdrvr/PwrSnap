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

// Second test: the same hug contract under the states the first test never
// reaches — zoomed, multi-line, and rotated. These exercise the full chain
// the stale-scale fix depends on: zoom resizes the canvas's LAYOUT box →
// the canvasCssHeight ResizeObserver fires → TextHtml re-measures at the
// new scale → the registry republishes → the outline follows. A regression
// anywhere in that chain (a transform-polluted scale, a missed re-measure,
// a stale registry entry) shows up as center drift here.
//
// Measured margins on macOS when written: zoomed drift 0.23px (integer
// `offsetWidth` rounding at the larger glyph — the documented residual),
// multi-line drift 0.05px, rotation angle agreement 1e-5°.
test("editor-text-outline: outline hugs under zoom, multi-line, and rotation", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "text-outline-states",
      sourceAppName: "Text Outline States"
    });
    const win = await openEditor(app, captureId);
    const canvas = win.locator(".editor-canvas");
    await canvas.waitFor({ state: "visible", timeout: 15_000 });

    const measure = async (idx: number) =>
      await win.evaluate((i) => {
        const g = document.querySelectorAll('[data-testid="text-glyph"]')[i];
        const r = document.querySelector(
          '[data-testid="chrome-svg"] [data-testid="selection-outline"] rect'
        );
        if (g === undefined || r === null) return null;
        const gr = g.getBoundingClientRect();
        const rr = r.getBoundingClientRect();
        return {
          fontPx: parseFloat(getComputedStyle(g as HTMLElement).fontSize),
          glyphH: gr.height,
          outlineH: rr.height,
          dcx: (rr.left + rr.right) / 2 - (gr.left + gr.right) / 2,
          dcy: (rr.top + rr.bottom) / 2 - (gr.top + gr.bottom) / 2
        };
      }, idx);

    const addText = async (
      pos: { x: number; y: number },
      body: string
    ): Promise<void> => {
      await selectTool(win, "text");
      await canvas.click({ position: pos });
      const draft = win.locator('textarea[aria-label="Edit text annotation"]');
      await draft.waitFor({ state: "visible", timeout: 5_000 });
      await draft.fill(body);
      await win.keyboard.press("Enter");
      await selectTool(win, "pointer");
    };

    const selectGlyph = async (idx: number): Promise<void> => {
      const g = win.locator('[data-testid="text-glyph"]').nth(idx);
      await g.waitFor({ state: "visible", timeout: 15_000 });
      const gb = await g.boundingBox();
      expect(gb, "glyph box").not.toBeNull();
      if (gb === null) throw new Error("unreachable");
      await win.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2);
      await win
        .locator('[data-testid="selection-outline"]')
        .first()
        .waitFor({ timeout: 5_000 });
    };

    // ---- zoomed: create, select, zoom 1.25x, outline must still hug ----
    await addText({ x: 220, y: 110 }, "Inject WWWW message yqg");
    await selectGlyph(0);
    const base = await measure(0);
    expect(base).not.toBeNull();
    if (base === null) return;
    await win.keyboard.press("ControlOrMeta+=");
    // Poll until the glyph's fontSize reflects the new scale — the chain is
    // RO → state → re-render → re-measure → registry emit, all async.
    await expect
      .poll(async () => (await measure(0))?.fontPx ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(base.fontPx * 1.2);
    const zoomed = await measure(0);
    expect(zoomed).not.toBeNull();
    if (zoomed === null) return;
    expect(Math.abs(zoomed.dcx), `zoomed drift ${zoomed.dcx.toFixed(2)}px`).toBeLessThan(1.5);
    expect(Math.abs(zoomed.dcy)).toBeLessThan(3);
    await win.keyboard.press("ControlOrMeta+0");
    await expect
      .poll(async () => (await measure(0))?.fontPx ?? 0, { timeout: 5_000 })
      .toBeLessThan(base.fontPx * 1.1);

    // ---- multi-line: 3 lines incl. a wide-cap line; outline hugs block ----
    await addText({ x: 220, y: 300 }, "Two lines\nof WWWW text\nyqg gap");
    await selectGlyph(1);
    const multi = await measure(1);
    expect(multi).not.toBeNull();
    if (multi === null) return;
    expect(Math.abs(multi.dcx), `multiline drift ${multi.dcx.toFixed(2)}px`).toBeLessThan(1.5);
    expect(Math.abs(multi.dcy)).toBeLessThan(3);
    // Height tracks the 3-line block, not a single line.
    expect(multi.glyphH).toBeGreaterThan(multi.fontPx * 2.9);
    expect(multi.outlineH).toBeGreaterThan(multi.fontPx * 2.9);

    // ---- rotated: drag the rotate handle; outline rotation must match ----
    await selectGlyph(0);
    const rot = win.locator('[data-testid="transform-handle-rotate"]');
    await rot.waitFor({ timeout: 5_000 });
    const rb = await rot.boundingBox();
    expect(rb, "rotate handle box").not.toBeNull();
    if (rb === null) return;
    const rcx = rb.x + rb.width / 2;
    const rcy = rb.y + rb.height / 2;
    await win.mouse.move(rcx, rcy);
    await win.mouse.down();
    await win.mouse.move(rcx + 60, rcy + 25, { steps: 8 });
    await win.mouse.up();
    const rotated = await win.evaluate(() => {
      const g = document.querySelector<HTMLElement>('[data-testid="text-glyph"]');
      const wrap = g?.parentElement ?? null;
      const og = document.querySelector(
        '[data-testid="chrome-svg"] [data-testid="selection-outline"]'
      );
      const orect = og?.querySelector("rect");
      if (g === null || wrap === null || og === null || !orect) return null;
      const m = new DOMMatrix(getComputedStyle(wrap).transform);
      const glyphDeg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
      const match = /rotate\((-?[\d.]+)/.exec(og.getAttribute("transform") ?? "");
      const gr = g.getBoundingClientRect();
      const rr = orect.getBoundingClientRect();
      return {
        glyphDeg,
        outlineDeg: match === null ? null : parseFloat(match[1]),
        dcx: (rr.left + rr.right) / 2 - (gr.left + gr.right) / 2,
        dcy: (rr.top + rr.bottom) / 2 - (gr.top + gr.bottom) / 2
      };
    });
    expect(rotated).not.toBeNull();
    if (rotated === null) return;
    expect(Math.abs(rotated.glyphDeg), "rotation actually happened").toBeGreaterThan(2);
    expect(rotated.outlineDeg).not.toBeNull();
    expect(Math.abs((rotated.outlineDeg ?? 0) - rotated.glyphDeg)).toBeLessThan(0.5);
    // The rotated boxes' axis-aligned bounds share a center when outline
    // and glyph rotate around the same pivot by the same angle.
    expect(Math.abs(rotated.dcx)).toBeLessThan(2);
    expect(Math.abs(rotated.dcy)).toBeLessThan(3);
  } finally {
    await app.close();
  }
});
