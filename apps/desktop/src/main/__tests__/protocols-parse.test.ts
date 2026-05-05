// URL parser tests for the custom `pwrsnap-capture://` and
// `pwrsnap-cache://` schemes. The parsers run on the hot path of every
// renderer image fetch — the library grid, the float-over preview, the
// drag-out icon — so a regression here means the entire library shows
// 404s. The capture-id case-preservation rule is the one that bit us
// in commit 8d92916; lock it down.

import { describe, expect, test } from "vitest";
import { parseCacheUrl, parseCaptureId, SCHEMES } from "../protocols-parse";

describe("parseCaptureId", () => {
  test("parses a typical nanoid id from the path", () => {
    expect(parseCaptureId("pwrsnap-capture://r/3eHcq7P_nj6zANFW")).toBe("3eHcq7P_nj6zANFW");
  });

  test("preserves mixed case (the bug commit 8d92916 fixed)", () => {
    // Chromium lowercases the URL authority — but the id sits in the
    // path, so its case must round-trip. Without this guarantee every
    // mixed-case capture id 404s on the very first render.
    expect(parseCaptureId("pwrsnap-capture://r/AbCdEf_GhIjKl")).toBe("AbCdEf_GhIjKl");
  });

  test("tolerates a trailing slash", () => {
    expect(parseCaptureId("pwrsnap-capture://r/abc123/")).toBe("abc123");
  });

  test("returns null for an empty id", () => {
    expect(parseCaptureId("pwrsnap-capture://r/")).toBeNull();
    expect(parseCaptureId("pwrsnap-capture://r/////")).toBeNull();
  });

  test("rejects ids with disallowed characters", () => {
    // nanoid alphabet is [A-Za-z0-9_-]; the parser must refuse anything
    // else so a malformed URL doesn't poison the DB lookup.
    expect(parseCaptureId("pwrsnap-capture://r/abc.png")).toBeNull();
    expect(parseCaptureId("pwrsnap-capture://r/../etc/passwd")).toBeNull();
    expect(parseCaptureId("pwrsnap-capture://r/abc def")).toBeNull();
    expect(parseCaptureId("pwrsnap-capture://r/abc%20def")).toBeNull();
  });

  test("rejects the wrong scheme", () => {
    expect(parseCaptureId("file:///r/abc123")).toBeNull();
    expect(parseCaptureId("pwrsnap-cache://r/abc123")).toBeNull();
    expect(parseCaptureId("https://r/abc123")).toBeNull();
  });

  test("rejects URLs missing the literal 'r' host", () => {
    expect(parseCaptureId("pwrsnap-capture://abc123")).toBeNull();
    expect(parseCaptureId("pwrsnap-capture://x/abc123")).toBeNull();
  });

  test("uses SCHEMES.capture by default", () => {
    expect(parseCaptureId(`${SCHEMES.capture}://r/abc123`)).toBe("abc123");
  });
});

describe("parseCacheUrl", () => {
  test("parses (id, width, format) from a well-formed url", () => {
    expect(parseCacheUrl("pwrsnap-cache://r/abc123/640w.webp")).toEqual({
      captureId: "abc123",
      width: 640,
      format: "webp"
    });
  });

  test("preserves mixed-case capture id", () => {
    expect(parseCacheUrl("pwrsnap-cache://r/AbC_xyz/1440w.png")).toEqual({
      captureId: "AbC_xyz",
      width: 1440,
      format: "png"
    });
  });

  test("accepts both png and webp formats", () => {
    expect(parseCacheUrl("pwrsnap-cache://r/abc/256w.png")?.format).toBe("png");
    expect(parseCacheUrl("pwrsnap-cache://r/abc/256w.webp")?.format).toBe("webp");
  });

  test("rejects unsupported formats", () => {
    expect(parseCacheUrl("pwrsnap-cache://r/abc/256w.jpg")).toBeNull();
    expect(parseCacheUrl("pwrsnap-cache://r/abc/256w.jpeg")).toBeNull();
    expect(parseCacheUrl("pwrsnap-cache://r/abc/256w.gif")).toBeNull();
  });

  test("clamps width to (0, 8192]", () => {
    // Width=0 gives a 0-byte output — refuse so we never wedge sharp.
    expect(parseCacheUrl("pwrsnap-cache://r/abc/0w.webp")).toBeNull();
    // 8192 is the upper bound — sharp's max for a single dim.
    expect(parseCacheUrl("pwrsnap-cache://r/abc/8192w.webp")).not.toBeNull();
    // Anything bigger is a DoS — refuse rather than let the renderer
    // worker pool allocate gigabytes of intermediate buffers.
    expect(parseCacheUrl("pwrsnap-cache://r/abc/8193w.webp")).toBeNull();
    expect(parseCacheUrl("pwrsnap-cache://r/abc/99999w.webp")).toBeNull();
  });

  test("rejects malformed width tokens", () => {
    expect(parseCacheUrl("pwrsnap-cache://r/abc/640.webp")).toBeNull(); // missing 'w'
    expect(parseCacheUrl("pwrsnap-cache://r/abc/wwebp")).toBeNull();
    expect(parseCacheUrl("pwrsnap-cache://r/abc/-1w.webp")).toBeNull();
    expect(parseCacheUrl("pwrsnap-cache://r/abc/abcw.webp")).toBeNull();
    expect(parseCacheUrl("pwrsnap-cache://r/abc/640w")).toBeNull(); // missing format
  });

  test("rejects the wrong scheme", () => {
    expect(parseCacheUrl("pwrsnap-capture://r/abc/640w.webp")).toBeNull();
    expect(parseCacheUrl("file:///r/abc/640w.webp")).toBeNull();
  });

  test("rejects extra path segments", () => {
    expect(parseCacheUrl("pwrsnap-cache://r/abc/640w.webp/extra")).toBeNull();
    expect(parseCacheUrl("pwrsnap-cache://r/abc/sub/640w.webp")).toBeNull();
  });

  test("tolerates a single trailing slash", () => {
    expect(parseCacheUrl("pwrsnap-cache://r/abc/640w.webp/")?.captureId).toBe("abc");
  });

  test("strips ?v=<n> cache-buster query suffix", () => {
    // Renderer appends ?v=<overlays_version> so Chromium re-fetches
    // after edits. The query has no semantic meaning to the
    // protocol; the parser must strip it before path-matching or
    // every cache-busted request 404s.
    expect(parseCacheUrl("pwrsnap-cache://r/abc/640w.webp?v=5")).toEqual({
      captureId: "abc",
      width: 640,
      format: "webp"
    });
    expect(parseCacheUrl("pwrsnap-cache://r/abc/72w.png?v=0")).toEqual({
      captureId: "abc",
      width: 72,
      format: "png"
    });
    // Empty query string should also work.
    expect(parseCacheUrl("pwrsnap-cache://r/abc/640w.webp?")).toEqual({
      captureId: "abc",
      width: 640,
      format: "webp"
    });
    // Hash fragments stripped too.
    expect(parseCacheUrl("pwrsnap-cache://r/abc/640w.webp#anchor")).toEqual({
      captureId: "abc",
      width: 640,
      format: "webp"
    });
    // Trailing slash + query.
    expect(parseCacheUrl("pwrsnap-cache://r/abc/640w.webp/?v=99")).toEqual({
      captureId: "abc",
      width: 640,
      format: "webp"
    });
  });
});
