// Nonheaded integration: real mask/composition/export FFmpeg and contrived
// screen/audio. Only camera decoding/segmentation is replaced with stamped PNGs.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { DEFAULT_AVATAR_STYLE, type CaptureRecord, type VideoRange } from "@pwrsnap/shared";

const state = vi.hoisted(() => ({ root: "", times: [] as number[] }));
vi.mock("electron", () => ({ app: { getAppPath: () => resolve("apps/desktop"), getPath: () => state.root } }));
vi.mock("../../persistence/paths", () => ({ getCacheRoot: () => state.root }));
vi.mock("../../persistence/video-repo", () => ({ lookupExport: () => null, recordExport: () => undefined }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock("../camera-worker", () => ({ CameraWorker: class {
  async load() {}
  async call(name: string, time: number, width: number, height: number) {
    if (name !== "frame") return undefined;
    state.times.push(time);
    const pixels = Buffer.alloc(width * 2 * height * 3, 255);
    // Camera time < 1 is red; >= 1 is green. The confidence half is white.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width * 2 + x) * 3;
      pixels[offset] = time < 1 ? 255 : 0;
      pixels[offset + 1] = time < 1 ? 0 : 255;
      pixels[offset + 2] = 0;
    }
    return (await sharp(pixels, { raw: { width: width * 2, height, channels: 3 } }).png().toBuffer()).toString("base64");
  }
  close() {}
} }));
import { resolveFfmpegPath } from "../ffmpeg-resolver";
import { exportVideoRange, GIF_PRESETS } from "../recording-exporter";
import { probeAudioStreamCount } from "../recording-audio";
import { withDerivedCacheCleanup } from "../../persistence/derived-cache-gate";
const ffmpeg = resolveFfmpegPath();
function run(args: string[]) {
  return execFileSync(ffmpeg!, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
}
function decodedFrames(path: string): Buffer[] {
  const bytes = run(["-i", path, "-map", "0:v:0", "-vf", "scale=160:90", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  const size = 160 * 90 * 3;
  return Array.from({ length: bytes.length / size }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
}
function expectColor(frame: Buffer, channel: number) {
  const offset = (30 * 160 + 100) * 3; // inside presenter when visible
  expect(frame[offset + channel]).toBeGreaterThan(180);
  for (let c = 0; c < 3; c++) if (c !== channel) expect(frame[offset + c]).toBeLessThan(65);
}
function tone(path: string, frequency: number): number {
  const bytes = run(["-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]);
  let sin = 0, cos = 0;
  const count = 12000, first = 4800;
  expect(bytes.length / 4).toBeGreaterThanOrEqual(first + count);
  for (let i = 0; i < count; i++) {
    const value = bytes.readFloatLE((first + i) * 4);
    sin += value * Math.sin(2 * Math.PI * frequency * i / 48000);
    cos += value * Math.cos(2 * Math.PI * frequency * i / 48000);
  }
  return 2 * Math.hypot(sin, cos) / count;
}
function record(id: string, offset: number, sync: number): CaptureRecord {
  return {
    id, kind: "video", legacy_src_path: join(state.root, "screen.mp4"),
    width_px: 160, height_px: 90, sha256: "a".repeat(64), deleted_at: null,
    video: {
      durationSec: 4, containerFormat: "mp4", hasSystemAudio: true, hasMicrophoneAudio: true,
      camera: { version: 1, durationSec: 4, offsetSec: offset, width: 40, height: 40, sha256: "b".repeat(64), mimeType: "video/mp4" },
      avatar: { ...DEFAULT_AVATAR_STYLE, crop: { x: 0, y: 0, width: 1, height: 1 }, x: 0.5, y: 0.2, width: 0.25, mirror: false, edge: 0, syncOffsetSec: sync }
    }
  } as CaptureRecord;
}

describe.skipIf(ffmpeg === null)("presenter prefixes through real FFmpeg", () => {
  beforeAll(async () => {
    state.root = await mkdtemp(join(tmpdir(), "pwrsnap-presenter-prefix-"));
    run([
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=20:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=4",
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "mpeg4", "-c:a", "aac", join(state.root, "screen.mp4")
    ]);
  });
  afterAll(async () => {
    await withDerivedCacheCleanup("all", async () => { if (state.root) await rm(state.root, { recursive: true, force: true }); });
  });

  const formats = process.platform === "darwin" || process.platform === "win32" ? ["mp4", "gif"] as const : ["gif"] as const;
  test.each(formats)("%s prefix preserves playable duration, offset timing, cuts and audio selection", async (format) => {
    for (const negative of [false, true]) for (const cut of [false, true]) {
      const capture = record(`${format}-${negative}-${cut}`, negative ? -0.5 : 0.5, negative ? -0.5 : 0.5);
      const spans: VideoRange[] | undefined = cut ? [{ start: 0.5, end: 1 }, { start: 2, end: 2.5 }] : undefined;
      state.times.length = 0;
      const result = await exportVideoRange({ record: capture, video: capture.video!, format, preset: "high", range: { start: 0.5, end: 2.5 }, spans, audio: { includeSystemAudio: false, includeMicrophone: true } });
      const duration = cut ? 1 : 2;
      expect(result.durationSec).toBe(duration);
      expect(state.times).toHaveLength(negative ? 53 : 23);
      const frames = decodedFrames(result.path);
      // Cut MP4s normalize to the recorder cap (60 fps); single ranges retain 20 fps.
      const fps = format === "gif" ? GIF_PRESETS.high.fps : cut ? 60 : 20;
      // Every frame decodes, and frame count / known output rate is the
      // playable duration, independently of the result metadata.
      expect(frames).toHaveLength(duration * fps);
      expectColor(frames[Math.round(0.25 * fps)]!, negative ? 1 : 2);
      expectColor(frames[Math.round((cut ? 0.75 : 1.75) * fps)]!, 1);
      expect(await probeAudioStreamCount(result.path)).toBe(format === "mp4" ? 1 : 0);
      if (format === "mp4") {
        expect(tone(result.path, 880)).toBeGreaterThan(0.02);
        expect(tone(result.path, 440)).toBeLessThan(0.003);
      }
    }
  }, 30_000);
});
