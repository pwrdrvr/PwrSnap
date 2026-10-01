import { describe, expect, test } from "vitest";

import type { BundleLayerNode } from "../bundle-manifest-schema-v2";

import {
  copyStem,
  copyTitle,
  emptyCaptureEditSummary,
  formatCaptureEditSummary,
  nextCopyNumber,
  stripStemCopySuffix,
  stripTitleCopySuffix,
  summarizeImageEdits,
  summarizeVideoEdits
} from "../capture-duplicate";

describe("formatCaptureEditSummary", () => {
  test("names each kind once, with counts past one", () => {
    expect(
      formatCaptureEditSummary({
        ...emptyCaptureEditSummary(),
        hasEdits: true,
        cropped: true,
        arrows: 2,
        blurs: 1
      })
    ).toBe("crop · 2 arrows · blur");
  });

  test("video edits read as trim and cuts", () => {
    expect(
      formatCaptureEditSummary(
        summarizeVideoEdits({
          durationSec: 30,
          segments: [
            { start: 2, end: 10 },
            { start: 14, end: 18 },
            { start: 20, end: 25 }
          ]
        })
      )
    ).toBe("trim · 2 cuts");
  });

  test("Draw strokes are edits: a snap with only strokes asks before copying, and names them", () => {
    const sha = "a".repeat(64);
    const layers = [
      { kind: "group", id: "g_root", parent_id: null },
      {
        kind: "raster",
        id: "raster_base",
        parent_id: "g_root",
        source_ref: { kind: "embedded", sha256: sha },
        natural_width_px: 800,
        natural_height_px: 600
      },
      {
        kind: "vector",
        id: "stroke_1",
        parent_id: "g_root",
        shape: { kind: "stroke", tool: "pen", points: [{ x: 0.1, y: 0.1 }], color: "auto" }
      },
      {
        kind: "vector",
        id: "stroke_2",
        parent_id: "g_root",
        shape: { kind: "stroke", tool: "marker", points: [{ x: 0.2, y: 0.2 }], color: "auto" }
      }
    ] as unknown as BundleLayerNode[];
    const summary = summarizeImageEdits(layers, { sha256: sha, width_px: 800, height_px: 600 });
    expect(summary.hasEdits).toBe(true);
    expect(summary.strokes).toBe(2);
    expect(formatCaptureEditSummary(summary)).toBe("2 drawings");
  });

  test("an untouched video has no edits", () => {
    const summary = summarizeVideoEdits({ durationSec: 30, segments: [{ start: 0, end: 30 }] });
    expect(summary.hasEdits).toBe(false);
    expect(formatCaptureEditSummary(summary)).toBe("");
  });
});

describe("copy naming", () => {
  test("strips any copy suffix so a copy of a copy numbers from the root", () => {
    expect(stripTitleCopySuffix("Cereal aisle copy 3")).toBe("Cereal aisle");
    expect(stripTitleCopySuffix("Cereal aisle copy")).toBe("Cereal aisle");
    expect(stripTitleCopySuffix("Copy machine")).toBe("Copy machine");
    expect(stripStemCopySuffix("cereal-aisle-copy-2")).toBe("cereal-aisle");
  });

  test("takes the lowest number neither titles nor stems in the family use", () => {
    expect(
      nextCopyNumber({
        titleBase: "Cereal aisle",
        stemBase: "cereal-aisle",
        familyTitles: ["Cereal aisle", "Cereal aisle copy", null],
        familyStems: ["cereal-aisle", null, "cereal-aisle-copy-2"]
      })
    ).toBe(3);
  });

  test("a renamed member does not hold a number", () => {
    expect(
      nextCopyNumber({
        titleBase: "Cereal aisle",
        stemBase: null,
        familyTitles: ["Oatmeal copy"],
        familyStems: []
      })
    ).toBe(1);
  });

  test("formats the first copy without a number", () => {
    expect(copyTitle("Cereal aisle", 1)).toBe("Cereal aisle copy");
    expect(copyTitle("Cereal aisle", 2)).toBe("Cereal aisle copy 2");
    expect(copyStem("cereal-aisle", 1)).toBe("cereal-aisle-copy");
    expect(copyStem("cereal-aisle", 4)).toBe("cereal-aisle-copy-4");
  });
});
