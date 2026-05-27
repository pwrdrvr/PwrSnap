import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildCompositionArgs, compose, type SceneInput } from "../composer";
import { resolveFfmpegPath } from "../../recording/ffmpeg-resolver";

// These tests shell out to the real ffmpeg binary (the same
// @ffmpeg-installer copy the app ships). They're tagged with a long
// timeout because libx264 encode of a few seconds of 720p video takes
// 1-3s on CI. If ffmpeg isn't resolvable the whole suite is skipped —
// it never breaks the rest of the matrix.
const FFMPEG = resolveFfmpegPath();

const shouldRun = FFMPEG !== null;
const skipIfNoFfmpeg = shouldRun ? describe : describe.skip;

skipIfNoFfmpeg("sizzle composer", () => {
  let tmpDir = "";
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pwrsnap-sizzle-composer-"));
  });
  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeImage(name: string, color: string): Promise<string> {
    const out = join(tmpDir, name);
    const ff = spawnSync(
      FFMPEG!,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=640x360:d=1`,
        "-frames:v",
        "1",
        out
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    if (ff.status !== 0) {
      throw new Error(
        `failed to synthesize test image: ${ff.stderr?.toString() ?? ""}`
      );
    }
    return out;
  }

  async function makeSilentMp3(name: string, durationSec: number): Promise<string> {
    const out = join(tmpDir, name);
    const ff = spawnSync(
      FFMPEG!,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `anullsrc=channel_layout=mono:sample_rate=44100`,
        "-t",
        durationSec.toFixed(3),
        "-c:a",
        "libmp3lame",
        "-q:a",
        "9",
        out
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    if (ff.status !== 0) {
      throw new Error(
        `failed to synthesize test audio: ${ff.stderr?.toString() ?? ""}`
      );
    }
    return out;
  }

  function probeOutput(
    path: string
  ): { durationSec: number; nbReadFrames: number; width: number; height: number } {
    // -loglevel info keeps the "Duration:" + "Video:" header lines
    // that we parse below. -stats adds the final "frame=N" tally.
    const probe = spawnSync(
      FFMPEG!,
      [
        "-hide_banner",
        "-loglevel",
        "info",
        "-stats",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-f",
        "null",
        "-"
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    const stderr = probe.stderr?.toString() ?? "";
    // Parse "Duration: HH:MM:SS.MS"
    const dur = /Duration:\s+(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
    const durationSec = dur
      ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
      : 0;
    // Last "frame= NNNN" reported by the null muxer = total decoded video frames
    const frameMatches = stderr.match(/frame=\s*(\d+)/g) ?? [];
    const lastFrame = frameMatches[frameMatches.length - 1] ?? "frame=0";
    const fm = /frame=\s*(\d+)/.exec(lastFrame);
    const nbReadFrames = fm ? Number(fm[1]) : 0;
    // Parse "Video: ... WxH"
    const dims = /Video:[^,]+,[^,]+,\s*(\d+)x(\d+)/.exec(stderr);
    const width = dims ? Number(dims[1]) : 0;
    const height = dims ? Number(dims[2]) : 0;
    return { durationSec, nbReadFrames, width, height };
  }

  it(
    "produces video whose frame count and duration match all input scenes (not just the first)",
    async () => {
      const scenes: SceneInput[] = [
        {
          imagePath: await makeImage("img1.png", "red"),
          audioPath: await makeSilentMp3("aud1.mp3", 1.5),
          durationSec: 1.5
        },
        {
          imagePath: await makeImage("img2.png", "green"),
          audioPath: await makeSilentMp3("aud2.mp3", 1.5),
          durationSec: 1.5
        },
        {
          imagePath: await makeImage("img3.png", "blue"),
          audioPath: await makeSilentMp3("aud3.mp3", 1.5),
          durationSec: 1.5
        },
        {
          imagePath: await makeImage("img4.png", "yellow"),
          audioPath: await makeSilentMp3("aud4.mp3", 1.5),
          durationSec: 1.5
        }
      ];
      const outputPath = join(tmpDir, "out.mp4");
      const fps = 30;
      const width = 640;
      const height = 360;

      await compose({ scenes, outputPath, width, height, fps });

      const probe = probeOutput(outputPath);
      // Expected: 4 × 1.5s = 6s at 30fps = 180 frames. Allow a small
      // delta for encoder rounding (typically ±1-2 frames).
      const expectedFrames = scenes.length * Math.round(1.5 * fps);
      expect(probe.nbReadFrames).toBeGreaterThanOrEqual(expectedFrames - 4);
      expect(probe.nbReadFrames).toBeLessThanOrEqual(expectedFrames + 4);
      // Duration ≈ 6s. -shortest may round to nearest GOP boundary.
      expect(probe.durationSec).toBeGreaterThanOrEqual(5.5);
      expect(probe.durationSec).toBeLessThanOrEqual(6.5);
      // Output canvas size honors the request.
      expect(probe.width).toBe(width);
      expect(probe.height).toBe(height);
    },
    60_000
  );

  it("sampled mid-scene frames are distinct colors (each input image appears in output)", async () => {
    const colors: Array<{ name: string; hex: string; rgb: [number, number, number] }> = [
      { name: "red", hex: "red", rgb: [255, 0, 0] },
      { name: "green", hex: "green", rgb: [0, 128, 0] },
      { name: "blue", hex: "blue", rgb: [0, 0, 255] },
      { name: "yellow", hex: "yellow", rgb: [255, 255, 0] }
    ];
    const scenes: SceneInput[] = [];
    for (let i = 0; i < colors.length; i++) {
      scenes.push({
        imagePath: await makeImage(`c${i}.png`, colors[i]!.hex),
        audioPath: await makeSilentMp3(`s${i}.mp3`, 1.0),
        durationSec: 1.0
      });
    }
    const outputPath = join(tmpDir, "colors.mp4");
    await compose({ scenes, outputPath, width: 320, height: 180, fps: 30 });

    // Sample each scene's middle: scene i is at t = i + 0.5 (1s per
    // scene). signalstats prints YUVAVG; for color=red we expect a
    // distinctive Y/U/V profile vs blue, green, yellow. We use ffmpeg
    // to dump the average pixel color of each sampled frame as raw
    // RGB then compare to the input color.
    const samples: Array<[number, number, number]> = [];
    for (let i = 0; i < colors.length; i++) {
      const ts = (i + 0.5).toFixed(2);
      const rawPath = join(tmpDir, `sample-${i}.rawvideo`);
      const ff = spawnSync(
        FFMPEG!,
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          ts,
          "-i",
          outputPath,
          "-vframes",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-s",
          "1x1", // average the whole frame to a single 1×1 pixel
          rawPath
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      expect(ff.status, ff.stderr?.toString()).toBe(0);
      const { readFileSync } = await import("node:fs");
      const buf = readFileSync(rawPath);
      samples.push([buf[0]!, buf[1]!, buf[2]!]);
    }

    // Sanity: every sampled middle-of-scene frame must have its
    // dominant channel match the input color. This is the actual
    // regression test for the "video has only one image" bug — under
    // the old composer with zoompan/-t mismatch, all 4 samples came
    // out red.
    for (let i = 0; i < colors.length; i++) {
      const [r, g, b] = samples[i]!;
      const expected = colors[i]!;
      const expectedDominantIdx =
        expected.rgb[0] >= expected.rgb[1] && expected.rgb[0] >= expected.rgb[2]
          ? 0
          : expected.rgb[1] >= expected.rgb[2]
            ? 1
            : 2;
      const actualMax = Math.max(r, g, b);
      const actualDominantIdx = r === actualMax ? 0 : g === actualMax ? 1 : 2;
      // Yellow is R≈G>>B, so accept either R or G as dominant.
      const yellowOk =
        expected.name === "yellow" && (actualDominantIdx === 0 || actualDominantIdx === 1);
      const ok = yellowOk || actualDominantIdx === expectedDominantIdx;
      expect(
        ok,
        `scene ${i} (${expected.name}) — sample rgb=(${r},${g},${b}) dominant idx=${actualDominantIdx}, expected ${expectedDominantIdx}`
      ).toBe(true);
    }
  }, 90_000);

  it("buildCompositionArgs: image inputs are single-frame (no -loop, no -t, no -framerate)", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          { imagePath: "/x/a.png", audioPath: "/x/a.mp3", durationSec: 2 },
          { imagePath: "/x/b.png", audioPath: "/x/b.mp3", durationSec: 3 }
        ],
        outputPath: "/x/out.mp4",
        width: 1920,
        height: 1080,
        fps: 30
      },
      "/x/audio-list.txt"
    );
    // Image inputs are bare `-i image` — anything else (especially
    // -loop or -framerate) turns the input into a multi-frame stream
    // and zoompan's d=N then emits N output frames per input frame
    // instead of N total. Lock the shape in.
    const aIdx = args.indexOf("/x/a.png");
    const bIdx = args.indexOf("/x/b.png");
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(args[aIdx - 1]).toBe("-i");
    expect(args[bIdx - 1]).toBe("-i");
    // Between the two scene inputs there must be nothing but `-i a -i b`.
    expect(bIdx - aIdx).toBe(2);
    // No -loop / -framerate / -t before the first input.
    const firstI = args.indexOf("-i");
    const before = args.slice(0, firstI);
    expect(before).not.toContain("-loop");
    expect(before).not.toContain("-framerate");
    expect(before).not.toContain("-t");
  });
});
