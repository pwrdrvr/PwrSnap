// E2E coverage for the editor crop CLIP (PR #249).
//
// The editor renders the SOURCE raster directly, sizing the <img> to
// `(source / canvas) × 100%`, so a cropped capture's <img> OVERFLOWS
// the canvas box and must be clipped to it by the `.editor-image-clip`
// wrapper. `.editor-canvas` itself is overflow:visible on purpose so
// SelectionOutline + TransformHandles can extend off-canvas (#125),
// which means it can no longer clip the image — hence the wrapper.
//
// Regression guarded: #125 unclipped the image (overflow:visible on
// .editor-canvas, no wrapper) on the false assumption that the image
// never extends past the canvas. Cropped captures then rendered as the
// FULL uncropped image in the editor while every baked surface stayed
// correctly cropped. These specs assert:
//
//   1. The wrapper clips the oversized image to the canvas, and neither
//      the canvas nor the clip collapse to zero (the absolute wrapper
//      removes the <img> from flow — this guards the pre-measured
//      "canvas has no in-flow content" concern).
//   2. Off-origin crops translate the <img> AND still clip to the
//      canvas. (The translate MATH itself is unit-tested in
//      editor-image-style.test.ts; this checks the real layout.)
//   3. A backdrop-filter blur still renders, correctly positioned over
//      the clipped image (the clip wrapper is a sibling of the blur
//      layer and must not displace or hide it).
//
// Cross-platform: pure Chromium layout — runs on the Linux/xvfb CI
// subset, not macOS-only.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

// First spec cold-starts Electron; 90s mirrors the other editor specs.
test.setTimeout(90_000);

async function makeTempPng(widthPx: number, heightPx: number): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-crop-clip-src-"));
  const pngPath = path.join(dir, "fixture.png");
  const buf = await sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 3,
      background: { r: 30, g: 144, b: 255 }
    }
  })
    .png()
    .toBuffer();
  await writeFile(pngPath, buf);
  return pngPath;
}

/**
 * Seed a real raster-backed v2 capture (root group + raster at the PNG's
 * natural dims) through the production persistCaptureFromTempV2 pipeline.
 * `outputDir` is pinned under a tmpdir so the bundle never lands in the
 * host's real ~/Documents/PwrSnap (getCapturesRoot() defaults to the OS
 * documents dir, which the launch fixture does NOT rebase).
 */
async function seedBundleCapture(
  app: LaunchedApp,
  widthPx: number,
  heightPx: number
): Promise<string> {
  const tempPath = await makeTempPng(widthPx, heightPx);
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-crop-clip-out-"));
  return await app.electronApp.evaluate(
    async (_electron, payload) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            persistBundleCapture: (input: {
              tempPath: string;
              sourceApp: { bundleId: string | null; appName: string | null } | null;
              outputDir?: string;
            }) => Promise<{ record: { id: string } }>;
          };
        }
      ).__PWRSNAP_TEST__;
      const { record } = await bridge.persistBundleCapture({
        tempPath: payload.tempPath,
        sourceApp: { bundleId: "com.test.crop-clip", appName: "Crop Clip Spec" },
        outputDir: payload.outputDir
      });
      return record.id;
    },
    { tempPath, outputDir }
  );
}

