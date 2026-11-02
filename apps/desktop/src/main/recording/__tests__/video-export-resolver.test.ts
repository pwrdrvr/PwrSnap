// Unit tests for the shared `mapVideoResolveError` mapper. The
// three error kinds × the three video-aware verb labels produce 9
// distinct user-facing strings; this file locks the shape so
// rephrasing the messages stays a deliberate code change.

import { describe, expect, test, vi } from "vitest";
import { resolveVideoExport, mapVideoResolveError } from "../video-export-resolver";

describe("mapVideoResolveError", () => {
  test("not_found error includes verb + captureId in message", () => {
    const out = mapVideoResolveError(
      { kind: "not_found" },
      "video:prepareDrag",
      "cap_abc"
    );
    expect(out).toEqual({
      kind: "validation",
      code: "not_found",
      message: "video:prepareDrag: capture not found: cap_abc"
    });
  });

  test("not_a_video error includes verb + captureId in message", () => {
    const out = mapVideoResolveError(
      { kind: "not_a_video" },
      "clipboard:copyVideoFile",
      "cap_img"
    );
    expect(out).toEqual({
      kind: "validation",
      code: "not_a_video",
      message: "clipboard:copyVideoFile: capture cap_img is not a video"
    });
  });

  test("audio_track_missing reports system vs microphone distinctly", () => {
    const sys = mapVideoResolveError(
      { kind: "audio_track_missing", track: "system" },
      "clipboard:copyVideoPath",
      "cap_a"
    );
    expect(sys.code).toBe("audio_track_missing");
    expect(sys.message).toBe(
      "clipboard:copyVideoPath: cannot include system audio — source recording has no system track"
    );

    const mic = mapVideoResolveError(
      { kind: "audio_track_missing", track: "microphone" },
      "clipboard:copyVideoPath",
      "cap_a"
    );
    expect(mic.code).toBe("audio_track_missing");
    expect(mic.message).toBe(
      "clipboard:copyVideoPath: cannot include microphone — source recording has no microphone track"
    );
  });

  test("verb label flows through verbatim — supports future verbs without rewiring", () => {
    const out = mapVideoResolveError(
      { kind: "not_found" },
      "future:newVerb",
      "x"
    );
    expect(out.message).toBe("future:newVerb: capture not found: x");
  });

  test("returned shape always has kind=validation so bus envelope is uniform", () => {
    const kinds = [
      { kind: "not_found" as const },
      { kind: "not_a_video" as const },
      { kind: "audio_track_missing" as const, track: "system" as const }
    ];
    for (const k of kinds) {
      const out = mapVideoResolveError(k, "v", "c");
      expect(out.kind).toBe("validation");
    }
  });
});

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => ({ id: "vid", kind: "video", deleted_at: null, video: { durationSec: 10, segments: [{ start: 0, end: 10 }] } })
}));
const exporter = vi.hoisted(() => vi.fn());
vi.mock("../recording-exporter", () => ({ exportVideoRange: exporter }));
test("clipboard/drag resolver refuses empty normalized segments before encoding", async () => {
  const result = await resolveVideoExport({ captureId: "vid", format: "mp4", preset: "med", segments: [{ start: 100, end: 101 }] });
  expect(result).toMatchObject({ ok: false, error: { kind: "invalid_segments" } });
  expect(exporter).not.toHaveBeenCalled();
  if (!result.ok) expect(mapVideoResolveError(result.error, "clipboard:copyVideoFile", "vid")).toMatchObject({ kind: "validation", code: "invalid_segments" });
});
