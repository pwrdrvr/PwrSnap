import { z } from "zod";

const frame = z.number().int().min(0).max(36_000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const color = z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/);
const text = z.string().max(4000);
const scalar = z.union([
  z.number().finite(),
  z.object({ binding: id }).strict()
]);
const pose = z
  .object({
    x: z.number().min(-8192).max(8192).default(0),
    y: z.number().min(-8192).max(8192).default(0),
    scale: z.number().min(0.01).max(10).default(1),
    rotation: z.number().min(-360).max(360).default(0),
    opacity: z.number().min(0).max(1).default(1)
  })
  .strict();
const base = {
  id,
  x: z.number().min(-8192).max(8192).default(0),
  y: z.number().min(-8192).max(8192).default(0),
  width: z.number().positive().max(8192),
  height: z.number().positive().max(8192),
  startFrame: frame.default(0),
  endFrame: frame.optional(),
  fadeInFrames: frame.default(0),
  fadeOutFrames: frame.default(0),
  motion: z
    .object({
      from: pose,
      to: pose,
      startFrame: frame.default(0),
      endFrame: frame,
      easing: z.enum(["linear", "ease-in-out", "ease-out"]).default("ease-out")
    })
    .strict()
    .optional()
};
const typography = {
  fontSize: z.number().min(8).max(500).default(64),
  fontFamily: z
    .enum(["sans-serif", "monospace", "Geist", "Geist Mono"])
    .default("sans-serif"),
  fontWeight: z.enum(["400", "600", "700", "800"]).default("700"),
  color: color.default("#ffffff"),
  align: z.enum(["left", "center", "right"]).default("left"),
  lineHeight: z.number().min(0.8).max(3).default(1.2)
};
const media = {
  assetId: id,
  fit: z.enum(["contain", "cover"]).default("contain"),
  zoomFrom: z.number().min(1).max(8).default(1),
  zoomTo: z.number().min(1).max(8).default(1),
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
  radius: z.number().min(0).max(1000).default(0),
  wipeFrames: frame.default(0)
};

export const SizzleTimelineLayerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("rect"),
      fill: color,
      stroke: color.optional(),
      strokeWidth: z.number().min(0).max(50).default(0),
      radius: z.number().min(0).max(1000).default(0)
    })
    .strict(),
  z.object({ ...base, ...typography, kind: z.literal("text"), text }).strict(),
  z
    .object({
      ...base,
      ...typography,
      kind: z.literal("counter"),
      from: scalar.default(0),
      to: scalar,
      countFrames: frame,
      prefix: text.default(""),
      suffix: text.default("")
    })
    .strict(),
  z
    .object({
      ...base,
      ...typography,
      kind: z.literal("typing"),
      text,
      revealFrames: frame,
      caret: z.boolean().default(true)
    })
    .strict(),
  z
    .object({
      ...base,
      ...typography,
      kind: z.literal("terminal"),
      lines: z
        .array(z.object({ text, color: color.default("#ffffff") }).strict())
        .min(1)
        .max(100),
      lineDelayFrames: frame.default(10),
      revealFrames: frame.default(8),
      fill: color.default("#10131d"),
      padding: z.number().min(0).max(200).default(24)
    })
    .strict(),
  z.object({ ...base, ...media, kind: z.literal("image") }).strict(),
  z
    .object({
      ...base,
      ...media,
      kind: z.literal("video"),
      sourceStartSec: z.number().min(0).max(86400).default(0),
      playbackRate: z.number().min(0.25).max(4).default(1),
      endBehavior: z.enum(["freeze", "loop"]).default("freeze")
    })
    .strict()
]);

