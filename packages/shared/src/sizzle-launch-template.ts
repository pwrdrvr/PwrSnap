import { z } from "zod";
import {
  SizzleTimelineSchema,
  type SizzleTimelineInput,
  type SizzleTimeline
} from "./sizzle-timeline";

const asset = z.string().regex(/^[a-f0-9]{64}$/);
const copy = z.string().min(1).max(500);
export const SizzleLaunchTemplateSchema = z
  .object({
    productName: copy,
    tagline: copy,
    url: copy,
    accent: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .default("#ff8a1f"),
    logo: asset,
    overview: asset,
    handoffImage: asset.optional(),
    featuresImage: asset,
    workflowImage: asset,
    workflowVideo: asset.optional(),
    safetyImage: asset,
    resultImage: asset,
    resultSequence: z.array(asset).min(1).max(8).optional(),
    intro: copy,
    context: copy,
    handoff: copy,
    features: z.array(copy).min(1).max(4),
    metricValue: z.number().finite(),
    metricLabel: copy,
    metricResult: copy,
    terminalLines: z.array(copy).min(1).max(8),
    workflowCaption: copy,
    safetyHeadline: copy,
    safetyLines: z.array(copy).min(1).max(4),
    confirmation: copy,
    resultCaption: copy,
    voiceoverAssets: z.array(asset).length(9).optional(),
    narration: z.array(z.string().min(1).max(4000)).length(9).optional(),
    pronunciation: z
      .record(z.string().min(1).max(100), z.string().min(1).max(200))
      .default({}),
    voice: z
      .enum([
        "ash",
        "alloy",
        "coral",
        "onyx",
        "nova",
        "sage",
        "shimmer",
        "marin",
        "cedar"
      ])
      .default("ash"),
    delivery: z
      .string()
      .max(4000)
      .default(
        "Fast, energetic launch narrator. Confident, conversational delivery with short pauses."
      ),
    music: z.boolean().default(true)
  })
  .strict()
  .refine(
    (data) => !(data.voiceoverAssets && data.narration),
    "Choose existing voiceover assets or generated narration"
  );
export type SizzleLaunchTemplateInput = z.input<
  typeof SizzleLaunchTemplateSchema
>;

/** Nine fixed slots from the worked launch format. Absolute boundaries are
 * rounded once; independent rounding of scene durations would add frames. */
