// Unit tests for the shared bus-boundary validator used by
// `video:export`, `clipboard:copyVideoFile`, `clipboard:copyVideoPath`
// and `video:prepareDrag`.
//
// The NaN case is the one that motivated extracting this: a
// `{ start: NaN, end: NaN }` range survives `normalizeRange`
// (`Math.max(0, Math.min(NaN, d))` is `NaN`), can never match a cached
// export row (`NaN !== NaN`), renders a cache filename like
// `rNaN-NaN`, and reaches ffmpeg as `-ss NaN -t NaN`. Guaranteed
// re-encode, guaranteed failure, every single call.

import { describe, expect, test } from "vitest";
import type { VideoExportCoordinates } from "@pwrsnap/shared";
import { validateVideoExportRequest } from "../video-export-validation";

const base: VideoExportCoordinates = {
  captureId: "cap_1",
  format: "mp4",
  preset: "med"
};

function reject(req: unknown): { code: string; message: string } {
  const out = validateVideoExportRequest(req as VideoExportCoordinates, "video:export");
  if (out.ok) throw new Error("expected a validation rejection");
  return { code: out.error.code, message: out.error.message };
}

describe("validateVideoExportRequest", () => {
  test("accepts a minimal request with no range / audio", () => {
    const out = validateVideoExportRequest(base, "video:export");
    expect(out.ok).toBe(true);
  });

  test("accepts a well-formed range and returns the request unchanged", () => {
    const req = { ...base, range: { start: 1.25, end: 4.5 } };
    const out = validateVideoExportRequest(req, "video:export");
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    // Identity matters: the export cache key is exact float equality
    // on start/end, so the validator must not round or rebuild.
    expect(out.value).toBe(req);
  });

  test("rejects a NaN range", () => {
    expect(reject({ ...base, range: { start: NaN, end: NaN } })).toEqual({
      code: "invalid_range",
      message: "video:export: range start/end must be finite"
    });
  });

  test("rejects a half-NaN range", () => {
    expect(reject({ ...base, range: { start: 0, end: NaN } }).code).toBe("invalid_range");
  });

  test("rejects an Infinity range", () => {
    expect(reject({ ...base, range: { start: 0, end: Number.POSITIVE_INFINITY } }).code).toBe(
      "invalid_range"
    );
  });

  test("rejects an inverted range", () => {
    expect(reject({ ...base, range: { start: 8, end: 2 } })).toEqual({
      code: "invalid_range",
      message: "video:export: range end must be > start"
    });
  });

  test("rejects a zero-length range", () => {
    expect(reject({ ...base, range: { start: 3, end: 3 } }).code).toBe("invalid_range");
  });

  test("rejects a negative range", () => {
    expect(reject({ ...base, range: { start: -5, end: 2 } })).toEqual({
      code: "invalid_range",
      message: "video:export: range start/end must be >= 0"
    });
  });

  test("rejects non-numeric range fields", () => {
    expect(reject({ ...base, range: { start: "0", end: "5" } }).code).toBe("invalid_range");
    expect(reject({ ...base, range: null }).code).toBe("invalid_range");
  });

  test("rejects a bad captureId / format / preset", () => {
    expect(reject({ ...base, captureId: "" }).code).toBe("invalid_capture_id");
    expect(reject({ ...base, format: "webm" }).code).toBe("invalid_format");
    expect(reject({ ...base, preset: "ultra" }).code).toBe("invalid_preset");
  });

  test("rejects non-boolean audio toggles", () => {
    expect(
      reject({ ...base, audio: { includeSystemAudio: "yes", includeMicrophone: false } }).code
    ).toBe("invalid_audio");
  });

  test("prefixes messages with the caller's verb", () => {
    const out = validateVideoExportRequest(
      { ...base, range: { start: NaN, end: NaN } },
      "clipboard:copyVideoFile"
    );
    if (out.ok) throw new Error("expected a rejection");
    expect(out.error.message.startsWith("clipboard:copyVideoFile: ")).toBe(true);
  });
});
