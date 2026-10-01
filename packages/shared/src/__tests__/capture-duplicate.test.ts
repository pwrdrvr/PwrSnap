import { describe, expect, test } from "vitest";

import {
  copyStem,
  copyTitle,
  emptyCaptureEditSummary,
  formatCaptureEditSummary,
  nextCopyNumber,
  stripStemCopySuffix,
  stripTitleCopySuffix,
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
