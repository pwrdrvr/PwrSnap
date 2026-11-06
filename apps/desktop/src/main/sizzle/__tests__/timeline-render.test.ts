import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SizzleTimelineSchema, type SizzleAsset } from "@pwrsnap/shared";
import {
  timelineSceneCacheKey,
  renderSizzleTimeline
} from "../timeline-render";
import { importTimelineAsset } from "../timeline-assets";
import {
  fitTimelineAudio,
  timelineTranscriptMatches,
  prepareTimelineAudio
} from "../timeline-audio";
import { synthesizeTimelineMusic } from "../timeline-music";
import { inspectTimelineAudio } from "../timeline-audio-qa";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const temporary = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pwrsnap-timeline-"));
  roots.push(root);
  return root;
};
const timeline = () =>
  SizzleTimelineSchema.parse({
    version: 1,
    width: 320,
    height: 180,
    bindings: { count: 10 },
    scenes: [
      {
        id: "benchmark",
        durationFrames: 6,
        layers: [
          {
            id: "count",
            kind: "counter",
            width: 300,
            height: 120,
            to: { binding: "count" },
            countFrames: 3
          }
        ]
      },
      {
        id: "outro",
        durationFrames: 6,
        layers: [
          { id: "title", kind: "text", width: 300, height: 120, text: "Done" }
        ]
      }
    ]
  });
