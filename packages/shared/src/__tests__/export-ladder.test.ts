import { describe, it, expect } from "vitest";
import {
  resolveExportLadder,
  resolveExportStrategy,
  exportStrategyFromSettings,
  rungForPreset,
  type ExportRung
} from "../export-ladder";

function widths(ladder: ExportRung[]): Record<string, number> {
  return Object.fromEntries(ladder.map((r) => [r.preset, r.widthPx]));
}

const retina2x = { widthPx: 2880, heightPx: 1800, devicePixelRatio: 2 };
const oneX = { widthPx: 1600, heightPx: 1000, devicePixelRatio: 1 };

describe("resolveExportStrategy", () => {
  it("is legacy when DPI-aware export is off", () => {
    expect(
      resolveExportStrategy({ dpiAwareExport: false, allowRetinaExport: true })
    ).toBe("legacy");
    expect(
      resolveExportStrategy({ dpiAwareExport: false, allowRetinaExport: false })
    ).toBe("legacy");
  });

  it("maps the Retina toggle to physical vs logical anchoring", () => {
    expect(
      resolveExportStrategy({ dpiAwareExport: true, allowRetinaExport: true })
    ).toBe("scalePhysical");
    expect(
      resolveExportStrategy({ dpiAwareExport: true, allowRetinaExport: false })
    ).toBe("scaleLogical");
  });

  it("falls back to legacy for missing settings", () => {
    expect(resolveExportStrategy(undefined)).toBe("legacy");
    expect(exportStrategyFromSettings(undefined)).toBe("legacy");
    expect(exportStrategyFromSettings({})).toBe("legacy");
  });
});

describe("resolveExportLadder — legacy", () => {
  it("clamps to the historical fixed widths", () => {
    expect(widths(resolveExportLadder(retina2x, "legacy"))).toEqual({
      low: 800,
      med: 1440,
      high: 2880
    });
  });

  it("collapses presets on a small capture (the old 'all the same' case)", () => {
    const small = { widthPx: 700, heightPx: 400, devicePixelRatio: 2 };
    expect(widths(resolveExportLadder(small, "legacy"))).toEqual({
      low: 700,
      med: 700,
      high: 700
    });
  });
});

describe("resolveExportLadder — scalePhysical (Retina export on)", () => {
  const ladder = resolveExportLadder(retina2x, "scalePhysical");

  it("is 25 / 50 / 100% of the physical width", () => {
    expect(widths(ladder)).toEqual({ low: 720, med: 1440, high: 2880 });
  });

  it("flags only the full-resolution rung as Retina on a 2× capture", () => {
    expect(rungForPreset(ladder, "high")?.retina).toBe(true);
    expect(rungForPreset(ladder, "med")?.retina).toBe(false);
    expect(rungForPreset(ladder, "low")?.retina).toBe(false);
  });

  it("reports the on-screen multiple (High=2×, Med=1×, Low=½×)", () => {
    expect(rungForPreset(ladder, "high")?.onScreenMultiple).toBeCloseTo(2);
    expect(rungForPreset(ladder, "med")?.onScreenMultiple).toBeCloseTo(1);
    expect(rungForPreset(ladder, "low")?.onScreenMultiple).toBeCloseTo(0.5);
  });

  it("never marks anything Retina on a 1× capture", () => {
    const l = resolveExportLadder(oneX, "scalePhysical");
    expect(widths(l)).toEqual({ low: 400, med: 800, high: 1600 });
    expect(l.every((r) => !r.retina)).toBe(true);
  });
});

describe("resolveExportLadder — scaleLogical (Retina export off)", () => {
  it("re-anchors so High becomes the on-screen 1× resolution", () => {
    // logical = 2880 / 2 = 1440 → High=1440 (was the old 50%), with two
    // smaller rungs below.
    expect(widths(resolveExportLadder(retina2x, "scaleLogical"))).toEqual({
      low: 360,
      med: 720,
      high: 1440
    });
  });

  it("makes the toggle inert on a 1× capture (logical == physical)", () => {
    expect(widths(resolveExportLadder(oneX, "scaleLogical"))).toEqual(
      widths(resolveExportLadder(oneX, "scalePhysical"))
    );
  });
});

describe("resolveExportLadder — invariants", () => {
  it("never upscales past the source width", () => {
    for (const strategy of ["legacy", "scalePhysical", "scaleLogical"] as const) {
      for (const rung of resolveExportLadder(retina2x, strategy)) {
        expect(rung.widthPx).toBeLessThanOrEqual(retina2x.widthPx);
        expect(rung.widthPx).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("treats a 0 / negative DPR as 1× rather than dividing by zero", () => {
    const l = resolveExportLadder(
      { widthPx: 1000, heightPx: 500, devicePixelRatio: 0 },
      "scalePhysical"
    );
    expect(widths(l)).toEqual({ low: 250, med: 500, high: 1000 });
    expect(l.every((r) => Number.isFinite(r.onScreenMultiple))).toBe(true);
  });
});
