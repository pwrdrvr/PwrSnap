// Nonheaded media integration for the filmstrip contact strip: real FFmpeg
// against generated clips. No screen capture, Electron or operator data.
//
// Every fixture frame carries its own timestamp as brightness
// (Y = 48 + 4·t), so a tile reads back as "the source instant it shows".
// Two fixtures:
//
//   cfr40   40.000 s at 30 fps with AAC, the reported case. At 12 tiles
//           (and at 48) the pre-fix argv emitted one frame fewer than
//           `tile` wanted, and the strip ended in a black tile.
//   stills  what the recorder writes for a take that opens and closes on a
//           still screen: it appends only frames whose content changed, so
//           frame 0 is held until the first change (5 s) and the video
//           track stops at the last one (30 s) while the audio, and the
//           wall-clock `durationSec`, run on to 40 s.
//
// Timing is read from a raw-video run of the production argv, not from the
// JPEG: decoding a JPEG back to limited-range YUV is range-converted or not
// depending on the FFmpeg version, which would make an absolute brightness
// check pass on one host and fail on another. The JPEG is checked for what
// survives either mapping — its geometry, and that no tile is black.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoCaptureMetadata } from "@pwrsnap/shared";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: {
  getAppPath: () => resolve("apps/desktop"),
  getPath: () => state.root
} }));
vi.mock("../../persistence/paths", () => ({ getCacheRoot: () => state.root }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));

import { resolveFfmpegPath } from "../ffmpeg-resolver";
import {
  buildFramesArgs,
  ensureVideoFrames,
  FRAMES_COUNT_MAX,
  FRAMES_COUNT_STEP,
  type FramesSpec
} from "../video-frames";

const ffmpeg = resolveFfmpegPath();

function run(args: string[]): Buffer {
  return execFileSync(ffmpeg!, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024
  });
}

function frameCount(path: string): number {
  // `passthrough`: count the frames that are in the file, not the ones a
  // constant-rate output would duplicate into its gaps.
  const bytes = run(["-i", path, "-map", "0:v:0", "-vf", "scale=8:8,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"]);
  return bytes.length / 64;
}

const W = 160;
const H = 100;
const TIME_CODE = "geq=lum='48+4*T':cb=128:cr=128";
/** Luma below this is tile padding, not a fixture frame (whose floor is 48,
 *  or ~37 once a JPEG has range-expanded it). */
const BLACK_BELOW = 26;

type Tile = number | "black";

/** Mean interior luma per tile, inset so JPEG ringing at a tile seam is not
 *  averaged in. `plane` is the first (luma) plane, `count` tiles wide. */
function tileLumas(plane: Buffer, spec: FramesSpec): number[] {
  const { count, frameWidth: w, frameHeight: h } = spec;
  const inset = 8;
  return Array.from({ length: count }, (_, k) => {
    let sum = 0;
    let n = 0;
    for (let y = inset; y < h - inset; y++) {
      for (let x = inset; x < w - inset; x++) {
        sum += plane[y * w * count + k * w + x]!;
        n++;
      }
    }
    return sum / n;
  });
}

/** The source instant each tile shows, from a raw run of the production
 *  argv — the same filter graph, with only the output swapped. */
function sampledTimes(source: string, durationSec: number, count: number): Tile[] {
  // Build the spec directly: normalizeFramesSpec would round a 2 up to 4,
  // and 2 is a size it can produce (for a request of 1).
  const spec: FramesSpec = { count, frameWidth: 64, frameHeight: 40 };
  const args = buildFramesArgs({ sourcePath: source, durationSec, spec, outputPath: "pipe:1" });
  const raw = run([...args.slice(0, -1), "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1"]);
  return tileLumas(raw, spec).map((y) => (y < BLACK_BELOW ? "black" : (y - 48) / 4));
}

/** Tile k's span is [k·I, (k+1)·I); it should show the frame on screen at
 *  the middle of it. */
function midpoints(durationSec: number, count: number): number[] {
  const interval = durationSec / count;
  return Array.from({ length: count }, (_, k) => (k + 0.5) * interval);
}

/** A tile time within one luma step (0.25 s) plus one frame of `expected`. */
function expectShows(tiles: Tile[], expected: number[]): void {
  expect(tiles).not.toContain("black");
  const shown = tiles.map((t) => Math.round((t as number) * 100) / 100);
  const wanted = expected.map((t) => Math.round(t * 100) / 100);
  for (let k = 0; k < tiles.length; k++) {
    expect(
      Math.abs(shown[k]! - wanted[k]!),
      `tile ${k}: shows ${shown[k]} s, wanted ~${wanted[k]} s\n  shown  ${shown.join(" ")}\n  wanted ${wanted.join(" ")}`
    ).toBeLessThan(0.3);
  }
}

