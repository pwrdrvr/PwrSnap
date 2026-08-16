// Bus-level coverage for the timeline verbs added by the video
// transport + trim work (plan 2026-08-15-001):
//
//   • video:setDefaultRange — normalizes, persists, and broadcasts
//     `events:captures:changed` so the Library revalidates the record.
//   • video:frames — validates, delegates to the contact-strip
//     extractor, and returns a `pwrsnap-cache://v/…` URL + geometry.
//   • video:audio — short-circuits to `{ hasAudio: false }` for silent
//     recordings without spawning ffmpeg; mirrors the m4a otherwise.
//   • video:presetMetrics — size estimates re-derive from the persisted
//     range duration (a trimmed clip estimates smaller).
//
// ffmpeg, better-sqlite3, and the recorder are all mocked.

import { rm, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoRange } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  capture: null as CaptureRecord | null,
  setDefaultRange: vi.fn((_: string, range: VideoRange) => range),
  broadcast: vi.fn(),
  ensureVideoFrames: vi.fn(),
  extractVideoAudio: vi.fn()
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  systemPreferences: {
    getMediaAccessStatus: () => "granted"
  } as unknown as typeof import("electron").systemPreferences,
  shell: {
    openExternal: async () => undefined
  } as unknown as typeof import("electron").shell,
  BrowserWindow: {
    getAllWindows: () => []
  } as unknown as typeof import("electron").BrowserWindow,
  app: {
    getPath: () => "/tmp/pwrsnap-test-userdata"
  } as unknown as typeof import("electron").app
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => mocks.capture
}));

vi.mock("../../persistence/video-repo", () => ({
  getVideoMetadata: () => mocks.capture?.video ?? null,
  lookupExport: () => null,
  normalizeRange: (range: VideoRange, durationSec: number) => {
    const start = Math.max(0, Math.min(range.start, durationSec));
    const end = Math.max(start, Math.min(range.end, durationSec));
    return { start, end };
  },
  setDefaultRange: mocks.setDefaultRange
}));

vi.mock("../../events", () => ({
  broadcastCapturesChanged: mocks.broadcast
}));

vi.mock("../../recording/video-frames", () => ({
  ensureVideoFrames: mocks.ensureVideoFrames,
  videoAssetDir: (id: string) => `/tmp/pwrsnap-test-cache/video/${id}`
}));

vi.mock("../../sizzle/audio-extract", () => ({
  extractVideoAudio: mocks.extractVideoAudio
}));

vi.mock("../../recording/recording-service", () => ({
  getRecordingService: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    restart: vi.fn(),
    isActive: () => false
  })
}));

vi.mock("../../recording/video-poster", () => ({
  ensureVideoPoster: async () => "/tmp/poster.png"
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async (path: string) => path
}));

const { bus } = await import("../../command-bus");
const { registerRecordingHandlers } = await import("../recording-handlers");

registerRecordingHandlers();

function videoCapture(overrides: Partial<NonNullable<CaptureRecord["video"]>> = {}): CaptureRecord {
  return {
    id: "vid_Timeline1",
    kind: "video",
    captured_at: "2026-08-15T12:00:00.000Z",
    legacy_src_path: "/tmp/vid_Timeline1.mp4",
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 1,
    bundle_edits_version: 0,
    width_px: 1920,
    height_px: 1080,
    device_pixel_ratio: 1,
    byte_size: 10_000_000,
    sha256: "sha-timeline",
    edits_version: 0,
    source_app_bundle_id: null,
    source_app_name: null,
    has_alpha: false,
    deleted_at: null,
    app_id: null,
    title: null,
    description: null,
    filename: null,
    notes: null,
    rating: null,
    starred: 0,
    archived: 0,
    pinned: 0,
    video: {
      durationSec: 16,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      defaultRange: { start: 0, end: 16 },
      previewPath: null,
      previewStatus: "ready",
      ...overrides
    }
  } as CaptureRecord;
}

beforeEach(async () => {
  mocks.capture = videoCapture();
  mocks.setDefaultRange.mockClear();
  mocks.broadcast.mockClear();
  mocks.ensureVideoFrames.mockReset();
  mocks.extractVideoAudio.mockReset();
  await rm("/tmp/pwrsnap-test-cache/video/vid_Timeline1", { recursive: true, force: true });
});

