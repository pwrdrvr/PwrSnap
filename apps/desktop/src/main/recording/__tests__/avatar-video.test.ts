import { spawnSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_AVATAR_STYLE,
  type CameraTrackMetadata,
} from "@pwrsnap/shared";
vi.mock("../camera-worker", () => ({ CameraWorker: class {} }));
vi.mock("../../persistence/paths", () => ({ getCacheRoot: () => "/unused" }));
vi.mock("../../persistence/derived-cache-gate", () => ({
  runGatedCacheWrite: vi.fn(),
}));
vi.mock("../ffmpeg-resolver", () => ({ resolveFfmpegPath: () => null }));
import { avatarCompositionFilter, presenterEdgeFilter } from "../avatar-video";
const camera: CameraTrackMetadata = {
  version: 1,
  durationSec: 1,
  width: 16,
  height: 16,
  offsetSec: 0,
  sha256: "b".repeat(64),
  mimeType: "video/mp4",
};
const binary = process.env.PWRSNAP_FFMPEG_PATH ?? "ffmpeg";
const available =
  spawnSync(binary, ["-version"], { stdio: "ignore" }).status === 0;

describe("presenter composition", () => {
  test("pre-roll and a scene sync adjustment map to the same source time as preview", () => {
    const filter = avatarCompositionFilter({
      camera: { ...camera, offsetSec: -3 },
      style: { ...DEFAULT_AVATAR_STYLE, syncOffsetSec: 0.5 },
      width: 640,
      height: 360,
    });
    expect(filter).toContain(
      "trim=start=2.500000,setpts=PTS-STARTPTS+0.000000/TB",
    );
    expect(filter).toContain("eof_action=pass:repeatlast=0");
  });
  test.skipIf(!available)(
    "real FFmpeg preserves background, applies soft alpha, and places two scenes independently",
    () => {
      function compose(x: number, mask: string, portrait = false): Buffer {
        const filter = avatarCompositionFilter({
          camera,
          style: {
            ...DEFAULT_AVATAR_STYLE,
            x,
            y: 0.25,
            width: 0.25,
            mirror: false,
            // The model's own soft mask, so mid-gray stays half-opaque.
            edge: 0,
          },
          width: 64,
          height: 64,
          normalizeScreen: portrait,
        });
        const result = spawnSync(
          binary,
          [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            `color=blue:s=${portrait ? "32x64" : "64x64"}:d=1:r=1`,
            "-f",
            "lavfi",
            "-i",
            `color=red:s=16x16:d=1:r=1[c];color=${mask}:s=16x16:d=1:r=1[a];[c][a]hstack`,
            "-filter_complex",
            filter,
            "-map",
            "[out]",
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          { maxBuffer: 1024 * 1024 },
        );
        expect(result.status, result.stderr?.toString()).toBe(0);
        return result.stdout;
      }
      const left = compose(0.25, "white"),
        right = compose(0.5, "white"),
        transparent = compose(0.25, "black"),
        soft = compose(0.25, "gray");
      const pixel = (bytes: Buffer, x: number, y: number) => [
        ...bytes.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3),
      ];
      expect(pixel(left, 20, 20)[0]).toBeGreaterThan(220);
      expect(pixel(left, 40, 20)[2]).toBeGreaterThan(220);
      expect(pixel(right, 20, 20)[2]).toBeGreaterThan(220);
      expect(pixel(right, 40, 20)[0]).toBeGreaterThan(220);
      expect(pixel(transparent, 20, 20)[2]).toBeGreaterThan(220);
      expect(pixel(soft, 20, 20)[0]).toBeGreaterThan(70);
      expect(pixel(soft, 20, 20)[2]).toBeGreaterThan(70);
      const portrait = compose(0.75, "white", true);
      expect(pixel(portrait, 54, 20)[0]).toBeGreaterThan(220);
      expect(pixel(portrait, 30, 20)[2]).toBeGreaterThan(220);
      expect(pixel(portrait, 8, 20).every((channel) => channel < 10)).toBe(
        true,
      );
    },
  );
});

/** Compose one frame per `times` entry: blue screen, red camera, the
 *  given alpha mask beside it (the cached mask video's layout). */
