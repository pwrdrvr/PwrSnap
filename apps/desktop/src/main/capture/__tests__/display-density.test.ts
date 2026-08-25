import { describe, expect, it } from "vitest";
import { displayScaleFactorForId } from "../display-density";

const displays = [
  { id: 10, scaleFactor: 2 },
  { id: 20, scaleFactor: 1 },
  { id: 30, scaleFactor: 1.5 }
] as const;

describe("displayScaleFactorForId", () => {
  it("uses the selected display instead of the machine's highest density", () => {
    expect(displayScaleFactorForId(displays, 20)).toBe(1);
    expect(displayScaleFactorForId(displays, 10)).toBe(2);
  });

  it("preserves fractional Windows display scaling", () => {
    expect(displayScaleFactorForId(displays, 30)).toBe(1.5);
  });

  it("defaults unknown or invalid density to truthful standard DPI", () => {
    expect(displayScaleFactorForId(displays, 999)).toBe(1);
    expect(displayScaleFactorForId([{ id: 40, scaleFactor: 0 }], 40)).toBe(1);
  });
});
