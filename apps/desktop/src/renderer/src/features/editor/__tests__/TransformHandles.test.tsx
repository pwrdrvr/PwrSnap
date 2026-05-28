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
  /** Optional live-preview hook fired on every pointermove during a
   *  drag. Threaded through to TransformHandles so tests can assert
   *  on the in-progress geometry stream. */
  onGeometryDrag?: (g: GeometryUpdate) => void;
  onDragStart?: (row: OverlayRow) => void;
  onDragEnd?: () => void;
  /** Threaded into TransformHandles so the click-to-edit path on
   *  selected text overlays can be exercised end-to-end (synthetic
   *  click events fired after pointerup). */
  onRequestEdit?: (row: OverlayRow) => void;
}

async function render(props: HarnessProps): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(TransformHandles, {
        selectedOverlay: props.selectedOverlay,
        imageWidthPx: 1920,
        imageHeightPx: 1080,
        // Source dims drive textBoundsBox via computeTextGlyphSize.
        // The text-rotation-pivot path NaNs out without these
        // because fontSizePx = sourceShortSide / divisor → NaN when
        // sources are undefined. Match canvas dims so the bucket
        // math gives the same result as it would in production for
        // an uncropped capture.
        sourceWidthPx: 1920,
        sourceHeightPx: 1080,
        onGeometryChange: props.onGeometryChange ?? (() => undefined),
        onGeometryDrag: props.onGeometryDrag,
        onDragStart: props.onDragStart,
        onDragEnd: props.onDragEnd,
        onRequestEdit: props.onRequestEdit
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

/** Synthesizes the DOM `click` that the browser fires after a
 *  mousedown + mouseup land on the same element without a drag. jsdom
 *  doesn't derive `click` from our dispatched `pointer*` events, so
 *  tests for the click-to-edit branch fire it explicitly. */
function fireClick(el: Element, clientX: number, clientY: number): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY
      })
    );
  });
}

/** Count of the resize / endpoint / anchor handles, excluding the
 *  transparent body-hit rect (added by the drag-to-move work). The
 *  body shares the `transform-handle-` testid prefix so a raw
 *  `[data-testid^="transform-handle-"]` selector matches it too; this
 *  helper filters it out so the existing per-kind asserts stay
 *  focused on the resize surface. */
function countResizeHandles(): number {
  const all = document.querySelectorAll('[data-testid^="transform-handle-"]');
  let n = 0;
  for (const el of Array.from(all)) {
    if (el.getAttribute("data-testid") !== "transform-handle-body") n += 1;
  }
  return n;
}

