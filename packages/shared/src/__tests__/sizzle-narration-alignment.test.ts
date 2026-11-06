import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { alignSizzleTimelineNarration } from "../sizzle-narration-alignment";
import { SizzleTimelineSchema, sizzleTimelineFrames } from "../sizzle-timeline";
import type { SizzleSpeechTiming } from "../protocol";

const makeTimeline = () =>
  SizzleTimelineSchema.parse({
    version: 1,
    width: 320,
    height: 180,
    scenes: ["intro", "scan", "result"].map((id) => ({
      id,
      durationFrames: 90,
      layers: [
        {
          id: "title",
          kind: "typing",
          text: id,
          width: 300,
          height: 100,
          startFrame: 30,
          endFrame: 90,
          revealFrames: 50,
        },
      ],
    })),
    audio: [
      {
        id: "narration",
        startFrame: 0,
        durationFrames: 270,
        source: { kind: "speech", text: "Start scan done" },
      },
      {
        id: "music",
        role: "music",
        startFrame: 0,
        durationFrames: 270,
        source: { kind: "synth", dropFrame: 90, finalHitFrame: 180 },
      },
    ],
  });
const timing = (
  scan: number,
  done: number,
  durationSec: number,
): SizzleSpeechTiming => ({
  text: "Start scan done",
  durationSec,
  quality: "precise",
  warnings: [],
  words: [
    ["Start", 0, 0.5],
    ["scan", scan, scan + 0.5],
    ["done", done, done + 0.5],
  ].map(([word, startSec, endSec], index) => ({
    index,
    word: String(word),
    normalized: String(word).toLowerCase(),
    startSec: Number(startSec),
    endSec: Number(endSec),
  })),
});
const cues = [
  { sceneId: "scan", phrase: "scan" },
  { sceneId: "result", phrase: "done" },
];

describe("narration-led layered timelines", () => {
  it("uses measured word anchors while preserving one complete narration source", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 1, max: 80 }),
        (a, b) => {
          const t = makeTimeline(),
            before = JSON.stringify(t);
          const measured = timing(a, a + b, a + b + 1);
          const aligned = alignSizzleTimelineNarration(t, measured, cues);
          expect(aligned.scenes.map((scene) => scene.durationFrames)).toEqual([
            a * 30,
            b * 30,
            45,
          ]);
          expect(sizzleTimelineFrames(aligned)).toBe(
            Math.ceil(measured.durationSec * 30) + 15,
          );
          const voice = aligned.audio.filter((track) => track.role === "voice");
          expect(voice).toHaveLength(1);
          expect(voice[0]).toMatchObject({
            source: t.audio[0]!.source,
            startFrame: 0,
            durationFrames: sizzleTimelineFrames(aligned),
            trimSilence: false,
            fit: "strict",
          });
          expect(aligned.audio[1]!.source).toMatchObject({
            dropFrame: a * 30,
            finalHitFrame: (a + b) * 30,
          });
          expect(alignSizzleTimelineNarration(aligned, measured, cues)).toEqual(aligned);
      expect(JSON.stringify(t)).toBe(before);
          expect(SizzleTimelineSchema.safeParse(aligned).success).toBe(true);
        },
      ),
    );
  });
  it("supports the end of a repeated phrase plus an explicit timing offset", () => {
    const measured = timing(1, 3, 5);
    measured.words.push({
      index: 3,
      word: "scan",
      normalized: "scan",
      startSec: 4,
      endSec: 4.3,
    });
    const aligned = alignSizzleTimelineNarration(makeTimeline(), measured, [
      { sceneId: "scan", phrase: "scan", edge: "end", offsetSec: 0.1 },
      { sceneId: "result", phrase: "scan", occurrence: 2 },
    ]);
    expect(aligned.scenes.map((scene) => scene.durationFrames)).toEqual([
      48, 72, 45,
    ]);
  });
  it("refuses guessed, missing, reordered or incomplete anchors instead of silently cutting audio", () => {
    const t = makeTimeline(),
      measured = timing(1, 3, 5);
    expect(() =>
      alignSizzleTimelineNarration(
        t,
        { ...measured, quality: "approximate" },
        cues,
      ),
    ).toThrow("measured word");
    for (const bad of [
      cues.slice(0, 1),
      [cues[0]!, cues[0]!],
      [cues[0]!, { sceneId: "result", phrase: "missing" }],
      [
        { sceneId: "scan", phrase: "done" },
        { sceneId: "result", phrase: "scan" },
      ],
    ])
      expect(() => alignSizzleTimelineNarration(t, measured, bad)).toThrow();
    expect(() =>
      alignSizzleTimelineNarration(
        { ...t, audio: [t.audio[0]!, { ...t.audio[0]!, id: "other" }] },
        measured,
        cues,
      ),
    ).toThrow("one complete");
  });
});
