// E2E: the crop overlay must render against the canvas's LIVE rect.
//
// Regression guard for the stale-canvasRect class
// (docs/solutions/2026-08-28-text-outline-stale-canvas-scale.md, "A second
// instance"): EditorLoaded caches the canvas's post-transform DOMRect for
// CropTool, and the cache froze mid-`.psl__focus`-entrance-animation — a
// finishing transform fires no ResizeObserver and touches no effect dep, so
// nothing ever re-measured. The fix re-measures when the crop tool opens
// (`tool` in the effect's deps).
//
// What a stale rect actually breaks — established by measurement, not the
// obvious guess: every CropTool pointer gesture is DELTA-based, and a drag
// delta maps screen→source→screen through the SAME cached width, so the
// staleness cancels exactly and drags track the pointer perfectly even
// against a badly stale rect. A drag-tracking assertion is therefore
// TAUTOLOGICAL here — it can never fail, and must not be trusted as a guard
// (a reverted-fix build passed it 8/8). What does NOT cancel is rendering:
// the selection rect and the dim tiles are drawn at the cached scale inside
// a live-sized canvas, so the highlighted region covers different image
// content than the commit will keep (~1.5% pre-fix — ~12px at the far
// corner), and the dim overlay stops short of the canvas edge (the visible
// L-gap that exposed the bug).
//
// So the load-bearing assertion is render-vs-live: the default crop rect is
// a centered 60% of the source, so its SE corner must sit at
// live.left + 0.8·live.width (and 0.8·height). To make the guard bite
// DETERMINISTICALLY — the organic race self-heals whenever a late layout
// nudge (font swap, rail settle) re-measures behind the animation — stage 0
// recreates the stale state faithfully: put the entrance animation's own
// transform back on `.psl__focus`, force re-measures under it (zoom
// round-trip changes the canvasStyle deps), then remove it (no observer, no
// dep). Opening crop must then re-measure. With the fix the corner lands on
// the live prediction; with the fix reverted it lands ~12px off, every run.

import { expect, launchPwrSnap, test } from "./fixtures/electron-app";
import { openEditor, seedImageCapture, selectTool } from "./fixtures/editor";

test.setTimeout(90_000);

