import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SizzleTimelineSchema,
  resolveSizzleScene,
  resolveSizzleText,
  sizzleTimelineFrames,
  type SizzleTimelineInput,
} from "../sizzle-timeline";
import { sizzleSceneSvg } from "../sizzle-timeline-svg";
import {
  buildSizzleLaunchTemplate,
  type SizzleLaunchTemplateInput,
} from "../sizzle-launch-template";

const input = (): SizzleTimelineInput => ({
  version: 1,
  width: 1920,
  height: 1080,
  scenes: [{ id: "intro", durationFrames: 90, layers: [] }],
});

describe("Sizzle's deterministic timeline contract", () => {
  it("keeps a scene's frame count independent of bindings and unrelated audio", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 300 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (durations) => {
          const t = SizzleTimelineSchema.parse({
            ...input(),
            bindings: { count: 33_524_125 },
            scenes: durations.map((durationFrames, index) => ({
              id: `s${index}`,
              durationFrames,
              layers: [],
            })),
          });
          expect(sizzleTimelineFrames(t)).toBe(
            durations.reduce((a, b) => a + b, 0),
          );
          expect(
            SizzleTimelineSchema.parse({ ...t, bindings: { count: 7 } }).scenes,
          ).toEqual(t.scenes);
        },
      ),
    );
  });

  it("rejects ambiguous timing, duplicate identity, and silent narration truncation", () => {
    for (const scenes of [
      [{ id: "x", durationFrames: 1.5, layers: [] }],
      [
        { id: "x", durationFrames: 90, layers: [] },
        { id: "x", durationFrames: 90, layers: [] },
      ],
      [
        {
          id: "x",
          durationFrames: 90,
          layers: [
            {
              id: "layer",
              kind: "rect",
              width: 10,
              height: 10,
              fill: "#000000",
              startFrame: 91,
            },
          ],
        },
      ],
    ])
      expect(
        SizzleTimelineSchema.safeParse({ ...input(), scenes }).success,
      ).toBe(false);
    expect(
      SizzleTimelineSchema.safeParse({
        ...input(),
        audio: [
          {
            id: "voice",
            role: "voice",
            startFrame: 0,
            durationFrames: 90,
            fit: "trim",
            source: { kind: "speech", text: "Hello" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SizzleTimelineSchema.safeParse({
        ...input(),
        arbitraryCode: "doSomething()",
      }).success,
    ).toBe(false);
  });

  it("resolves one binding across text and counter without invalidating unrelated scenes", () => {
    const t = SizzleTimelineSchema.parse({
      ...input(),
      bindings: { count: 33_524_125 },
      scenes: [
        {
          id: "benchmark",
          durationFrames: 90,
          layers: [
            {
              id: "number",
              kind: "counter",
              width: 100,
              height: 100,
              to: { binding: "count" },
              countFrames: 30,
            },
            {
              id: "caption",
              kind: "text",
              width: 100,
              height: 100,
              text: "{{count|number}} files",
            },
          ],
        },
        { id: "outro", durationFrames: 30, layers: [] },
      ],
    });
    const before = t.scenes.map((s) => resolveSizzleScene(s, t.bindings));
    const after = t.scenes.map((s) => resolveSizzleScene(s, { count: 42 }));
    expect(before[0]).not.toEqual(after[0]);
    expect(before[1]).toEqual(after[1]);
    expect(after[0]!.layers[1]).toMatchObject({ text: "42 files" });
    expect(() => resolveSizzleScene(t.scenes[0]!, {})).toThrow();
  });

  it("renders any frame reproducibly without mutating data or interpreting supplied markup", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        fc.integer({ min: 0, max: 89 }),
        (text, frame) => {
          const t = SizzleTimelineSchema.parse({
            ...input(),
            scenes: [
              {
                id: "text",
                durationFrames: 90,
                layers: [
                  {
                    id: "t",
                    kind: "typing",
                    width: 1000,
                    height: 200,
                    text: `<script>${text}</script>`,
                    revealFrames: 30,
                  },
                ],
              },
            ],
          });
          const before = JSON.stringify(t);
          const render = (at: number): string =>
            sizzleSceneSvg({
              scene: t.scenes[0]!,
              frame: at,
              width: t.width,
              height: t.height,
              media: new Map(),
            });
          const first = render(frame);
          render(89);
          expect(render(frame)).toBe(first);
          expect(first).not.toContain("<script>");
          expect(JSON.stringify(t)).toBe(before);
        },
      ),
    );
  });

  it("resolves caption dependencies transitively and rejects cycles before rendering", () => {
    expect(
      resolveSizzleText("{{caption}}", {
        caption: "{{count|number}} files",
        count: 33524125,
      }),
    ).toBe("33,524,125 files");
    expect(() =>
      resolveSizzleText("{{caption}}", { caption: "{{caption}}" }),
    ).toThrow("acyclic");
    expect(() =>
      resolveSizzleText("{{a}}", { a: "{{b}}", b: "{{a}}" }),
    ).toThrow("acyclic");
  });

  it("keeps the reusable launch format at exactly 975 frames with nine independent VO slots", () => {
    const id = "a".repeat(64);
    const data: SizzleLaunchTemplateInput = {
      productName: "Demo",
      tagline: "Get it done",
      url: "example.test",
      logo: id,
      overview: id,
      featuresImage: id,
      workflowImage: id,
      safetyImage: id,
      resultImage: id,
      intro: "Meet Demo",
      context: "Make room",
      handoff: "Here we go",
      features: ["Fast", "Local"],
      metricValue: 42,
      metricLabel: "files",
      metricResult: "Instant",
      terminalLines: ["tool_run"],
      workflowCaption: "Review first",
      safetyHeadline: "Protected",
      safetyLines: ["refused"],
      confirmation: "I mean it",
      resultCaption: "Done",
      narration: Array.from({ length: 9 }, () => "{{metricValue}} files"),
    };
    const t = buildSizzleLaunchTemplate(data);
    expect(sizzleTimelineFrames(t)).toBe(975);
    expect(t.scenes).toHaveLength(9);
    expect(t.audio.filter((a) => a.role === "voice")).toHaveLength(9);
    expect(t.audio.every((a) => a.startFrame + a.durationFrames <= 975)).toBe(
      true,
    );
    expect(t.audio.find((a) => a.role === "music")?.source.kind).toBe("synth");
    expect(
      buildSizzleLaunchTemplate({ ...data, metricValue: 99 }).scenes,
    ).toEqual(t.scenes);
  });
});
