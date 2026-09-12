import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { computeNativeAudioCacheKey } from "../audio-extract";

describe("computeNativeAudioCacheKey", () => {
  const baseline = {
    videoPath: "/Users/u/Library/Application Support/PwrSnap/captures/abc.mp4",
    mtimeMs: 1748390400000,
    size: 1024 * 1024 * 5,
    hasSystemAudio: true,
    hasMicrophoneAudio: true,
    startSec: 1.5,
    durationSec: 3.25
  };

  test("baseline produces a 24-character hex digest", () => {
    const key = computeNativeAudioCacheKey(baseline);
    expect(key).toMatch(/^[0-9a-f]{24}$/);
  });

  test("recorded source flags invalidate the cache key", () => {
    // Which sources carried sound decides which tracks the extraction
    // selects, so it has to be part of the identity of the result.
    expect(computeNativeAudioCacheKey({ ...baseline, hasMicrophoneAudio: false })).not.toBe(
      computeNativeAudioCacheKey(baseline)
    );
    expect(computeNativeAudioCacheKey({ ...baseline, hasSystemAudio: false })).not.toBe(
      computeNativeAudioCacheKey(baseline)
    );
  });

  test("the armed record invalidates it too, because it decides track order", () => {
    expect(computeNativeAudioCacheKey({ ...baseline, requestedSystemAudio: false })).not.toBe(
      computeNativeAudioCacheKey({ ...baseline, requestedSystemAudio: true })
    );
  });

  test("mixing version invalidates old first-track-only extractions", () => {
    const oldKey = createHash("sha256")
      .update(baseline.videoPath).update("\0")
      .update(String(baseline.mtimeMs)).update("\0")
      .update(String(baseline.size)).update("\0")
      .update(baseline.startSec.toFixed(3)).update("\0")
      .update(baseline.durationSec.toFixed(3)).digest("hex").slice(0, 24);
    expect(computeNativeAudioCacheKey(baseline)).not.toBe(oldKey);
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
