// `video:edit` / `video:inspect` — the verbs behind the Library timeline
// and BOTH agent surfaces (MCP `pwrsnap_video_*`, chat `*_video`). What
// is pinned here is the contract the tools teach: exactly one op, source
// seconds, never an empty edit, a broadcast on every write, and an
// inspect that still answers when the activity analysis cannot run.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoRange } from "@pwrsnap/shared";
import { encodeActivityMagnitude, videoSegmentsOrFull } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  segments: [] as VideoRange[],
  broadcasts: [] as string[][],
  activity: null as null | { sampleHz: number; magnitudes: number[] },
  activityError: null as Error | null
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  systemPreferences: {
    getMediaAccessStatus: () => "granted"
  } as unknown as typeof import("electron").systemPreferences,
  shell: { openExternal: async () => undefined } as unknown as typeof import("electron").shell,
  BrowserWindow: { getAllWindows: () => [] } as unknown as typeof import("electron").BrowserWindow
}));

const DURATION = 20;

function capture(): CaptureRecord {
  const segments = mocks.segments;
  return {
    id: "vid",
    kind: "video",
    captured_at: "2026-09-22T12:00:00.000Z",
    legacy_src_path: "/tmp/vid.mp4",
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 1,
    bundle_edits_version: 0,
    width_px: 1280,
    height_px: 720,
    device_pixel_ratio: 1,
    byte_size: 1,
    sha256: "sha",
    edits_version: 0,
    source_app_bundle_id: null,
    source_app_name: null,
    source_window_title: null,
    has_alpha: false,
    deleted_at: null,
    video: {
      durationSec: DURATION,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      requestedSystemAudio: false,
      requestedMicrophone: false,
      defaultRange: { start: segments[0]!.start, end: segments[segments.length - 1]!.end },
      segments,
      previewPath: null,
      previewStatus: "ready"
    }
  } as unknown as CaptureRecord;
}

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: (id: string) => (id === "vid" ? capture() : null)
}));

vi.mock("../../persistence/video-repo", () => ({
  getVideoMetadata: () => null,
  lookupExport: () => null,
  normalizeRange: (range: VideoRange) => range,
  setDefaultRange: () => undefined,
  setVideoSegments: (_id: string, next: VideoRange[]) => {
    mocks.segments = videoSegmentsOrFull(next, DURATION);
    return mocks.segments;
  }
}));

vi.mock("../../events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../events")>()),
  broadcastCapturesChanged: (ids: string[]) => {
    mocks.broadcasts.push(ids);
  }
}));

vi.mock("../../recording/video-activity", () => ({
  ensureVideoActivity: async () => {
    if (mocks.activityError !== null) throw mocks.activityError;
    return { track: mocks.activity, width: 192, height: 108 };
  }
}));

vi.mock("../../recording/recording-service", () => ({
  getRecordingService: () => ({ isActive: () => false })
}));

const { bus } = await import("../../command-bus");
const { registerRecordingHandlers } = await import("../recording-handlers");
registerRecordingHandlers();

const ipc = { principal: "ipc" } as const;

// 5 Hz: busy 0–2 s, still 2–10 s, busy 10–11 s, still 11–20 s.
function track(): { sampleHz: number; magnitudes: number[] } {
  const busy = encodeActivityMagnitude(0.5);
  return {
    sampleHz: 5,
    magnitudes: [
      ...Array(10).fill(busy),
      ...Array(40).fill(0),
      ...Array(5).fill(busy),
      ...Array(45).fill(0)
    ]
  };
}

beforeEach(() => {
  mocks.segments = [{ start: 0, end: DURATION }];
  mocks.broadcasts = [];
  mocks.activity = track();
  mocks.activityError = null;
});

