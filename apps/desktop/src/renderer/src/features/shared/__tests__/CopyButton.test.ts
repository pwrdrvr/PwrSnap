import { describe, it, expect } from "vitest";
import type { ExportRung } from "@pwrsnap/shared";
import { rungTag, estimateMetricForRung } from "../CopyButton";

function rung(partial: Partial<ExportRung>): ExportRung {
  return {
    preset: "high",
    widthPx: 2880,
    heightPx: 1800,
    onScreenMultiple: 2,
    retina: true,
    ...partial
  };
}

describe("rungTag", () => {
  it("labels a Retina rung explicitly", () => {
    expect(rungTag(rung({ retina: true, onScreenMultiple: 2 }))).toEqual({
      label: "Retina",
      retina: true
    });
  });

  it("renders common fractions for sub-1× rungs", () => {
    expect(rungTag(rung({ retina: false, onScreenMultiple: 1 })).label).toBe("1×");
    expect(rungTag(rung({ retina: false, onScreenMultiple: 0.5 })).label).toBe("½×");
    expect(rungTag(rung({ retina: false, onScreenMultiple: 0.25 })).label).toBe("¼×");
    expect(rungTag(rung({ retina: false, onScreenMultiple: 0.75 })).label).toBe("¾×");
  });

  it("falls back to a decimal multiple for odd scales (e.g. 3× Med)", () => {
    expect(rungTag(rung({ retina: false, onScreenMultiple: 1.5 })).label).toBe("1.5×");
  });
});

describe("estimateMetricForRung", () => {
  it("uses the rung's dims and an area-scaled, provisional byte estimate", () => {
    const m = estimateMetricForRung(
      rung({ widthPx: 1440, heightPx: 900 }),
      2880,
      4_000_000
    );
    expect(m.dim).toBe("1440 × 900");
    expect(m.exact).toBe(false);
    // 0.5 scale → ~¼ the bytes, marked provisional with "~".
    expect(m.bytes.startsWith("~")).toBe(true);
  });
});