let cfr40: string;
let stills: string;

function record(id: string, source: string): CaptureRecord {
  return { id, kind: "video", legacy_src_path: source, width_px: W, height_px: H } as unknown as CaptureRecord;
}

function video(durationSec: number): VideoCaptureMetadata {
  return {
    durationSec,
    containerFormat: "mp4",
    hasSystemAudio: true,
    hasMicrophoneAudio: false,
    requestedSystemAudio: true,
    requestedMicrophone: false,
    defaultRange: { start: 0, end: durationSec },
    previewPath: null,
    previewStatus: "ready"
  } as VideoCaptureMetadata;
}

describe.skipIf(ffmpeg === null)("filmstrip through real FFmpeg", () => {
  beforeAll(() => {
    state.root = mkdtempSync(join(tmpdir(), "pwrsnap-video-frames-"));
    const tone = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=40"];
    // Intra-only at q 1 so each flat frame decodes to its exact brightness.
    const encode = ["-map", "0:v", "-map", "1:a", "-c:v", "mpeg4", "-q:v", "1", "-g", "1", "-c:a", "aac"];
    cfr40 = join(state.root, "cfr40.mp4");
    run([
      "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=30:d=40`, ...tone,
      "-vf", TIME_CODE, ...encode, cfr40
    ]);
    // Keep frame 0 and 5–30 s. `passthrough` preserves both gaps instead of
    // re-duplicating frames into them.
    stills = join(state.root, "stills.mp4");
    run([
      "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=30:d=40`, ...tone,
      "-vf", `${TIME_CODE},select='eq(n\\,0)+between(t\\,5\\,29.99)'`,
      "-fps_mode", "passthrough", ...encode, stills
    ]);
  }, 30_000);
  afterAll(() => {
    if (state.root) rmSync(state.root, { recursive: true, force: true });
  });

  test("the fixtures are what they claim", () => {
    expect(frameCount(cfr40)).toBe(1200);
    // Frame 0, then 5.000–29.967 s.
    expect(frameCount(stills)).toBe(1 + 750);
  });

  test("40.000 s at 12 tiles: the strip lands under a versioned name and no tile is black", async () => {
    const result = await ensureVideoFrames(record("cfr40", cfr40), video(40), { count: 12, frameWidth: 96 });
    expect(result.spec).toEqual({ count: 12, frameWidth: 96, frameHeight: 60 });
    expect(result.fileName).toBe("frames-v2-n12-w96.jpg");
    const plane = run(["-i", result.path, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    expect(plane.length).toBe(12 * 96 * 60);
    const lumas = tileLumas(plane, result.spec).map((y) => Math.round(y));
    expect(lumas.filter((y) => y < BLACK_BELOW), `tile lumas: ${lumas.join(" ")}`).toEqual([]);
  }, 30_000);

  test("each tile shows the frame on screen at the middle of its span", () => {
    // Not the END of the span, which is what the pre-fix `fps` rounding
    // picked — that is what put the last tile on the clip's final instant,
    // where one rounding step decided between a frame and a black tile.
    expectShows(sampledTimes(cfr40, 40, 12), midpoints(40, 12));
  }, 30_000);

  test("no strip size ends in a black tile on an exactly 40 s clip", () => {
    // Every count normalizeFramesSpec can produce. 12 and 48 are the two the
    // pre-fix argv lost a frame on.
    const counts = [2];
    for (let n = FRAMES_COUNT_STEP; n <= FRAMES_COUNT_MAX; n += FRAMES_COUNT_STEP) counts.push(n);
    const failures = counts.filter((n) => sampledTimes(cfr40, 40, n).includes("black"));
    expect(failures).toEqual([]);
  }, 60_000);

  test("a take that opens and closes on a still screen shows what was on screen", () => {
    const tiles = sampledTimes(stills, 40, 12);
    const expected = midpoints(40, 12).map((t) => {
      if (t < 5) return 0; // frame 0, held — not the first change after it
      if (t >= 30) return 29 + 29 / 30; // the last frame, held — not black
      return t;
    });
    expectShows(tiles, expected);
  }, 30_000);

  test("a wall-clock duration past the end of the media repeats the last frame", () => {
    // 44 s claimed, 40 s of media: the last tile's midpoint (42.2 s) has no
    // frame of its own.
    const expected = midpoints(44, 12).map((t) => Math.min(t, 39 + 29 / 30));
    expectShows(sampledTimes(cfr40, 44, 12), expected);
  }, 30_000);
});