describe("video:setDefaultRange", () => {
  test("persists the normalized range and broadcasts captures:changed", async () => {
    const result = await bus.dispatch(
      "video:setDefaultRange",
      { captureId: "vid_Timeline1", range: { start: 3.4, end: 11.2 } },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    expect(mocks.setDefaultRange).toHaveBeenCalledWith("vid_Timeline1", { start: 3.4, end: 11.2 });
    expect(mocks.broadcast).toHaveBeenCalledWith(["vid_Timeline1"]);
  });

  test("clamps an out-of-bounds range to the clip before persisting", async () => {
    const result = await bus.dispatch(
      "video:setDefaultRange",
      { captureId: "vid_Timeline1", range: { start: -1, end: 99 } },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    expect(mocks.setDefaultRange).toHaveBeenCalledWith("vid_Timeline1", { start: 0, end: 16 });
  });

  test("rejects non-finite ranges and image captures without touching the repo", async () => {
    const bad = await bus.dispatch(
      "video:setDefaultRange",
      { captureId: "vid_Timeline1", range: { start: Number.NaN, end: 2 } },
      { principal: "ipc" }
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected error");
    expect(bad.error.code).toBe("invalid_range");

    mocks.capture = { ...videoCapture(), kind: "image", video: null } as CaptureRecord;
    const img = await bus.dispatch(
      "video:setDefaultRange",
      { captureId: "vid_Timeline1", range: { start: 0, end: 1 } },
      { principal: "ipc" }
    );
    expect(img.ok).toBe(false);
    if (img.ok) throw new Error("expected error");
    expect(img.error.code).toBe("not_a_video");
    expect(mocks.setDefaultRange).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  test("rejects inverted and too-short ranges without persisting a zero-length default", async () => {
    for (const range of [
      { start: 10, end: 2 },
      { start: 4, end: 4.05 }
    ]) {
      const result = await bus.dispatch(
        "video:setDefaultRange",
        { captureId: "vid_Timeline1", range },
        { principal: "ipc" }
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("invalid_range");
    }
    expect(mocks.setDefaultRange).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});

describe("video:frames", () => {
  test("returns a v/ cache URL plus the strip geometry from the extractor", async () => {
    mocks.ensureVideoFrames.mockResolvedValue({
      path: "/tmp/pwrsnap-test-cache/video/vid_Timeline1/frames-n24-w96.jpg",
      fileName: "frames-n24-w96.jpg",
      spec: { count: 24, frameWidth: 96, frameHeight: 54 }
    });
    const result = await bus.dispatch(
      "video:frames",
      { captureId: "vid_Timeline1", count: 24, frameWidth: 96 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toEqual({
      url: "pwrsnap-cache://v/vid_Timeline1/frames-n24-w96.jpg",
      frameCount: 24,
      frameWidth: 96,
      frameHeight: 54
    });
    expect(mocks.ensureVideoFrames).toHaveBeenCalledWith(
      expect.objectContaining({ id: "vid_Timeline1" }),
      expect.objectContaining({ durationSec: 16 }),
      { count: 24, frameWidth: 96 }
    );
  });

  test("maps extractor failures to a render error", async () => {
    mocks.ensureVideoFrames.mockRejectedValue(new Error("ffmpeg exited 1"));
    const result = await bus.dispatch(
      "video:frames",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("render");
    expect(result.error.code).toBe("video_frames_failed");
  });

  test("rejects a non-finite count", async () => {
    const result = await bus.dispatch(
      "video:frames",
      { captureId: "vid_Timeline1", count: Number.POSITIVE_INFINITY },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    expect(mocks.ensureVideoFrames).not.toHaveBeenCalled();
  });
});

describe("video:audio", () => {
  test("silent recordings return hasAudio:false without extracting", async () => {
    const result = await bus.dispatch(
      "video:audio",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toEqual({ hasAudio: false });
    expect(mocks.extractVideoAudio).not.toHaveBeenCalled();
  });

  test("extraction failure maps to a render error", async () => {
    mocks.capture = videoCapture({ hasSystemAudio: true });
    mocks.extractVideoAudio.mockRejectedValue(new Error("boom"));
    const result = await bus.dispatch(
      "video:audio",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("video_audio_failed");
    expect(mocks.extractVideoAudio).toHaveBeenCalledWith({
      videoPath: "/tmp/vid_Timeline1.mp4",
      startSec: 0,
      durationSec: 16
    });
  });

  test("joins concurrent extraction requests for the same capture", async () => {
    mocks.capture = videoCapture({ hasSystemAudio: true });
    const extracted = `/tmp/video-audio-${Date.now().toString(36)}.m4a`;
    let finishExtraction: ((path: string) => void) | undefined;
    mocks.extractVideoAudio.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishExtraction = resolve;
        })
    );

    const first = bus.dispatch(
      "video:audio",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    await vi.waitFor(() => expect(mocks.extractVideoAudio).toHaveBeenCalledTimes(1));
    const second = bus.dispatch(
      "video:audio",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    await Promise.resolve();
    expect(mocks.extractVideoAudio).toHaveBeenCalledTimes(1);

    await writeFile(extracted, "audio");
    if (finishExtraction === undefined) throw new Error("extraction did not start");
    finishExtraction(extracted);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(mocks.extractVideoAudio).toHaveBeenCalledTimes(1);
    await rm(extracted, { force: true });
    await rm("/tmp/pwrsnap-test-cache/video/vid_Timeline1", { recursive: true, force: true });
  });
});

describe("video:presetMetrics honors the persisted range", () => {
  test("a trimmed defaultRange yields proportionally smaller MP4 estimates", async () => {
    const full = await bus.dispatch(
      "video:presetMetrics",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    mocks.capture = videoCapture({ defaultRange: { start: 4, end: 12 } });
    const trimmed = await bus.dispatch(
      "video:presetMetrics",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    if (!full.ok || !trimmed.ok) throw new Error("expected ok");
    const fullMed = full.value.metrics.find((m) => m.format === "mp4" && m.preset === "med")!;
    const trimMed = trimmed.value.metrics.find((m) => m.format === "mp4" && m.preset === "med")!;
    expect(trimMed.byteSize).toBe(fullMed.byteSize / 2);
  });
});
