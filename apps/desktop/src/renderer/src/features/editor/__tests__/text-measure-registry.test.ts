// Unit tests for the measured-glyph-size registry — the store that lets
// TextHtml publish a glyph's REAL laid-out box so the selection outline /
// transform handles / hit-test read it instead of re-deriving it. See
// text-measure-registry.ts.

import { afterEach, describe, expect, test } from "vitest";
import {
  clearGlyphSize,
  getGlyphSize,
  reportGlyphSize
} from "../text-measure-registry";

afterEach(() => {
  // The registry is module-level; clean up the ids each test touches so
  // state doesn't leak across tests in this process.
  clearGlyphSize("a");
  clearGlyphSize("b");
});

describe("text-measure-registry", () => {
  test("get returns undefined for an unmeasured id", () => {
    expect(getGlyphSize("never-measured")).toBeUndefined();
  });

  test("report then get round-trips the box", () => {
    reportGlyphSize("a", { widthImagePx: 120, heightImagePx: 40 });
    expect(getGlyphSize("a")).toEqual({ widthImagePx: 120, heightImagePx: 40 });
  });

  test("clear removes a published box", () => {
    reportGlyphSize("a", { widthImagePx: 10, heightImagePx: 10 });
    clearGlyphSize("a");
    expect(getGlyphSize("a")).toBeUndefined();
  });

  test("ids are independent", () => {
    reportGlyphSize("a", { widthImagePx: 1, heightImagePx: 2 });
    reportGlyphSize("b", { widthImagePx: 3, heightImagePx: 4 });
    expect(getGlyphSize("a")).toEqual({ widthImagePx: 1, heightImagePx: 2 });
    expect(getGlyphSize("b")).toEqual({ widthImagePx: 3, heightImagePx: 4 });
  });

  test("keeps a stable object reference when the dims are unchanged", () => {
    // useSyncExternalStore relies on snapshot identity — a no-change
    // report must NOT swap in a new object (which would force a render
    // and could loop).
    reportGlyphSize("a", { widthImagePx: 50, heightImagePx: 25 });
    const first = getGlyphSize("a");
    reportGlyphSize("a", { widthImagePx: 50, heightImagePx: 25 });
    expect(getGlyphSize("a")).toBe(first);
  });

  test("swaps in a new box when the dims change", () => {
    reportGlyphSize("a", { widthImagePx: 50, heightImagePx: 25 });
    const first = getGlyphSize("a");
    reportGlyphSize("a", { widthImagePx: 60, heightImagePx: 25 });
    expect(getGlyphSize("a")).not.toBe(first);
    expect(getGlyphSize("a")).toEqual({ widthImagePx: 60, heightImagePx: 25 });
  });
});
