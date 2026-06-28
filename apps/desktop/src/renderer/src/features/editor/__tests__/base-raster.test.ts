// Unit coverage for selectBaseRaster — the editor's "which raster is the
// <img>?" resolver. The editor shows ONE source image (the sha-matched
// embedded raster the `pwrsnap-capture://` protocol serves); these specs
// pin that it tracks the right layer even when a capture carries several
// rasters, and degrades sensibly when nothing matches.

import type { BundleLayerNode, RasterLayer } from "@pwrsnap/shared";
import { describe, expect, test } from "vitest";
import { selectBaseRaster } from "../base-raster";

const SOURCE_SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

function rasterNode(
  id: string,
  overrides: Partial<RasterLayer> = {}
): RasterLayer {
  return {
    id,
    parent_id: "root-group",
    name: "raster",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-06-27T12:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-06-27T12:00:00.000Z",
    kind: "raster",
    source_ref: { kind: "embedded", sha256: SOURCE_SHA },
    natural_width_px: 800,
    natural_height_px: 600,
    ...overrides
  };
}

const rootGroup: BundleLayerNode = {
  id: "root-group",
  parent_id: null,
  name: "Root",
  visible: true,
  locked: false,
  opacity: 1,
  blend_mode: "normal",
  transform: [1, 0, 0, 1, 0, 0],
  z_index: 0,
  source: "user",
  ai_run_id: null,
  applied_at: "2026-06-27T12:00:00.000Z",
  rejected_at: null,
  superseded_by: null,
  created_at: "2026-06-27T12:00:00.000Z",
  kind: "group",
  collapsed: false
};

describe("selectBaseRaster", () => {
  test("single raster → that raster", () => {
    const base = rasterNode("r1");
    expect(selectBaseRaster([rootGroup, base], SOURCE_SHA)?.id).toBe("r1");
  });

  test("multiple rasters → the sha-matched one, not the first in order", () => {
    // An overlay raster (different sha) appears BEFORE the source raster.
    const overlay = rasterNode("overlay", { source_ref: { kind: "embedded", sha256: OTHER_SHA } });
    const source = rasterNode("source", { source_ref: { kind: "embedded", sha256: SOURCE_SHA } });
    const picked = selectBaseRaster([rootGroup, overlay, source], SOURCE_SHA);
    expect(picked?.id).toBe("source");
  });

  test("no sha match → falls back to the first eligible raster", () => {
    const first = rasterNode("first", { source_ref: { kind: "embedded", sha256: OTHER_SHA } });
    const second = rasterNode("second", { source_ref: { kind: "embedded", sha256: OTHER_SHA } });
    expect(selectBaseRaster([rootGroup, first, second], SOURCE_SHA)?.id).toBe("first");
  });

  test("root-level rasters (parent_id === null) are ineligible", () => {
    const orphan = rasterNode("orphan", { parent_id: null });
    expect(selectBaseRaster([rootGroup, orphan], SOURCE_SHA)).toBeUndefined();
  });

  test("no rasters at all → undefined", () => {
    expect(selectBaseRaster([rootGroup], SOURCE_SHA)).toBeUndefined();
  });

  test("the sha-matched source's visibility is carried by the picked layer", () => {
    const overlay = rasterNode("overlay", {
      source_ref: { kind: "embedded", sha256: OTHER_SHA },
      visible: true
    });
    // Source hidden, overlay visible: must report the SOURCE's hidden state.
    const source = rasterNode("source", { visible: false });
    expect(selectBaseRaster([rootGroup, overlay, source], SOURCE_SHA)?.visible).toBe(false);
  });
});