describe("video:edit", () => {
  test("keep replaces the edit, normalized, and broadcasts", async () => {
    const result = await bus.dispatch(
      "video:edit",
      { captureId: "vid", keep: [{ start: 12, end: 15 }, { start: 1, end: 4 }] },
      ipc
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.segments).toEqual([
      { start: 1, end: 4 },
      { start: 12, end: 15 }
    ]);
    expect(result.value.keptDurationSec).toBe(6);
    expect(result.value.cuts).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 12 },
      { start: 15, end: 20 }
    ]);
    expect(mocks.broadcasts).toEqual([["vid"]]);
  });

  test("cut composes with the current edit", async () => {
    await bus.dispatch("video:edit", { captureId: "vid", cut: [{ start: 5, end: 8 }] }, ipc);
    const result = await bus.dispatch(
      "video:edit",
      { captureId: "vid", cut: [{ start: 15, end: 25 }] },
      ipc
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.spans).toEqual([
      { start: 0, end: 5 },
      { start: 8, end: 15 }
    ]);
  });

  test("cutStill removes the still stretches with padding", async () => {
    const result = await bus.dispatch(
      "video:edit",
      { captureId: "vid", cutStill: { minStillSec: 5, paddingSec: 0.5 } },
      ipc
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.spans).toEqual([
      { start: 0, end: 2.5 },
      { start: 9.5, end: 11.5 }
    ]);
    expect(result.value.keptDurationSec).toBe(4.5);
  });

  test("reset restores the whole clip", async () => {
    mocks.segments = [{ start: 3, end: 6 }];
    const result = await bus.dispatch("video:edit", { captureId: "vid", reset: true }, ipc);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.segments).toEqual([{ start: 0, end: DURATION }]);
  });

  test.each([
    [{}, "invalid_edit"],
    [{ reset: true, cut: [{ start: 1, end: 2 }] }, "invalid_edit"],
    [{ keep: [] }, "invalid_segments"],
    [{ keep: [{ start: 3, end: 2 }] }, "invalid_segments"],
    [{ keep: [{ start: 30, end: 40 }] }, "invalid_segments"],
    [{ cut: [{ start: 0, end: DURATION }] }, "invalid_segments"],
    [{ cut: [{ start: Number.NaN, end: 2 }] }, "invalid_segments"]
  ])("rejects %j with %s and writes nothing", async (op, code) => {
    const result = await bus.dispatch("video:edit", { captureId: "vid", ...op }, ipc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(mocks.broadcasts).toEqual([]);
    expect(mocks.segments).toEqual([{ start: 0, end: DURATION }]);
  });

  test("an unknown capture is not_found", async () => {
    const result = await bus.dispatch("video:edit", { captureId: "nope", reset: true }, ipc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("video:inspect", () => {
  test("summarizes the edit and the activity", async () => {
    const result = await bus.dispatch(
      "video:inspect",
      { captureId: "vid", minStillSec: 5, includeTrack: true },
      ipc
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.keptDurationSec).toBe(DURATION);
    expect(result.value.activity?.stillSpans).toEqual([
      { start: 2, end: 10, durationSec: 8 },
      { start: 11, end: 20, durationSec: 9 }
    ]);
    expect(result.value.activity?.stillTotalSec).toBe(17);
    expect(result.value.activity?.runs.map((r) => r.level)).toEqual([3, 0, 3, 0]);
    expect(result.value.activity?.track).toHaveLength(100);
    expect(result.value.activity?.levels["0"]).toContain("still");
  });

  test("omits the dense track unless asked", async () => {
    const result = await bus.dispatch("video:inspect", { captureId: "vid" }, ipc);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.activity).not.toHaveProperty("track");
  });

  test("still answers with the edit when analysis fails", async () => {
    mocks.activityError = new Error("ffmpeg not found");
    const result = await bus.dispatch("video:inspect", { captureId: "vid" }, ipc);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.activity).toBeNull();
    expect(result.value.activityError).toContain("ffmpeg");
    expect(result.value.segments).toEqual([{ start: 0, end: DURATION }]);
  });
});