async function openEditor(app: LaunchedApp, captureId: string): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok, "editor:open should succeed").toBe(true);
  const page = app.window;
  await page.locator(".psl__focus").waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('[data-testid="editor-image"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

/** Shrink the canvas — an edge-aligned crop's authoritative signal. */
async function cropCanvas(
  app: LaunchedApp,
  captureId: string,
  widthPx: number,
  heightPx: number
): Promise<void> {
  const res = await app.dispatch("bundle:updateCanvasDimensions", {
    captureId,
    widthPx,
    heightPx
  });
  expect(res.ok, "updateCanvasDimensions should succeed").toBe(true);
}

/**
 * Reproduce an off-origin crop's end state: translate the raster layer's
 * transform by (dx, dy). Mirrors useCaptureModel's crop "Step 0.5"
 * (delete + re-upsert the raster with the new translation). Driven
 * through the loosely-typed test bridge so we don't thread the strict
 * AffineTransform tuple / BundleLayerNode union through app.dispatch.
 */
async function translateRaster(
  app: LaunchedApp,
  captureId: string,
  dx: number,
  dy: number
): Promise<void> {
  await app.electronApp.evaluate(
    async (_electron, payload) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            dispatch: (
              n: string,
              r: unknown
            ) => Promise<{ ok: boolean; value?: unknown }>;
          };
        }
      ).__PWRSNAP_TEST__;
      const listed = await bridge.dispatch("layers:list", {
        captureId: payload.captureId
      });
      const layers = (listed.value ?? []) as Array<{ id: string; kind: string }>;
      const raster = layers.find((l) => l.kind === "raster");
      if (raster === undefined) throw new Error("no raster layer to translate");
      const del = await bridge.dispatch("layers:delete", { id: raster.id });
      if (!del.ok) throw new Error("layers:delete failed");
      const up = await bridge.dispatch("layers:upsert", {
        captureId: payload.captureId,
        layer: {
          ...raster,
          id: "rasterShifted001",
          transform: [1, 0, 0, 1, payload.dx, payload.dy]
        }
      });
      if (!up.ok) throw new Error("layers:upsert failed");
    },
    { captureId, dx, dy }
  );
}

/**
 * Insert a gaussian blur effect layer over a canvas-pixel rect. Avoids a
 * flaky UI drag — the point of the test is the RENDER of a blur over the
 * clipped image, not the draw gesture (covered elsewhere). `clip_rect`
 * is absolute canvas pixels per the EffectLayer contract.
 */
async function insertGaussianBlur(
  app: LaunchedApp,
  captureId: string,
  clipRect: { x: number; y: number; w: number; h: number }
): Promise<void> {
  await app.electronApp.evaluate(
    async (_electron, payload) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            dispatch: (
              n: string,
              r: unknown
            ) => Promise<{ ok: boolean; value?: unknown }>;
          };
        }
      ).__PWRSNAP_TEST__;
      const listed = await bridge.dispatch("layers:list", {
        captureId: payload.captureId
      });
      const layers = (listed.value ?? []) as Array<{
        id: string;
        kind: string;
        parent_id: string | null;
      }>;
      const root = layers.find(
        (l) => l.kind === "group" && l.parent_id === null
      );
      if (root === undefined) throw new Error("no root group");
      const now = new Date().toISOString();
      const up = await bridge.dispatch("layers:upsert", {
        captureId: payload.captureId,
        layer: {
          id: "blurEffectItem01",
          parent_id: root.id,
          name: "Blur",
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          z_index: 1000,
          source: "user",
          ai_run_id: null,
          applied_at: now,
          rejected_at: null,
          superseded_by: null,
          created_at: now,
          kind: "effect",
          effect: { type: "blur", radius_px: 14, style: "gaussian", rotation: 0 },
          clip_rect: payload.clipRect
        }
      });
      if (!up.ok) throw new Error("layers:upsert (blur) failed");
    },
    { captureId, clipRect }
  );
}

function approxEqual(a: number, b: number, tol = 1.5): boolean {
  return Math.abs(a - b) <= tol;
}

type CropClipLayer = {
  kind: string;
  clip_rect?: { x: number; y: number; w: number; h: number } | null;
  shape?: { kind?: string; rect?: { x: number; y: number; w: number; h: number } };
};

async function readLayers(
  app: LaunchedApp,
  captureId: string
): Promise<CropClipLayer[]> {
  const res = await app.dispatch("layers:list", { captureId });
  expect(res.ok, "layers:list should succeed").toBe(true);
  if (!res.ok) return [];
  return res.value as unknown as CropClipLayer[];
}

