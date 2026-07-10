// Component tests for the raster resize handles: the 8 handles render on
// the box corners/edges, and a handle drag runs the pure resize math and
// fires the preview + commit callbacks. The math itself is covered
// exhaustively in raster-resize.test.ts; this pins the DOM wiring.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import type { AffineTransform } from "@pwrsnap/shared";

import { RasterResizeHandles } from "../RasterResizeHandles";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// transform [1,0,0,1,100,50], natural 200×100, canvas 400×300 →
// normalized box { x: 0.25, y: 0.1667, w: 0.5, h: 0.333 }.
const START: AffineTransform = [1, 0, 0, 1, 100, 50];

async function render(
  overrides: Partial<Parameters<typeof RasterResizeHandles>[0]> = {}
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(RasterResizeHandles, {
        layerId: "L1",
        transform: START,
        naturalWidthPx: 200,
        naturalHeightPx: 100,
        imageWidthPx: 400,
        imageHeightPx: 300,
        onResizeDrag: () => undefined,
        onResizeCommit: () => undefined,
        ...overrides
      })
    );
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function handle(kind: string): HTMLElement {
  return container!.querySelector(`[data-testid="raster-resize-handle-${kind}"]`) as HTMLElement;
}

describe("RasterResizeHandles", () => {
  test("renders 8 handles at the box corners + edge midpoints", async () => {
    await render();
    expect(
      container!.querySelectorAll('[data-testid^="raster-resize-handle-"]')
    ).toHaveLength(8);
    // SE corner: (x+w, y+h) = (0.75, 0.5). NW: (0.25, 0.1666…). N edge mid: (0.5, 0.1666…).
    expect(handle("se").style.left).toBe("75%");
    expect(handle("se").style.top).toBe("50%");
    expect(handle("nw").style.left).toBe("25%");
    expect(handle("n").style.left).toBe("50%");
    expect(handle("se").style.cursor).toBe("nwse-resize");
    expect(handle("e").style.cursor).toBe("ew-resize");
  });

  test("SE corner preserves the aspect ratio by default (previews + commits)", async () => {
    const drags: AffineTransform[] = [];
    let committed: { start: AffineTransform; next: AffineTransform } | null = null;
    await render({
      onResizeDrag: (t) => drags.push(t),
      onResizeCommit: (start, next) => {
        committed = { start, next };
      }
    });

    const se = handle("se");
    const outer = container!.querySelector(
      '[data-testid="raster-resize-handles"]'
    ) as HTMLElement;
    // Container is 400×300 screen px → 1 client px == 1 canvas px (imageWidth=400).
    outer.getBoundingClientRect = () =>
      ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    se.setPointerCapture = vi.fn();
    se.releasePointerCapture = vi.fn();

    await act(async () => {
      se.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 300, clientY: 150, pointerId: 1, bubbles: true })
      );
    });
    await act(async () => {
      se.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 350, clientY: 180, pointerId: 1, bubbles: true })
      );
    });
    // Δ(50,30), NO Shift → aspect locked (start ratio 2:1). The dominant axis
    // (dy, +30%) drives width: dx = 30·2 = 60 → box 260×130, ratio preserved.
    const expected: AffineTransform = [260 / 200, 0, 0, 130 / 100, 100, 50];
    expect(drags.at(-1)).toEqual(expected);
    expect((expected[0] * 200) / (expected[3] * 100)).toBeCloseTo(2, 6); // 2:1 kept
    expect(se.setPointerCapture).toHaveBeenCalledWith(1);

    await act(async () => {
      se.dispatchEvent(
        new PointerEvent("pointerup", { clientX: 350, clientY: 180, pointerId: 1, bubbles: true })
      );
    });
    expect(committed).toEqual({ start: START, next: expected });
  });

  test("Shift on a corner distorts freely (aspect NOT preserved)", async () => {
    const drags: AffineTransform[] = [];
    await render({ onResizeDrag: (t) => drags.push(t) });
    const se = handle("se");
    const outer = container!.querySelector(
      '[data-testid="raster-resize-handles"]'
    ) as HTMLElement;
    outer.getBoundingClientRect = () =>
      ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    se.setPointerCapture = vi.fn();
    se.releasePointerCapture = vi.fn();
    await act(async () => {
      se.dispatchEvent(new PointerEvent("pointerdown", { clientX: 300, clientY: 150, pointerId: 1, bubbles: true }));
    });
    await act(async () => {
      // Shift held → each axis independent → 250×130 (ratio 2.5:1, distorted).
      se.dispatchEvent(new PointerEvent("pointermove", { clientX: 350, clientY: 180, shiftKey: true, pointerId: 1, bubbles: true }));
    });
    expect(drags.at(-1)).toEqual([250 / 200, 0, 0, 130 / 100, 100, 50]);
  });

  test("edge handles stretch a single axis and ignore Shift", async () => {
    const drags: AffineTransform[] = [];
    await render({ onResizeDrag: (t) => drags.push(t) });
    const e = handle("e");
    const outer = container!.querySelector(
      '[data-testid="raster-resize-handles"]'
    ) as HTMLElement;
    outer.getBoundingClientRect = () =>
      ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    e.setPointerCapture = vi.fn();
    e.releasePointerCapture = vi.fn();
    // E handle sits at (0.75, 0.5) → (300, 150).
    await act(async () => {
      e.dispatchEvent(new PointerEvent("pointerdown", { clientX: 300, clientY: 150, pointerId: 1, bubbles: true }));
    });
    await act(async () => {
      // Shift held + a big vertical delta — both ignored by an edge handle.
      e.dispatchEvent(new PointerEvent("pointermove", { clientX: 340, clientY: 250, shiftKey: true, pointerId: 1, bubbles: true }));
    });
    // Width only: 200 + 40 = 240; height + origin unchanged.
    expect(drags.at(-1)).toEqual([240 / 200, 0, 0, 1, 100, 50]);
  });

  test("scales the client delta by the container rect (zoomed canvas)", async () => {
    const drags: AffineTransform[] = [];
    await render({ onResizeDrag: (t) => drags.push(t) });
    const se = handle("se");
    const outer = container!.querySelector(
      '[data-testid="raster-resize-handles"]'
    ) as HTMLElement;
    // Container is HALF the canvas dims on screen (200×150 for a 400×300
    // canvas) — a 50% zoom, so each screen px is worth 2 canvas px. The math
    // must divide by the rect and multiply by the canvas dims, not assume 1:1.
    outer.getBoundingClientRect = () =>
      ({ width: 200, height: 150, left: 0, top: 0, right: 200, bottom: 150, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    se.setPointerCapture = vi.fn();
    se.releasePointerCapture = vi.fn();
    // SE handle sits at (0.75, 0.5) → (150, 75) in the 200×150 container.
    await act(async () => {
      se.dispatchEvent(new PointerEvent("pointerdown", { clientX: 150, clientY: 75, pointerId: 1, bubbles: true }));
    });
    await act(async () => {
      // Shift = free resize, to isolate the scale-factor check from aspect lock.
      se.dispatchEvent(new PointerEvent("pointermove", { clientX: 175, clientY: 90, shiftKey: true, pointerId: 1, bubbles: true }));
    });
    // client Δ(25,15) ÷ rect(200,150) × canvas(400,300) = canvas Δ(50,30)
    // → a 250×130 box (Shift held, so axes are independent).
    expect(drags.at(-1)).toEqual([250 / 200, 0, 0, 130 / 100, 100, 50]);
  });

  test("resize detents back to the home size when dragged near it", async () => {
    const drags: AffineTransform[] = [];
    await render({
      transform: [0.9, 0, 0, 0.9, 0, 0], // current box 180×90 at the origin
      originalTransform: [1, 0, 0, 1, 0, 0], // home box 200×100
      onResizeDrag: (t) => drags.push(t)
    });
    const se = handle("se");
    const outer = container!.querySelector(
      '[data-testid="raster-resize-handles"]'
    ) as HTMLElement;
    // 1:1 rect → the capture radius is HOME_SNAP_SCREEN_PX (7) canvas px.
    outer.getBoundingClientRect = () =>
      ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    se.setPointerCapture = vi.fn();
    se.releasePointerCapture = vi.fn();
    // SE handle sits at ((0+180)/400, (0+90)/300) = (0.45, 0.30) → (180, 90).
    await act(async () => {
      se.dispatchEvent(new PointerEvent("pointerdown", { clientX: 180, clientY: 90, pointerId: 1, bubbles: true }));
    });
    await act(async () => {
      // Δ(19,9) → box ~199×99, both within 7px of the home 200×100. Shift =
      // free, so each axis snaps independently to the exact home dimension.
      se.dispatchEvent(new PointerEvent("pointermove", { clientX: 199, clientY: 99, shiftKey: true, pointerId: 1, bubbles: true }));
    });
    expect(drags.at(-1)).toEqual([1, 0, 0, 1, 0, 0]); // snapped exactly to home
  });

  test("a click on a handle with no drag does not commit", async () => {
    let commits = 0;
    await render({ onResizeCommit: () => (commits += 1) });
    const se = handle("se");
    const outer = container!.querySelector(
      '[data-testid="raster-resize-handles"]'
    ) as HTMLElement;
    outer.getBoundingClientRect = () =>
      ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    se.setPointerCapture = vi.fn();
    se.releasePointerCapture = vi.fn();
    await act(async () => {
      se.dispatchEvent(new PointerEvent("pointerdown", { clientX: 300, clientY: 150, pointerId: 1, bubbles: true }));
      se.dispatchEvent(new PointerEvent("pointerup", { clientX: 300, clientY: 150, pointerId: 1, bubbles: true }));
    });
    expect(commits).toBe(0);
  });
});
