// Focused coverage for `video:presetMetrics`. The handler returns
// estimated byte labels before a user clicks an export card, so it
// must stay in lockstep with recording-exporter.ts's MP4 bitrate
// ladder instead of carrying its own stale bitrate model.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  capture: null as CaptureRecord | null
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
  lookupExport: () => null,
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
      defaultRange: { start: 0, end: 3 },
      previewPath: null,
      previewStatus: "ready"
    }
  } as CaptureRecord;
}

describe("video:presetMetrics", () => {
  beforeEach(() => {
    mocks.capture = videoCapture();
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
