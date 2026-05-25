// Unit tests for `TransformHandles` — Phase 3.5 drag-handles overlay
// rendered over the selected overlay's bounding box.
//
// Mirrors `OverlaySvg.test.tsx`'s bare-react createRoot + act harness.
// No @testing-library dep (no project precedent).
//
// Coverage:
//   • Renders the right number + kinds of handles per overlay kind
//     (8 corners/edges for rect/highlight/blur, 2 endpoints for arrow,
//     1 anchor for text/step)
//   • Pointer down → move → up fires onGeometryChange once with the
//     correct geometry (using getBoundingClientRect-stubbed coords)
//   • onDragStart receives the pre-drag overlay; onDragEnd fires after
//     onGeometryChange

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";

import { TransformHandles } from "../OverlaySvg";
import type { GeometryUpdate } from "../useCaptureModel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom doesn't implement setPointerCapture / releasePointerCapture.
  const proto = (globalThis as unknown as { HTMLElement?: { prototype: HTMLElement } })
    .HTMLElement?.prototype;
  if (proto !== undefined) {
    if (typeof (proto as unknown as { setPointerCapture?: unknown }).setPointerCapture !== "function") {
      (proto as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture =
        function () {};
    }
    if (typeof (proto as unknown as { releasePointerCapture?: unknown }).releasePointerCapture !== "function") {
      (proto as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
        function () {};
    }
  }
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function arrowRow(): OverlayRow {
  return {
    id: "arrow_1",
    capture_id: "cap_1",
    data: {
      kind: "arrow",
      from: { x: 0.2, y: 0.2 },
      to: { x: 0.8, y: 0.8 },
      color: "auto"
    },
    schema_version: 1,
    created_at: "2026-05-24T00:00:00Z",
    applied_at: "2026-05-24T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

function rectRow(): OverlayRow {
  return {
    id: "rect_1",
    capture_id: "cap_1",
    data: {
      kind: "rect",
      rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
      color: "auto"
    },
    schema_version: 1,
    created_at: "2026-05-24T00:00:00Z",
    applied_at: "2026-05-24T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

function textRow(): OverlayRow {
  return {
    id: "text_1",
    capture_id: "cap_1",
    data: {
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "hello",
      size: "small",
      color: "auto"
    },
    schema_version: 1,
    created_at: "2026-05-24T00:00:00Z",
    applied_at: "2026-05-24T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

interface HarnessProps {
  selectedOverlay: OverlayRow;
  onGeometryChange?: (g: GeometryUpdate) => void;
  onDragStart?: (row: OverlayRow) => void;
  onDragEnd?: () => void;
}

async function render(props: HarnessProps): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(TransformHandles, {
        selectedOverlay: props.selectedOverlay,
        onGeometryChange: props.onGeometryChange ?? (() => undefined),
        onDragStart: props.onDragStart,
        onDragEnd: props.onDragEnd
      } as Parameters<typeof TransformHandles>[0])
    );
  });
  const el = container.querySelector('[data-testid="transform-handles"]');
  if (el === null) throw new Error("TransformHandles did not render");
  // Stub the container's bounding rect so client→normalized math is
  // deterministic. Use a 1000×1000 canvas frame so normalized coords
  // map 1:1 to pixel coords (xn = px / 1000).
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      right: 1000,
      top: 0,
      bottom: 1000,
      width: 1000,
      height: 1000,
      toJSON: () => ({})
    }) as DOMRect;
  return el as HTMLElement;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function firePointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number
): void {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
        pointerId: 1
      })
    );
  });
}

