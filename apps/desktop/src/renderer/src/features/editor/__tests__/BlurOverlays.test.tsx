// Tests for `BlurOverlays` — specifically the pixelate-preview path
// after issue #137.
//
// Issue #137 — the editor's pixelate preview was a static decoration:
// `backdrop-filter: blur(8px)` plus a diagonal-checker CSS pattern,
// no actual mosaic sampling. The bake (sharp's
// resize-down→nearest-up) produced a TRUE coarse-grid mosaic. Two
// renderings, two completely different looks.
//
// Post-fix the editor's pixelate item is a `<canvas>` that samples
// the underlying source image at coarse blocks, drawn with the same
// block-size formula as `compose-tree.ts` so the editor and the
// bake produce visually-matching mosaics.
//
// What this file pins:
//   1. A pixelate row renders as a `<canvas>` (not a styled div with
//      the old static-pattern class).
//   2. The canvas's internal resolution is the coarse-grid dim
//      (block-count, not display-pixel-count) so the browser's
//      `image-rendering: pixelated` upscale gives crisp mosaic
//      blocks.
//   3. Gaussian + redact items still render as styled divs
//      (untouched by this fix).

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";

import { BlurOverlays } from "../BlurOverlays";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function blurRow(
  id: string,
  style: "gaussian" | "pixelate" | "redact" = "pixelate"
): OverlayRow {
  return {
    id,
    capture_id: "cap_1",
    data: {
      kind: "blur",
      rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      style
    },
    schema_version: 1,
    source: "user",
    ai_run_id: null,
    applied_at: new Date().toISOString(),
    rejected_at: null,
    superseded_by: null,
    z_index: 0,
    created_at: new Date().toISOString()
  };
}

/** Render BlurOverlays with uncropped-capture defaults for the four
 *  source/translate props. Tests that pin the cropped-capture sampling
 *  branch pass explicit overrides; everything else degenerates to the
 *  uncropped identity (sourceWidth == canvasWidth, no rasterTranslate)
 *  which matches the pre-#147-followup test expectations. */
type RenderProps = Omit<
  Parameters<typeof BlurOverlays>[0],
  "sourceWidthPx" | "sourceHeightPx" | "rasterTranslateXPx" | "rasterTranslateYPx"
> & {
  sourceWidthPx?: number;
  sourceHeightPx?: number;
  rasterTranslateXPx?: number;
  rasterTranslateYPx?: number;
};

function render(props: RenderProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const fullProps: Parameters<typeof BlurOverlays>[0] = {
    ...props,
    sourceWidthPx: props.sourceWidthPx ?? props.canvasWidthPx,
    sourceHeightPx: props.sourceHeightPx ?? props.canvasHeightPx,
    rasterTranslateXPx: props.rasterTranslateXPx ?? 0,
    rasterTranslateYPx: props.rasterTranslateYPx ?? 0
  };
  act(() => {
    root!.render(createElement(BlurOverlays, fullProps));
  });
  return container;
}

// Stub HTMLImageElement properties so `imageRef.current` looks "loaded".
function makeFakeImage(): HTMLImageElement {
  const img = document.createElement("img");
  Object.defineProperty(img, "complete", { value: true, configurable: true });
  Object.defineProperty(img, "naturalWidth", { value: 400, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 300, configurable: true });
  return img;
}