export const SizzleTimelineAudioSchema = z
  .object({
    id,
    role: z.enum(["voice", "music", "sound"]).default("voice"),
    startFrame: frame,
    durationFrames: frame.min(1),
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("synth"),
          bpm: z.number().min(60).max(200).default(128),
          dropFrame: frame.default(0),
          finalHitFrame: frame.optional(),
          seed: z.number().int().min(0).max(0xffffffff).default(7)
        })
        .strict(),
      z
        .object({
          kind: z.literal("asset"),
          assetId: id,
          trimStartSec: z.number().min(0).max(86400).default(0)
        })
        .strict(),
      z
        .object({
          kind: z.literal("speech"),
          text,
          voice: z
            .enum([
              "alloy",
              "ash",
              "ballad",
              "coral",
              "echo",
              "fable",
              "onyx",
              "nova",
              "sage",
              "shimmer",
              "verse",
              "marin",
              "cedar"
            ])
            .default("ash"),
          model: z.literal("gpt-4o-mini-tts").default("gpt-4o-mini-tts"),
          instructions: text.default(""),
          pronunciation: z
            .record(z.string().min(1).max(100), z.string().min(1).max(200))
            .default({}),
          speed: z.number().min(0.25).max(4).default(1),
          takeId: id.default("default")
        })
        .strict()
    ]),
    volume: z.number().min(0).max(4).default(1),
    fit: z.enum(["strict", "speed", "trim", "loop"]).default("strict"),
    maxSpeed: z.number().min(1).max(2).default(1.35),
    trimSilence: z.boolean().default(false),
    expectedText: text.optional(),
    fadeInFrames: frame.default(0),
    fadeOutFrames: frame.default(0)
  })
  .strict();

export const SizzleTimelineSchema = z
  .object({
    version: z.literal(1),
    width: z
      .number()
      .int()
      .min(320)
      .max(3840)
      .refine((n) => n % 2 === 0),
    height: z
      .number()
      .int()
      .min(180)
      .max(2160)
      .refine((n) => n % 2 === 0),
    fps: z
      .union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)])
      .default(30),
    bindings: z
      .record(id, z.union([z.string().max(4000), z.number().finite()]))
      .refine(
        (value) => Object.keys(value).length <= 200,
        "At most 200 bindings"
      )
      .default({}),
    scenes: z
      .array(
        z
          .object({
            id,
            durationFrames: frame.min(1),
            background: color.default("#000000"),
            layers: z.array(SizzleTimelineLayerSchema).max(100)
          })
          .strict()
      )
      .min(1)
      .max(100),
    audio: z.array(SizzleTimelineAudioSchema).max(100).default([]),
    mix: z
      .object({
        duckMusic: z.boolean().default(true),
        loudnessLufs: z.number().min(-30).max(-9).default(-14)
      })
      .strict()
      .default({ duckMusic: true, loudnessLufs: -14 })
  })
  .strict()
  .superRefine((timeline, ctx) => {
    const total = timeline.scenes.reduce(
      (sum, scene) => sum + scene.durationFrames,
      0
    );
    if (total > 36_000)
      ctx.addIssue({
        code: "custom",
        message: "Timeline exceeds 36000 frames"
      });
    const unique = (values: string[], path: (string | number)[]): void => {
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: "custom", path, message: "IDs must be unique" });
    };
    unique(
      timeline.scenes.map((s) => s.id),
      ["scenes"]
    );
    unique(
      timeline.audio.map((a) => a.id),
      ["audio"]
    );
    timeline.scenes.forEach((scene, si) => {
      unique(
        scene.layers.map((l) => l.id),
        ["scenes", si, "layers"]
      );
      scene.layers.forEach((layer, li) => {
        if (
          layer.startFrame >= (layer.endFrame ?? scene.durationFrames) ||
          (layer.endFrame ?? 0) > scene.durationFrames
        )
          ctx.addIssue({
            code: "custom",
            path: ["scenes", si, "layers", li],
            message: "Layer window must lie within its scene"
          });
        if (layer.motion && layer.motion.endFrame <= layer.motion.startFrame)
          ctx.addIssue({
            code: "custom",
            message: "Motion end must follow start"
          });
      });
    });
    timeline.audio.forEach((track, i) => {
      if (track.source.kind === "synth" && track.role !== "music")
        ctx.addIssue({
          code: "custom",
          path: ["audio", i],
          message: "Synthesized beds must use the music role"
        });
      if (
        track.source.kind === "synth" &&
        (track.source.dropFrame >= track.durationFrames ||
          (track.source.finalHitFrame !== undefined &&
            (track.source.finalHitFrame < track.source.dropFrame ||
              track.source.finalHitFrame >= track.durationFrames)))
      )
        ctx.addIssue({
          code: "custom",
          path: ["audio", i],
          message:
            "Music hit positions must lie within the track after its drop"
        });
      if (track.startFrame + track.durationFrames > total)
        ctx.addIssue({
          code: "custom",
          path: ["audio", i],
          message: "Audio slot extends beyond timeline"
        });
      if (
        track.role === "voice" &&
        (track.fit === "trim" || track.fit === "loop")
      )
        ctx.addIssue({
          code: "custom",
          path: ["audio", i],
          message: "Voice slots may not truncate or loop speech"
        });
    });
  });

