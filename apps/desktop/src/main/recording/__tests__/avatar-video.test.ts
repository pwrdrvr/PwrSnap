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
import { avatarCompositionFilter } from "../avatar-video";
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
