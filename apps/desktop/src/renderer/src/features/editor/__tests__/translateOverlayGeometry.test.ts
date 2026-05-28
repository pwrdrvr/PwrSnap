// Pure-math coverage for the arrow-key nudge helper. The helper
// translates an overlay's geometry by a normalized delta and returns
// the GeometryUpdate that nudgeSelectedRef passes to dispatchEdit.
// Easy to test in isolation; the harder integration (effect + ref +
// dispatch) is covered by the editor unit suite once the hook lands.

import { describe, expect, test } from "vitest";
import type { GeometryUpdate } from "../useCaptureModel";
import type { OverlayRow } from "@pwrsnap/shared";

import { translateOverlayGeometry } from "../Editor";

function arrowData(): Extract<OverlayRow["data"], { kind: "arrow" }> {
  return {
    kind: "arrow",
    from: { x: 0.2, y: 0.5 },
    to: { x: 0.8, y: 0.5 },
    color: "auto"
  };
}

function rectData(
  kind: "rect" | "highlight" | "blur"
): Extract<OverlayRow["data"], { kind: "rect" | "highlight" | "blur" }> {
  return {
    kind,
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    color: "auto"
  } as Extract<OverlayRow["data"], { kind: "rect" | "highlight" | "blur" }>;
}

function textData(): Extract<OverlayRow["data"], { kind: "text" }> {
  return {
    kind: "text",
    point: { x: 0.5, y: 0.5 },
    body: "hello",
    size: "medium",
    color: "auto"
  };
}

/** `toEqual` chokes on the float drift `0.2 + 0.01 = 0.21000000000000002`.
 *  This pair-wise compare uses `toBeCloseTo(... , 9)` (well past the
 *  drift threshold) so the tests stay tight against the shape but
 *  ignore irrelevant FP noise. */
function expectGeometry(actual: GeometryUpdate | null, expected: GeometryUpdate): void {
  expect(actual).not.toBeNull();
  if (actual === null) return;
  expect(actual.kind).toBe(expected.kind);
  if (expected.kind === "arrow" && actual.kind === "arrow") {
    expect(actual.from.x).toBeCloseTo(expected.from.x, 9);
    expect(actual.from.y).toBeCloseTo(expected.from.y, 9);
    expect(actual.to.x).toBeCloseTo(expected.to.x, 9);
    expect(actual.to.y).toBeCloseTo(expected.to.y, 9);
    return;
  }
  if (expected.kind === "rect" && actual.kind === "rect") {
    expect(actual.rect.x).toBeCloseTo(expected.rect.x, 9);
    expect(actual.rect.y).toBeCloseTo(expected.rect.y, 9);
    expect(actual.rect.w).toBeCloseTo(expected.rect.w, 9);
    expect(actual.rect.h).toBeCloseTo(expected.rect.h, 9);
    return;
  }
  if (expected.kind === "text" && actual.kind === "text") {
    expect(actual.point.x).toBeCloseTo(expected.point.x, 9);
    expect(actual.point.y).toBeCloseTo(expected.point.y, 9);
    return;
  }
  if (expected.kind === "step" && actual.kind === "step") {
    expect(actual.point.x).toBeCloseTo(expected.point.x, 9);
    expect(actual.point.y).toBeCloseTo(expected.point.y, 9);
    return;
  }
  throw new Error(`Unhandled kind in expectGeometry: ${expected.kind}`);
}

describe("translateOverlayGeometry", () => {
  test("arrow translates both endpoints by the same (dxn, dyn)", () => {
    expectGeometry(translateOverlayGeometry(arrowData(), 0.05, -0.1), {
      kind: "arrow",
      from: { x: 0.25, y: 0.4 },
      to: { x: 0.85, y: 0.4 }
    });
  });

  test("rect translates x / y but preserves width + height (no resize)", () => {
    expectGeometry(translateOverlayGeometry(rectData("rect"), 0.05, -0.05), {
      kind: "rect",
      rect: { x: 0.15, y: 0.15, w: 0.3, h: 0.4 }
    });
  });

  test("highlight kind also translates via the rect branch", () => {
    expectGeometry(translateOverlayGeometry(rectData("highlight"), 0.01, 0.01), {
      kind: "rect",
      rect: { x: 0.11, y: 0.21, w: 0.3, h: 0.4 }
    });
  });

  test("blur kind also translates via the rect branch", () => {
    expectGeometry(translateOverlayGeometry(rectData("blur"), -0.05, 0.05), {
      kind: "rect",
      rect: { x: 0.05, y: 0.25, w: 0.3, h: 0.4 }
    });
  });

  test("text translates its anchor point", () => {
    expectGeometry(translateOverlayGeometry(textData(), 0.02, 0.03), {
      kind: "text",
      point: { x: 0.52, y: 0.53 }
    });
  });

  test("zero delta returns a geometry equivalent to the original", () => {
    expectGeometry(translateOverlayGeometry(rectData("rect"), 0, 0), {
      kind: "rect",
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
    });
  });

  test("negative delta moves up / left", () => {
    // ArrowLeft + ArrowUp are negative; verify both axes go the right way.
    expectGeometry(translateOverlayGeometry(textData(), -0.1, -0.1), {
      kind: "text",
      point: { x: 0.4, y: 0.4 }
    });
  });
});
