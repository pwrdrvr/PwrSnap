// Nonheaded media integration for cut editing: real FFmpeg against a
// generated recording. No screen capture, Electron or operator data.
//
// The fixture reproduces the one property of a real screen recording that
// the cut path exists to survive — VARIABLE frame rate. Between 2 s and
// 6 s it carries a single frame, held on screen for four seconds, exactly
// what ScreenCaptureKit writes while nothing moves. A span that starts
// inside that stretch has no frame of its own at its start.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoCaptureMetadata, VideoRange } from "@pwrsnap/shared";
import { videoStillSpans } from "@pwrsnap/shared";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: {
  getAppPath: () => resolve("apps/desktop"),
  getPath: () => state.root
} }));
vi.mock("../../persistence/paths", () => ({ getCacheRoot: () => state.root }));
vi.mock("../../persistence/video-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../persistence/video-repo")>()),
  lookupExport: () => null,
  recordExport: () => undefined
}));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));

import { resolveFfmpegPath } from "../ffmpeg-resolver";
import { exportVideoRange } from "../recording-exporter";
import { ensureVideoActivity } from "../video-activity";

const ffmpeg = resolveFfmpegPath();

function run(args: string[]): Buffer {
  return execFileSync(ffmpeg!, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  });
}

function frameCount(path: string): number {
  // `passthrough`: count the frames that are in the file, not the ones a
  // constant-rate output would duplicate into its gaps.
  const bytes = run(["-i", path, "-map", "0:v:0", "-vf", "scale=8:8,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"]);
  return bytes.length / 64;
}

function audioSeconds(path: string): number {
  const bytes = run(["-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);
  return bytes.length / 2 / 8000;
}

const DURATION = 8;
let source: string;

function record(): CaptureRecord {
  return {
    id: "cut-fixture",
    kind: "video",
    legacy_src_path: source,
    width_px: 320,
    height_px: 180
  } as unknown as CaptureRecord;
}

const video: VideoCaptureMetadata = {
  durationSec: DURATION,
  containerFormat: "mp4",
  hasSystemAudio: true,
  hasMicrophoneAudio: false,
  requestedSystemAudio: true,
  requestedMicrophone: false,
  defaultRange: { start: 0, end: DURATION },
  segments: [{ start: 0, end: DURATION }],
  previewPath: null,
  previewStatus: "ready"
};

// Middle span sits wholly inside the held-frame stretch.
const SPANS: VideoRange[] = [
  { start: 0.5, end: 1.5 },
  { start: 3, end: 4 },
  { start: 6.5, end: 7.5 }
];

describe.skipIf(ffmpeg === null)("cut editing through real FFmpeg", () => {
  beforeAll(() => {
    state.root = mkdtempSync(join(tmpdir(), "pwrsnap-video-cuts-"));
    source = join(state.root, "vfr-with-still.mp4");
    // testsrc2 moves every frame; keep 0–2 s and 6–8 s whole, and from the
    // 2–6 s stretch keep only the frame at 2 s. `passthrough` preserves the
    // gap instead of re-duplicating frames into it.
    run([
      "-f", "lavfi", "-i", `testsrc2=s=320x180:r=20:d=${DURATION}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
      "-vf", "select='lt(t\\,2)+gte(t\\,6)+eq(n\\,40)'",
      "-fps_mode", "passthrough",
      "-map", "0:v", "-map", "1:a", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac",
      source
    ]);
  }, 30_000);
  afterAll(() => {
    if (state.root) rmSync(state.root, { recursive: true, force: true });
  });

  test("the fixture really is variable-frame-rate", () => {
    // 40 + 1 + 40 frames, not 160.
    expect(frameCount(source)).toBe(81);
  });

  test("activity analysis finds the held-frame stretch and nothing else", async () => {
    const { track } = await ensureVideoActivity(record(), video);
    expect(track.sampleHz).toBe(5);
    const still = videoStillSpans(track, { minStillSec: 1 });
    expect(still).toHaveLength(1);
    expect(still[0]!.start).toBeCloseTo(2, 0);
    expect(still[0]!.end).toBeCloseTo(6, 0);
    // Cached: a second call reads the file rather than re-running ffmpeg.
    const again = await ensureVideoActivity(record(), video);
    expect(again.track.magnitudes).toEqual(track.magnitudes);
  }, 30_000);

  test("a cut GIF runs exactly the kept length, including the span inside the still", async () => {
    const result = await exportVideoRange({
      record: record(),
      video,
      format: "gif",
      preset: "low",
      range: { start: SPANS[0]!.start, end: SPANS[2]!.end },
      spans: SPANS,
      audio: { includeSystemAudio: false, includeMicrophone: false }
    });
    expect(result.durationSec).toBeCloseTo(3, 3);
    expect(result.path).toMatch(/\.c[0-9a-f]{12}\.low\.silent\.gif$/);
    // LOW is 15 fps: three one-second spans are 45 frames. An accurate
    // per-span seek would have opened the middle span on the NEXT frame
    // after the still (6 s) and lost it entirely — ~30 frames.
    expect(frameCount(result.path)).toBeGreaterThanOrEqual(44);
    expect(frameCount(result.path)).toBeLessThanOrEqual(46);
  }, 60_000);

  describe.skipIf(process.platform !== "darwin" && process.platform !== "win32")("MP4", () => {
    test("a cut MP4 keeps picture and sound the same length", async () => {
      const result = await exportVideoRange({
        record: record(),
        video,
        format: "mp4",
        preset: "low",
        range: { start: SPANS[0]!.start, end: SPANS[2]!.end },
        spans: SPANS,
        audio: { includeSystemAudio: true, includeMicrophone: false }
      });
      expect(result.durationSec).toBeCloseTo(3, 3);
      // 60 fps constant: 180 frames for 3 s.
      expect(frameCount(result.path)).toBe(180);
      expect(audioSeconds(result.path)).toBeCloseTo(3, 1);
    }, 60_000);
  });
});
