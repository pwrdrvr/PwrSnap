// Regression coverage: rotation must survive the undo round-trip.
//
// Every geometry undo entry stores a `previousGeometry` built by
// `overlayDataToGeometry(preDrag.data)` and a `nextGeometry` from the
// drag. Undo re-dispatches the previous one through `updateGeometry`,
// which merges it onto the CURRENT row via `applyGeometryToOverlay`.
//
// That merge treats an ABSENT `rotation` as "leave the persisted
// rotation alone" — deliberately, so a body-drag or a nudge doesn't
// clobber the angle. But `overlayDataToGeometry` never emitted the
// field, so the "before" half of every undo entry was rotation-blind:
//
//   • Undoing a rotation restored the (unchanged) position and left the
//     NEW angle in place — ⌘Z looked like it did nothing at all.
//   • Undoing anything OLDER then replayed those earlier positions with
//     the rotation still applied, so the layer walked back through its
//     own history at the wrong angle. That is the reported "it moved
//     the rotated text left and right, mimicking movements I had done
//     before the rotation."
//
// These tests drive the real pair of functions the undo stack uses, in
// the order it uses them, rather than asserting on the shape of
// `overlayDataToGeometry`'s output alone — the bug was in how the two
// compose.

import { describe, expect, test } from "vitest";
import { readOverlayRotation, type Overlay } from "@pwrsnap/shared";
import { overlayDataToGeometry } from "../Editor";
import { applyGeometryToOverlay } from "../useCaptureModel";

/** What the undo stack does on ⌘Z: take the geometry captured from the
 *  PRE-drag row and merge it onto whatever the row looks like now. */
function undoOnto(before: Overlay, current: Overlay): Overlay {
  const previousGeometry = overlayDataToGeometry(before);
  expect(previousGeometry).not.toBeNull();
  const restored = applyGeometryToOverlay(current, previousGeometry!);
  expect(restored).not.toBeNull();
  return restored!;
}

/** `readOverlayRotation` takes the optional-rotation shape; the Overlay
 *  union also contains kinds (arrow, step) that never carry the field,
 *  so narrow at the read. */
const rotationOf = (data: Overlay): number =>
  readOverlayRotation(data as { rotation?: number });

const textAt = (x: number, y: number, rotation?: number): Overlay =>
  ({
    kind: "text",
    point: { x, y },
    body: "hello",
    size: "medium",
    color: "auto",
    ...(rotation !== undefined ? { rotation } : {})
  }) as Overlay;

const shapeAt = (x: number, y: number, rotation?: number): Overlay =>
  ({
    kind: "shape",
    shape: "rect",
    rect: { x, y, w: 0.2, h: 0.1 },
    color: "auto",
    ...(rotation !== undefined ? { rotation } : {})
  }) as Overlay;

describe("rotation survives the undo round-trip", () => {
  test("text — undoing a rotation restores the un-rotated angle", () => {
    // The exact reported gesture: an unrotated layer, rotated by the
    // handle (position untouched), then ⌘Z.
    const before = textAt(0.3, 0.5);
    const afterRotate = textAt(0.3, 0.5, 0.7);
    expect(rotationOf(undoOnto(before, afterRotate))).toBeCloseTo(0, 6);
  });

  test("text — undoing back PAST a rotation restores the older angle too", () => {
    // The second half of the report: earlier moves replayed at the
    // rotated angle. Undoing to a pre-rotation position must also
    // restore the pre-rotation ANGLE, or the layer walks its history
    // sideways.
    const oldPosition = textAt(0.1, 0.5);
    const nowRotatedAndMoved = textAt(0.6, 0.5, 0.7);
    const undone = undoOnto(oldPosition, nowRotatedAndMoved);
    expect(rotationOf(undone)).toBeCloseTo(0, 6);
    expect((undone as { point: { x: number } }).point.x).toBeCloseTo(0.1, 6);
  });

  test("text — undoing a rotation made ON TOP of an existing one restores the first", () => {
    const before = textAt(0.3, 0.5, 0.25);
    const afterSecondRotate = textAt(0.3, 0.5, 1.4);
    expect(rotationOf(undoOnto(before, afterSecondRotate))).toBeCloseTo(
      0.25,
      6
    );
  });

  test("shape — undoing a rotation restores the un-rotated angle", () => {
    // rect-shaped layers (shape / highlight / blur) carry rotation on
    // the same optional field and travel the `rect` geometry arm.
    const before = shapeAt(0.2, 0.2);
    const afterRotate = shapeAt(0.2, 0.2, -0.9);
    expect(rotationOf(undoOnto(before, afterRotate))).toBeCloseTo(0, 6);
  });

  test("shape — a rotated layer's position undo keeps its angle", () => {
    // The converse guard: restoring an older POSITION from a row that
    // was already rotated at that time must not flatten the rotation.
    const before = shapeAt(0.2, 0.2, 0.5);
    const afterMove = shapeAt(0.7, 0.2, 0.5);
    const undone = undoOnto(before, afterMove);
    expect(rotationOf(undone)).toBeCloseTo(0.5, 6);
    expect((undone as { rect: { x: number } }).rect.x).toBeCloseTo(0.2, 6);
  });
});
