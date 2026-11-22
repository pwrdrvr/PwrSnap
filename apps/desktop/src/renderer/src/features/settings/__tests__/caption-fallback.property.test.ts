// What turning the caption fallback on stores. Oracle: behind Codex the
// stored fallback must be a pickable model on this Mac (main arms it, and it
// can caption with no network), never Codex and never a disabled entry; when
// there is none, nothing is stored. Behind anything else, `{}` as before.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { captionFallbackOnValue, runsOnCodex, type CaptionFallbackOption } from "../caption-fallback";

const VALUES = ["apple:system", "acp:gemini", "acp:kimi", "custom:local-a", "custom:remote-b", "custom:local-c"];
const onDevice = (provider: string): boolean => provider === "apple:system" || provider.startsWith("custom:local");

const option: fc.Arbitrary<CaptionFallbackOption> = fc.record({
  value: fc.constantFrom(...VALUES),
  label: fc.constant("x"),
  disabled: fc.boolean()
});

describe("captionFallbackOnValue (property)", () => {
  test("behind Codex: the first pickable on-device model, else nothing", () => {
    fc.assert(fc.property(fc.array(option, { maxLength: 6 }), (options) => {
      const stored = captionFallbackOnValue({ primaryOnCodex: true, options, onDevice });
      const pickableOnDevice = options.filter((o) => o.disabled !== true && onDevice(o.value));
      if (pickableOnDevice.length === 0) {
        expect(stored).toBeNull();
        return;
      }
      expect(stored).toEqual({ provider: pickableOnDevice[0]!.value });
      expect(runsOnCodex(stored?.provider, ["gemini", "kimi"])).toBe(false);
    }), { numRuns: 300 });
  });

  test("behind any other primary: {} (Codex on its managed default)", () => {
    fc.assert(fc.property(fc.array(option, { maxLength: 6 }), (options) => {
      expect(captionFallbackOnValue({ primaryOnCodex: false, options, onDevice })).toEqual({});
    }), { numRuns: 100 });
  });
});

describe("runsOnCodex", () => {
  test.each([
    [undefined, true], ["", true], ["codex", true], ["acp:qwen", true],
    ["acp:kimi", false], ["apple:system", false], ["custom:abc", false]
  ] as const)("%s → %s", (provider, expected) => {
    expect(runsOnCodex(provider, ["kimi"])).toBe(expected);
  });
});
