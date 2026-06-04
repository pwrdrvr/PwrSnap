// URL-builder tests for the renderer-side `cacheUrl` / `captureSrcUrl`
// helpers. The matching parser tests in protocols-parse.test.ts cover
// the inverse direction; together they catch a drift between what the
// renderer produces and what the main-process parser accepts.

import { describe, expect, test } from "vitest";
import { parseCacheUrl, parseCaptureId } from "../../../../main/protocols-parse";
import { cacheUrl, captureSrcUrl, sizzleOutputUrl } from "../pwrsnap";

describe("captureSrcUrl ↔ parseCaptureId round-trip", () => {
  test.each([
    "abc123",
    "AbCdEf_GhIjKl",
    "3eHcq7P_nj6zANFW",
    "AAAAAAAAAAAAAAAA",
    "z-z_z-z_z-z_z-z_"
  ])("preserves id `%s`", (id) => {
    const url = captureSrcUrl(id);
    expect(parseCaptureId(url)).toBe(id);
  });

  test("emits the literal 'r' host", () => {
    expect(captureSrcUrl("abc")).toBe("pwrsnap-capture://r/abc");
  });
});

describe("cacheUrl ↔ parseCacheUrl round-trip", () => {
  test("default format is webp", () => {
    expect(cacheUrl("abc", 640)).toBe("pwrsnap-cache://r/abc/640w.webp");
  });

  test("explicit png format", () => {
    expect(cacheUrl("abc", 1440, "png")).toBe("pwrsnap-cache://r/abc/1440w.png");
  });

  test.each([
    ["abc", 256, "webp" as const],
    ["MixedCase_id", 1440, "webp" as const],
    ["x", 1, "png" as const],
    ["aLongerNanoidLooking_id", 8192, "png" as const]
  ])("round-trip (%s, %d, %s)", (id, width, format) => {
    const url = cacheUrl(id, width, format);
    expect(parseCacheUrl(url)).toEqual({ captureId: id, width, format });
  });
});

describe("sizzleOutputUrl ↔ parseCaptureId round-trip", () => {
  test("emits the sizzle output scheme", () => {
    expect(sizzleOutputUrl("sz_76a98a1b-b4a")).toBe(
      "pwrsnap-sizzle://r/sz_76a98a1b-b4a"
    );
  });

  test("uses lastRenderedAt as a cache buster", () => {
    const url = sizzleOutputUrl("sz_76a98a1b-b4a", "2026-06-03T10:11:12.000Z");
    expect(url).toBe(
      "pwrsnap-sizzle://r/sz_76a98a1b-b4a?v=2026-06-03T10%3A11%3A12.000Z"
    );
    expect(parseCaptureId(url, "pwrsnap-sizzle")).toBe("sz_76a98a1b-b4a");
  });
});