describe("BlurOverlays — pixelate uses a canvas mosaic (issue #137)", () => {
  test("a pixelate row renders as a <canvas> (no static-checker div)", () => {
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [blurRow("blur_pix", "pixelate")],
      draft: null,
      blurStyle: "pixelate",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    // Pre-fix: a `<div class="ed-blur-item ed-blur-item--pixelate">`
    // Post-fix: a `<canvas>` whose CSS positions it at the rect bounds
    const canvas = el.querySelector("canvas");
    expect(
      canvas,
      "pixelate row should render as a <canvas> element so the underlying " +
        "image is sampled at coarse blocks with image-rendering: pixelated. " +
        "If you see this fail, the editor reverted to the static-pattern preview."
    ).not.toBeNull();
    // And explicitly: NO static-pattern divs for the pixelate kind.
    const staticPatternDivs = el.querySelectorAll("div.ed-blur-item--pixelate");
    expect(
      staticPatternDivs.length,
      "the old static-checker pixelate div must not be present"
    ).toBe(0);
  });

  test("gaussian rows still render as styled divs (untouched)", () => {
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [blurRow("blur_gauss", "gaussian")],
      draft: null,
      blurStyle: "gaussian",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const gaussian = el.querySelector("div.ed-blur-item--gaussian");
    expect(gaussian).not.toBeNull();
  });

  test("redact rows still render as styled divs (untouched)", () => {
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [blurRow("blur_red", "redact")],
      draft: null,
      blurStyle: "redact",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const redact = el.querySelector("div.ed-blur-item--redact");
    expect(redact).not.toBeNull();
  });

  test("the canvas's internal resolution matches the coarse-grid block count", async () => {
    const ref = createRef<HTMLImageElement>();
    // Stub drawImage + clearRect on the canvas 2d context so the
    // effect can run through (jsdom's canvas doesn't actually
    // rasterize without the optional `canvas` npm dep).
    const drawImageMock = vi.fn();
    const clearRectMock = vi.fn();
    const ctx2dMock = {
      drawImage: drawImageMock,
      clearRect: clearRectMock,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "high" as const
    };
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2dMock) as never;
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    // 400×300 canvas, 50%×50% rect → 200×150 rect short side 150
    // → blockSize = max(4, round(150/16)) = 9
    // → downW = floor(200/9) = 22, downH = floor(150/9) = 16
    const el = render({
      overlays: [blurRow("blur_pix", "pixelate")],
      draft: null,
      blurStyle: "pixelate",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    // Flush React's useEffect (the canvas-sizing happens there, not
    // in the initial render commit).
    await act(async () => undefined);
    const canvas = el.querySelector("canvas") as HTMLCanvasElement | null;
    expect(canvas).not.toBeNull();
    if (canvas === null) return;
    expect(canvas.width, "coarse-grid horizontal block count").toBe(22);
    expect(canvas.height, "coarse-grid vertical block count").toBe(16);
    // drawImage was called to sample the source into the coarse grid.
    expect(drawImageMock).toHaveBeenCalled();
    expect(clearRectMock).toHaveBeenCalled();
  });

  test("a live-drag draft with blurStyle 'pixelate' renders as a <canvas> (not a styled div)", () => {
    // The committed-overlay path is covered above. The live-drag path
    // is a SEPARATE branch in BlurOverlays.tsx:
    //
    //   {liveRect !== null && blurStyle === "pixelate" && <PixelateMosaicCanvas .../>}
    //   {liveRect !== null && blurStyle !== "pixelate" && <BlurOverlayItem .../>}
    //
    // A future refactor that flipped the conditions, fell through, or
    // merged the two would silently regress live-drag pixelate to a
    // styled div. This test pins the canvas signature for that path.
    //
    // The draft shape is `DraftRect` with kind="rect-drag", tool="blur".
    // rectFromDrag converts startXn/startYn/curXn/curYn into [0,1]
    // normalized {x,y,w,h}. We pick coords inside [0,1] so the resulting
    // rect passes the MIN_DRAG_LENGTH guard.
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [],
      draft: {
        kind: "rect-drag",
        tool: "blur",
        startXn: 0.2,
        startYn: 0.3,
        curXn: 0.7,
        curYn: 0.8
      },
      blurStyle: "pixelate",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const canvas = el.querySelector("canvas");
    expect(
      canvas,
      "live-drag draft with blurStyle 'pixelate' should render the canvas mosaic, " +
        "not the styled div for gaussian/redact"
    ).not.toBeNull();
    // And NO static-pattern div for the pixelate kind during the drag.
    const staticPatternDivs = el.querySelectorAll("div.ed-blur-item--pixelate");
    expect(staticPatternDivs.length).toBe(0);
  });

  test("a live-drag draft with blurStyle 'gaussian' renders as a styled div (not a canvas)", () => {
    // Mirror of the test above for the non-pixelate live-drag branch.
    // Catches the same refactor risk in the OTHER direction.
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [],
      draft: {
        kind: "rect-drag",
        tool: "blur",
        startXn: 0.2,
        startYn: 0.3,
        curXn: 0.7,
        curYn: 0.8
      },
      blurStyle: "gaussian",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const gaussianDraft = el.querySelector("div.ed-blur-item--gaussian.is-draft");
    expect(
      gaussianDraft,
      "live-drag draft with blurStyle 'gaussian' should still be a styled div"
    ).not.toBeNull();
    const stray = el.querySelector("canvas");
    expect(stray, "no canvas should mount for a gaussian live-drag").toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Issue #147 — rotated blur WYSIWYG mirror of the bake.
//
// The v2 bake (`compose-tree.ts applyEffectOntoAccumulator`) handles
// rotation by:
//   1. Computing the rotated rect's AABB in canvas-pixel space.
//   2. Extracting that AABB from the accumulator.
//   3. Applying the effect (gaussian / pixelate) to the AABB content.
//   4. Compositing back via a rotation mask so only the rotated-rect
//      interior shows the effect.
//
// The editor must mirror this for rotated gaussian + pixelate. Redact
// stays a styled div at any rotation — a rotated black square IS a
// rotated black square, no algorithmic divergence to fix.
//
// These tests pin the renderer mirror's contract: the canvas element
// for a rotated blur sits at the AABB position (not the rect), and
// CSS clip-path: polygon(...) clips the canvas to the rotated rect
// interior. If a future refactor breaks the mirror, the divergence
// surfaces here, not silently on a user's screen.
// ───────────────────────────────────────────────────────────────────────

function rotatedBlurRow(
  id: string,
  style: "gaussian" | "pixelate" | "redact",
  rotation: number,
  rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
): OverlayRow {
  return {
    id,
    capture_id: "cap_1",
    data: {
      kind: "blur",
      rect,
      style,
      rotation
    },
    schema_version: 1,
    source: "user",
    ai_run_id: null,
    applied_at: new Date().toISOString(),
    rejected_at: null,
    superseded_by: null,
    z_index: 0,
    created_at: new Date().toISOString()
  };
}

/** AABB math kept in sync with `computeRotatedAabb` in BlurOverlays.tsx.
 *  Tests use it to derive the EXPECTED canvas position/size for a
 *  given (rect, rotation, canvasDim) tuple without poking at module
 *  internals. */
function expectedAabb(args: {
  rect: { x: number; y: number; w: number; h: number };
  rotation: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
}): { x: number; y: number; w: number; h: number } {
  const { rect, rotation, canvasWidthPx, canvasHeightPx } = args;
  const rectXPx = rect.x * canvasWidthPx;
  const rectYPx = rect.y * canvasHeightPx;
  const rectWPx = rect.w * canvasWidthPx;
  const rectHPx = rect.h * canvasHeightPx;
  const cx = rectXPx + rectWPx / 2;
  const cy = rectYPx + rectHPx / 2;
  const hw = rectWPx / 2;
  const hh = rectHPx / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ].map(([lx, ly]) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos
  }));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

describe("BlurOverlays — rotated blur mirrors bake AABB + mask (issue #147)", () => {
  test("rotated gaussian routes to RotatedEffectCanvas (not the CSS backdrop-filter div)", () => {
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [rotatedBlurRow("blur_rg", "gaussian", Math.PI / 4)],
      draft: null,
      blurStyle: "gaussian",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const canvas = el.querySelector("canvas.ed-blur-item--rotated-gaussian");
    expect(
      canvas,
      "rotated gaussian should render as a canvas mirror of the bake's " +
        "rotated-AABB pipeline, not a CSS backdrop-filter div (which only " +
        "matches the bake at rotation === 0)."
    ).not.toBeNull();
    // The un-rotated CSS path must NOT also render.
    const cssDiv = el.querySelector("div.ed-blur-item--gaussian");
    expect(cssDiv).toBeNull();
  });

  test("rotated pixelate routes to RotatedEffectCanvas (not the unrotated mosaic canvas)", () => {
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [rotatedBlurRow("blur_rp", "pixelate", Math.PI / 6)],
      draft: null,
      blurStyle: "pixelate",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const canvas = el.querySelector("canvas.ed-blur-item--rotated-pixelate");
    expect(
      canvas,
      "rotated pixelate should route through the rotated-AABB canvas, " +
        "not the unrotated --pixelate-canvas which samples at the rect " +
        "(not the AABB) and gets WYSIWYG wrong for rotation !== 0."
    ).not.toBeNull();
    // The unrotated canvas class must NOT also be present.
    const unrotated = el.querySelector("canvas.ed-blur-item--pixelate-canvas");
    expect(unrotated).toBeNull();
  });

  test("rotated redact stays a styled div (no algorithmic mismatch to fix)", () => {
    // A rotated black square is a rotated black square. The bake fills
    // black inside the rotated-rect mask; the editor rotates a black
    // div via CSS transform. Both produce the same pixels at any
    // rotation, so we keep the cheap div path.
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [rotatedBlurRow("blur_rr", "redact", Math.PI / 3)],
      draft: null,
      blurStyle: "redact",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const redactDiv = el.querySelector("div.ed-blur-item--redact");
    expect(redactDiv).not.toBeNull();
    const stray = el.querySelector("canvas");
    expect(stray, "no canvas should mount for a rotated redact").toBeNull();
  });

  test("rotated canvas sits at the rotated rect's AABB (larger than the rect)", () => {
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    // 50%×50% rect rotated 45° — AABB corners swing out, the AABB is
    // larger than the rect in both dimensions.
    const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const rotation = Math.PI / 4;
    const canvasWidthPx = 400;
    const canvasHeightPx = 300;
    const el = render({
      overlays: [rotatedBlurRow("blur_aabb", "gaussian", rotation, rect)],
      draft: null,
      blurStyle: "gaussian",
      editorImageRef: ref,
      canvasWidthPx,
      canvasHeightPx
    });
    const canvas = el.querySelector(
      "canvas.ed-blur-item--rotated-gaussian"
    ) as HTMLCanvasElement | null;
    expect(canvas).not.toBeNull();
    if (canvas === null) return;
    const aabb = expectedAabb({ rect, rotation, canvasWidthPx, canvasHeightPx });
    // Position + size as percent-of-parent. Match within a small
    // tolerance to absorb the AABB Math.round happening in the
    // component (we don't round here).
    const leftPct = parseFloat(canvas.style.left);
    const topPct = parseFloat(canvas.style.top);
    const widthPct = parseFloat(canvas.style.width);
    const heightPct = parseFloat(canvas.style.height);
    expect(leftPct).toBeCloseTo((aabb.x / canvasWidthPx) * 100, 4);
    expect(topPct).toBeCloseTo((aabb.y / canvasHeightPx) * 100, 4);
    expect(widthPct).toBeCloseTo((aabb.w / canvasWidthPx) * 100, 4);
    expect(heightPct).toBeCloseTo((aabb.h / canvasHeightPx) * 100, 4);
    // Width % should be MEANINGFULLY larger than the rect's 50% — the
    // AABB at 45° expands to ~√2 × the rect's diagonal. For a 400-wide
    // canvas with a 200-wide rect, the AABB width is √2/2 × (200+150)
    // ≈ 247.5 → ~61.9% of 400. Anything under "rect's 50%" would mean
    // we forgot to take the AABB.
    expect(
      widthPct,
      `rotated rect's AABB width % (${widthPct.toFixed(2)}) should be ` +
        `meaningfully wider than the unrotated rect's 50%.`
    ).toBeGreaterThan(55);
  });

  test("rotated canvas's CSS clip-path is a 4-point polygon (rotation mask mirror)", () => {
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    const el = render({
      overlays: [
        rotatedBlurRow("blur_cp", "pixelate", Math.PI / 4, {
          x: 0.25,
          y: 0.25,
          w: 0.5,
          h: 0.5
        })
      ],
      draft: null,
      blurStyle: "pixelate",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const canvas = el.querySelector(
      "canvas.ed-blur-item--rotated-pixelate"
    ) as HTMLCanvasElement | null;
    expect(canvas).not.toBeNull();
    if (canvas === null) return;
    // clip-path mirrors the bake's SVG `dest-in` rotation mask.
    // Without it, the user would see a rotated-AABB-shaped blur
    // instead of a rotated-rect-shaped blur — bigger and wrong shape.
    const clipPath = canvas.style.clipPath;
    expect(clipPath, "rotated canvas must have a clip-path mask").toMatch(
      /^polygon\(/
    );
    // The polygon has 4 corners (one per rotated-rect vertex).
    const commas = (clipPath.match(/,/g) ?? []).length;
    expect(commas, "polygon should have 4 vertices = 3 commas").toBe(3);
  });

  test("at rotation === 0 the unrotated fast paths still kick in (regression guard)", () => {
    // The new RotatedEffectCanvas only activates when rotation !== 0.
    // At zero rotation we preserve the existing fast paths so the
    // load-bearing unrotated baseline that #137 fixed doesn't change.
    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    // Unrotated pixelate → the existing pixelate-canvas class.
    const el = render({
      overlays: [rotatedBlurRow("blur_unrot", "pixelate", 0)],
      draft: null,
      blurStyle: "pixelate",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    expect(
      el.querySelector("canvas.ed-blur-item--pixelate-canvas"),
      "rotation === 0 must keep the unrotated --pixelate-canvas fast path"
    ).not.toBeNull();
    expect(
      el.querySelector("canvas.ed-blur-item--rotated-pixelate"),
      "rotation === 0 must NOT engage the rotated-canvas path"
    ).toBeNull();
  });

  test("drawImage source rect matches the rotated rect's AABB in source-pixel coords", async () => {
    // The load-bearing assertion that addresses the user's PR #148
    // review: "you didn't resample what is under the rotated blur."
    // We mock ctx.drawImage and assert the SOURCE RECT passed to it
    // is the rotated rect's AABB in source-natural-pixel coords (i.e.
    // what the bake samples in `compose-tree.ts`'s rotated-effect
    // pipeline). If this test passes, the editor's sampling is at
    // the same pixels the bake operates on, modulo CSS clip-path.
    //
    // For uncropped captures (most of them) natural == canvas, so
    // the source rect equals the AABB in canvas-pixel coords.
    const drawImageCalls: Array<{
      srcX: number;
      srcY: number;
      srcW: number;
      srcH: number;
      dstX: number;
      dstY: number;
      dstW: number;
      dstH: number;
    }> = [];
    const drawImageMock = vi.fn(
      (
        _img: unknown,
        srcX: number,
        srcY: number,
        srcW: number,
        srcH: number,
        dstX: number,
        dstY: number,
        dstW: number,
        dstH: number
      ) => {
        drawImageCalls.push({ srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH });
      }
    );
    const ctx2dMock = {
      drawImage: drawImageMock,
      clearRect: vi.fn(),
      filter: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "high" as const
    };
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2dMock) as never;

    const ref = createRef<HTMLImageElement>();
    (ref as { current: HTMLImageElement }).current = makeFakeImage();
    // 400×300 canvas, 50%×50% rect → un-rotated 200×150 at (100, 75).
    // Rotated π/4 around center (200, 150). AABB worked out by hand:
    //   corners after rotation: (76.3, 26.3), (323.7, 167.7),
    //     (217.7, 273.7), (76.3, 132.3)
    //   AABB: x=76.3, y=26.3, w=247.4, h=247.4
    const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const rotation = Math.PI / 4;
    const canvasWidthPx = 400;
    const canvasHeightPx = 300;
    render({
      overlays: [rotatedBlurRow("blur_smp", "gaussian", rotation, rect)],
      draft: null,
      blurStyle: "gaussian",
      editorImageRef: ref,
      canvasWidthPx,
      canvasHeightPx
    });
    await act(async () => undefined);
    expect(drawImageCalls).toHaveLength(1);
    const call = drawImageCalls[0]!;
    const aabb = expectedAabb({ rect, rotation, canvasWidthPx, canvasHeightPx });
    // For makeFakeImage(): naturalWidth=400, naturalHeight=300, so
    // scaleX = scaleY = 1 (matches canvas dims). Source rect should
    // equal AABB in canvas pixels.
    expect(
      call.srcX,
      `drawImage source X should be the AABB's left edge (${aabb.x.toFixed(2)} px) — ` +
        `if this is off, the editor is sampling at the wrong canvas position ` +
        `and the rotated blur shows content from somewhere else.`
    ).toBeCloseTo(aabb.x, 4);
    expect(call.srcY).toBeCloseTo(aabb.y, 4);
    expect(call.srcW).toBeCloseTo(aabb.w, 4);
    expect(call.srcH).toBeCloseTo(aabb.h, 4);
    // Destination should map AABB → full canvas (start at 0, fill
    // internalW × internalH). Same aspect ratio as source so the
    // rotated rect interior shows correctly placed pixels.
    expect(call.dstX).toBe(0);
    expect(call.dstY).toBe(0);
    // dstW/dstH = aabbW/aabbH rounded (gaussian uses 1:1 internal res).
    // Tolerance of 1 absorbs the Math.round in the component.
    expect(Math.abs(call.dstW - aabb.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(call.dstH - aabb.h)).toBeLessThanOrEqual(1);
  });

  test("drawImage source rect for ROTATED blur on a CROPPED capture subtracts rasterTranslate + scales by natural/source", async () => {
    // The full general case (PR #148 follow-up): the canvas dims describe
    // the document's drawable area (post-crop), the source raster's
    // natural dims describe what the source PNG actually holds, and the
    // raster layer's transform[4]/[5] tells us WHERE in canvas-pixel
    // space the source raster's (0, 0) sits. For an off-origin crop
    // (e.g., user cropped down to the right-half), the rasterTranslate
    // is NEGATIVE — the source's origin sits OFF the left edge of the
    // canvas.
    //
    // canvasRectToImgNaturalRect should compute:
    //   srcX = (canvasX - rasterTranslateXPx) × (naturalWidth / sourceWidthPx)
    // For our setup: canvas=200×100, source=400×300, natural=800×600
    // (Retina source, 2× DPR), rasterTranslate=(-50, -25).
    //   scale = 800/400 = 2
    //   AABB at (76.3, 26.3, 247.4, 247.4) — wait, that's the 400×300
    //   case. Let me use a clean rect that fits the 200×100 canvas.
    //
    // Use a rect at (10%, 20%, 30%, 40%) of the canvas:
    //   canvas-px rect: (20, 20, 60, 40)
    //   no rotation for the AABB math here — easier hand-check. We use
    //   a small rotation to route through RotatedEffectCanvas.
    const drawImageCalls: Array<{
      srcX: number;
      srcY: number;
      srcW: number;
      srcH: number;
    }> = [];
    const drawImageMock = vi.fn(
      (
        _img: unknown,
        srcX: number,
        srcY: number,
        srcW: number,
        srcH: number
      ) => {
        drawImageCalls.push({ srcX, srcY, srcW, srcH });
      }
    );
    const ctx2dMock = {
      drawImage: drawImageMock,
      clearRect: vi.fn(),
      filter: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "high" as const
    };
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2dMock) as never;

    // Retina source 800×600; canvas (post-crop) 200×100; raster sits at
    // (-50, -25) so canvas shows the source region [50..250, 25..125]
    // in source-pixel coords.
    const ref = createRef<HTMLImageElement>();
    const img = document.createElement("img");
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 600, configurable: true });
    (ref as { current: HTMLImageElement }).current = img;

    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const rotation = Math.PI / 6;
    const canvasWidthPx = 200;
    const canvasHeightPx = 100;
    const sourceWidthPx = 400;
    const sourceHeightPx = 300;
    const rasterTranslateXPx = -50;
    const rasterTranslateYPx = -25;
    render({
      overlays: [rotatedBlurRow("blur_crop", "gaussian", rotation, rect)],
      draft: null,
      blurStyle: "gaussian",
      editorImageRef: ref,
      canvasWidthPx,
      canvasHeightPx,
      sourceWidthPx,
      sourceHeightPx,
      rasterTranslateXPx,
      rasterTranslateYPx
    });
    await act(async () => undefined);
    expect(drawImageCalls).toHaveLength(1);
    const call = drawImageCalls[0]!;
    const aabb = expectedAabb({ rect, rotation, canvasWidthPx, canvasHeightPx });
    // scale = naturalWidth / sourceWidthPx = 800 / 400 = 2.
    // Expected source rect = (AABB - rasterTranslate) × scale
    const scaleX = 800 / 400;
    const scaleY = 600 / 300;
    expect(
      call.srcX,
      "cropped+rotated source X should subtract rasterTranslate THEN scale by " +
        "natural/source. Without the rasterTranslate subtract the editor " +
        "samples from the WRONG region of the source raster."
    ).toBeCloseTo((aabb.x - rasterTranslateXPx) * scaleX, 4);
    expect(call.srcY).toBeCloseTo((aabb.y - rasterTranslateYPx) * scaleY, 4);
    expect(call.srcW).toBeCloseTo(aabb.w * scaleX, 4);
    expect(call.srcH).toBeCloseTo(aabb.h * scaleY, 4);
  });

  test("drawImage source rect for UNROTATED pixelate on a CROPPED capture subtracts rasterTranslate + scales by natural/source", async () => {
    // Sister test of the rotated one above — same scenario, but the
    // unrotated pixelate path runs through PixelateMosaicCanvas instead
    // of RotatedEffectCanvas. Both must respect the cropped-capture
    // sampling invariant or the editor's pixelate preview shows the
    // wrong region of the source.
    const drawImageCalls: Array<{
      srcX: number;
      srcY: number;
      srcW: number;
      srcH: number;
    }> = [];
    const drawImageMock = vi.fn(
      (
        _img: unknown,
        srcX: number,
        srcY: number,
        srcW: number,
        srcH: number
      ) => {
        drawImageCalls.push({ srcX, srcY, srcW, srcH });
      }
    );
    const ctx2dMock = {
      drawImage: drawImageMock,
      clearRect: vi.fn(),
      filter: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "high" as const
    };
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2dMock) as never;

    const ref = createRef<HTMLImageElement>();
    const img = document.createElement("img");
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 600, configurable: true });
    (ref as { current: HTMLImageElement }).current = img;

    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const canvasWidthPx = 200;
    const canvasHeightPx = 100;
    const sourceWidthPx = 400;
    const sourceHeightPx = 300;
    const rasterTranslateXPx = -50;
    const rasterTranslateYPx = -25;
    // rotation: 0 → unrotated path → PixelateMosaicCanvas.
    render({
      overlays: [rotatedBlurRow("blur_crop_pix", "pixelate", 0, rect)],
      draft: null,
      blurStyle: "pixelate",
      editorImageRef: ref,
      canvasWidthPx,
      canvasHeightPx,
      sourceWidthPx,
      sourceHeightPx,
      rasterTranslateXPx,
      rasterTranslateYPx
    });
    await act(async () => undefined);
    expect(drawImageCalls).toHaveLength(1);
    const call = drawImageCalls[0]!;
    // Rect in canvas-px: (rect.x × canvasW, rect.y × canvasH, …)
    const rectXPx = rect.x * canvasWidthPx;
    const rectYPx = rect.y * canvasHeightPx;
    const rectWPx = rect.w * canvasWidthPx;
    const rectHPx = rect.h * canvasHeightPx;
    const scaleX = 800 / 400;
    const scaleY = 600 / 300;
    expect(call.srcX).toBeCloseTo((rectXPx - rasterTranslateXPx) * scaleX, 4);
    expect(call.srcY).toBeCloseTo((rectYPx - rasterTranslateYPx) * scaleY, 4);
    expect(call.srcW).toBeCloseTo(rectWPx * scaleX, 4);
    expect(call.srcH).toBeCloseTo(rectHPx * scaleY, 4);
  });

  test("drawImage source rect accounts for source-vs-canvas natural-dim scaling", async () => {
    // When the loaded image's naturalWidth differs from canvasWidthPx
    // (cropped v2 captures, or DPR'd source PNGs), the AABB in CANVAS-
    // pixel coords needs scaling to SOURCE-NATURAL-pixel coords for
    // drawImage's source rect. Otherwise we'd sample from the wrong
    // region of the source bytes.
    const drawImageCalls: Array<{
      srcX: number;
      srcY: number;
      srcW: number;
      srcH: number;
    }> = [];
    const drawImageMock = vi.fn(
      (
        _img: unknown,
        srcX: number,
        srcY: number,
        srcW: number,
        srcH: number
      ) => {
        drawImageCalls.push({ srcX, srcY, srcW, srcH });
      }
    );
    const ctx2dMock = {
      drawImage: drawImageMock,
      clearRect: vi.fn(),
      filter: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "high" as const
    };
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2dMock) as never;

    // 2× source vs canvas (e.g., Retina capture where the PNG is at
    // DPR=2 but the canvas's canonical dims are CSS pixels).
    const ref = createRef<HTMLImageElement>();
    const img = document.createElement("img");
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 600, configurable: true });
    (ref as { current: HTMLImageElement }).current = img;

    const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const rotation = Math.PI / 4;
    const canvasWidthPx = 400;
    const canvasHeightPx = 300;
    render({
      overlays: [rotatedBlurRow("blur_scl", "gaussian", rotation, rect)],
      draft: null,
      blurStyle: "gaussian",
      editorImageRef: ref,
      canvasWidthPx,
      canvasHeightPx
    });
    await act(async () => undefined);
    expect(drawImageCalls).toHaveLength(1);
    const call = drawImageCalls[0]!;
    const aabb = expectedAabb({ rect, rotation, canvasWidthPx, canvasHeightPx });
    // Scale factor = naturalWidth / canvasWidthPx = 800 / 400 = 2.
    const scale = 2;
    expect(call.srcX).toBeCloseTo(aabb.x * scale, 4);
    expect(call.srcY).toBeCloseTo(aabb.y * scale, 4);
    expect(call.srcW).toBeCloseTo(aabb.w * scale, 4);
    expect(call.srcH).toBeCloseTo(aabb.h * scale, 4);
  });
});

