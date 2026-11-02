// Pure-function coverage for the filmstrip contact-strip extractor
// (`video:frames`). ffmpeg is not spawned here — we pin the argv shape
// and the request→spec quantization so a refactor can't silently drop
// the midpoint sampling offset, the end padding, the tile geometry, or
// the cache-key filename. What ffmpeg actually does with that argv is
// pinned by video-frames-ffmpeg.test.ts.

import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/pwrsnap-test-userdata" }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const {
  buildFramesArgs,
  framesFileName,
  normalizeFramesSpec,
  FRAMES_COUNT_DEFAULT,
  FRAMES_COUNT_MAX,
  FRAMES_COUNT_MIN,
  FRAMES_PIPELINE_VERSION,
  FRAMES_WIDTH_DEFAULT,
  FRAMES_WIDTH_MAX,
  FRAMES_WIDTH_MIN
} = await import("../video-frames");

describe("normalizeFramesSpec", () => {
  test("defaults when the renderer omits count / width", () => {
    const spec = normalizeFramesSpec({ sourceWidthPx: 1920, sourceHeightPx: 1080 });
    expect(spec.count).toBe(FRAMES_COUNT_DEFAULT);
    expect(spec.frameWidth).toBe(FRAMES_WIDTH_DEFAULT);
    // 96 * 1080/1920 = 54 → even
    expect(spec.frameHeight).toBe(54);
  });

  test("quantizes count to steps of 4 and width to steps of 16", () => {
    const spec = normalizeFramesSpec({
      count: 27,
      frameWidth: 103,
      sourceWidthPx: 1000,
      sourceHeightPx: 1000
    });
    expect(spec.count).toBe(28);
    expect(spec.frameWidth).toBe(96);
    expect(spec.frameHeight).toBe(96);
  });

  test("clamps count and width to their bounds", () => {
    const lo = normalizeFramesSpec({
      count: 0,
      frameWidth: 1,
      sourceWidthPx: 100,
      sourceHeightPx: 100
    });
    expect(lo.count).toBe(FRAMES_COUNT_MIN);
    expect(lo.frameWidth).toBe(FRAMES_WIDTH_MIN);
    const hi = normalizeFramesSpec({
      count: 10_000,
      frameWidth: 10_000,
      sourceWidthPx: 100,
      sourceHeightPx: 100
    });
    expect(hi.count).toBe(FRAMES_COUNT_MAX);
    expect(hi.frameWidth).toBe(FRAMES_WIDTH_MAX);
  });

  test("frame height is always even and at least 2 (portrait sources too)", () => {
    const portrait = normalizeFramesSpec({
      frameWidth: 64,
      sourceWidthPx: 429,
      sourceHeightPx: 936
    });
    expect(portrait.frameHeight % 2).toBe(0);
    // 64 * 936/429 = 139.6 → 140
    expect(portrait.frameHeight).toBe(140);
    const degenerate = normalizeFramesSpec({ sourceWidthPx: 0, sourceHeightPx: 0 });
    expect(degenerate.frameHeight).toBeGreaterThanOrEqual(2);
  });

  test("filename encodes the pipeline version, count + width (the cache key)", () => {
    expect(FRAMES_PIPELINE_VERSION).toBe(2);
    expect(framesFileName({ count: 24, frameWidth: 96, frameHeight: 54 })).toBe(
      "frames-v2-n24-w96.jpg"
    );
  });
});

/** Where the argv's fps ticks fall on the SOURCE timeline: the setpts shift
 *  plus k ticks of 1/fps. */
function tickTimes(args: string[], count: number): number[] {
  const vf = args[args.indexOf("-vf") + 1]!;
  const shift = Number(vf.match(/setpts=PTS-([\d.]+)\/TB/)?.[1]);
  const [num, den] = (vf.match(/fps=fps=([\d.]+\/[\d.]+):/)?.[1] ?? "").split("/").map(Number);
  expect(Number.isFinite(shift) && Number.isFinite(num) && Number.isFinite(den)).toBe(true);
  return Array.from({ length: count }, (_, k) => shift + (k * den!) / num!);
}

