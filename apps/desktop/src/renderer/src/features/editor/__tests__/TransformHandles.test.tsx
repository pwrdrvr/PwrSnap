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
  test("rect: renders 8 handles (4 corners + 4 edges)", async () => {
    await render({ selectedOverlay: rectRow() });
    expect(countResizeHandles()).toBe(8);
    // Verify each handle kind is present.
    for (const k of ["nw", "ne", "se", "sw", "n", "e", "s", "w"]) {
      const h = document.querySelector(`[data-testid="transform-handle-${k}"]`);
      expect(h, `missing ${k} handle`).not.toBeNull();
    }
    // Body-hit rect for drag-to-move sits alongside the 8 resize
    // handles for rect-shaped layers.
    expect(document.querySelector('[data-testid="transform-handle-body"]')).not.toBeNull();
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
    expect(countResizeHandles()).toBe(8);
    expect(document.querySelector('[data-testid="transform-handle-body"]')).not.toBeNull();
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
    expect(countResizeHandles()).toBe(8);
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

  test("text: no anchor handle (drag uses the body-hit rect only)", async () => {
    // The standalone anchor handle was a 10×10 white square at the
    // glyph's anchor point — users mistook it for a checkbox and it
    // was redundant with the body-hit rect that already catches
    // drag-to-move across the entire bounding box. Now text has just
    // the body-hit rect (sized to the actual text bounds via
    // `textBoundsBox`); the dashed SelectionOutline shows the user
    // what's selected.
    await render({ selectedOverlay: textRow() });
    expect(countResizeHandles()).toBe(0);
    expect(document.querySelector('[data-testid="transform-handle-anchor"]')).toBeNull();
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

  test("body drag clamps so the layer cannot leave [0,1]", async () => {
    const onGeometryChange = vi.fn();
    await render({
      selectedOverlay: rectRow(),
      onGeometryChange
    });
    const body = document.querySelector('[data-testid="transform-handle-body"]')!;
    // Initial rect: x=0.1, y=0.1, w=0.4, h=0.3. Try to drag way
    // off-canvas (delta = (-5000px, -5000px)). The clamp should pin
    // x and y to 0 (so w+h remain inside [0,1]).
    firePointer(body, "pointerdown", 300, 300);
    firePointer(body, "pointermove", -5000, -5000);
    firePointer(body, "pointerup", -5000, -5000);
    const commit = onGeometryChange.mock.calls[0]?.[0] as GeometryUpdate;
    if (commit.kind === "rect") {
      expect(commit.rect.x).toBeCloseTo(0, 3);
      expect(commit.rect.y).toBeCloseTo(0, 3);
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
});
