// Pins the invariant that lets the editor and the bake agree on
// annotation SIZE: both must resolve the base raster through
// `selectBaseRaster`, not through "first raster in tree order".
//
// This mattered mildly before the 2026-08 annotation-scale
// recalibration — the source raster's dims only drove the text-bucket
// fallback, which almost never fires because every text row persists an
// explicit `sizePx`. It matters a lot now: the same dims feed
// `annotationBasisPx`, which drives arrow and shape stroke widths, and
// those have NO per-row absolute fallback. A disagreement about which
// raster is "the image" exports every stroke at the wrong width.
//
// `compose-tree.ts` used to scan `flattened` for the first
// `kind === "raster"` node. This test is the shape of capture that
// broke.

import { describe, expect, test } from "vitest";
import type { BundleLayerNode } from "../bundle-manifest-schema-v2";
import { selectBaseRaster } from "../base-raster";
import { annotationBasisPx } from "../annotation-scale";

const SOURCE_SHA = "a".repeat(64);
const CURSOR_SHA = "b".repeat(64);

function raster(
  id: string,
  sha: string,
  w: number,
  h: number,
  zIndex: number
): BundleLayerNode {
  return {
    id,
    parent_id: "g_root",
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: zIndex,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-08-28T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-08-28T00:00:00Z",
    kind: "raster",
    source_ref: { kind: "embedded", sha256: sha },
    natural_width_px: w,
    natural_height_px: h,
    original_transform: [1, 0, 0, 1, 0, 0]
  } as BundleLayerNode;
}

describe("annotation basis resolves off the SHA-MATCHED base raster", () => {
  // A retina full-screen grab (2880×1800) that also carries a captured
  // cursor raster (280×400) — the exact pair the real bundles carry.
  // Here the cursor sorts FIRST, which is what a naive scan would pick.
  const cursorFirst: BundleLayerNode[] = [
    raster("cursor", CURSOR_SHA, 280, 400, 0),
    raster("source", SOURCE_SHA, 2880, 1800, 1)
  ];

  test("picks the sha-matched source, not the first raster in tree order", () => {
    const base = selectBaseRaster(cursorFirst, SOURCE_SHA);
    expect(base?.id).toBe("source");
    // What the removed first-raster scan would have picked:
    expect(cursorFirst[0]?.id).toBe("cursor");
  });

  test("the two picks produce materially different annotation bases", () => {
    // This is the bug, quantified: strokes would have exported at half
    // the width the editor previewed.
    const correct = annotationBasisPx(2880, 1800);
    const naive = annotationBasisPx(280, 400);
    expect(correct).toBe(1800);
    expect(naive).toBe(900);
    expect(correct / naive).toBe(2);
  });

  test("falls back to the first eligible raster when nothing sha-matches", () => {
    // Defensive path — a capture whose record sha doesn't match any
    // embedded raster (or an empty sha) still resolves to something
    // rather than sizing off canvas dims.
    const base = selectBaseRaster(cursorFirst, "");
    expect(base?.id).toBe("cursor");
  });

  test("single-raster captures are unaffected — the common case", () => {
    const single = [raster("source", SOURCE_SHA, 1920, 1080, 0)];
    expect(selectBaseRaster(single, SOURCE_SHA)?.id).toBe("source");
    expect(selectBaseRaster(single, "")?.id).toBe("source");
  });
});