describe("buildFramesArgs", () => {
  test("pads the end, shifts half an interval, samples on span midpoints, tiles Nx1", () => {
    const args = buildFramesArgs({
      sourcePath: "/captures/clip.mp4",
      durationSec: 16,
      spec: { count: 8, frameWidth: 96, frameHeight: 54 },
      outputPath: "/cache/video/id/frames-v2-n8-w96.jpg.tmp.jpg"
    });
    // interval = 2s → shift 1s; 8 ticks over 16s
    expect(args).toEqual([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "/captures/clip.mp4",
      "-an",
      "-sn",
      "-vf",
      [
        "tpad=stop_mode=clone:stop_duration=16.000",
        "setpts=PTS-1.000000/TB",
        "fps=fps=8/16.000:start_time=0:round=up",
        "scale=96:54:flags=bilinear",
        "tile=8x1"
      ].join(","),
      "-frames:v",
      "1",
      "-q:v",
      "4",
      "/cache/video/id/frames-v2-n8-w96.jpg.tmp.jpg"
    ]);
  });

  // An accurate input seek discards every frame before the seek point — a
  // frame 0 held through a still opening included — and the strip then ran
  // out of frames before its last tile.
  test("never seeks on the input", () => {
    const args = buildFramesArgs({
      sourcePath: "/x.mov",
      durationSec: 3.3,
      spec: { count: 24, frameWidth: 64, frameHeight: 36 },
      outputPath: "/out.jpg"
    });
    expect(args).not.toContain("-ss");
    expect(args.at(-1)).toBe("/out.jpg");
    expect(args[args.indexOf("-vf") + 1]).toContain("tile=24x1");
  });

  // The reported case. The v1 argv put the last sample on the clip's final
  // instant, and whether ffmpeg emitted it came down to rounding the EOF
  // timestamp — 40.000 s at 12 tiles emitted 11, and `tile` padded black.
  test("the last tick sits half an interval inside the clip, not on its end", () => {
    const args = buildFramesArgs({
      sourcePath: "/x.mp4",
      durationSec: 40,
      spec: { count: 12, frameWidth: 96, frameHeight: 60 },
      outputPath: "/out.jpg"
    });
    const ticks = tickTimes(args, 12);
    for (const [k, t] of ticks.entries()) expect(t).toBeCloseTo(((k + 0.5) * 40) / 12, 5);
    expect(40 - ticks.at(-1)!).toBeCloseTo(40 / 12 / 2, 5);
  });

  test("ticks stay on span midpoints for a fractional wall-clock duration", () => {
    const durationSec = 7.3456;
    const args = buildFramesArgs({
      sourcePath: "/x.mp4",
      durationSec,
      spec: { count: 24, frameWidth: 64, frameHeight: 36 },
      outputPath: "/out.jpg"
    });
    const ticks = tickTimes(args, 24);
    // The argv rounds the duration to ms; the ticks follow that value.
    for (const [k, t] of ticks.entries()) expect(t).toBeCloseTo(((k + 0.5) * 7.346) / 24, 5);
    expect(args[args.indexOf("-vf") + 1]).toContain("tpad=stop_mode=clone:stop_duration=7.346,");
  });

  test("tile 0 is pinned to the start and ticks take the frame at or before them", () => {
    const args = buildFramesArgs({
      sourcePath: "/x.mp4",
      durationSec: 12,
      spec: { count: 4, frameWidth: 32, frameHeight: 18 },
      outputPath: "/out.jpg"
    });
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toMatch(/fps=fps=[^,]*:start_time=0:round=up(,|$)/);
    // tpad must run on the source timeline, before the shift and the sampler.
    expect(vf.indexOf("tpad=")).toBeLessThan(vf.indexOf("setpts="));
    expect(vf.indexOf("setpts=")).toBeLessThan(vf.indexOf("fps="));
  });

  test("guards a zero-duration clip against a division by zero", () => {
    const args = buildFramesArgs({
      sourcePath: "/x.mp4",
      durationSec: 0,
      spec: { count: 4, frameWidth: 32, frameHeight: 18 },
      outputPath: "/out.jpg"
    });
    const ticks = tickTimes(args, 4);
    for (const t of ticks) expect(Number.isFinite(t)).toBe(true);
    expect(ticks[1]!).toBeGreaterThan(ticks[0]!);
  });
});