export type SizzleTimeline = z.infer<typeof SizzleTimelineSchema>;
export type SizzleTimelineInput = z.input<typeof SizzleTimelineSchema>;
export type SizzleTimelineLayer = z.infer<typeof SizzleTimelineLayerSchema>;
export type SizzleTimelineAudio = z.infer<typeof SizzleTimelineAudioSchema>;
export const SizzleAssetSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().max(200),
    kind: z.enum(["image", "video", "audio"]),
    extension: z.enum([
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".mp4",
      ".mov",
      ".m4v",
      ".wav",
      ".mp3",
      ".m4a",
      ".flac",
      ".aac"
    ]),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 ** 3),
    durationSec: z.number().min(0).max(86400),
    width: z.number().int().min(0).max(40_000),
    height: z.number().int().min(0).max(40_000)
  })
  .strict();
export type SizzleAsset = z.infer<typeof SizzleAssetSchema>;

export function validateSizzleTimelineAssets(
  timeline: SizzleTimeline,
  assets: readonly SizzleAsset[]
): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const scene of timeline.scenes) {
    resolveSizzleScene(scene, timeline.bindings);
    for (const layer of scene.layers)
      if (layer.kind === "image" || layer.kind === "video") {
        if (byId.get(layer.assetId)?.kind !== layer.kind)
          throw new Error(`Missing ${layer.kind} asset for layer ${layer.id}`);
      }
  }
  for (const track of timeline.audio) {
    if (
      track.source.kind === "asset" &&
      !["audio", "video"].includes(byId.get(track.source.assetId)?.kind ?? "")
    )
      throw new Error(`Missing audio asset for track ${track.id}`);
    if (track.source.kind === "speech")
      resolveSizzleText(track.source.text, timeline.bindings);
    if (track.expectedText)
      resolveSizzleText(track.expectedText, timeline.bindings);
  }
}

export function sizzleTimelineFrames(timeline: SizzleTimeline): number {
  return timeline.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
}

export function resolveSizzleText(
  value: string,
  bindings: SizzleTimeline["bindings"]
): string {
  const visit = (text: string, active: ReadonlySet<string>): string => {
    const result = text.replace(
      /\{\{([\w-]+)(\|number)?\}\}/g,
      (_, key: string, format: string | undefined) => {
        const resolved = Object.hasOwn(bindings, key)
          ? bindings[key]
          : undefined;
        if (resolved === undefined) throw new Error(`Unknown binding: ${key}`);
        if (active.has(key) || active.size >= 20)
          throw new Error(
            "Bindings must be acyclic with a maximum depth of 20"
          );
        if (typeof resolved === "number")
          return format ? resolved.toLocaleString("en-US") : String(resolved);
        return visit(resolved, new Set([...active, key]));
      }
    );
    if (result.length > 16_000)
      throw new Error("Resolved text exceeds 16000 characters");
    return result;
  };
  return visit(value, new Set());
}

export function resolveSizzleNumber(
  value: number | { binding: string },
  bindings: SizzleTimeline["bindings"]
): number {
  const resolved =
    typeof value === "number"
      ? value
      : Object.hasOwn(bindings, value.binding)
        ? bindings[value.binding]
        : undefined;
  if (typeof resolved !== "number" || !Number.isFinite(resolved))
    throw new Error("Counter binding must be a finite number");
  return resolved;
}

/** Resolve only a scene's dependencies: changing VO or another scene preserves its visual cache. */
export function resolveSizzleScene(
  scene: SizzleTimeline["scenes"][number],
  bindings: SizzleTimeline["bindings"]
): SizzleTimeline["scenes"][number] {
  return {
    ...scene,
    layers: scene.layers.map((layer) => {
      if (layer.kind === "counter")
        return {
          ...layer,
          from: resolveSizzleNumber(layer.from, bindings),
          to: resolveSizzleNumber(layer.to, bindings),
          prefix: resolveSizzleText(layer.prefix, bindings),
          suffix: resolveSizzleText(layer.suffix, bindings)
        };
      if (layer.kind === "text" || layer.kind === "typing")
        return { ...layer, text: resolveSizzleText(layer.text, bindings) };
      if (layer.kind === "terminal")
        return {
          ...layer,
          lines: layer.lines.map((line) => ({
            ...line,
            text: resolveSizzleText(line.text, bindings)
          }))
        };
      return layer;
    })
  };
}
