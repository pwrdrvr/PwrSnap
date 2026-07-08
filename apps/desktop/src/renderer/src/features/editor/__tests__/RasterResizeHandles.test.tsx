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

  test("dragging the SE handle previews then commits the resized transform", async () => {
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
    // dx=50, dy=30 → SE grows the box to 250×130 at the same NW origin.
    const expected: AffineTransform = [250 / 200, 0, 0, 130 / 100, 100, 50];
    expect(drags.at(-1)).toEqual(expected);
    expect(se.setPointerCapture).toHaveBeenCalledWith(1);

    await act(async () => {
      se.dispatchEvent(
        new PointerEvent("pointerup", { clientX: 350, clientY: 180, pointerId: 1, bubbles: true })
      );
    });
    expect(committed).toEqual({ start: START, next: expected });
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
      se.dispatchEvent(new PointerEvent("pointermove", { clientX: 175, clientY: 90, pointerId: 1, bubbles: true }));
    });
    // client Δ(25,15) ÷ rect(200,150) × canvas(400,300) = canvas Δ(50,30)
    // → the same 250×130 box as the 1:1 drag test above.
    expect(drags.at(-1)).toEqual([250 / 200, 0, 0, 130 / 100, 100, 50]);
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
