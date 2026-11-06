import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SizzleTimelineSchema } from "@pwrsnap/shared";
import { resolveFfmpegPath } from "../../recording/ffmpeg-resolver";
import { importTimelineAsset } from "../timeline-assets";
import { prepareTimelineAudio } from "../timeline-audio";
import {
  renderSizzleTimeline,
  type TimelineRenderRequest,
} from "../timeline-render";
import * as processor from "../timeline-process";

const ffmpeg = resolveFfmpegPath();
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const temporary = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pwrsnap-timeline-oracle-"));
  roots.push(root);
  return root;
};
const run = (args: string[]): Buffer =>
  execFileSync(ffmpeg!, ["-v", "error", "-y", ...args], {
    maxBuffer: 4 * 1024 ** 2,
  });

async function heldVideo(): Promise<TimelineRenderRequest> {
  const root = await temporary();
  const clip = join(root, "held.mov");
  // Exactly three frames at t=0 (red), t=2 (blue), t=3 (blue).
  // The first frame really remains on screen throughout [0, 2).
  run([
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x180:r=1:d=4,drawbox=color=blue:t=fill:enable=gte(t\\,2),select=eq(n\\,0)+eq(n\\,2)+eq(n\\,3)",
    "-fps_mode",
    "vfr",
    "-c:v",
    "png",
    clip,
  ]);
  const assetsRoot = join(root, "assets");
  const asset = await importTimelineAsset(assetsRoot, clip, ffmpeg);
  return {
    timeline: SizzleTimelineSchema.parse({
      version: 1,
      width: 320,
      height: 180,
      scenes: [
        {
          id: "held",
          durationFrames: 90,
          layers: [
            {
              id: "video",
              kind: "video",
              assetId: asset.id,
              width: 320,
              height: 180,
              sourceStartSec: 1,
            },
          ],
        },
      ],
    }),
    assets: [asset],
    assetsRoot,
    cacheRoot: join(root, "cache"),
    ffmpeg: ffmpeg!,
    platform: process.platform === "win32" ? "win32" : "darwin",
    width: 320,
    height: 180,
    outputPath: join(root, "contact.png"),
  };
}

