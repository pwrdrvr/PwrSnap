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
// glyph (usually too wide). See
// docs/solutions/2026-06-25-text-selection-outline-measure-real-glyph.md.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

// First spec cold-starts Electron; mirror the 90s bump used by the other
// editor specs.
test.setTimeout(90_000);

test("editor-text-outline: selection outline hugs the rendered glyph", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
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

    // 4) Measure both in screen px and compare. The outline is sized
    //    from the glyph's measured box plus a small normalized pad
    //    (0.006 of the canvas per edge ≈ a handful of screen px). So the
    //    outline should be SLIGHTLY larger than the glyph and track it
    //    tightly. The old drift made the box tens of px too wide.
    const m = await win.evaluate(() => {
      const g = document.querySelector('[data-testid="text-glyph"]');
      const r = document.querySelector(
        '[data-testid="chrome-svg"] [data-testid="selection-outline"] rect'
      );
      if (g === null || r === null) return null;
      const gr = g.getBoundingClientRect();
      const rr = r.getBoundingClientRect();
      return {
        glyphW: gr.width,
        glyphH: gr.height,
        outlineW: rr.width,
        outlineH: rr.height
      };
    });
    expect(m, "should read both boxes").not.toBeNull();
    if (m === null) return;

    // Sanity: real, non-degenerate boxes.
    expect(m.glyphW).toBeGreaterThan(20);
    expect(m.glyphH).toBeGreaterThan(8);

    // The outline covers the glyph (allow a couple px of subpixel slack)…
    expect(m.outlineW).toBeGreaterThanOrEqual(m.glyphW - 3);
    expect(m.outlineH).toBeGreaterThanOrEqual(m.glyphH - 3);
    // …and hugs it — only the small pad larger, NOT the tens-of-px drift
    // the fallback-font estimate produced. Width is the load-bearing
    // assertion (the reported symptom was a too-wide box); height bound
    // is a looser sanity check since the pad is relatively larger
    // against a single line's height.
    expect(m.outlineW).toBeLessThanOrEqual(m.glyphW * 1.2 + 14);
    expect(m.outlineH).toBeLessThanOrEqual(m.glyphH * 1.6 + 14);
  } finally {
    await app.close();
  }
});

// ---- helpers (mirror editor-tool-styles.spec.ts) --------------------

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-text-outline-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  // 1×1 transparent PNG.
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `text-outline-${Date.now().toString(36)}-${Math.random()
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
        source_app_name: "Text Outline Spec",
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
    .locator('.psl__edit-toolbar button[data-tool="text"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

async function selectTool(win: Page, tool: string): Promise<void> {
  await win.locator(`.psl__edit-toolbar button[data-tool="${tool}"]`).click();
  await expect(
    win.locator(`.psl__edit-toolbar button[data-tool="${tool}"].is-active`)
  ).toHaveCount(1);
}
