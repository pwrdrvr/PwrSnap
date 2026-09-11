// Nonheaded media integration: real FFmpeg, real generated tones and decoded
// PCM measurements. No microphone, screen capture, Electron or operator data.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoCaptureMetadata, VideoExportAudio } from "@pwrsnap/shared";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: {
  getAppPath: () => resolve("apps/desktop"),
  getPath: () => state.root
} }));
vi.mock("../../persistence/paths", () => ({ getCacheRoot: () => join(state.root, "render-cache") }));
vi.mock("../../persistence/video-repo", () => ({ lookupExport: () => null, recordExport: () => undefined }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));

import { resolveFfmpegPath } from "../ffmpeg-resolver";
import { probeAudioStreamCount } from "../recording-audio";
import { exportVideoRange } from "../recording-exporter";
import { extractVideoAudio, prepareVideoPlayback } from "../../sizzle/audio-extract";

const ffmpeg = resolveFfmpegPath();
if (process.env.PWRSNAP_REQUIRE_AUDIO_FFMPEG === "1" && ffmpeg === null) {
  throw new Error("Real audio verification requires PWRSNAP_FFMPEG_PATH or ffmpeg on PATH");
}
function run(args: string[]): Buffer {
  return execFileSync(ffmpeg!, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 20_000, maxBuffer: 16 * 1024 * 1024
  });
}
function pcm(path: string): Float32Array {
  const bytes = run(["-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]);
  const samples = new Float32Array(bytes.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
  return samples;
}
function magnitude(samples: Float32Array, frequency: number, start = 0.2, duration = 0.4): number {
  let sin = 0;
  let cos = 0;
  const first = Math.round(start * 48000);
  const count = Math.round(duration * 48000);
  expect(samples.length).toBeGreaterThanOrEqual(first + count);
  for (let i = 0; i < count; i++) {
    const angle = 2 * Math.PI * frequency * i / 48000;
    sin += samples[first + i]! * Math.sin(angle);
    cos += samples[first + i]! * Math.cos(angle);
  }
  return 2 * Math.hypot(sin, cos) / count;
}
function expectTones(path: string, system: boolean, mic: boolean): void {
  const samples = pcm(path);
  for (const [frequency, present] of [[440, system], [880, mic]] as const) {
    const amplitude = magnitude(samples, frequency);
    if (present) expect(amplitude, `${frequency} Hz should be audible`).toBeGreaterThan(0.02);
    else expect(amplitude, `${frequency} Hz should be absent`).toBeLessThan(0.003);
  }
}

let source: string;
let systemOnly: string;
let micOnly: string;
let silent: string;
const dual = { hasSystemAudio: true, hasMicrophoneAudio: true };
const video: VideoCaptureMetadata = {
  ...dual, durationSec: 2.4, containerFormat: "mp4",
  defaultRange: { start: 0, end: 2.4 }, previewPath: null, previewStatus: "ready"
};

// Extraction and playback use native codecs and run on any ffmpeg host.
// MP4 export itself uses the shipped platform H.264 encoder, so only that
// sub-suite is platform-gated. Linux cannot execute VideoToolbox or MF.
describe.skipIf(ffmpeg === null)("recorded audio through real FFmpeg", () => {
  beforeAll(() => {
    state.root = mkdtempSync(join(tmpdir(), "pwrsnap-recorded-audio-"));
    source = join(state.root, "system-and-mic.mp4");
    systemOnly = join(state.root, "system-only.mp4");
    micOnly = join(state.root, "mic-only.mp4");
    silent = join(state.root, "silent.mp4");
    run([
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=20:d=2.4",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2.4",
      "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1.5",
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "mpeg4", "-c:a", "aac",
      "-ac:a:0", "2", "-b:a", "192k", source
    ]);
    run(["-i", source, "-map", "0:v", "-map", "0:a:0", "-c", "copy", systemOnly]);
    run(["-i", source, "-map", "0:v", "-map", "0:a:1", "-c", "copy", micOnly]);
    run(["-i", source, "-map", "0:v", "-c", "copy", "-an", silent]);
  }, 30_000);
  afterAll(() => { if (state.root) rmSync(state.root, { recursive: true, force: true }); });

  test("detects actual streams without requiring ffprobe", async () => {
    expect(await probeAudioStreamCount(source)).toBe(2);
    expect(await probeAudioStreamCount(systemOnly)).toBe(1);
    expect(await probeAudioStreamCount(silent)).toBe(0);
  });

  test("native extraction mixes both tones into one AAC stream over the requested trim", async () => {
    const path = await extractVideoAudio({ videoPath: source, ...dual, startSec: 0.75, durationSec: 1 });
    expect(await probeAudioStreamCount(path)).toBe(1);
    expectTones(path, true, true);
    expect(pcm(path).length / 48000).toBeCloseTo(1, 1);
  });

  test("native extraction supports mic-only and stale dual metadata", async () => {
    const mic = await extractVideoAudio({ videoPath: micOnly, hasSystemAudio: false, hasMicrophoneAudio: true, startSec: 0.75, durationSec: 1 });
    expectTones(mic, false, true);
    const old = await extractVideoAudio({ videoPath: systemOnly, ...dual, startSec: 0.75, durationSec: 1 });
    expectTones(old, true, false);
    const none = await extractVideoAudio({ videoPath: silent, ...dual, startSec: 0.75, durationSec: 1 });
    expectTones(none, false, false);
  });

  test("playback copies video packets, mixes delayed mic at the right time, and retains system tail", async () => {
    const path = await prepareVideoPlayback({ captureId: "fixture", videoPath: source, ...dual });
    expect(path).not.toBe(source);
    expect(await probeAudioStreamCount(path)).toBe(1);
    // A byte-identical elementary video stream proves -c:v copy really ran.
    const elementary = (p: string) => run(["-i", p, "-map", "0:v:0", "-c:v", "copy", "-f", "data", "pipe:1"]);
    expect(elementary(path)).toEqual(elementary(source));
    const samples = pcm(path);
    expect(magnitude(samples, 880, 0.1, 0.2)).toBeLessThan(0.003);
    expect(magnitude(samples, 440, 0.8, 0.4)).toBeGreaterThan(0.02);
    expect(magnitude(samples, 880, 0.8, 0.4)).toBeGreaterThan(0.02);
    expect(magnitude(samples, 440, 2.1, 0.2)).toBeGreaterThan(0.02);
    expect(magnitude(samples, 880, 2.1, 0.2)).toBeLessThan(0.003);
    expect(await prepareVideoPlayback({ captureId: "fixture", videoPath: source, ...dual })).toBe(path);
  });

  test("playback returns original for single, silent or stale dual recordings", async () => {
    expect(await prepareVideoPlayback({ captureId: "fixture", videoPath: micOnly, hasSystemAudio: false, hasMicrophoneAudio: true })).toBe(micOnly);
    expect(await prepareVideoPlayback({ captureId: "fixture", videoPath: systemOnly, ...dual })).toBe(systemOnly);
    expect(await prepareVideoPlayback({ captureId: "fixture", videoPath: silent, ...dual })).toBe(silent);
  });

  test("playback invalidates a derivative after the source revision changes", async () => {
    const first = await prepareVideoPlayback({ captureId: "fixture", videoPath: source, ...dual });
    const info = await stat(source);
    await utimes(source, info.atime, new Date(info.mtimeMs + 2000));
    const next = await prepareVideoPlayback({ captureId: "fixture", videoPath: source, ...dual });
    expect(next).not.toBe(first);
    expect(await probeAudioStreamCount(next)).toBe(1);
  });

  describe.skipIf(process.platform !== "darwin" && process.platform !== "win32")("MP4 exports", () => {
    test.each([
      ["both", true, true, "dual"],
      ["system", true, false, "dual"],
      ["mic", false, true, "dual"],
      ["silent", false, false, "dual"],
      ["mic-only", false, true, "mic-only"],
      ["stale-both", true, true, "system-only"],
      ["stale-mic", false, true, "system-only"],
      ["stale-silent", true, true, "silent"]
    ])("exports %s selection", async (name, system, mic, fixture) => {
      // Fixtures are created in beforeAll, so resolve names here.
      const path = fixture === "system-only" ? systemOnly : fixture === "silent" ? silent : fixture === "mic-only" ? micOnly : source;
      const audio: VideoExportAudio = { includeSystemAudio: system, includeMicrophone: mic };
      const result = await exportVideoRange({
        record: { id: name, kind: "video", legacy_src_path: path, width_px: 160, height_px: 90 } as CaptureRecord,
        video: { ...video, hasSystemAudio: fixture !== "mic-only" }, format: "mp4", preset: "high", range: { start: 0.75, end: 1.75 }, audio
      });
      const expectSystem = system && fixture !== "silent";
      const expectMic = mic && fixture !== "system-only" && fixture !== "silent";
      expect(await probeAudioStreamCount(result.path)).toBe(expectSystem || expectMic ? 1 : 0);
      if (expectSystem || expectMic) expectTones(result.path, expectSystem, expectMic);
    });
  });
});