export function buildSizzleLaunchTemplate(
  input: SizzleLaunchTemplateInput
): SizzleTimeline {
  const d = SizzleLaunchTemplateSchema.parse(input);
  const boundaries = [0, 102, 176, 243, 392, 474, 593, 750, 870, 975];
  type Layer = SizzleTimelineInput["scenes"][number]["layers"][number];
  const txt = (
    id: string,
    text: string,
    x: number,
    y: number,
    width: number,
    fontSize = 80,
    color = "#ffffff"
  ): Extract<Layer, { kind: "text" }> => ({
    kind: "text",
    id,
    text,
    x,
    y,
    width,
    height: fontSize * 3,
    fontSize,
    color,
    fadeInFrames: 6,
    fadeOutFrames: 5
  });
  const image = (
    id: string,
    assetId: string,
    x = 160,
    y = 70,
    width = 1600,
    height = 900
  ): Extract<Layer, { kind: "image" }> => ({
    kind: "image",
    id,
    assetId,
    x,
    y,
    width,
    height,
    zoomFrom: 1,
    zoomTo: 1.05,
    radius: 18,
    fadeInFrames: 7,
    fadeOutFrames: 6
  });
  const rect = (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fill = "#10131d"
  ): Extract<Layer, { kind: "rect" }> => ({
    kind: "rect",
    id,
    x,
    y,
    width,
    height,
    fill,
    radius: 20
  });
  const darken: Layer = {
    kind: "rect",
    id: "shade",
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    fill: "#000000bb"
  };
  const scenes: SizzleTimelineInput["scenes"] = [
    {
      id: "intro",
      durationFrames: 102,
      layers: [
        image("overview", d.overview),
        darken,
        txt("headline", "{{intro}}", 120, 650, 1680, 110)
      ]
    },
    {
      id: "context",
      durationFrames: 74,
      layers: [
        image("overview", d.overview),
        darken,
        txt("headline", "{{context}}", 110, 360, 1000, 100),
        ...d.features.slice(0, 4).flatMap((feature, i) => [
          rect(`card${i}`, 1200, 180 + i * 170, 630, 130),
          {
            ...txt(
              `feature${i}`,
              feature,
              1240,
              205 + i * 170,
              550,
              48,
              d.accent
            ),
            startFrame: i * 8,
            motion: {
              from: { x: 400, opacity: 0 },
              to: { x: 0, opacity: 1 },
              endFrame: 12
            }
          } as Layer
        ])
      ]
    },
    {
      id: "handoff",
      durationFrames: 67,
      layers: [
        image("overview", d.overview),
        ...(d.handoffImage
          ? [
              {
                ...image("reveal", d.handoffImage),
                startFrame: 32,
                wipeFrames: 20
              }
            ]
          : []),
        darken,
        {
          ...txt("headline", "{{handoff}}", 120, 380, 1680, 140),
          align: "center"
        }
      ]
    },
    {
      id: "features",
      durationFrames: 149,
      layers: [
        image("settings", d.featuresImage, 1000, 210, 850, 600),
        image("logo", d.logo, 80, 80, 150, 150),
        txt("product", "{{productName}}", 260, 90, 700, 100),
        ...d.features.map(
          (feature, i) =>
            ({
              ...txt(
                `feature${i}`,
                `✓ ${feature}`,
                110,
                320 + i * 155,
                850,
                60
              ),
              startFrame: i * 20,
              motion: {
                from: { x: -100, opacity: 0 },
                to: { x: 0, opacity: 1 },
                endFrame: 10
              }
            }) as Layer
        )
      ]
    },
    {
      id: "benchmark",
      durationFrames: 82,
      layers: [
        {
          kind: "counter",
          id: "number",
          width: 1800,
          height: 220,
          x: 60,
          y: 240,
          from: 0,
          to: { binding: "metricValue" },
          countFrames: 28,
          fontSize: 170,
          fontFamily: "monospace",
          align: "center"
        },
        {
          ...txt("label", "{{metricLabel}}", 60, 460, 1800, 56),
          align: "center"
        },
        {
          ...txt("result", "{{metricResult}}", 60, 650, 1800, 100, d.accent),
          align: "center",
          startFrame: 40
        }
      ]
    },
    {
      id: "workflow",
      durationFrames: 119,
      layers: [
        d.workflowVideo
          ? {
              kind: "video",
              id: "workflow",
              assetId: d.workflowVideo,
              x: 900,
              y: 150,
              width: 960,
              height: 600,
              fadeInFrames: 7
            }
          : image("workflow", d.workflowImage, 900, 150, 960, 600),
        {
          kind: "terminal",
          id: "terminal",
          x: 70,
          y: 150,
          width: 790,
          height: 550,
          fontSize: 28,
          lines: d.terminalLines.map((text) => ({ text, color: d.accent })),
          lineDelayFrames: 10,
          revealFrames: 8
        },
        txt("caption", "{{workflowCaption}}", 80, 820, 1700, 66)
      ]
    },
    {
      id: "safety",
      durationFrames: 157,
      layers: [
        image("safety", d.safetyImage, 960, 200, 880, 540),
        {
          kind: "terminal",
          id: "terminal",
          x: 70,
          y: 170,
          width: 820,
          height: 260,
          fontSize: 28,
          lines: d.safetyLines.map((text) => ({ text, color: d.accent }))
        },
        txt("headline", "{{safetyHeadline}}", 100, 480, 800, 88, d.accent),
        rect("field", 80, 780, 820, 110),
        {
          kind: "typing",
          id: "confirmation",
          x: 105,
          y: 790,
          width: 780,
          height: 90,
          text: "{{confirmation}}",
          fontSize: 44,
          fontFamily: "monospace",
          startFrame: 80,
          revealFrames: 36
        }
      ]
    },
    {
      id: "result",
      durationFrames: 120,
      layers: [
        ...(d.resultSequence ?? [d.resultImage]).map((assetId, i, list) => ({
          ...image(`result${i}`, assetId),
          startFrame: Math.floor((i * 120) / list.length),
          endFrame: Math.min(120, Math.floor(((i + 1) * 120) / list.length) + 7)
        })),
        rect("caption-bg", 0, 890, 1920, 190, "#000000cc"),
        {
          ...txt("caption", "{{resultCaption}}", 60, 920, 1800, 72, d.accent),
          align: "center",
          startFrame: 35
        }
      ]
    },
    {
      id: "end",
      durationFrames: 105,
      layers: [
        image("logo", d.logo, 320, 210, 220, 220),
        txt("product", "{{productName}}", 590, 220, 1100, 150),
        {
          ...txt("tagline", "{{tagline}}", 80, 480, 1760, 90, d.accent),
          align: "center"
        },
        {
          ...txt("url", "{{url}}", 80, 680, 1760, 44),
          align: "center",
          fontFamily: "monospace"
        }
      ]
    }
  ];
  const audio: NonNullable<SizzleTimelineInput["audio"]> = [];
  for (let i = 0; i < 9; i++) {
    const startFrame = boundaries[i]! + (i === 0 ? 9 : 0);
    const assetId = d.voiceoverAssets?.[i],
      narration = d.narration?.[i];
    if (assetId || narration)
      audio.push({
        id: `voice${i + 1}`,
        role: "voice",
        startFrame,
        durationFrames: boundaries[i + 1]! - startFrame,
        fit: "speed",
        maxSpeed: 1.35,
        trimSilence: true,
        source: assetId
          ? { kind: "asset", assetId }
          : {
              kind: "speech",
              text: narration!,
              voice: d.voice,
              instructions: d.delivery,
              pronunciation: d.pronunciation
            }
      });
  }
  if (d.music)
    audio.push({
      id: "music",
      role: "music",
      startFrame: 0,
      durationFrames: 975,
      volume: 0.4,
      source: {
        kind: "synth",
        bpm: 128,
        dropFrame: 231,
        finalHitFrame: 870,
        seed: 7
      },
      fadeOutFrames: 36
    });
  const {
    intro,
    context,
    handoff,
    productName,
    tagline,
    url,
    metricValue,
    metricLabel,
    metricResult,
    workflowCaption,
    safetyHeadline,
    confirmation,
    resultCaption
  } = d;
  return SizzleTimelineSchema.parse({
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    bindings: {
      intro,
      context,
      handoff,
      productName,
      tagline,
      url,
      metricValue,
      metricLabel,
      metricResult,
      workflowCaption,
      safetyHeadline,
      confirmation,
      resultCaption
    },
    scenes,
    audio
  });
}
