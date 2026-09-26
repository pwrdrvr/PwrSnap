// Focused coverage for `video:presetMetrics`. The handler returns
// estimated byte labels before a user clicks an export card, so it
// must stay in lockstep with recording-exporter.ts's MP4 bitrate
// ladder instead of carrying its own stale bitrate model.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  capture: null as CaptureRecord | null,
  lookupExport: vi.fn((_key: unknown): unknown => null),
  readRecordingSettings: vi.fn(async (): Promise<Record<string, unknown>> => ({
    mp4IncludeMicrophone: true,
    mp4IncludeSystemAudio: true
  }))
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
  } as unknown as typeof import("electron").BrowserWindow
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => mocks.capture
}));

vi.mock("../../persistence/video-repo", () => ({
  getVideoMetadata: () => null,
  lookupExport: (key: unknown) => mocks.lookupExport(key),
  normalizeRange: (range: { start: number; end: number }) => range,
  setDefaultRange: () => undefined
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

vi.mock("../../settings/desktop-settings-store", () => ({
  getDesktopSettingsStore: () => ({ readDomain: mocks.readRecordingSettings })
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async (path: string) => path
}));

const { bus } = await import("../../command-bus");
const { registerRecordingHandlers } = await import("../recording-handlers");

registerRecordingHandlers();

function videoCapture(): CaptureRecord {
  return {
    id: "video-metrics",
    kind: "video",
    captured_at: "2026-06-24T12:00:00.000Z",
    legacy_src_path: "/tmp/video-metrics.mp4",
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 1,
    bundle_edits_version: 0,
    width_px: 1681,
    height_px: 946,
    device_pixel_ratio: 1,
    byte_size: 10_000_000,
    sha256: "sha-video-metrics",
    edits_version: 0,
    source_app_bundle_id: null,
    source_app_name: null,
    source_window_title: null,
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
      durationSec: 3,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      requestedSystemAudio: false,
      requestedMicrophone: false,
      defaultRange: { start: 0, end: 3 },
      segments: [{ start: 0, end: 3 }],
      previewPath: null,
      previewStatus: "ready"
    }
  } as CaptureRecord;
}

function withAudio(record: CaptureRecord): CaptureRecord {
  return {
    ...record,
    video: { ...record.video!, hasSystemAudio: true, hasMicrophoneAudio: true }
  } as CaptureRecord;
}

async function mp4Metrics(req: Record<string, unknown>) {
  const result = await bus.dispatch(
    "video:presetMetrics",
    { captureId: "video-metrics", ...req } as never,
    { principal: "ipc" }
  );
  if (!result.ok) throw new Error(result.error.message);
  return new Map(result.value.metrics.map((m) => [`${m.format}-${m.preset}`, m]));
}

function mp4LookupAudio(): unknown[] {
  return mocks.lookupExport.mock.calls
    .map(([key]) => key as { format: string; audio: unknown })
    .filter((key) => key.format === "mp4")
    .map((key) => key.audio);
}

describe("video:presetMetrics", () => {
  beforeEach(() => {
    mocks.capture = videoCapture();
    mocks.lookupExport.mockClear();
    mocks.readRecordingSettings.mockClear();
  });

  // 192 kbps AAC over the 3 s take = 72,000 bytes on top of the video.
  test("the MP4 estimate counts the AAC track only when the choice keeps one", async () => {
    mocks.capture = withAudio(videoCapture());

    const kept = await mp4Metrics({
      audio: { includeSystemAudio: false, includeMicrophone: true }
    });
    expect(kept.get("mp4-low")?.byteSize).toBe(822_000);

    const silent = await mp4Metrics({
      audio: { includeSystemAudio: false, includeMicrophone: false }
    });
    expect(silent.get("mp4-low")?.byteSize).toBe(750_000);
    // GIF never carries audio.
    expect(kept.get("gif-low")?.byteSize).toBe(silent.get("gif-low")?.byteSize);
  });

  test("a cached encode is looked up under the audio choice the grid is showing", async () => {
    mocks.capture = withAudio(videoCapture());

    await mp4Metrics({ audio: { includeSystemAudio: true, includeMicrophone: false } });

    expect(mp4LookupAudio()).toEqual([
      { includeSystemAudio: true, includeMicrophone: false },
      { includeSystemAudio: true, includeMicrophone: false },
      { includeSystemAudio: true, includeMicrophone: false }
    ]);
  });

  test("an omitted audio choice uses the saved MP4 audio preference", async () => {
    mocks.capture = withAudio(videoCapture());
    mocks.readRecordingSettings.mockResolvedValueOnce({
      mp4IncludeMicrophone: false,
      mp4IncludeSystemAudio: false
    });

    const metrics = await mp4Metrics({});

    expect(metrics.get("mp4-low")?.byteSize).toBe(750_000);
    expect(mp4LookupAudio()[0]).toEqual({ includeSystemAudio: false, includeMicrophone: false });
  });

  test("a choice naming a track the take lacks is narrowed, not rejected", async () => {
    // videoCapture() recorded no audio at all.
    await mp4Metrics({ audio: { includeSystemAudio: true, includeMicrophone: true } });

    expect(mp4LookupAudio()[0]).toEqual({ includeSystemAudio: false, includeMicrophone: false });
  });

  test("a malformed audio choice is rejected", async () => {
    const result = await bus.dispatch(
      "video:presetMetrics",
      { captureId: "video-metrics", audio: { includeSystemAudio: "yes" } } as never,
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_audio");
  });

  test("MP4 size estimates follow the encoder bitrate ladder", async () => {
    const result = await bus.dispatch(
      "video:presetMetrics",
      { captureId: "video-metrics" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const byKey = new Map(result.value.metrics.map((m) => [`${m.format}-${m.preset}`, m]));

    expect(byKey.get("mp4-low")?.byteSize).toBe(750_000);
    expect(byKey.get("mp4-med")?.byteSize).toBe(1_875_000);
    expect(byKey.get("mp4-high")?.byteSize).toBe(2_250_000);
    expect(byKey.get("mp4-high")?.widthPx).toBe(1680);
    expect(byKey.get("mp4-high")?.heightPx).toBe(946);
    expect(byKey.get("mp4-high")?.fromCache).toBe(false);
  });
});
