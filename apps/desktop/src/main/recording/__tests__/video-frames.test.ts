// Pure-function coverage for the filmstrip contact-strip extractor
// (`video:frames`). ffmpeg is not spawned here — we pin the argv shape
// and the request→spec quantization so a refactor can't silently drop
// the midpoint sampling offset, the tile geometry, or the cache-key
// filename.

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

  test("filename encodes count + width (the cache key)", () => {
    expect(framesFileName({ count: 24, frameWidth: 96, frameHeight: 54 })).toBe(
      "frames-n24-w96.jpg"
    );
  });
});

describe("buildFramesArgs", () => {
  test("seeks half an interval, samples count/duration fps, tiles Nx1, one output frame", () => {
    const args = buildFramesArgs({
      sourcePath: "/captures/clip.mp4",
      durationSec: 16,
      spec: { count: 8, frameWidth: 96, frameHeight: 54 },
      outputPath: "/cache/video/id/frames-n8-w96.jpg.tmp.jpg"
    });
    // interval = 2s → midpoint offset 1s; fps = 8/16 = 0.5
    expect(args).toEqual([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1.000",
      "-i",
      "/captures/clip.mp4",
      "-an",
      "-sn",
      "-vf",
      "fps=0.500000,scale=96:54:flags=bilinear,tile=8x1",
      "-frames:v",
      "1",
      "-q:v",
      "4",
      "/cache/video/id/frames-n8-w96.jpg.tmp.jpg"
    ]);
  });

  test("-ss precedes -i (input-side seek) and the output path is last", () => {
    const args = buildFramesArgs({
      sourcePath: "/x.mov",
      durationSec: 3.3,
      spec: { count: 24, frameWidth: 64, frameHeight: 36 },
      outputPath: "/out.jpg"
    });
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args.at(-1)).toBe("/out.jpg");
    expect(args[args.indexOf("-vf") + 1]).toContain("tile=24x1");
  });

  test("guards a zero-duration clip against a division by zero", () => {
    const args = buildFramesArgs({
      sourcePath: "/x.mp4",
      durationSec: 0,
      spec: { count: 4, frameWidth: 32, frameHeight: 18 },
      outputPath: "/out.jpg"
    });
    const vf = args[args.indexOf("-vf") + 1]!;
    const fps = Number(vf.match(/fps=([\d.]+)/)?.[1]);
    expect(Number.isFinite(fps)).toBe(true);
    expect(fps).toBeGreaterThan(0);
  });
});