test("editor-crop-drag: crop overlay renders against the live canvas rect", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "crop-drag",
      sourceAppName: "Crop Drag Spec"
    });
    const win = await openEditor(app, captureId);
    const canvas = win.locator(".editor-canvas");
    await canvas.waitFor({ state: "visible", timeout: 15_000 });
    const cropRect = win.locator('[data-testid="crop-rect"]');

    // SE corner of the rendered crop selection vs the position predicted
    // from the LIVE canvas rect and the crop's known source-space rect
    // (fractions of source dims — the default rect is x:0.2 y:0.2 w:0.6
    // h:0.6). Any stale cached scale shows up here and nowhere else.
    const seCornerError = async (
      fx: number,
      fy: number
    ): Promise<{ ex: number; ey: number }> =>
      await win.evaluate(
        ([fxN, fyN]) => {
          const cv = document.querySelector('[data-testid="editor-canvas"]');
          const cr = document.querySelector('[data-testid="crop-rect"]');
          if (cv === null || cr === null) throw new Error("missing nodes");
          const live = cv.getBoundingClientRect();
          const sel = cr.getBoundingClientRect();
          return {
            ex: sel.right - (live.left + fxN * live.width),
            ey: sel.bottom - (live.top + fyN * live.height)
          };
        },
        [fx, fy]
      );

    // ---- stage 0: deterministic staleness — the entrance animation,
    //      replayed. Settle first so no late reflow re-measures for us.
    await win.evaluate(async () => {
      await document.fonts.ready;
    });
    await win.waitForTimeout(300);
    const focusTransform = async (value: string): Promise<void> => {
      await win.evaluate((v) => {
        const el = document.querySelector<HTMLElement>(".psl__focus");
        if (el === null) throw new Error("no .psl__focus");
        el.style.transform = v;
      }, value);
    };
    await focusTransform("scale(0.985)");
    // Force re-measures while the transform is live: the zoom round-trip
    // changes canvasStyle width/height (zoom is layout, not transform),
    // so the canvasRect effect re-runs — and reads a polluted rect, the
    // exact mechanism of the original bug.
    const cw0 = (await canvas.boundingBox())?.width ?? 0;
    await win.keyboard.press("ControlOrMeta+=");
    await expect
      .poll(async () => (await canvas.boundingBox())?.width ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(cw0 * 1.05);
    await win.keyboard.press("ControlOrMeta+0");
    await expect
      .poll(async () => (await canvas.boundingBox())?.width ?? 0, { timeout: 5_000 })
      .toBeLessThan(cw0 * 1.05);
    // Let the ⌘0 resize's TRAILING ResizeObserver delivery land while the
    // transform is still applied — it re-measures a frame after the layout
    // effect, and removing the transform before it lands would let it
    // refresh the cache and defeat the poison (observed: pass/fail races
    // without this wait).
    await win.evaluate(
      async () =>
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 80))
          );
        })
    );
    await focusTransform("");
    // The transform's removal fires nothing — the cache is now stale,
    // exactly as after the real entrance animation. Opening the crop tool
    // must re-measure.
    await selectTool(win, "crop");
    await cropRect.waitFor({ timeout: 10_000 });
    const e0 = await seCornerError(0.8, 0.8);
    expect(
      Math.abs(e0.ex),
      `SE x off by ${e0.ex.toFixed(2)}px — crop overlay rendered against a stale canvasRect`
    ).toBeLessThan(3);
    expect(Math.abs(e0.ey), `SE y off by ${e0.ey.toFixed(2)}px`).toBeLessThan(3);

    // ---- stage 1: the dim overlay tiles the whole canvas — its outer
    //      edges must reach the live canvas edges (the pre-fix defect
    //      left a visible gap at the bottom-right corner).
    const dim = await win.evaluate(() => {
      const cv = document.querySelector('[data-testid="editor-canvas"]');
      const overlay = document.querySelector('[data-testid="crop-tool"]');
      if (cv === null || overlay === null) throw new Error("missing nodes");
      const live = cv.getBoundingClientRect();
      // Union of every positioned child that is a dim tile: use the
      // overlay's own box (inset:0 in the canvas) as the frame and find
      // the max extent of the dim divs (they carry no testid; they are
      // the four direct children before the crop-rect).
      let maxRight = -Infinity;
      let maxBottom = -Infinity;
      for (const child of Array.from(overlay.children)) {
        const r = child.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > maxRight) maxRight = r.right;
        if (r.bottom > maxBottom) maxBottom = r.bottom;
      }
      return { gapRight: live.right - maxRight, gapBottom: live.bottom - maxBottom };
    });
    expect(Math.abs(dim.gapRight), `dim gap right ${dim.gapRight.toFixed(2)}px`).toBeLessThan(3);
    expect(Math.abs(dim.gapBottom), `dim gap bottom ${dim.gapBottom.toFixed(2)}px`).toBeLessThan(3);

    // ---- stage 2: zoom with the crop tool OPEN (canvasStyle deps change,
    //      the cache must re-measure while its consumer is on screen),
    //      then re-assert the corner against the live rect.
    const preZoom = (await canvas.boundingBox())?.width ?? 0;
    await win.keyboard.press("ControlOrMeta+=");
    await expect
      .poll(async () => (await canvas.boundingBox())?.width ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(preZoom * 1.05);
    const e2 = await seCornerError(0.8, 0.8);
    expect(Math.abs(e2.ex), `zoomed SE x off by ${e2.ex.toFixed(2)}px`).toBeLessThan(3);
    expect(Math.abs(e2.ey), `zoomed SE y off by ${e2.ey.toFixed(2)}px`).toBeLessThan(3);

    // ---- stage 3: interaction smoke — a handle drag still works and the
    //      selection follows the pointer. NOTE: this is deliberately NOT a
    //      staleness guard (drag deltas cancel a stale rect — see header);
    //      it only proves the gesture pipeline is alive.
    const se = win.locator('[data-testid="crop-handle-se"]');
    const seb = await se.boundingBox();
    expect(seb, "SE handle box").not.toBeNull();
    if (seb === null) return;
    const start = { x: seb.x + seb.width / 2, y: seb.y + seb.height / 2 };
    await win.mouse.move(start.x, start.y);
    await win.mouse.down();
    await win.mouse.move(start.x - 40, start.y - 30, { steps: 8 });
    await win.mouse.up();
    const after = await cropRect.boundingBox();
    expect(after, "crop rect after drag").not.toBeNull();
    if (after === null) return;
    expect(Math.abs(after.x + after.width - (start.x - 40))).toBeLessThan(3);
    expect(Math.abs(after.y + after.height - (start.y - 30))).toBeLessThan(3);
  } finally {
    await app.close();
  }
});