const ffmpeg = process.env.PWRSNAP_FFMPEG_PATH ?? "ffmpeg";
let available = false;
try {
  available = execFileSync(ffmpeg, ["-hide_banner", "-encoders"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).includes("h264_videotoolbox");
} catch {
  /* integration requires the vetted encoder */
}

describe("timeline cache and fixed narration slots", () => {
  it("verifies narrated integers independently of sentence length and ASR number spelling", () => {
    expect(timelineTranscriptMatches("one two three", "six")).toBe(false);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), (value) => {
        const tail = Array.from({ length: 50 }, () => "safe").join(" ");
        expect(
          timelineTranscriptMatches(
            `${value} percent ${tail}`,
            `${value + 1} percent ${tail}`
          )
        ).toBe(false);
      })
    );
    expect(
      timelineTranscriptMatches(
        "33,524,125 files",
        "thirty-three million five hundred twenty-four thousand one hundred twenty-five files"
      )
    ).toBe(true);
    expect(
      timelineTranscriptMatches(
        "11 percent of your disk",
        "eleven percent of your disc"
      )
    ).toBe(true);
  });
  it("accepts disk/disc homophone spelling from live transcription without accepting a different name", () => {
    const aliases: [string, string][] = [["PwrDisk", "Power Disk"]];
    expect(
      timelineTranscriptMatches(
        "Power Disk. Get your disk back.",
        "PowerDisc. Get your disc back.",
        aliases
      )
    ).toBe(true);
    expect(
      timelineTranscriptMatches(
        "Power Disk. Get your disk back.",
        "PowerDesk. Get your disc back.",
        aliases
      )
    ).toBe(false);
  });
  it("never hides a pronunciation error in a long otherwise-correct line", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 80 }), (length) => {
        const tail = Array.from({ length }, () => "safe").join(" ");
        expect(
          timelineTranscriptMatches(
            `Power Disk ${tail}`,
            `Power Desk ${tail}`,
            [["PwrDisk", "Power Disk"]]
          )
        ).toBe(false);
        expect(
          timelineTranscriptMatches(`Power Disk ${tail}`, `PwrDisk ${tail}`, [
            ["PwrDisk", "Power Disk"]
          ])
        ).toBe(true);
      })
    );
  });
  it("synthesizes the same PCM music for the same seed and gives it an exact sample count", async () => {
    const args = { durationSec: 0.1, bpm: 128, dropSec: 0.02, seed: 7 };
    const first = await synthesizeTimelineMusic(args);
    expect(await synthesizeTimelineMusic(args)).toEqual(first);
    expect(await synthesizeTimelineMusic({ ...args, seed: 8 })).not.toEqual(
      first
    );
    expect(first.length).toBe(44 + 4800 * 4);
    await expect(
      synthesizeTimelineMusic(args, AbortSignal.abort())
    ).rejects.toThrow();
  });
  it("invalidates exactly the scenes depending on a changed value", () => {
    const before = timeline();
    fc.assert(
      fc.property(fc.integer({ min: 11, max: 100_000_000 }), (count) => {
        const after = { ...before, bindings: { count } };
        const args = { width: 320, height: 180, platform: "darwin" as const };
        expect(
          timelineSceneCacheKey(
            { ...args, timeline: before },
            before.scenes[0]!
          )
        ).not.toBe(
          timelineSceneCacheKey({ ...args, timeline: after }, after.scenes[0]!)
        );
        expect(
          timelineSceneCacheKey(
            { ...args, timeline: before },
            before.scenes[1]!
          )
        ).toBe(
          timelineSceneCacheKey({ ...args, timeline: after }, after.scenes[1]!)
        );
        expect(
          timelineSceneCacheKey(
            { ...args, timeline: before },
            before.scenes[1]!
          )
        ).toBe(
          timelineSceneCacheKey(
            { ...args, timeline: { ...before, audio: [] } },
            before.scenes[1]!
          )
        );
      })
    );
  });

  it("fits speech only within the permitted rate and otherwise fails explicitly", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 30, noNaN: true }),
        fc.double({ min: 1.01, max: 1.35, noNaN: true }),
        (slot, ratio) => {
          const rate = fitTimelineAudio(slot * ratio, slot, "speed", 1.35);
          expect(rate).toBeLessThanOrEqual(1.35);
          expect((slot * ratio) / rate).toBeLessThanOrEqual(slot + 0.015001);
          expect(() =>
            fitTimelineAudio(slot * 2, slot, "strict", 1.35)
          ).toThrow();
          expect(() =>
            fitTimelineAudio(slot * 2, slot, "speed", 1.35)
          ).toThrow();
        }
      )
    );
    expect(
      timelineTranscriptMatches(
        "Power Disk. Get your disk back!",
        "Power Disk get your disk back"
      )
    ).toBe(true);
    expect(timelineTranscriptMatches("Disk Tree", "Disk Free")).toBe(false);
  });

  it("rejects renamed text, remote URLs, and directories as media imports", async () => {
    const root = await temporary();
    const fake = join(root, "secret.mp4");
    await writeFile(fake, "this is definitely not media");
    await expect(
      importTimelineAsset(join(root, "assets"), fake, ffmpeg)
    ).rejects.toThrow("header");
    await expect(
      importTimelineAsset(
        join(root, "assets"),
        "https://example.invalid/video.mp4",
        ffmpeg
      )
    ).rejects.toThrow("absolute local");
    await expect(
      importTimelineAsset(join(root, "assets"), root, ffmpeg)
    ).rejects.toThrow();
  });

  it("stores a byte-identical managed copy rather than retaining the source path", async () => {
    const root = await temporary();
    const path = join(root, "photo.png"),
      assetsRoot = join(root, "assets");
    const source = await sharp({
      create: { width: 80, height: 40, channels: 3, background: "red" }
    })
      .png()
      .toBuffer();
    await writeFile(path, source);
    // Still images use Sharp and must remain importable without an encoder.
    const asset = await importTimelineAsset(assetsRoot, path, null);
    expect(asset).toMatchObject({
      kind: "image",
      width: 80,
      height: 40,
      name: "photo.png"
    });
    expect(JSON.stringify(asset)).not.toContain(root);
    expect(await readFile(join(assetsRoot, `${asset.id}.png`))).toEqual(source);
    await writeFile(path, "source changed");
    expect(await readFile(join(assetsRoot, `${asset.id}.png`))).toEqual(source);
  });
});