test("editor-crop-clip: cropped capture clips the source to the canvas; canvas + clip never collapse", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedBundleCapture(app, 800, 600);
    // Edge-aligned band crop: canvas shrinks to an 800×180 strip while
    // the raster stays 800×600, so the <img> renders at 100% × 333%.
    await cropCanvas(app, captureId, 800, 180);
    const win = await openEditor(app, captureId);

    const canvasBox = await win.locator(".editor-canvas").first().boundingBox();
    const clipBox = await win.locator(".editor-image-clip").first().boundingBox();
    const imgBox = await win
      .locator('[data-testid="editor-image"]')
      .first()
      .boundingBox();
    expect(canvasBox, "canvas box").not.toBeNull();
    expect(clipBox, "clip box").not.toBeNull();
    expect(imgBox, "img box").not.toBeNull();
    if (canvasBox === null || clipBox === null || imgBox === null) return;

    // Pre-measured no-collapse: canvas + clip have real, non-zero size.
    // The clip is position:absolute; inset:0, so making the <img>
    // absolute can't collapse the canvas to 0 (the in-flow-content
    // concern when the image left the flow).
    expect(canvasBox.width).toBeGreaterThan(0);
    expect(canvasBox.height).toBeGreaterThan(0);

    // The clip box IS the canvas box (inset:0).
    expect(approxEqual(clipBox.x, canvasBox.x)).toBe(true);
    expect(approxEqual(clipBox.y, canvasBox.y)).toBe(true);
    expect(approxEqual(clipBox.width, canvasBox.width)).toBe(true);
    expect(approxEqual(clipBox.height, canvasBox.height)).toBe(true);

    // overflow:hidden is what actually hides the overflowing image.
    const overflow = await win
      .locator(".editor-image-clip")
      .first()
      .evaluate((el) => getComputedStyle(el).overflow);
    expect(overflow).toBe("hidden");

    // The <img> genuinely OVERFLOWS its clip (source 600 / canvas 180 ≈
    // 3.33× taller). getBoundingClientRect reports the full layout box
    // regardless of the ancestor's clipping, so a taller img proves the
    // overflow exists and is being HIDDEN by the wrapper — not that the
    // image was squashed to fit (which would have hidden the crop, the
    // original bug).
    expect(imgBox.height).toBeGreaterThan(clipBox.height * 1.8);
  } finally {
    await app.close();
  }
});

test("editor-crop-clip: off-origin crop translates the image and clips it to the canvas", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedBundleCapture(app, 800, 600);
    // Off-origin end state: canvas 400×300, raster translated by
    // (-200, -150) so the editor shows the user's chosen interior
    // region. computeEditorImageStyle maps that to translate(-25%, -25%)
    // (tx/sourceW = -200/800, ty/sourceH = -150/600).
    await cropCanvas(app, captureId, 400, 300);
    await translateRaster(app, captureId, -200, -150);
    const win = await openEditor(app, captureId);

    const transform = await win
      .locator('[data-testid="editor-image"]')
      .first()
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(transform).toBe("translate(-25%, -25%)");

    const canvasBox = await win.locator(".editor-canvas").first().boundingBox();
    const clipBox = await win.locator(".editor-image-clip").first().boundingBox();
    const imgBox = await win
      .locator('[data-testid="editor-image"]')
      .first()
      .boundingBox();
    if (canvasBox === null || clipBox === null || imgBox === null) {
      throw new Error("missing editor layout boxes");
    }

    // Clip == canvas, and the translated image overflows it (source 600
    // / canvas 300 = 2× taller) so the off-canvas region is hidden.
    expect(approxEqual(clipBox.width, canvasBox.width)).toBe(true);
    expect(approxEqual(clipBox.height, canvasBox.height)).toBe(true);
    expect(imgBox.height).toBeGreaterThan(clipBox.height * 1.5);
  } finally {
    await app.close();
  }
});