describe("TransformHandles", () => {
  test("rect: renders 9 handles (4 corners + 4 edges + rotate)", async () => {
    await render({ selectedOverlay: rectRow() });
    // 8 resize handles + 1 rotation handle = 9.
    expect(countResizeHandles()).toBe(9);
    // Verify each handle kind is present.
    for (const k of ["nw", "ne", "se", "sw", "n", "e", "s", "w", "rotate"]) {
      const h = document.querySelector(`[data-testid="transform-handle-${k}"]`);
      expect(h, `missing ${k} handle`).not.toBeNull();
    }
    // Body-hit rect for drag-to-move sits alongside the resize +
    // rotate handles for rect-shaped layers.
    expect(document.querySelector('[data-testid="transform-handle-body"]')).not.toBeNull();
  });

  test("highlight: 9 handles (rect/highlight/blur share the rect+rotate layout)", async () => {
    const hl: OverlayRow = {
      ...rectRow(),
      data: {
        kind: "highlight",
        rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }
      }
    };
    await render({ selectedOverlay: hl });
    expect(countResizeHandles()).toBe(9);
    expect(document.querySelector('[data-testid="transform-handle-rotate"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transform-handle-body"]')).not.toBeNull();
  });

  test("blur: 9 handles", async () => {
    const blur: OverlayRow = {
      ...rectRow(),
      data: {
        kind: "blur",
        rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }
      }
    };
    await render({ selectedOverlay: blur });
    expect(countResizeHandles()).toBe(9);
    expect(document.querySelector('[data-testid="transform-handle-rotate"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transform-handle-body"]')).not.toBeNull();
  });

  test("arrow: renders 2 endpoint handles", async () => {
    await render({ selectedOverlay: arrowRow() });
    expect(countResizeHandles()).toBe(2);
    expect(document.querySelector('[data-testid="transform-handle-arrow-from"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transform-handle-arrow-to"]')).not.toBeNull();
    // Body-hit rect for drag-to-move (translates both endpoints by
    // the same delta). Arrow's body spans the bounding box of the
    // from→to segment.
    expect(document.querySelector('[data-testid="transform-handle-body"]')).not.toBeNull();
  });

  test("text: only the rotation handle (move + edit go through the body-hit rect)", async () => {
    // The standalone anchor handle was a 10×10 white square at the
    // glyph's anchor point — users mistook it for a checkbox and it
    // was redundant with the body-hit rect that already catches
    // drag-to-move across the entire bounding box. Now text has the
    // body-hit rect (sized to the actual text bounds via
    // `textBoundsBox`) plus the rotation handle above the top edge.
    // The dashed SelectionOutline shows what's selected.
    await render({ selectedOverlay: textRow() });
    expect(countResizeHandles()).toBe(1);
    expect(document.querySelector('[data-testid="transform-handle-anchor"]')).toBeNull();
    expect(document.querySelector('[data-testid="transform-handle-rotate"]')).not.toBeNull();
    // Body-hit rect IS present — drag-to-move + double-click-to-edit
    // both go through it.
    expect(document.querySelector('[data-testid="transform-handle-body"]')).not.toBeNull();
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

  test("text body drag → onGeometryChange fires with translated point", async () => {
    // After removing the standalone anchor handle, dragging text
    // goes through the body-hit rect (which now covers the actual
    // text glyph extents via `textBoundsBox`). Same end result:
    // the overlay's `point` translates by the pointer delta.
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: textRow(),
      onGeometryChange
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    // Initial point: (0.5, 0.5). Drag delta (-0.2, +0.2) → new point
    // (0.3, 0.7). The body translation uses `geometryFromDrag`'s
    // body branch which subtracts startPt from newPt.
    firePointer(body, "pointerdown", 500, 500);
    firePointer(body, "pointermove", 300, 700);
    firePointer(body, "pointerup", 300, 700);
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

  test("arrow endpoint drag fires onGeometryDrag every pointermove with live geometry", async () => {
    // Live-preview plumbing: TransformHandles must emit
    // onGeometryDrag (NOT just onGeometryChange) so the parent can
    // paint the arrow at the in-progress endpoint while the user
    // drags. Without this the painted glyph stays at the pre-drag
    // position and the user sees "the line vanishes" while dragging
    // the handle.
    const onGeometryChange = vi.fn();
    const onGeometryDrag = vi.fn();
    await render({
      selectedOverlay: arrowRow(),
      onGeometryChange,
      onGeometryDrag
    });
    const toHandle = document.querySelector(
      '[data-testid="transform-handle-arrow-to"]'
    )!;
    firePointer(toHandle, "pointerdown", 800, 800);
    firePointer(toHandle, "pointermove", 600, 600);
    firePointer(toHandle, "pointermove", 500, 500);
    firePointer(toHandle, "pointermove", 400, 400);
    firePointer(toHandle, "pointerup", 400, 400);
    // Three pointermoves → three onGeometryDrag calls.
    expect(onGeometryDrag.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Last drag call should reflect the most recent pointer position.
    const lastDrag = onGeometryDrag.mock.calls.at(-1)?.[0] as GeometryUpdate;
    if (lastDrag.kind === "arrow") {
      expect(lastDrag.to.x).toBeCloseTo(0.4, 3);
      expect(lastDrag.to.y).toBeCloseTo(0.4, 3);
      // `from` stays put — only the dragged endpoint moves.
      expect(lastDrag.from.x).toBeCloseTo(0.2, 3);
      expect(lastDrag.from.y).toBeCloseTo(0.2, 3);
    }
    // onGeometryChange fires exactly once at pointerup.
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const commit = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (commit.kind === "arrow") {
      expect(commit.to.x).toBeCloseTo(0.4, 3);
      expect(commit.to.y).toBeCloseTo(0.4, 3);
    }
  });

  test("body drag translates an arrow by the pointer delta (both endpoints shift)", async () => {
    // Drag-to-move: pointerdown on the body-hit rect translates
    // the entire layer by the cursor delta. For arrows that means
    // BOTH `from` and `to` shift by the same vector — neither
    // endpoint stays put.
    const onGeometryChange = vi.fn();
    const onGeometryDrag = vi.fn();
    await render({
      selectedOverlay: arrowRow(),
      onGeometryChange,
      onGeometryDrag
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    // Initial arrow: from=(0.2,0.2), to=(0.8,0.8). Pointerdown at
    // (500, 500) — anywhere inside the body — then drag to (600,500)
    // → delta = (+0.1, 0). Expected new from=(0.3,0.2), to=(0.9,0.8).
    firePointer(body, "pointerdown", 500, 500);
    firePointer(body, "pointermove", 600, 500);
    firePointer(body, "pointerup", 600, 500);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const commit = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (commit.kind === "arrow") {
      expect(commit.from.x).toBeCloseTo(0.3, 3);
      expect(commit.from.y).toBeCloseTo(0.2, 3);
      expect(commit.to.x).toBeCloseTo(0.9, 3);
      expect(commit.to.y).toBeCloseTo(0.8, 3);
    }
    // Live preview also fires.
    expect(onGeometryDrag.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("body drag translates a rect by the pointer delta (w/h unchanged)", async () => {
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: rectRow(),
      onGeometryChange
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    // Initial rect: x=0.1, y=0.1, w=0.4, h=0.3. Drag delta = (+0.2, +0.1).
    // Expected: x=0.3, y=0.2, w=0.4, h=0.3.
    firePointer(body, "pointerdown", 300, 300);
    firePointer(body, "pointermove", 500, 400);
    firePointer(body, "pointerup", 500, 400);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const commit = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (commit.kind === "rect") {
      expect(commit.rect.x).toBeCloseTo(0.3, 3);
      expect(commit.rect.y).toBeCloseTo(0.2, 3);
      expect(commit.rect.w).toBeCloseTo(0.4, 3);
      expect(commit.rect.h).toBeCloseTo(0.3, 3);
    }
  });

  test("body drag passes coordinates through without clamping (user can push layer off-canvas)", async () => {
    // Pre-fix this test asserted the body-drag clamp held the rect at
    // (0, 0). The clamp was removed in the "drag past edge" fix —
    // users want to push a shape mostly off-canvas (e.g., only a
    // corner peeks out). The underlying NormalizedScalar schema
    // accepts any finite number; the bake clips at canvas bounds
    // automatically.
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: rectRow(),
      onGeometryChange
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    // Initial rect: x=0.1, y=0.1, w=0.4, h=0.3. Drag from (300,300)
    // to (-5000,-5000) → delta (-5.3, -5.3) in normalized coords.
    // Expected new rect: x = 0.1 + (-5.3) = -5.2; y = -5.2; same w/h.
    firePointer(body, "pointerdown", 300, 300);
    firePointer(body, "pointermove", -5000, -5000);
    firePointer(body, "pointerup", -5000, -5000);
    const commit = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (commit.kind === "rect") {
      expect(commit.rect.x).toBeCloseTo(-5.2, 3);
      expect(commit.rect.y).toBeCloseTo(-5.2, 3);
      expect(commit.rect.w).toBeCloseTo(0.4, 3);
      expect(commit.rect.h).toBeCloseTo(0.3, 3);
    }
  });

  test("body drag on text translates the anchor point", async () => {
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: textRow(),
      onGeometryChange
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    // Initial point: (0.5, 0.5). Drag from (600,600) → (700,500),
    // delta = (+0.1, -0.1). Expected new point: (0.6, 0.4).
    firePointer(body, "pointerdown", 600, 600);
    firePointer(body, "pointermove", 700, 500);
    firePointer(body, "pointerup", 700, 500);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const commit = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (commit.kind === "text") {
      expect(commit.point.x).toBeCloseTo(0.6, 3);
      expect(commit.point.y).toBeCloseTo(0.4, 3);
    }
  });

  test("click-without-drag on selected text body fires onRequestEdit (not onGeometryChange)", async () => {
    // The "I selected the text — now how do I get a caret in it?" gap.
    // Previously the only edit affordance was a double-click on the
    // body-hit rect, which is fiddly (first click is intercepted by
    // the canvas to select; the second click needs to land on the
    // body-hit rect within the dblclick window). Now a plain click on
    // an already-selected text overlay enters edit mode immediately —
    // matches Figma's "select → click again to edit" gesture.
    const onGeometryChange = vi.fn();
    const onRequestEdit = vi.fn();
    await render({
      selectedOverlay: textRow(),
      onGeometryChange,
      onRequestEdit
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    // Pointerdown + pointerup at identical coords = no drag. The
    // pointerup branch must short-circuit before onGeometryChange
    // fires (so we don't write a no-op move that pushes a redundant
    // undo entry). Then the click event triggers onRequestEdit.
    firePointer(body, "pointerdown", 500, 500);
    firePointer(body, "pointerup", 500, 500);
    fireClick(body, 500, 500);
    expect(onGeometryChange).not.toHaveBeenCalled();
    expect(onRequestEdit).toHaveBeenCalledTimes(1);
    expect(onRequestEdit.mock.calls[0]?.[0]?.id).toBe("text_1");
  });

  test("click-without-drag on selected rect body fires NEITHER onRequestEdit NOR onGeometryChange", async () => {
    // Non-text kinds don't have an "edit body" affordance — they
    // commit on placement (rect outline, arrow vector, etc.). A bare
    // click on a selected rect must be a no-op: no onRequestEdit
    // (none of those layer kinds is editable in-place), no
    // onGeometryChange (no movement happened).
    const onGeometryChange = vi.fn();
    const onRequestEdit = vi.fn();
    await render({
      selectedOverlay: rectRow(),
      onGeometryChange,
      onRequestEdit
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    firePointer(body, "pointerdown", 300, 300);
    firePointer(body, "pointerup", 300, 300);
    fireClick(body, 300, 300);
    expect(onGeometryChange).not.toHaveBeenCalled();
    expect(onRequestEdit).not.toHaveBeenCalled();
  });

  test("drag on selected text body still moves the layer (onClick suppressed by browser drag threshold)", async () => {
    // The click-to-edit branch must NOT fire when the user actually
    // dragged the text. The browser only emits `click` on a
    // mousedown→mouseup with no significant movement, so a real drag
    // path emits no `click` event — onRequestEdit stays quiet and
    // onGeometryChange fires with the translated point. We omit the
    // synthetic click here to mirror that browser behavior.
    const onGeometryChange = vi.fn();
    const onRequestEdit = vi.fn();
    await render({
      selectedOverlay: textRow(),
      onGeometryChange,
      onRequestEdit
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    // Substantive drag — well past the no-drag threshold.
    firePointer(body, "pointerdown", 500, 500);
    firePointer(body, "pointermove", 700, 600);
    firePointer(body, "pointerup", 700, 600);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    expect(onRequestEdit).not.toHaveBeenCalled();
  });

  test("drag just above NO_DRAG_THRESHOLD_N commits geometry and does NOT request edit", async () => {
    // Boundary case for the drag-vs-click decision in onPointerUp.
    // NO_DRAG_THRESHOLD_N = 0.002 (~2 normalized units on the 1000×1000
    // harness canvas → 2 client px). A 3-px move is JUST past the
    // threshold; the contract is: geometry commits, edit does not fire
    // — even though the browser still emits `click` (the click event
    // has no movement threshold). Locks the boundary so future
    // refactors that touch the threshold can't silently swap behavior
    // in the narrow band between "definitely a click" and "definitely
    // a drag."
    const onGeometryChange = vi.fn();
    const onRequestEdit = vi.fn();
    await render({
      selectedOverlay: textRow(),
      onGeometryChange,
      onRequestEdit
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    firePointer(body, "pointerdown", 500, 500);
    firePointer(body, "pointermove", 503, 500);
    firePointer(body, "pointerup", 503, 500);
    fireClick(body, 503, 500);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    expect(onRequestEdit).not.toHaveBeenCalled();
  });

  test("drag-then-click on selected text body: onGeometryChange ONCE + onRequestEdit NEVER (clone bug)", async () => {
    // Real browsers DO fire `click` after a mousedown→mousemove→mouseup
    // sequence whenever mousedown and mouseup target the same element
    // — there's no movement threshold for `click` (only for `dblclick`).
    // The body-hit rect follows liveData during a drag, so the same
    // <div> node sees both mousedown and mouseup; the browser fires a
    // synthetic `click` on it after pointerup.
    //
    // Without suppression, the post-drag click fires onRequestEdit
    // against the PRE-DRAG `selectedOverlay` snapshot. The Editor's
    // handler then opens a TextDraftInput at the old position with
    // editingId pointing at the row id that the geometry write has
    // just replaced. TextHtmlOverlays can no longer find that id to
    // suppress, so the moved overlay paints at the new position AND
    // the draft input paints at the old position — a visible clone.
    // resolveTextDraftStyle falls back to the current tool style for
    // the unfound id, so the clone also picks up a different look:
    // exactly the "clones it and leaves a copy behind with a new
    // style" symptom the user reported.
    //
    // Contract: pointerup is the single decision point for drag-vs-
    // click. A drag (delta ≥ NO_DRAG_THRESHOLD_N) commits geometry and
    // does NOT request edit — even if the browser later emits `click`.
    const onGeometryChange = vi.fn();
    const onRequestEdit = vi.fn();
    await render({
      selectedOverlay: textRow(),
      onGeometryChange,
      onRequestEdit
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    firePointer(body, "pointerdown", 500, 500);
    firePointer(body, "pointermove", 700, 600);
    firePointer(body, "pointerup", 700, 600);
    fireClick(body, 700, 600);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    expect(onRequestEdit).not.toHaveBeenCalled();
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
          imageWidthPx: 1920,
          imageHeightPx: 1080,
          sourceWidthPx: 1920,
          sourceHeightPx: 1080,
          onGeometryChange: () => undefined
        } as Parameters<typeof TransformHandles>[0])
      );
    });
    expect(container.querySelector('[data-testid="transform-handles"]')).toBeNull();
  });

  test("rect rotation handle drag → onGeometryChange fires with new rotation around bbox center", async () => {
    // rectRow: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 } → center at (0.3, 0.25)
    // With 1000×1000 client rect, center is (300, 250) in client px.
    //
    // Start the drag directly right of the pivot (angle 0); move
    // directly below the pivot (angle π/2). Expected new rotation is
    // π/2 (90° clockwise) since the pre-drag rotation is 0.
    const onGeometryChange = vi.fn();
    await render({ selectedOverlay: rectRow(), onGeometryChange });
    const rotate = document.querySelector('[data-testid="transform-handle-rotate"]')!;
    firePointer(rotate, "pointerdown", 400, 250); // (400-300, 250-250) = (+100, 0) → angle 0
    firePointer(rotate, "pointermove", 300, 350); // (300-300, 350-250) = (0, +100) → angle π/2
    firePointer(rotate, "pointerup", 300, 350);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    expect(geom.kind).toBe("rect");
    if (geom.kind === "rect") {
      // Rect unchanged — rotation handle only writes the rotation
      // field; the rect comes through as the pre-drag value so the
      // merger preserves it.
      expect(geom.rect.x).toBeCloseTo(0.1, 6);
      expect(geom.rect.y).toBeCloseTo(0.1, 6);
      expect(geom.rect.w).toBeCloseTo(0.4, 6);
      expect(geom.rect.h).toBeCloseTo(0.3, 6);
      expect(geom.rotation).toBeCloseTo(Math.PI / 2, 6);
    }
  });

  test("rect rotation drag with pre-existing rotation accumulates the delta", async () => {
    // Pre-drag rotation = π/4. Drag adds another π/2. Expected total:
    // 3π/4. Confirms the merge reads `startData.rotation` (the
    // pre-drag value), not the live `data.rotation` that the live-
    // preview branch updates on every move.
    const onGeometryChange = vi.fn();
    const row = rectRow();
    const rowWithRotation: OverlayRow = {
      ...row,
      data: { ...row.data, rotation: Math.PI / 4 } as OverlayRow["data"]
    };
    await render({ selectedOverlay: rowWithRotation, onGeometryChange });
    const rotate = document.querySelector('[data-testid="transform-handle-rotate"]')!;
    firePointer(rotate, "pointerdown", 400, 250);
    firePointer(rotate, "pointermove", 300, 350);
    firePointer(rotate, "pointerup", 300, 350);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (geom.kind === "rect") {
      expect(geom.rotation).toBeCloseTo(Math.PI / 4 + Math.PI / 2, 6);
    }
  });

  test("text rotation handle pivots around the body-box CENTER, not the anchor", async () => {
    // textRow has body "hello", size "small", point (0.5, 0.5).
    // Body-box for "small" on a 1920×1080 source:
    //   fontSizePx = min(1920, 1080) / 50 = 21.6  (small bucket)
    //   naturalWidthPx  = 5 chars × 21.6 × 0.55 ≈ 59.4
    //   naturalHeightPx = 21.6
    //   box = { x: 0.5, y: 0.49, w: 0.0309, h: 0.02 }
    // Body-box center in NORMALIZED coords: (0.5155, 0.5).
    // In client px (test harness has a 1000×1000 client rect):
    // (515.5, 500).
    //
    // Drag the rotate handle from RIGHT of the pivot (angle 0) to
    // BELOW the pivot (angle π/2):
    //   • pointerdown at (615.5, 500): dx = +100 from pivot,
    //     dy = 0 → atan2(0, +) = 0.
    //   • pointermove + up at (515.5, 600): dx = 0, dy = +100 from
    //     pivot → atan2(+, 0) = π/2.
    // Expected rotation delta = π/2.
    //
    // Pre-fix this test asserted pivot at the ANCHOR (data.point =
    // 0.5, 0.5) — but the anchor is the LEFT EDGE of the rendered
    // text, not its visible center. Rotating around it swung the
    // text in a wide arc, which is what the user reported in a
    // screenshot ("Text is rotating on an imaginary point on the
    // left corner"). The pivot now matches what the user sees as
    // the middle of the text.
    const onGeometryChange = vi.fn();
    await render({ selectedOverlay: textRow(), onGeometryChange });
    const rotate = document.querySelector('[data-testid="transform-handle-rotate"]')!;
    firePointer(rotate, "pointerdown", 615.5, 500);
    firePointer(rotate, "pointermove", 515.5, 600);
    firePointer(rotate, "pointerup", 515.5, 600);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    expect(geom.kind).toBe("text");
    if (geom.kind === "text") {
      // Anchor unchanged (rotation handle only writes the rotation
      // field; the merger keeps point as-is).
      expect(geom.point.x).toBeCloseTo(0.5, 6);
      expect(geom.point.y).toBeCloseTo(0.5, 6);
      // Rotation delta = π/2 because we started at angle 0 from the
      // body-box center and ended at angle π/2 from it.
      expect(geom.rotation).toBeCloseTo(Math.PI / 2, 2);
    }
  });

  test("rotated rect: resize handles render at the rotated corner positions", async () => {
    // 0.4 × 0.3 rect rotated 90° around its center (0.3, 0.25). In
    // the unrotated frame, NE is at (x+w, y) = (0.5, 0.1). After
    // 90° CW rotation around (0.3, 0.25), the NE corner lands where
    // SE used to be (in canvas terms, "right-then-up" becomes
    // "down-then-right"): (0.45, 0.45) on the 1920×1080 canvas.
    //
    // We're on a NON-SQUARE canvas (1920×1080) so pure-normalized
    // rotation math would land the handle at the wrong place; the
    // pixel-space rotation we now apply lands it correctly.
    const row = rectRow();
    const rotated: OverlayRow = {
      ...row,
      data: { ...row.data, rotation: Math.PI / 2 } as OverlayRow["data"]
    };
    await render({ selectedOverlay: rotated });
    const ne = document.querySelector(
      '[data-testid="transform-handle-ne"]'
    ) as HTMLElement | null;
    expect(ne).not.toBeNull();
    // Center of rect in PIXEL space: (0.3 * 1920, 0.25 * 1080) =
    // (576, 270). The original NE corner local offset (in pixels)
    // is (+0.2 * 1920, -0.15 * 1080) = (+384, -162). After 90° CW
    // rotation: (+162, +384). So NE world = (576 + 162, 270 + 384)
    // = (738, 654). Normalized: (738 / 1920, 654 / 1080) =
    // (0.384375, 0.605555…).
    const left = ne!.style.left;
    const top = ne!.style.top;
    // Style values are like "38.4375%" — parse + compare.
    expect(parseFloat(left)).toBeCloseTo(38.4375, 2);
    expect(parseFloat(top)).toBeCloseTo(60.5555, 1);
  });

  test("body-drag lets shapes go off-canvas (user can drag a shape mostly past the edge)", async () => {
    // Body-drag used to clamp the rect / AABB to the canvas bounds,
    // which made it impossible to push a shape so only a corner
    // peeks out at the edge (a common cropping-style annotation
    // gesture). Now uncapped: the underlying NormalizedScalar schema
    // accepts any finite number, and the bake clips at canvas bounds
    // automatically. This test pins the new behavior so a future
    // "add the clamp back" doesn't sneak in unnoticed.
    const row = rectRow();
    const rotated: OverlayRow = {
      ...row,
      data: { ...row.data, rotation: Math.PI / 4 } as OverlayRow["data"]
    };
    const onGeometryChange = vi.fn();
    await render({ selectedOverlay: rotated, onGeometryChange });
    const body = document.querySelector(
      '[data-testid="transform-handle-body"]'
    )!;
    // Drag massively left + up so the resulting rect lands at
    // x, y << 0 (well off-canvas). Pointerdown at (300, 250),
    // pointermove to (-500, -500) = a delta of (-800, -750) in
    // client px. Normalized against the test harness's 1000×1000
    // client rect: dx = -0.8, dy = -0.75. Applied to rect.x = 0.1
    // → new x = -0.7; rect.y = 0.1 → new y = -0.65.
    firePointer(body, "pointerdown", 300, 250);
    firePointer(body, "pointermove", -500, -500);
    firePointer(body, "pointerup", -500, -500);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    expect(geom.kind).toBe("rect");
    if (geom.kind === "rect") {
      // The rect is allowed off-canvas — no clamp held it back.
      expect(geom.rect.x).toBeCloseTo(-0.7, 6);
      expect(geom.rect.y).toBeCloseTo(-0.65, 6);
      // Rotation preserved across the translation.
      expect(geom.rotation).toBeCloseTo(Math.PI / 4, 6);
      // Width / height unchanged (body drag never resizes).
      expect(geom.rect.w).toBeCloseTo(0.4, 6);
      expect(geom.rect.h).toBeCloseTo(0.3, 6);
    }
  });

  test("rotated rect resize: dragging NE on a 90°-rotated rect pivots around the rotated SW", async () => {
    // Unrotated rect (0.1, 0.1, 0.4, 0.3). Rotated 90° CW around its
    // center (0.3, 0.25). The rotated NE corner is where SE was in
    // pixel-space terms; the SW pivot (which stays put) is at the
    // ROTATED SW world position.
    //
    // For the test we don't need to assert the exact resulting rect;
    // we just verify the resize:
    //   1. Returns a geometry update (the rotated-resize path didn't
    //      fall back to null).
    //   2. PRESERVES rotation (the rect stays rotated, doesn't snap
    //      back to axis-aligned).
    //   3. Width / height are non-zero (the resize math produced a
    //      sensible result rather than collapsing to MIN_PX).
    const row = rectRow();
    const rotated: OverlayRow = {
      ...row,
      data: { ...row.data, rotation: Math.PI / 2 } as OverlayRow["data"]
    };
    const onGeometryChange = vi.fn();
    await render({ selectedOverlay: rotated, onGeometryChange });
    const ne = document.querySelector(
      '[data-testid="transform-handle-ne"]'
    )!;
    // The NE handle's CSS position is at the rotated location (per
    // the test above). Drag it diagonally to grow the rect.
    const neRect = (ne as HTMLElement).getBoundingClientRect();
    const startX = neRect.left + neRect.width / 2;
    const startY = neRect.top + neRect.height / 2;
    firePointer(ne, "pointerdown", startX, startY);
    firePointer(ne, "pointermove", startX + 100, startY + 100);
    firePointer(ne, "pointerup", startX + 100, startY + 100);
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const geom = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    expect(geom.kind).toBe("rect");
    if (geom.kind === "rect") {
      // Rotation preserved through resize.
      expect(geom.rotation).toBeCloseTo(Math.PI / 2, 6);
      // Width / height positive (didn't collapse).
      expect(geom.rect.w).toBeGreaterThan(0);
      expect(geom.rect.h).toBeGreaterThan(0);
    }
  });

  test("rect cursors rotate with the rect (NE handle on 90°-rotated rect shows nwse-resize)", async () => {
    // The handle SHAPE stays axis-aligned (industry convention) but
    // the CURSOR's diagonal / axial direction should follow the
    // visible edge so the user knows which way they're resizing.
    //
    // Unrotated: NE handle has cursor `nesw-resize` (/ diagonal).
    // After 90° CW rotation: the NE handle is at the visible
    // top-right-ish-but-now-rotated corner; its effective direction
    // vector (originally (+1, -1) in screen coords with +y down)
    // rotates to (+1, +1) — which is the \\ diagonal → `nwse-resize`.
    const row = rectRow();
    const rotated: OverlayRow = {
      ...row,
      data: { ...row.data, rotation: Math.PI / 2 } as OverlayRow["data"]
    };
    await render({ selectedOverlay: rotated });
    const ne = document.querySelector(
      '[data-testid="transform-handle-ne"]'
    ) as HTMLElement;
    expect(ne).not.toBeNull();
    expect(ne.style.cursor).toBe("nwse-resize");
    // The N handle (axially vertical when unrotated → ns-resize)
    // rotates by 90° to become horizontally aligned → ew-resize.
    const n = document.querySelector(
      '[data-testid="transform-handle-n"]'
    ) as HTMLElement;
    expect(n.style.cursor).toBe("ew-resize");
  });

  test("unrotated rect cursors match the original axis-aligned convention", async () => {
    // Belt-and-suspenders for the rotation === 0 short-circuit:
    // existing cursors stay bit-identical (nwse / nesw / ns / ew)
    // so unrotated rows don't see any regression.
    await render({ selectedOverlay: rectRow() });
    const cursors: Record<string, string> = {};
    for (const k of ["nw", "ne", "se", "sw", "n", "e", "s", "w"]) {
      const el = document.querySelector(
        `[data-testid="transform-handle-${k}"]`
      ) as HTMLElement;
      cursors[k] = el.style.cursor;
    }
    expect(cursors.nw).toBe("nwse-resize");
    expect(cursors.se).toBe("nwse-resize");
    expect(cursors.ne).toBe("nesw-resize");
    expect(cursors.sw).toBe("nesw-resize");
    expect(cursors.n).toBe("ns-resize");
    expect(cursors.s).toBe("ns-resize");
    expect(cursors.e).toBe("ew-resize");
    expect(cursors.w).toBe("ew-resize");
  });
});