describe.skipIf(!available)("timeline media oracle (nonheaded)", () => {
  it("keeps a quiet word ending when trimming silence from an already tight take", async () => {
    const root = await temporary();
    const source = join(root, "quiet-ending.wav");
    // A loud syllable followed by a 100 ms, -54 dBFS consonant. The
    // consonant is below the silence detector, but is still part of speech.
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=if(between(t\\,0.2\\,0.7)\\,0.1*sin(2*PI*440*t)\\,if(between(t\\,0.7\\,0.8)\\,0.002*sin(2*PI*1600*t)\\,0)):s=48000:d=1",
      "-c:a",
      "pcm_s16le",
      source,
    ]);
    const assetsRoot = join(root, "assets"),
      cacheRoot = join(root, "cache");
    const asset = await importTimelineAsset(assetsRoot, source, ffmpeg);
    const t = SizzleTimelineSchema.parse({
      ...timeline(),
      scenes: [{ id: "voice", durationFrames: 30, layers: [] }],
      audio: [
        {
          id: "voice",
          startFrame: 0,
          durationFrames: 30,
          trimSilence: true,
          source: { kind: "asset", assetId: asset.id },
        },
      ],
    });
    await prepareTimelineAudio({
      timeline: t,
      assets: [asset],
      assetsRoot,
      cacheRoot,
      ffmpeg,
      apiKey: null,
    });
    const prepared = (await readdir(cacheRoot)).find((name) =>
      /^track-.*\.wav$/.test(name),
    )!;
    const pcm = execFileSync(ffmpeg, [
      "-v",
      "error",
      "-i",
      join(cacheRoot, prepared),
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-",
    ]);
    let lastLoud = 0,
      lastQuiet = 0;
    for (let i = 0; i < pcm.length / 2; i++) {
      const sample = Math.abs(pcm.readInt16LE(i * 2));
      if (sample > 500) lastLoud = i;
      if (sample > 10) lastQuiet = i;
    }
    // This oracle checks the output waveform, not the filter string or ASR
    // guessing a complete word from a clipped prefix.
    expect((lastQuiet - lastLoud) / 48000).toBeGreaterThan(0.09);
  }, 30_000);
  it("sends delivery and pronunciation controls, verifies speech, and caches unchanged takes", async () => {
    const root = await temporary();
    const wavPath = join(root, "take.wav");
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.5",
      wavPath
    ]);
    const wav = await readFile(wavPath);
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push({
          url,
          body: typeof options.body === "string" ? options.body : "multipart"
        });
        return url.endsWith("/speech")
          ? new Response(wav)
          : Response.json({ text: "Power Disk get your disk back" });
      })
    );
    const t = SizzleTimelineSchema.parse({
      version: 1,
      width: 320,
      height: 180,
      scenes: [{ id: "voice", durationFrames: 30, layers: [] }],
      audio: [
        {
          id: "voice",
          role: "voice",
          startFrame: 0,
          durationFrames: 30,
          source: {
            kind: "speech",
            text: "PwrDisk. Get your disk back.",
            voice: "ash",
            instructions: "FAST delivery",
            pronunciation: { PwrDisk: "Power Disk" },
            speed: 1.2
          }
        }
      ]
    });
    const args = {
      timeline: t,
      assets: [],
      assetsRoot: root,
      cacheRoot: join(root, "cache"),
      ffmpeg,
      apiKey: "test-secret-never-log"
    };
    const first = await prepareTimelineAudio(args);
    const cached = await prepareTimelineAudio(args);
    expect(cached).toEqual(first);
    expect(requests).toHaveLength(2);
    await prepareTimelineAudio({
      ...args,
      timeline: { ...t, audio: [{ ...t.audio[0]!, volume: 0.8 }] }
    });
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      input: "Power Disk. Get your disk back.",
      voice: "ash",
      speed: 1.2,
      instructions: "FAST delivery"
    });
    expect(first.reports[0]?.qa).toBe("matched");
    expect(JSON.stringify(requests)).not.toContain("test-secret-never-log");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("test-secret-never-log", { status: 401 }))
    );
    const track = t.audio[0]!;
    if (track.source.kind !== "speech")
      throw new Error("Speech fixture required");
    await expect(
      prepareTimelineAudio({
        ...args,
        timeline: {
          ...t,
          audio: [
            {
              ...track,
              source: { ...track.source, instructions: "different take" }
            }
          ]
        }
      })
    ).rejects.toThrow("HTTP 401");
  }, 30_000);
  it("encodes exact frame counts and reuses the unaffected scene on a binding revision", async () => {
    const root = await temporary();
    const t = timeline();
    const request = {
      timeline: t,
      assets: [] as SizzleAsset[],
      assetsRoot: root,
      cacheRoot: join(root, "cache"),
      ffmpeg,
      platform: "darwin" as const,
      width: 320,
      height: 180,
      outputPath: join(root, "movie.mp4")
    };
    const first = await renderSizzleTimeline(request);
    expect(first).toMatchObject({
      frames: 12,
      renderedScenes: 2,
      cachedScenes: 0
    });
    const second = await renderSizzleTimeline({
      ...request,
      timeline: { ...t, bindings: { count: 99 } }
    });
    expect(second).toMatchObject({
      frames: 12,
      renderedScenes: 1,
      cachedScenes: 1
    });
    const raw = execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        request.outputPath,
        "-map",
        "0:v:0",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-"
      ],
      { maxBuffer: 20 * 1024 ** 2 }
    );
    expect(raw.length / (320 * 180 * 3)).toBe(12);
    await expect(
      renderSizzleTimeline(request, AbortSignal.abort())
    ).rejects.toThrow();
  }, 30_000);

  it("imports moving footage, inspects its frames, and freezes its final frame", async () => {
    const root = await temporary();
    const clip = join(root, "motion.mov");
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=30:d=0.2",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      clip
    ]);
    const asset = await importTimelineAsset(join(root, "assets"), clip, ffmpeg);
    const t = SizzleTimelineSchema.parse({
      version: 1,
      width: 320,
      height: 180,
      scenes: [
        {
          id: "motion",
          durationFrames: 30,
          layers: [
            {
              id: "clip",
              kind: "video",
              assetId: asset.id,
              width: 320,
              height: 180
            }
          ]
        }
      ]
    });
    const outputPath = join(root, "contact.png");
    await renderSizzleTimeline({
      timeline: t,
      assets: [asset],
      assetsRoot: join(root, "assets"),
      cacheRoot: join(root, "cache"),
      ffmpeg,
      platform: "darwin",
      width: 320,
      height: 180,
      outputPath,
      frames: [0, 5, 20]
    });
    const png = sharp(await readFile(outputPath));
    expect(await png.metadata()).toMatchObject({ width: 960, height: 180 });
    const a = await png
      .clone()
      .extract({ left: 0, top: 0, width: 320, height: 180 })
      .png()
      .toBuffer();
    const b = await png
      .clone()
      .extract({ left: 320, top: 0, width: 320, height: 180 })
      .png()
      .toBuffer();
    const c = await png
      .clone()
      .extract({ left: 640, top: 0, width: 320, height: 180 })
      .png()
      .toBuffer();
    expect(a).not.toEqual(b);
    expect(b).toEqual(c);
  }, 30_000);

  it("fits existing narration and ducks a music bed without API access", async () => {
    const root = await temporary();
    const assetsRoot = join(root, "assets"),
      cacheRoot = join(root, "cache");
    await mkdir(cacheRoot);
    const assets: SizzleAsset[] = [];
    for (const [name, hz] of [
      ["voice", 440],
      ["music", 110]
    ] as const) {
      const path = join(root, `${name}.wav`);
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${hz}:duration=0.5`,
        path
      ]);
      assets.push(await importTimelineAsset(assetsRoot, path, ffmpeg));
    }
    const t = SizzleTimelineSchema.parse({
      ...timeline(),
      scenes: [{ id: "audio", durationFrames: 30, layers: [] }],
      audio: [
        {
          id: "voice",
          startFrame: 3,
          durationFrames: 12,
          fit: "speed",
          source: { kind: "asset", assetId: assets[0]!.id }
        },
        {
          id: "music",
          role: "music",
          startFrame: 0,
          durationFrames: 30,
          fit: "loop",
          source: { kind: "asset", assetId: assets[1]!.id }
        }
      ]
    });
    const result = await prepareTimelineAudio({
      timeline: t,
      assets,
      assetsRoot,
      cacheRoot,
      ffmpeg,
      apiKey: null
    });
    expect(result.reports[0]).toMatchObject({
      playbackRate: 1.25,
      slotDurationSec: 0.4,
      qa: "not_requested"
    });
    expect(result.path).toBeTruthy();
    const samples = execFileSync(ffmpeg, [
      "-v",
      "error",
      "-i",
      result.path!,
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-"
    ]);
    expect(samples.length).toBe(48_000 * 2 * 2);
    await writeFile(
      `${result.path}.timeline.json`,
      JSON.stringify({
        ...t,
        audio: t.audio.map((track) =>
          track.role === "voice"
            ? { ...track, expectedText: "Power Disk" }
            : track
        )
      })
    );
    const transcribe = vi.fn(async () => Response.json({ text: "Power Disk" }));
    vi.stubGlobal("fetch", transcribe);
    const qa = await inspectTimelineAudio({
      outputPath: result.path!,
      cacheRoot,
      ffmpeg,
      apiKey: "test-key"
    });
    expect(qa).toMatchObject({
      transcript: "Power Disk",
      expectedText: "Power Disk",
      matches: true
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(
      await inspectTimelineAudio({
        outputPath: result.path!,
        cacheRoot,
        ffmpeg,
        apiKey: "test-key"
      })
    ).toEqual(qa);
    expect(transcribe).toHaveBeenCalledTimes(1);
  }, 30_000);
});