describe("BlurOverlays — z-index per layer (cross-kind ordering)", () => {
  // Regression for: "Bring Forward / Bring to Front on a Rect does
  // not bring it above the arrows, ever." (User reported on PR #150
  // for arrow↔rect — fixed via SVG paint-order — and then noted
  // that blur is in the same broken kind-bucket-stacking class. Same
  // fix shape: each persisted blur item gets CSS z-index = layer's
  // z_index so it stacks in the canvas-wrap stacking context against
  // arrows/rects/text by their layer z_index.)
  //
  // The container `.ed-blur-layer` is `position: absolute` with NO
  // z-index, so it does NOT create its own stacking context — its
  // children's CSS z-index applies to the canvas-wrap context.
  // These tests just verify the per-item z-index reaches the DOM.

  test("each persisted blur item carries CSS z-index = its layer.z_index", () => {
    const ref = createRef<HTMLImageElement>();
    const a = blurRow("blur_zindex_a_", "gaussian");
    const b = blurRow("blur_zindex_b_", "gaussian");
    const c = blurRow("blur_zindex_c_", "redact");
    a.z_index = 1000;
    b.z_index = 2000;
    c.z_index = 3000;
    const el = render({
      overlays: [a, b, c],
      draft: null,
      blurStyle: "gaussian",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const items = Array.from(
      el.querySelectorAll<HTMLDivElement>(
        ".ed-blur-item:not(.is-draft)"
      )
    );
    // Three persisted items.
    expect(items.length).toBe(3);
    // Each item's inline style includes the layer's z_index. Order
    // of items in DOM matches the array order (newest LAST), but
    // the z-index VALUES are what makes cross-kind stacking work,
    // not DOM order.
    expect(items[0]!.style.zIndex).toBe("1000");
    expect(items[1]!.style.zIndex).toBe("2000");
    expect(items[2]!.style.zIndex).toBe("3000");
  });

  test("pixelate canvas items also carry CSS z-index = layer.z_index", () => {
    const ref = createRef<HTMLImageElement>();
    const a = blurRow("blur_pixzix_a_", "pixelate");
    a.z_index = 4500;
    const el = render({
      overlays: [a],
      draft: null,
      blurStyle: "pixelate",
      editorImageRef: ref,
      canvasWidthPx: 400,
      canvasHeightPx: 300
    });
    const canvas = el.querySelector<HTMLCanvasElement>("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas!.style.zIndex).toBe("4500");
  });
});