function frames(
  filter: string,
  { mask = "white", times = [0.5] }: { mask?: string; times?: number[] } = {},
): Buffer[] {
  return times.map((t) => {
    const result = spawnSync(
      binary,
      [
        "-v", "error",
        "-f", "lavfi", "-i", "color=blue:s=64x64:d=2:r=10",
        "-f", "lavfi", "-i", `color=red:s=16x16:d=2:r=10[c];color=${mask}:s=16x16:d=2:r=10[a];[c][a]hstack`,
        "-filter_complex", filter,
        "-map", "[out]", "-ss", String(t), "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    expect(result.status, result.stderr?.toString()).toBe(0);
    return result.stdout;
  });
}
const px = (bytes: Buffer, x: number, y: number) => [
  ...bytes.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3),
];
const cut = (over: Partial<typeof DEFAULT_AVATAR_STYLE> = {}) => ({
  ...DEFAULT_AVATAR_STYLE,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  y: 0.25,
  width: 0.25,
  ...over,
});

describe("cut-out edge", () => {
  test("edge 0 adds nothing; any other edge ramps the mask", () => {
    expect(presenterEdgeFilter(cut({ edge: 0 }))).toBe("");
    expect(presenterEdgeFilter(cut())).toContain("lut=c0=");
  });

  test.skipIf(!available)("a tighter edge drops the half-sure fringe the soft mask keeps", () => {
    const red = (edge: number) =>
      px(frames(avatarCompositionFilter({ camera, style: cut({ x: 0.25, edge }), width: 64, height: 64 }), { mask: "gray" })[0]!, 20, 20)[0]!;
    // 50% confidence: half there with the raw mask, gone at full tightness.
    expect(red(0)).toBeGreaterThan(100);
    expect(red(0.5)).toBeLessThan(red(0));
    expect(red(1)).toBeLessThan(20);
  });
});

describe("presenter spans", () => {
  test.skipIf(!available)("a span shows its own presenter, only inside its window", () => {
    const filter = avatarCompositionFilter({
      camera: { ...camera, durationSec: 2 },
      style: cut({ x: 0.1 }),
      spans: [{ start: 1, end: 2, style: cut({ x: 0.6 }) }],
      width: 64,
      height: 64,
    });
    const [before, inside] = frames(filter, { times: [0.5, 1.5] });
    // Before 1 s: the recording's presenter on the left, nothing right.
    expect(px(before!, 10, 20)[0]).toBeGreaterThan(220);
    expect(px(before!, 44, 20)[2]).toBeGreaterThan(220);
    // Inside the span: moved right, and the left one is gone.
    expect(px(inside!, 44, 20)[0]).toBeGreaterThan(220);
    expect(px(inside!, 10, 20)[2]).toBeGreaterThan(220);
  });

  test.skipIf(!available)("a span can hide the presenter, and mix looks with the recording's", () => {
    const hidden = avatarCompositionFilter({
      camera: { ...camera, durationSec: 2 },
      style: cut({ x: 0.1 }),
      spans: [{ start: 1, end: 2, style: cut({ x: 0.1, visible: false }) }],
      width: 64,
      height: 64,
    });
    const [shown, gone] = frames(hidden, { times: [0.5, 1.5] });
    expect(px(shown!, 10, 20)[0]).toBeGreaterThan(220);
    expect(px(gone!, 10, 20)[2]).toBeGreaterThan(220);

    // A cut-out recording with one circle piece reads both inputs.
    const mixed = avatarCompositionFilter({
      camera,
      style: cut(),
      spans: [{ start: 1, end: 2, style: cut({ background: "original", shape: "circle" }) }],
      width: 64,
      height: 64,
    });
    expect(mixed).toContain("[1:v]null[src1_0]");
    expect(mixed).toContain("[2:v]null[src2_0]");
  });

  test("a recording with every presenter hidden passes the screen through", () => {
    expect(
      avatarCompositionFilter({ camera, style: cut({ visible: false }), width: 64, height: 64 }),
    ).toBe("[0:v]format=yuv420p[out]");
  });
});

describe("presenter shapes", () => {
  test.skipIf(!available)("a circle masks its corners and keeps its centre", () => {
    const filter = avatarCompositionFilter({
      camera,
      style: {
        ...DEFAULT_AVATAR_STYLE,
        background: "original",
        shape: "circle",
        crop: { x: 0, y: 0, width: 1, height: 1 },
        x: 0.25,
        y: 0.25,
        width: 0.5,
      },
      width: 64,
      height: 64,
    });
    const result = spawnSync(
      binary,
      [
        "-v", "error",
        "-f", "lavfi", "-i", "color=blue:s=64x64:d=1:r=1",
        "-f", "lavfi", "-i", "color=red:s=16x16:d=1:r=1",
        "-filter_complex", filter,
        "-map", "[out]", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    expect(result.status, result.stderr?.toString()).toBe(0);
    const pixel = (x: number, y: number) => [
      ...result.stdout.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3),
    ];
    expect(pixel(32, 32)[0]).toBeGreaterThan(220);
    // The presenter's own top-left corner sits outside the circle.
    expect(pixel(17, 17)[2]).toBeGreaterThan(200);
  });

  test("a rect, and any cut-out, adds no mask", () => {
    for (const style of [
      { ...DEFAULT_AVATAR_STYLE },
      { ...DEFAULT_AVATAR_STYLE, background: "original" as const, shape: "rect" as const },
      { ...DEFAULT_AVATAR_STYLE, shape: "circle" as const },
    ]) {
      expect(
        avatarCompositionFilter({ camera, style, width: 64, height: 64 }),
      ).not.toContain("geq");
    }
  });
});
