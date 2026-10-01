// The burst rule: which stroke, if any, a new stroke joins as another
// segment. The editor test drives a real two-stroke burst end to end;
// this pins every way a burst is refused.

import { describe, expect, test } from "vitest";
import { MAX_STROKE_POINTS, type OverlayRow, type StrokeOverlay } from "@pwrsnap/shared";

import { burstTarget } from "../stroke-burst";

const stroke: StrokeOverlay = {
  kind: "stroke",
  tool: "pen",
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 }
  ],
  color: "#ff0000",
  thickness: "medium"
};

function row(id: string, z: number, data: OverlayRow["data"]): OverlayRow {
  return {
    id,
    capture_id: "cap",
    data,
    schema_version: 1,
    created_at: "2026-10-01T00:00:00Z",
    applied_at: "2026-10-01T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: z
  };
}

const arrow = { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" } as const;

describe("burstTarget", () => {
  test("joins the top layer when it is a stroke in the same style", () => {
    const rows = [row("arrow", 1000, arrow), row("last", 2000, stroke)];
    expect(burstTarget(rows, [], stroke)).toEqual({ id: "last", data: stroke });
  });

  test("an unset thickness matches 'auto'", () => {
    const { thickness: _t, ...noThickness } = stroke;
    const rows = [row("last", 2000, { ...stroke, thickness: "auto" })];
    expect(burstTarget(rows, [], noThickness)).not.toBeNull();
  });

  test.each([
    ["another tool", { tool: "marker" as const }],
    ["another color", { color: "#00ff00" }],
    ["another weight", { thickness: "large" as const }],
    ["an opacity override", { opacity: 0.5 }]
  ])("refuses a top stroke with %s", (_label, change) => {
    const rows = [row("last", 2000, { ...stroke, ...change })];
    expect(burstTarget(rows, [], stroke)).toBeNull();
  });

  test("refuses when something else is on top — an arrow, or a pasted image", () => {
    expect(burstTarget([row("last", 1000, stroke), row("arrow", 2000, arrow)], [], stroke)).toBeNull();
    expect(burstTarget([row("last", 1000, stroke)], [{ z_index: 3000 }], stroke)).toBeNull();
  });

  test("refuses when the joined stroke would pass the point cap", () => {
    const full = {
      ...stroke,
      points: Array.from({ length: MAX_STROKE_POINTS - 1 }, (_, i) => ({ x: i / MAX_STROKE_POINTS, y: 0.5 }))
    };
    expect(burstTarget([row("last", 1000, full)], [], stroke)).toBeNull();
  });

  test("nothing to join on an empty canvas", () => {
    expect(burstTarget([], [], stroke)).toBeNull();
  });
});
