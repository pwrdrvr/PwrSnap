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

function render(props: Parameters<typeof BlurOverlays>[0]): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(BlurOverlays, props));
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