describe("TransformHandles", () => {
  test("rect: renders 8 handles (4 corners + 4 edges)", async () => {
    await render({ selectedOverlay: rectRow() });
    const handles = document.querySelectorAll('[data-testid^="transform-handle-"]');
    expect(handles.length).toBe(8);
    // Verify each handle kind is present.
    for (const k of ["nw", "ne", "se", "sw", "n", "e", "s", "w"]) {
      const h = document.querySelector(`[data-testid="transform-handle-${k}"]`);
      expect(h, `missing ${k} handle`).not.toBeNull();
    }
  });

  test("highlight: 8 handles (rect/highlight/blur share the rect layout)", async () => {
    const hl: OverlayRow = {
      ...rectRow(),
      data: {
        kind: "highlight",
        rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }
      }
    };
    await render({ selectedOverlay: hl });
    expect(document.querySelectorAll('[data-testid^="transform-handle-"]').length).toBe(8);
  });

  test("blur: 8 handles", async () => {
    const blur: OverlayRow = {
      ...rectRow(),
      data: {
        kind: "blur",
        rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }
      }
    };
    await render({ selectedOverlay: blur });
    expect(document.querySelectorAll('[data-testid^="transform-handle-"]').length).toBe(8);
  });

  test("arrow: renders 2 endpoint handles", async () => {
    await render({ selectedOverlay: arrowRow() });
    expect(document.querySelectorAll('[data-testid^="transform-handle-"]').length).toBe(2);
    expect(document.querySelector('[data-testid="transform-handle-arrow-from"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transform-handle-arrow-to"]')).not.toBeNull();
  });

  test("text: renders 1 anchor handle", async () => {
    await render({ selectedOverlay: textRow() });
    expect(document.querySelectorAll('[data-testid^="transform-handle-"]').length).toBe(1);
    expect(document.querySelector('[data-testid="transform-handle-anchor"]')).not.toBeNull();
  });

  test("rect SE corner drag → onGeometryChange fires with new rect", async () => {
    const onGeometryChange = vi.fn();
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    await render({
      selectedOverlay: rectRow(),
      onGeometryChange,
      onDragStart,
      onDragEnd
    });
    const se = document.querySelector('[data-testid="transform-handle-se"]')!;
    // Initial rect: x=0.1, y=0.1, w=0.4, h=0.3 → SE corner at (0.5, 0.4)
    // Drag the SE corner to (0.7, 0.6) → new rect: x=0.1, y=0.1, w=0.6, h=0.5
    firePointer(se, "pointerdown", 500, 400);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0]?.[0]?.id).toBe("rect_1");
    firePointer(se, "pointermove", 700, 600);
    firePointer(se, "pointerup", 700, 600);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    expect(geom.kind).toBe("rect");
    if (geom.kind === "rect") {
      expect(geom.rect.x).toBeCloseTo(0.1, 3);
      expect(geom.rect.y).toBeCloseTo(0.1, 3);
      expect(geom.rect.w).toBeCloseTo(0.6, 3);
      expect(geom.rect.h).toBeCloseTo(0.5, 3);
    }
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  test("rect NW corner drag → onGeometryChange fires with adjusted x/y/w/h", async () => {
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: rectRow(),
      onGeometryChange
    });
    const nw = document.querySelector('[data-testid="transform-handle-nw"]')!;
    // Initial rect: x=0.1, y=0.1, w=0.4, h=0.3
    // NW corner: (0.1, 0.1). Drag to (0.0, 0.0) → x=0, y=0, w=0.5, h=0.4
    firePointer(nw, "pointerdown", 100, 100);
    firePointer(nw, "pointermove", 0, 0);
    firePointer(nw, "pointerup", 0, 0);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (geom.kind === "rect") {
      expect(geom.rect.x).toBeCloseTo(0, 3);
      expect(geom.rect.y).toBeCloseTo(0, 3);
      expect(geom.rect.w).toBeCloseTo(0.5, 3);
      expect(geom.rect.h).toBeCloseTo(0.4, 3);
    }
  });

  test("arrow 'to' endpoint drag → onGeometryChange fires with new to position", async () => {
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: arrowRow(),
      onGeometryChange
    });
    const toHandle = document.querySelector(
      '[data-testid="transform-handle-arrow-to"]'
    )!;
    // Initial arrow: from=(0.2,0.2), to=(0.8,0.8). Drag 'to' to (0.5, 0.5).
    firePointer(toHandle, "pointerdown", 800, 800);
    firePointer(toHandle, "pointermove", 500, 500);
    firePointer(toHandle, "pointerup", 500, 500);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (geom.kind === "arrow") {
      expect(geom.from.x).toBeCloseTo(0.2, 3);
      expect(geom.from.y).toBeCloseTo(0.2, 3);
      expect(geom.to.x).toBeCloseTo(0.5, 3);
      expect(geom.to.y).toBeCloseTo(0.5, 3);
    }
  });

  test("text anchor drag → onGeometryChange fires with new point", async () => {
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: textRow(),
      onGeometryChange
    });
    const anchor = document.querySelector('[data-testid="transform-handle-anchor"]')!;
    // Initial point: (0.5, 0.5). Drag to (0.3, 0.7).
    firePointer(anchor, "pointerdown", 500, 500);
    firePointer(anchor, "pointermove", 300, 700);
    firePointer(anchor, "pointerup", 300, 700);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (geom.kind === "text") {
      expect(geom.point.x).toBeCloseTo(0.3, 3);
      expect(geom.point.y).toBeCloseTo(0.7, 3);
    }
  });

  test("clamps drag past viewport bounds to [0,1]", async () => {
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: arrowRow(),
      onGeometryChange
    });
    const toHandle = document.querySelector(
      '[data-testid="transform-handle-arrow-to"]'
    )!;
    // Drag well past the viewport edges.
    firePointer(toHandle, "pointerdown", 800, 800);
    firePointer(toHandle, "pointermove", 5000, -100);
    firePointer(toHandle, "pointerup", 5000, -100);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (geom.kind === "arrow") {
      expect(geom.to.x).toBe(1);
      expect(geom.to.y).toBe(0);
    }
  });

  test("returns null for crop overlay (no handles)", async () => {
    const cropOverlay: OverlayRow = {
      ...rectRow(),
      data: {
        kind: "crop",
        rect: { x: 0, y: 0, w: 1, h: 1 }
      }
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(TransformHandles, {
          selectedOverlay: cropOverlay,
          onGeometryChange: () => undefined
        } as Parameters<typeof TransformHandles>[0])
      );
    });
    expect(container.querySelector('[data-testid="transform-handles"]')).toBeNull();
  });
});
