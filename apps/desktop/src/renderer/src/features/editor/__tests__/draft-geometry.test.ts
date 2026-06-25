// Regression coverage for the live-drag override ("draftGeometry")
// lifecycle. The bug these guard against: after MOVING a layer and then
// hitting ⌘Z, the glyph stayed at the dragged position while the
// selection outline / handles / hit-test sat at the reverted position —
// because v2 `updateGeometry` PRESERVES the layer id, so the old
// id-presence cleanup never dropped the override, and the stale override
// masked the undo. See draft-geometry.ts.

import { describe, expect, test } from "vitest";
import type { Overlay, OverlayRow } from "@pwrsnap/shared";
import type { GeometryUpdate } from "../useCaptureModel";
import {
  overlayMatchesDraftGeometry,
  pruneLandedDraftGeometry
} from "../draft-geometry";

type Rect = { x: number; y: number; w: number; h: number };

function shape(rect: Rect, rotation?: number): Overlay {
  return {
    kind: "shape",
    shape: "rect",
    rect,
    color: "auto",
    thickness: 2,
    ...(rotation !== undefined ? { rotation } : {})
  } as unknown as Overlay;
}

function arrow(from: { x: number; y: number }, to: { x: number; y: number }): Overlay {
  return { kind: "arrow", from, to, color: "auto", thickness: 2 } as unknown as Overlay;
}

function text(point: { x: number; y: number }, rotation?: number): Overlay {
  return {
    kind: "text",
    point,
    body: "hi",
    size: "medium",
    color: "auto",
    ...(rotation !== undefined ? { rotation } : {})
  } as unknown as Overlay;
}

function row(id: string, data: Overlay): OverlayRow {
  return {
    id,
    capture_id: "cap",
    data,
    schema_version: 1,
    source: "user",
    ai_run_id: null,
    z_index: 0,
    rejected_at: null,
    applied_at: "2026-06-24T00:00:00.000Z",
    superseded_by: null,
    created_at: "2026-06-24T00:00:00.000Z"
  } as OverlayRow;
}

const rectGeom = (rect: Rect, rotation?: number): GeometryUpdate => ({
  kind: "rect",
  rect,
  ...(rotation !== undefined ? { rotation } : {})
});

describe("overlayMatchesDraftGeometry", () => {
  test("rect matches when the persisted rect equals the override", () => {
    const r = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    expect(overlayMatchesDraftGeometry(shape(r), rectGeom(r))).toBe(true);
  });

  test("rect differs → no match (still bridging the commit→refetch gap)", () => {
    expect(
      overlayMatchesDraftGeometry(
        shape({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
        rectGeom({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 })
      )
    ).toBe(false);
  });

  test("rotation-only drag: position equal but the angle hasn't landed → no match", () => {
    const r = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    expect(overlayMatchesDraftGeometry(shape(r, 0), rectGeom(r, 0.5))).toBe(false);
  });

  test("rotation landed → match", () => {
    const r = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    expect(overlayMatchesDraftGeometry(shape(r, 0.5), rectGeom(r, 0.5))).toBe(true);
  });

  test("override without rotation ignores the persisted angle", () => {
    const r = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    expect(overlayMatchesDraftGeometry(shape(r, 1.2), rectGeom(r))).toBe(true);
  });

  test("kind mismatch → false", () => {
    expect(
      overlayMatchesDraftGeometry(arrow({ x: 0, y: 0 }, { x: 1, y: 1 }), rectGeom({ x: 0, y: 0, w: 1, h: 1 }))
    ).toBe(false);
  });

  test("arrow / text positional matches", () => {
    expect(
      overlayMatchesDraftGeometry(arrow({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }), {
        kind: "arrow",
        from: { x: 0.1, y: 0.1 },
        to: { x: 0.4, y: 0.4 }
      })
    ).toBe(true);
    expect(
      overlayMatchesDraftGeometry(text({ x: 0.3, y: 0.3 }), { kind: "text", point: { x: 0.3, y: 0.3 } })
    ).toBe(true);
  });
});

describe("pruneLandedDraftGeometry", () => {
  test("REGRESSION: drops a landed override even though the id is preserved (v2)", () => {
    // The move committed and the refetch landed → overlays[X].data ==
    // override. Under the OLD id-presence cleanup this stayed (id still
    // present), so the stale override masked the next undo. The fix
    // drops it on geometry match.
    const moved = { x: 0.5, y: 0.5, w: 0.3, h: 0.3 };
    const draft = new Map<string, GeometryUpdate>([["X", rectGeom(moved)]]);
    const overlays = [row("X", shape(moved))];
    expect(pruneLandedDraftGeometry(draft, overlays)).toBeNull();
  });

  test("keeps an override still bridging (persisted geometry != override)", () => {
    const draft = new Map<string, GeometryUpdate>([
      ["X", rectGeom({ x: 0.5, y: 0.5, w: 0.3, h: 0.3 })]
    ]);
    // Row still at its pre-drag geometry — refetch hasn't landed yet.
    const overlays = [row("X", shape({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }))];
    // Same reference back → caller skips a no-op setState (no render loop).
    expect(pruneLandedDraftGeometry(draft, overlays)).toBe(draft);
  });

  test("drops an override whose row is gone (v1 delete-plus-insert id churn)", () => {
    const draft = new Map<string, GeometryUpdate>([
      ["OLD", rectGeom({ x: 0.5, y: 0.5, w: 0.3, h: 0.3 })]
    ]);
    expect(pruneLandedDraftGeometry(draft, [])).toBeNull();
  });

  test("multi-entry: drops the landed entry, keeps the bridging one", () => {
    const landed = { x: 0.5, y: 0.5, w: 0.3, h: 0.3 };
    const draft = new Map<string, GeometryUpdate>([
      ["A", rectGeom(landed)],
      ["B", rectGeom({ x: 0.6, y: 0.6, w: 0.2, h: 0.2 })]
    ]);
    const overlays = [
      row("A", shape(landed)),
      row("B", shape({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }))
    ];
    const result = pruneLandedDraftGeometry(draft, overlays);
    expect(result).not.toBeNull();
    expect([...result!.keys()]).toEqual(["B"]);
  });
});