test("editor-crop-clip: blur renders within the canvas over a cropped capture (clip wrapper preserves the blur layer)", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedBundleCapture(app, 800, 600);
    // Crop to 800×400 (img overflows at 150%) so the clip wrapper is
    // engaged, then drop a gaussian blur over a canvas-pixel rect.
    await cropCanvas(app, captureId, 800, 400);
    await insertGaussianBlur(app, captureId, { x: 120, y: 80, w: 320, h: 160 });
    const win = await openEditor(app, captureId);

    // The committed gaussian blur renders as an .ed-blur-item--gaussian
    // div, positioned by canvas-relative percentages. It is a SIBLING of
    // the clip wrapper, so the wrapper must not displace, clip away, or
    // zero it.
    const blur = win.locator(".ed-blur-item--gaussian").first();
    await blur.waitFor({ state: "attached", timeout: 10_000 });
    const blurBox = await blur.boundingBox();
    const canvasBox = await win.locator(".editor-canvas").first().boundingBox();
    expect(blurBox, "blur box").not.toBeNull();
    expect(canvasBox, "canvas box").not.toBeNull();
    if (blurBox === null || canvasBox === null) return;

    // Real, non-zero size.
    expect(blurBox.width).toBeGreaterThan(0);
    expect(blurBox.height).toBeGreaterThan(0);

    // Positioned INSIDE the canvas bounds (small tolerance for sub-px
    // rounding) — not clipped off or pushed out by the wrapper.
    expect(blurBox.x).toBeGreaterThanOrEqual(canvasBox.x - 2);
    expect(blurBox.y).toBeGreaterThanOrEqual(canvasBox.y - 2);
    expect(blurBox.x + blurBox.width).toBeLessThanOrEqual(
      canvasBox.x + canvasBox.width + 2
    );
    expect(blurBox.y + blurBox.height).toBeLessThanOrEqual(
      canvasBox.y + canvasBox.height + 2
    );
  } finally {
    await app.close();
  }
});

test("editor-crop-clip: off-origin crop translates a blur's clip_rect so it keeps covering the same region", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedBundleCapture(app, 800, 600);
    // Blur over a known source region, fully inside the kept area of the
    // centered-60% default crop (kept region is source [160,640]×[120,480]).
    const blurBefore = { x: 300, y: 240, w: 120, h: 90 };
    await insertGaussianBlur(app, captureId, blurBefore);
    const win = await openEditor(app, captureId);

    // Apply an OFF-ORIGIN crop through the REAL crop dispatch. Selecting
    // the Crop tool seeds a centered 60% rect ({0.2, 0.2, 0.6, 0.6} — both
    // x and y > 0), and Apply Crop runs useCaptureModel's crop op.
    await win.locator('.psl__edit-toolbar button[data-tool="crop"]').click();
    await win
      .locator('[data-testid="crop-tool"]')
      .waitFor({ state: "visible", timeout: 10_000 });
    await win.locator('[data-testid="crop-apply"]').click();
    // Crop commits → exits crop mode (tool → pointer), so the overlay
    // detaches once every crop write has landed in the DB.
    await win
      .locator('[data-testid="crop-tool"]')
      .waitFor({ state: "detached", timeout: 10_000 });

    const layers = await readLayers(app, captureId);
    const cropVec = layers.find(
      (l) => l.kind === "vector" && l.shape?.kind === "crop"
    );
    const blur = layers.find((l) => l.kind === "effect");
    expect(cropVec, "crop vector layer recorded").toBeTruthy();
    expect(blur, "blur effect layer survives the crop").toBeTruthy();
    const cropRect = cropVec?.shape?.rect;
    const clip = blur?.clip_rect;
    if (cropRect === undefined || clip === null || clip === undefined) {
      throw new Error("missing crop rect / blur clip_rect");
    }

    // A crop is a viewport translate: the blur must keep covering the
    // SAME source region. Its clip_rect (absolute canvas px) shifts by
    // the crop's pixel offset (rect.{x,y} × OLD canvas dims = 800×600),
    // exactly like the raster transform (Step 0.5). The dispatcher
    // currently SKIPS effect layers, so the blur drifts — failing here.
    // clip_rect drives BOTH the editor render and the bake (library
    // thumbnail), so this single check covers both surfaces.
    const offsetX = cropRect.x * 800;
    const offsetY = cropRect.y * 600;
    expect(approxEqual(clip.x, blurBefore.x - offsetX)).toBe(true);
    expect(approxEqual(clip.y, blurBefore.y - offsetY)).toBe(true);
    expect(approxEqual(clip.w, blurBefore.w)).toBe(true);
    expect(approxEqual(clip.h, blurBefore.h)).toBe(true);
  } finally {
    await app.close();
  }
});