const pixel = async (png: Buffer, tile: number): Promise<number[]> => {
  const { data } = await sharp(png)
    .extract({
      left: (tile % 3) * 320 + 160,
      top: Math.floor(tile / 3) * 180 + 90,
      width: 1,
      height: 1,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [...data];
};
const expectRed = (rgb: number[]): void => {
  expect(rgb[0]).toBeGreaterThan(220);
  expect(rgb[2]).toBeLessThan(30);
};
const expectBlue = (rgb: number[]): void => {
  expect(rgb[2]).toBeGreaterThan(220);
  expect(rgb[0]).toBeLessThan(30);
};

describe.skipIf(ffmpeg === null)("timeline media oracles (nonheaded)", () => {
  it("shows the frame held at the requested VFR source time, at each playback rate", async () => {
    const request = await heldVideo();
    for (const rate of [0.5, 1, 2]) {
      const scene = request.timeline.scenes[0]!;
      const layer = scene.layers[0]!;
      if (layer.kind !== "video") throw new Error("Video fixture required");
      // Blue starts exactly one source second after the trim boundary.
      const transition = 30 / rate;
      await renderSizzleTimeline({
        ...request,
        timeline: {
          ...request.timeline,
          scenes: [{ ...scene, layers: [{ ...layer, playbackRate: rate }] }],
        },
        frames: [0, transition - 1, transition],
      });
      const png = await readFile(request.outputPath);
      expectRed(await pixel(png, 0));
      expectRed(await pixel(png, 1));
      expectBlue(await pixel(png, 2));
    }
  }, 30_000);

  it("writes only distinct requested video frames, including freeze and loop holds", async () => {
    const request = await heldVideo();
    const actual = processor.timelineProcess;
    const extracted: number[] = [];
    vi.spyOn(processor, "timelineProcess").mockImplementation(
      async (binary, args, signal) => {
        const result = await actual(binary, args, signal);
        const output = args.at(-1)!;
        if (output.endsWith("%06d.jpg"))
          extracted.push(
            (await readdir(dirname(output))).filter((name) =>
              name.endsWith(".jpg"),
            ).length,
          );
        return result;
      },
    );
    const scene = request.timeline.scenes[0]!;
    const layer = scene.layers[0]!;
    if (layer.kind !== "video") throw new Error("Video fixture required");
    for (const endBehavior of ["freeze", "loop"] as const) {
      await renderSizzleTimeline({
        ...request,
        timeline: {
          ...request.timeline,
          scenes: [
            {
              ...scene,
              durationFrames: 18_000,
              layers: [
                { ...layer, startFrame: 30, endFrame: 17_000, endBehavior },
              ],
            },
          ],
        },
        // First is outside the layer; repeated requests and held source frames
        // must not expand into a full 10-minute media window on disk.
        frames: [0, 30, 30, 30 + 90, 30 + 90 * 50, 17_999],
      });
      const png = await readFile(request.outputPath);
      expect(await pixel(png, 0)).toEqual([0, 0, 0]);
      expectRed(await pixel(png, 1));
      expectRed(await pixel(png, 2));
      for (const tile of [3, 4])
        (endBehavior === "freeze" ? expectBlue : expectRed)(
          await pixel(png, tile),
        );
      expect(await pixel(png, 5)).toEqual([0, 0, 0]);
    }
    // Freeze needs first + final frame, loop only its first frame.
    expect(extracted).toEqual([2, 1]);
    // A separate slider request for the first frame writes one JPEG; an
    // entirely inactive layer writes none.
    await renderSizzleTimeline({ ...request, frames: [0] });
    await renderSizzleTimeline({
      ...request,
      frames: [0],
      timeline: {
        ...request.timeline,
        scenes: [{ ...scene, layers: [{ ...layer, startFrame: 30 }] }],
      },
    });
    expect(extracted).toEqual([2, 1, 1]);
  }, 30_000);

  it.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "keeps held-frame timing in the encoded movie as well as inspection",
    async () => {
      const request = await heldVideo();
      const outputPath = join(dirname(request.outputPath), "held.mp4");
      const scene = request.timeline.scenes[0]!;
      const layer = scene.layers[0]!;
      if (layer.kind !== "video") throw new Error("Video fixture required");
      for (const rate of [0.5, 1, 2]) {
        const transition = 30 / rate;
        await renderSizzleTimeline({
          ...request,
          outputPath,
          timeline: {
            ...request.timeline,
            scenes: [{ ...scene, layers: [{ ...layer, playbackRate: rate }] }],
          },
        });
        const frames = run([
          "-i",
          outputPath,
          "-an",
          "-vf",
          `select=eq(n\\,0)+eq(n\\,${transition - 1})+eq(n\\,${transition})`,
          "-fps_mode",
          "vfr",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-",
        ]);
        const sample = (frame: number): number[] => [
          ...frames.subarray(
            frame * 320 * 180 * 3 + (90 * 320 + 160) * 3,
            frame * 320 * 180 * 3 + (90 * 320 + 160) * 3 + 3,
          ),
        ];
        expect(frames.length).toBe(3 * 320 * 180 * 3);
        expectRed(sample(0));
        expectRed(sample(1));
        expectBlue(sample(2));
      }
    },
    30_000,
  );

  it("retains the tail of non-voice sources longer than ten minutes", async () => {
    const root = await temporary();
    const source = join(root, "long.wav");
    run([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=8000:duration=601",
      source,
    ]);
    const assetsRoot = join(root, "assets");
    const asset = await importTimelineAsset(assetsRoot, source, ffmpeg);
    for (const [role, fit] of [
      ["music", "strict"],
      ["sound", "speed"],
    ] as const) {
      const result = await prepareTimelineAudio({
        timeline: SizzleTimelineSchema.parse({
          version: 1,
          width: 320,
          height: 180,
          scenes: [{ id: "long", durationFrames: 18_030, layers: [] }],
          audio: [
            {
              id: "track",
              role,
              fit,
              startFrame: 0,
              durationFrames: 18_030,
              trimSilence: false,
              source: { kind: "asset", assetId: asset.id },
            },
          ],
        }),
        assets: [asset],
        assetsRoot,
        cacheRoot: join(root, role),
        ffmpeg: ffmpeg!,
        apiKey: null,
      });
      // Inspect the delivered mix, not the decoder arguments or metadata alone.
      const tail = run([
        "-ss",
        "600.5",
        "-i",
        result.path!,
        "-t",
        "0.25",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "s16le",
        "-",
      ]);
      let energy = 0;
      for (let offset = 0; offset < tail.length; offset += 2)
        energy += tail.readInt16LE(offset) ** 2;
      expect(Math.sqrt(energy / (tail.length / 2))).toBeGreaterThan(100);
      expect(result.reports[0]!.inputDurationSec).toBeCloseTo(601, 2);
    }
  }, 120_000);
});
