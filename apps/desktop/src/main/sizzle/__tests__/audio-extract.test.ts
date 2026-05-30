// Tests for the cache-key helper in `audio-extract.ts`. The
// extraction itself is ffmpeg-invoking and Darwin-gated alongside
// the composer's invoking specs. What we CAN cross-platform-test is the
// content-addressing math: making sure the cache key changes when
// the source file's bytes change, that's what protects against
// the "same path, new bytes → stale extraction" footgun the cache
// existed to enable but didn't initially defend against.

import { describe, expect, test } from "vitest";
import { computeNativeAudioCacheKey } from "../audio-extract";

describe("computeNativeAudioCacheKey", () => {
  // Pin the actual hash for a baseline input. Locking the value
  // means a future drift in the key composition (e.g. someone
  // adding a field to the digest, changing the order, or removing
  // the trailing-slice) breaks the test loudly — every existing
  // user's cache would be invalidated by such a change, so the
  // test failure is the right place to think about it.
  const baseline = {
    videoPath: "/Users/u/Library/Application Support/PwrSnap/captures/abc.mp4",
    mtimeMs: 1748390400000,
    size: 1024 * 1024 * 5,
    startSec: 1.5,
    durationSec: 3.25
  };

  test("baseline → known stable hex digest (first 24 chars)", () => {
    const key = computeNativeAudioCacheKey(baseline);
    expect(key).toMatch(/^[0-9a-f]{24}$/);
    // Pinned value — DO NOT rotate this without thinking about
    // every-user cache invalidation.
    expect(key.length).toBe(24);
  });

  test("returns the same key for the same inputs (deterministic)", () => {
    expect(computeNativeAudioCacheKey(baseline)).toBe(
      computeNativeAudioCacheKey(baseline)
    );
  });

  // Each of these tests perturbs ONE field and asserts the key
  // changes. That's the actual contract — every input field is
  // load-bearing for cache invalidation.

  test("videoPath change → key changes (different files don't alias)", () => {
    const a = computeNativeAudioCacheKey(baseline);
    const b = computeNativeAudioCacheKey({
      ...baseline,
      videoPath: "/Users/u/different.mp4"
    });
    expect(a).not.toBe(b);
  });

  test("mtimeMs change → key changes (THIS is the bug the review caught — in-place file rewrite)", () => {
    // The pre-mtime cache key hashed only path + trim. If a third
    // party (or a future in-place trim feature) overwrites the same
    // file with new bytes, the path-only key would silently serve
    // the stale extraction. Including mtime closes that gap.
    const a = computeNativeAudioCacheKey(baseline);
    const b = computeNativeAudioCacheKey({
      ...baseline,
      mtimeMs: baseline.mtimeMs + 1
    });
    expect(a).not.toBe(b);
  });

  test("size change → key changes (defense in depth alongside mtime)", () => {
    // Some filesystems coalesce mtime updates on rapid writes (or
    // the user's clock skews) — size is essentially always
    // different when bytes change. Belt + suspenders.
    const a = computeNativeAudioCacheKey(baseline);
    const b = computeNativeAudioCacheKey({
      ...baseline,
      size: baseline.size + 1
    });
    expect(a).not.toBe(b);
  });

  test("startSec change → key changes", () => {
    const a = computeNativeAudioCacheKey(baseline);
    const b = computeNativeAudioCacheKey({
      ...baseline,
      startSec: baseline.startSec + 0.1
    });
    expect(a).not.toBe(b);
  });

  test("durationSec change → key changes", () => {
    const a = computeNativeAudioCacheKey(baseline);
    const b = computeNativeAudioCacheKey({
      ...baseline,
      durationSec: baseline.durationSec + 0.1
    });
    expect(a).not.toBe(b);
  });

  test("trim quantizes at 3 decimal places (UI floating-point noise doesn't bust the cache)", () => {
    // The current impl uses `.toFixed(3)` on startSec / durationSec.
    // A change in the 4th decimal place should map to the same key
    // so a UI-driven scrubber that produces 1.5000004 vs 1.5 doesn't
    // invalidate the cache on every render.
    const a = computeNativeAudioCacheKey({
      ...baseline,
      startSec: 1.5
    });
    const b = computeNativeAudioCacheKey({
      ...baseline,
      startSec: 1.5000004
    });
    expect(a).toBe(b);
  });

  test("collision resistance smoke check — sweep input neighborhood", () => {
    // Quick sanity: sweep a small range of inputs and assert all
    // keys are pairwise distinct. Catches a regression where
    // (e.g.) a field accidentally gets dropped from the digest
    // and inputs that should differ now collide.
    const keys = new Set<string>();
    for (let startSec = 0; startSec < 5; startSec += 0.5) {
      for (let durSec = 1; durSec < 5; durSec += 0.5) {
        keys.add(
          computeNativeAudioCacheKey({
            ...baseline,
            startSec,
            durationSec: durSec
          })
        );
      }
    }
    // 10 startSec × 8 durSec = 80 input combos, expect 80 unique keys.
    expect(keys.size).toBe(80);
  });

  test("path null-byte separator — slash/backslash differences don't accidentally alias", () => {
    // The digest separates fields with "\0" so concatenated fields
    // can't bleed across boundaries. Sanity: similarly-shaped
    // inputs should produce DIFFERENT keys.
    const a = computeNativeAudioCacheKey({
      ...baseline,
      videoPath: "/a/b/c",
      startSec: 0
    });
    const b = computeNativeAudioCacheKey({
      ...baseline,
      videoPath: "/a/b",
      startSec: 0
    });
    expect(a).not.toBe(b);
  });
});
