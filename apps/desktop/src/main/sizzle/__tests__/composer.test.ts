import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildCompositionArgs, compose, ComposeError, type SceneInput } from "../composer";
import { resolveFfmpegPath } from "../../recording/ffmpeg-resolver";

// These tests shell out to the real ffmpeg binary (the same
// repo-built LGPL copy the app ships). They're tagged with a long
// timeout because hardware H.264 encode of a few seconds of 720p
// video takes 1-3s on CI.
//
// **macOS-only**: our composer pins `h264_videotoolbox` (Apple's
// hardware encoder) for the GPL-free path — that encoder simply
// doesn't exist on Linux CI runners. PwrSnap is macOS-first (Phase
// 8 cross-platform; see CLAUDE.md note about Linux CI skipping
// macOS-only specs); these tests sit in the same bucket.
//
// `buildCompositionArgs` tests (pure args-shape, no ffmpeg invocation)
// still run on every platform so the codec-contract assertion can't
// regress silently on Linux.
const FFMPEG = resolveFfmpegPath();
const IS_DARWIN = process.platform === "darwin";

const canInvokeFfmpeg = FFMPEG !== null && IS_DARWIN;
const skipIfCantInvokeFfmpeg = canInvokeFfmpeg ? describe : describe.skip;

skipIfCantInvokeFfmpeg("sizzle composer (ffmpeg-invoking, macOS-only)", () => {
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

  async function makeSilentM4a(name: string, durationSec: number): Promise<string> {
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
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
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

  // Tiny helper so the test bodies don't have to repeat the
  // discriminator + transition field on every SceneInput literal.
  function imageScene(args: {
    imagePath: string;
    audioPath: string;
    durationSec: number;
  }): SceneInput {
    return {
      kind: "image",
      imagePath: args.imagePath,
      audioPath: args.audioPath,
      durationSec: args.durationSec,
      transition: "cut"
    };
  }

  it(
    "produces video whose frame count and duration match all input scenes (not just the first)",
    async () => {
      const scenes: SceneInput[] = [
        imageScene({
          imagePath: await makeImage("img1.png", "red"),
          audioPath: await makeSilentM4a("aud1.m4a", 1.5),
          durationSec: 1.5
        }),
        imageScene({
          imagePath: await makeImage("img2.png", "green"),
          audioPath: await makeSilentM4a("aud2.m4a", 1.5),
          durationSec: 1.5
        }),
        imageScene({
          imagePath: await makeImage("img3.png", "blue"),
          audioPath: await makeSilentM4a("aud3.m4a", 1.5),
          durationSec: 1.5
        }),
        imageScene({
          imagePath: await makeImage("img4.png", "yellow"),
          audioPath: await makeSilentM4a("aud4.m4a", 1.5),
          durationSec: 1.5
        })
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
      scenes.push(
        imageScene({
          imagePath: await makeImage(`c${i}.png`, colors[i]!.hex),
          audioPath: await makeSilentM4a(`s${i}.m4a`, 1.0),
          durationSec: 1.0
        })
      );
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

  it("compose aborts when the AbortSignal fires mid-encode", async () => {
    // Build a deliberately long-running scene (10s) so we can fire
    // the abort signal while ffmpeg is still encoding. Without the
    // abort wire, this would hang for 10+ seconds; with it, ffmpeg
    // gets SIGKILL'd within the 100ms abort window and compose
    // rejects with a `cancelled` ComposeError.
    const scenes: SceneInput[] = [
      imageScene({
        imagePath: await makeImage("abort.png", "red"),
        audioPath: await makeSilentM4a("abort.m4a", 10),
        durationSec: 10
      })
    ];
    const outputPath = join(tmpDir, "abort.mp4");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    let caught: unknown = null;
    try {
      await compose({
        scenes,
        outputPath,
        width: 320,
        height: 180,
        fps: 30,
        signal: controller.signal
      });
    } catch (cause) {
      caught = cause;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(ComposeError);
    expect((caught as ComposeError).code).toBe("cancelled");
    // Should return well before the 10s scene duration would naturally
    // complete. Pad generously for CI latency.
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  it("compose does not create the old .audio-list.txt temp file", async () => {
    const scenes: SceneInput[] = [
      imageScene({
        imagePath: await makeImage("cleanup.png", "blue"),
        audioPath: await makeSilentM4a("cleanup.m4a", 0.5),
        durationSec: 0.5
      })
    ];
    const outputPath = join(tmpDir, "cleanup.mp4");
    await compose({ scenes, outputPath, width: 320, height: 180, fps: 30 });
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${outputPath}.audio-list.txt`)).toBe(false);
  }, 30_000);

});

// Pure args-shape tests — no ffmpeg invocation. Run on every
// platform so the codec contract (and the "no -loop on inputs"
// regression guard) can't drift on Linux CI even though the
// invoking tests above only run on macOS.
describe("buildCompositionArgs (cross-platform args contract)", () => {
  it("video codec is h264_videotoolbox (no GPL libx264 / libx265 / nonfree libfdk_aac)", () => {
    // GPL compliance + cost: libx264 must never be invoked from this
    // path. The bundled ffmpeg is built without GPL/nonfree flags,
    // so this invocation contract must stay inside built-in codecs.
    // This assertion locks the invocation contract in.
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "image",
            imagePath: "/x/a.png",
            audioPath: "/x/a.mp3",
            durationSec: 1,
            transition: "cut"
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const codecIdx = args.indexOf("-c:v");
    expect(codecIdx).toBeGreaterThan(0);
    expect(args[codecIdx + 1]).toBe("h264_videotoolbox");
    const allowSwIdx = args.indexOf("-allow_sw");
    expect(allowSwIdx).toBeGreaterThan(codecIdx);
    expect(args[allowSwIdx + 1]).toBe("1");
    const bitrateIdx = args.indexOf("-b:v");
    expect(bitrateIdx).toBeGreaterThan(codecIdx);
    expect(args[bitrateIdx + 1]).toMatch(/^\d+$/);
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("libx265");
    // Audio codec is ffmpeg's native (LGPL), not libfdk-aac (nonfree).
    const aIdx = args.indexOf("-c:a");
    expect(aIdx).toBeGreaterThan(0);
    expect(args[aIdx + 1]).toBe("aac");
    expect(args).not.toContain("libfdk_aac");
  });

  it("image inputs are single-frame (no -loop, no -t, no -framerate)", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "image",
            imagePath: "/x/a.png",
            audioPath: "/x/a.mp3",
            durationSec: 2,
            transition: "cut"
          },
          {
            kind: "image",
            imagePath: "/x/b.png",
            audioPath: "/x/b.mp3",
            durationSec: 3,
            transition: "cut"
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1920,
        height: 1080,
        fps: 30
      }
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

// Cross-platform xfade contract tests. The filter graph that ffmpeg
// consumes is built in `buildCompositionArgs`'s `-filter_complex`
// arg — a single semicolon-joined string. We assert that string
// contains the right number + shape of `xfade=` clauses for a few
// representative transition patterns. Locking this on Linux CI
// catches transition-chain regressions even though the actual
// ffmpeg invocation only runs on macOS.
describe("buildCompositionArgs — xfade transition chain", () => {
  // Helper — pull the filter-graph string out of the args array.
  function filterGraph(args: string[]): string {
    const i = args.indexOf("-filter_complex");
    expect(i).toBeGreaterThan(0);
    const graph = args[i + 1];
    expect(typeof graph).toBe("string");
    return graph!;
  }

  function imageScene(idx: number, transition: "cut" | "crossfade"): SceneInput {
    return {
      kind: "image",
      imagePath: `/x/${idx}.png`,
      audioPath: `/x/${idx}.mp3`,
      durationSec: 2,
      transition
    };
  }

  it("single-scene reel: no transitions at all", () => {
    const args = buildCompositionArgs(
      {
        scenes: [imageScene(0, "cut")],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    // No xfade, no inter-scene concat — just the per-scene
    // normalization filter that emits [v0].
    expect(graph).not.toContain("xfade=");
    expect(graph).not.toContain("concat=n=2");
    // Map output should point to v0 directly.
    const mapIdx = args.indexOf("-map");
    expect(mapIdx).toBeGreaterThan(0);
    expect(args[mapIdx + 1]).toBe("[v0]");
  });

  it("2 scenes, all-cut: one concat, zero xfade", () => {
    const args = buildCompositionArgs(
      {
        scenes: [imageScene(0, "cut"), imageScene(1, "cut")],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    expect(graph).not.toContain("xfade=");
    // Exactly one `concat=n=2` clause for the boundary.
    const concatMatches = graph.match(/concat=n=2:v=1:a=0/g) ?? [];
    expect(concatMatches.length).toBe(1);
  });

  it("2 scenes, all-crossfade: one xfade clause, zero concat", () => {
    const args = buildCompositionArgs(
      {
        scenes: [imageScene(0, "cut"), imageScene(1, "crossfade")],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    const xfadeMatches = graph.match(/xfade=/g) ?? [];
    expect(xfadeMatches.length).toBe(1);
    // The crossfade duration is the locked SIZZLE_CROSSFADE_SEC value
    // (currently 0.4). Lock the visible portion of the filter so a
    // future change to that constant fails the test (forcing the dev
    // to think about user-visible impact + update the test).
    expect(graph).toContain("xfade=transition=fade:duration=0.4");
  });

  it("object transitions map to ffmpeg xfade transitions and custom durations", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          imageScene(0, "cut"),
          {
            ...imageScene(1, "cut"),
            transition: { type: "dip-black", durationSec: 0.25 }
          },
          {
            ...imageScene(2, "cut"),
            transition: { type: "push-left", durationSec: 0.18 }
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    expect(graph).toContain("xfade=transition=fadeblack:duration=0.25");
    expect(graph).toContain("xfade=transition=slideleft:duration=0.18");
  });

  it("object cut/none transitions remain hard cuts", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          imageScene(0, "cut"),
          {
            ...imageScene(1, "cut"),
            transition: { type: "none", durationSec: 0 }
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    expect(graph).not.toContain("xfade=");
    expect((graph.match(/concat=n=2:v=1:a=0/g) ?? []).length).toBe(1);
  });

  it("3 scenes, [cut, crossfade]: one concat + one xfade", () => {
    // scene[0].transition is ignored (nothing precedes it). The
    // boundary between scene[0]→scene[1] is determined by
    // scene[1].transition; scene[1]→scene[2] by scene[2].transition.
    const args = buildCompositionArgs(
      {
        scenes: [
          imageScene(0, "cut"),
          imageScene(1, "cut"),
          imageScene(2, "crossfade")
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    expect((graph.match(/xfade=/g) ?? []).length).toBe(1);
    expect((graph.match(/concat=n=2:v=1:a=0/g) ?? []).length).toBe(1);
  });

  it("3 scenes, [cut, crossfade, crossfade]: zero concat + two xfade", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          imageScene(0, "cut"),
          imageScene(1, "crossfade"),
          imageScene(2, "crossfade")
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    expect((graph.match(/xfade=/g) ?? []).length).toBe(2);
    expect((graph.match(/concat=n=2:v=1:a=0/g) ?? []).length).toBe(0);
  });

  it("4 scenes, all-crossfade: 3 xfade clauses with monotonically increasing offsets", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          imageScene(0, "cut"),
          imageScene(1, "crossfade"),
          imageScene(2, "crossfade"),
          imageScene(3, "crossfade")
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    const xfadeMatches = graph.match(/xfade=/g) ?? [];
    expect(xfadeMatches.length).toBe(3);

    // Each xfade carries `offset=<seconds>` indicating where in the
    // chain's timeline that crossfade begins. With 4 scenes × 2s
    // duration × 0.4s crossfade overlap, the offsets are:
    //   boundary 0→1: chainEnd 2.0s, offset = 2.0 - 0.4 = 1.6
    //   boundary 1→2: chainEnd 3.6s (2 + 2 - 0.4), offset = 3.2
    //   boundary 2→3: chainEnd 5.2s, offset = 4.8
    // Walk the offsets and assert strict ordering — a regression that
    // computes offset from raw scene-start (not chain-end) would
    // collapse them to constant 1.6.
    const offsets = [...graph.matchAll(/xfade=transition=fade:duration=0\.4:offset=([\d.]+)/g)]
      .map((m) => parseFloat(m[1]!));
    expect(offsets.length).toBe(3);
    expect(offsets[1]).toBeGreaterThan(offsets[0]!);
    expect(offsets[2]).toBeGreaterThan(offsets[1]!);
    // Sanity: first offset ≈ first scene duration - SIZZLE_CROSSFADE_SEC.
    expect(offsets[0]).toBeCloseTo(2 - 0.4, 2);
  });

  it("video scene inputs use -ss before -i (input-side trim, fast seek)", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "video",
            videoPath: "/x/clip.mp4",
            startSec: 1.5,
            trimDurationSec: 3.0,
            durationSec: 3.0,
            audioPath: "/x/a.mp3",
            transition: "cut"
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    // -ss must come BEFORE -i for fast input-side seek (ffmpeg has
    // both an output-side and input-side -ss; the latter is the only
    // one that doesn't decode every frame from t=0).
    const iIdx = args.indexOf("-i");
    const ssIdx = args.indexOf("-ss");
    const tIdx = args.indexOf("-t");
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    expect(ssIdx).toBeLessThan(iIdx);
    expect(tIdx).toBeGreaterThan(ssIdx);
    expect(tIdx).toBeLessThan(iIdx);
    expect(args[ssIdx + 1]).toBe("1.500");
    expect(args[tIdx + 1]).toBe("3.000");
  });

  it("video scene with voiceover overrun: tpad freezes the last frame", () => {
    // durationSec > trimDurationSec → composer appends a tpad clone
    // filter holding the last frame for the delta. Without this, the
    // -shortest mux would truncate the reel where the video ended.
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "video",
            videoPath: "/x/clip.mp4",
            startSec: 0,
            trimDurationSec: 2.0,
            durationSec: 4.5, // voiceover overruns by 2.5s
            audioPath: "/x/a.mp3",
            transition: "cut"
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    // The tpad filter should appear with stop_mode=clone and a
    // stop_duration matching the overrun (2.500).
    expect(graph).toContain("tpad=stop_mode=clone:stop_duration=2.500");
  });

  it("video scene with no overrun: no tpad filter (no spurious frame hold)", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "video",
            videoPath: "/x/clip.mp4",
            startSec: 0,
            trimDurationSec: 2.0,
            durationSec: 2.0,
            audioPath: "/x/a.mp3",
            transition: "cut"
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    expect(graph).not.toContain("tpad=");
  });

  it("video scene with sub-50ms overrun: no tpad (small-delta deadband)", () => {
    // Floating-point math from voiceover-dur measurement can produce
    // tiny deltas (e.g. 0.001s) where tpad would just waste a filter
    // slot. The composer's 0.05s deadband prevents that.
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "video",
            videoPath: "/x/clip.mp4",
            startSec: 0,
            trimDurationSec: 2.0,
            durationSec: 2.01, // 0.01s overrun — below the 0.05 deadband
            audioPath: "/x/a.mp3",
            transition: "cut"
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    expect(filterGraph(args)).not.toContain("tpad=");
  });

  it("sequence beat audio can start from the middle of a narration file", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "image",
            imagePath: "/x/a.png",
            audioPath: "/x/narration.mp3",
            audioStartSec: 1.25,
            durationSec: 0.75,
            transition: "cut"
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    expect(filterGraph(args)).toContain("atrim=1.250:2.000");
  });

  it("loop video fit repeats a short clip to fill the target duration", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "video",
            videoPath: "/x/clip.mp4",
            startSec: 0,
            trimDurationSec: 1,
            durationSec: 4,
            audioPath: "/x/a.mp3",
            transition: "cut",
            videoFit: { mode: "loop", playbackRate: 1 }
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    expect(graph).toContain("loop=loop=3:size=30:start=0");
    expect(graph).toContain("trim=duration=4.000");
  });

  it("speed-to-fit video fit changes PTS rather than freezing the tail", () => {
    const args = buildCompositionArgs(
      {
        scenes: [
          {
            kind: "video",
            videoPath: "/x/clip.mp4",
            startSec: 0,
            trimDurationSec: 3,
            durationSec: 2,
            audioPath: "/x/a.mp3",
            transition: "cut",
            videoFit: { mode: "speed-to-fit", playbackRate: 1.5 }
          }
        ],
        outputPath: "/x/out.mp4",
        width: 1280,
        height: 720,
        fps: 30
      }
    );
    const graph = filterGraph(args);
    expect(graph).toContain("setpts=0.666667*PTS");
    expect(graph).not.toContain("tpad=stop_mode=clone");
  });
});
