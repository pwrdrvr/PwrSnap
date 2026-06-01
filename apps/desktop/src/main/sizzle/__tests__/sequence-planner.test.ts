import { describe, expect, it } from "vitest";
import type {
  CaptureRecord,
  SizzleScene,
  SizzleSequenceBeat,
  SizzleSpeechTiming
} from "@pwrsnap/shared";
import { approximateSpeechTiming } from "../speech-timing";
import {
  planSequenceMediaDiagnostics,
  planSequenceScene,
  planSequenceTimeline,
  SequencePlannerError
} from "../sequence-planner";

function capture(id: string, kind: "image" | "video", durationSec = 1): CaptureRecord {
  return {
    id,
    kind,
    captured_at: "2026-05-30T00:00:00.000Z",
    legacy_src_path: kind === "video" ? `/tmp/${id}.mp4` : null,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: kind === "video" ? 1 : 2,
    bundle_edits_version: 0,
    width_px: 100,
    height_px: 100,
    device_pixel_ratio: 1,
    byte_size: 10,
    sha256: id,
    source_app_bundle_id: null,
    source_app_name: null,
    edits_version: 0,
    deleted_at: null,
    video:
      kind === "video"
        ? {
            durationSec,
            containerFormat: "mp4",
            hasSystemAudio: false,
            hasMicrophoneAudio: false,
            defaultRange: { start: 0, end: durationSec },
            previewPath: null,
            previewStatus: "ready"
          }
        : null
  };
}

function sequenceScene(overrides: Partial<SizzleScene> = {}): SizzleScene {
  return {
    id: "sc_sequence",
    kind: "sequence",
    captureId: "cap_1",
    scriptLine: "Open the wizard then approve pairing",
    narration: "Open the wizard then approve pairing",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "voiceover",
    transition: "crossfade",
    beats: [
      {
        id: "bt_1",
        captureId: "cap_1",
        timing: { kind: "offset", startSec: 0, endSec: 1 },
        mediaTrim: null,
        transition: "cut",
        videoFit: "smart-fit"
      },
      {
        id: "bt_2",
        captureId: "cap_2",
        timing: { kind: "offset", startSec: 1, endSec: 2 },
        mediaTrim: null,
        transition: { type: "push-left", durationSec: 0.18 },
        videoFit: "smart-fit"
      }
    ],
    ...overrides
  };
}

function timing(text = "Open the wizard then approve pairing", durationSec = 2): SizzleSpeechTiming {
  return approximateSpeechTiming(text, durationSec);
}

describe("planSequenceScene", () => {
  it("lowers a sequence into one narration split across multiple visual segments", () => {
    const plan = planSequenceScene({
      scene: sequenceScene(),
      capturesById: new Map([
        ["cap_1", capture("cap_1", "image")],
        ["cap_2", capture("cap_2", "image")]
      ]),
      imagePathByCaptureId: new Map([
        ["cap_1", "/tmp/cap_1.png"],
        ["cap_2", "/tmp/cap_2.png"]
      ]),
      narrationAudioPath: "/tmp/narration.mp3",
      speechTiming: timing()
    });

    expect(plan.sceneInputs).toHaveLength(2);
    expect(plan.sceneInputs.map((input) => input.audioPath)).toEqual([
      "/tmp/narration.mp3",
      "/tmp/narration.mp3"
    ]);
    expect(plan.sceneInputs.map((input) => input.audioStartSec)).toEqual([0, 1]);
    expect(plan.sceneInputs[0]!.transition).toBe("crossfade");
    expect(plan.sceneInputs[1]!.transition).toEqual({ type: "push-left", durationSec: 0.18 });
    expect(plan.sceneInputs[1]!.durationSec).toBeCloseTo(1.18, 3);
    expect(plan.sceneInputs[1]!.audioDurationSec).toBeCloseTo(1, 3);
  });

  it("honors sequence durationOverrideSec when distributing beat windows", () => {
    const plan = planSequenceScene({
      scene: sequenceScene({
        durationOverrideSec: 4,
        beats: [
          {
            id: "bt_1",
            captureId: "cap_1",
            timing: { kind: "offset", startSec: 0, endSec: null },
            mediaTrim: null,
            transition: "cut",
            videoFit: "smart-fit"
          },
          {
            id: "bt_2",
            captureId: "cap_2",
            timing: { kind: "offset", startSec: 2, endSec: null },
            mediaTrim: null,
            transition: "cut",
            videoFit: "smart-fit"
          }
        ]
      }),
      capturesById: new Map([
        ["cap_1", capture("cap_1", "image")],
        ["cap_2", capture("cap_2", "image")]
      ]),
      imagePathByCaptureId: new Map([
        ["cap_1", "/tmp/cap_1.png"],
        ["cap_2", "/tmp/cap_2.png"]
      ]),
      narrationAudioPath: "/tmp/narration.mp3",
      speechTiming: timing("Open the wizard then approve pairing", 2)
    });

    expect(plan.beatPlans[0]!.startSec).toBe(0);
    expect(plan.beatPlans[1]!.endSec).toBe(4);
  });

  it("resolves phrase anchors using speech timing", () => {
    const scene = sequenceScene({
      beats: [
        {
          id: "bt_intro",
          captureId: "cap_1",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_settings",
          captureId: "cap_2",
          timing: { kind: "phrase", phrase: "wizard then", occurrence: 1, offsetSec: 0, durationSec: 0.5 },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        }
      ]
    });
    const plan = planSequenceScene({
      scene,
      capturesById: new Map([
        ["cap_1", capture("cap_1", "image")],
        ["cap_2", capture("cap_2", "image")]
      ]),
      imagePathByCaptureId: new Map([
        ["cap_1", "/tmp/cap_1.png"],
        ["cap_2", "/tmp/cap_2.png"]
      ]),
      narrationAudioPath: "/tmp/narration.mp3",
      speechTiming: timing("Open the wizard then approve pairing", 3)
    });

    expect(plan.diagnostics).toEqual([]);
    expect(plan.beatPlans[1]!.startSec).toBeGreaterThan(0);
    expect(plan.beatPlans[1]!.endSec - plan.beatPlans[1]!.startSec).toBeCloseTo(0.5, 3);
  });

  it("keeps narration continuous when a phrase anchor follows a stale fixed end", () => {
    const scene = sequenceScene({
      scriptLine: "Start with the editor, then zoom out to the capture library.",
      narration: "Start with the editor, then zoom out to the capture library.",
      beats: [
        {
          id: "bt_editor",
          captureId: "cap_1",
          timing: { kind: "offset", startSec: 0, endSec: 1 },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_library",
          captureId: "cap_2",
          timing: { kind: "phrase", phrase: "zoom out", occurrence: 1, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: "crossfade",
          videoFit: "smart-fit"
        }
      ]
    });
    const plan = planSequenceScene({
      scene,
      capturesById: new Map([
        ["cap_1", capture("cap_1", "image")],
        ["cap_2", capture("cap_2", "image")]
      ]),
      imagePathByCaptureId: new Map([
        ["cap_1", "/tmp/cap_1.png"],
        ["cap_2", "/tmp/cap_2.png"]
      ]),
      narrationAudioPath: "/tmp/narration.mp3",
      speechTiming: timing(scene.scriptLine, 9)
    });

    expect(plan.beatPlans[0]!.endSec).toBe(plan.beatPlans[1]!.startSec);
    expect(plan.beatPlans[0]!.endSec).toBeGreaterThan(1);
    expect(plan.sceneInputs[0]!.audioDurationSec).toBeCloseTo(
      plan.beatPlans[1]!.startSec,
      3
    );
  });

  it("keeps phrase anchors in narration time when durationOverrideSec is longer than TTS audio", () => {
    const scene = sequenceScene({
      durationOverrideSec: 4,
      scriptLine: "Open the wizard then approve pairing",
      narration: "Open the wizard then approve pairing",
      beats: [
        {
          id: "bt_intro",
          captureId: "cap_1",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_approve",
          captureId: "cap_2",
          timing: { kind: "phrase", phrase: "approve", occurrence: 1, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        }
      ]
    });
    const plan = planSequenceScene({
      scene,
      capturesById: new Map([
        ["cap_1", capture("cap_1", "image")],
        ["cap_2", capture("cap_2", "image")]
      ]),
      imagePathByCaptureId: new Map([
        ["cap_1", "/tmp/cap_1.png"],
        ["cap_2", "/tmp/cap_2.png"]
      ]),
      narrationAudioPath: "/tmp/narration.mp3",
      speechTiming: timing(scene.scriptLine, 2)
    });

    expect(plan.beatPlans[1]!.startSec).toBeGreaterThan(0);
    expect(plan.beatPlans[1]!.startSec).toBeLessThan(2);
    expect(plan.beatPlans[1]!.endSec).toBe(4);
    expect(plan.sceneInputs[1]!.audioStartSec).toBe(plan.beatPlans[1]!.startSec);
  });

  it("chooses loop for a short video smart-fit beat", () => {
    const scene = sequenceScene({
      beats: [
        {
          id: "bt_video",
          captureId: "cap_video",
          timing: { kind: "offset", startSec: 0, endSec: 4 },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        }
      ]
    });
    const plan = planSequenceScene({
      scene,
      capturesById: new Map([["cap_video", capture("cap_video", "video", 1)]]),
      imagePathByCaptureId: new Map(),
      narrationAudioPath: "/tmp/narration.mp3",
      speechTiming: timing("Generate code and approve pairing", 4)
    });

    expect(plan.sceneInputs[0]!.kind).toBe("video");
    if (plan.sceneInputs[0]!.kind === "video") {
      expect(plan.sceneInputs[0]!.videoFit?.mode).toBe("loop");
      expect(plan.sceneInputs[0]!.trimDurationSec).toBe(1);
      expect(plan.sceneInputs[0]!.durationSec).toBe(4);
    }
  });

  it("clamps video beat trims to the real source duration before fitting", () => {
    const scene = sequenceScene({
      scriptLine: "The finished GIF is ready to share privately and publish.",
      narration: "The finished GIF is ready to share privately and publish.",
      beats: [
        {
          id: "bt_publish",
          captureId: "cap_short",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: { startSec: 0, endSec: 9.1 },
          transition: "cut",
          videoFit: "speed-to-fit"
        }
      ]
    });
    const plan = planSequenceScene({
      scene,
      capturesById: new Map([["cap_short", capture("cap_short", "video", 4.204)]]),
      imagePathByCaptureId: new Map(),
      narrationAudioPath: "/tmp/narration.mp3",
      speechTiming: timing(scene.scriptLine, 9.6)
    });

    expect(plan.sceneInputs).toHaveLength(1);
    expect(plan.sceneInputs[0]!.kind).toBe("video");
    if (plan.sceneInputs[0]!.kind === "video") {
      expect(plan.sceneInputs[0]!.startSec).toBe(0);
      expect(plan.sceneInputs[0]!.trimDurationSec).toBeCloseTo(4.204, 3);
      expect(plan.sceneInputs[0]!.durationSec).toBeCloseTo(9.6, 3);
      expect(plan.sceneInputs[0]!.videoFit?.mode).toBe("freeze-end");
    }
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beatId: "bt_publish",
          code: "media_trim_clamped"
        }),
        expect.objectContaining({
          beatId: "bt_publish",
          code: "video_fit",
          message: "Requested speed-to-fit would exceed rate limits; using freeze-end"
        })
      ])
    );
  });

  it("reports unsafe video fit diagnostics during preview planning", () => {
    const scene = sequenceScene({
      scriptLine: "The finished GIF is ready to share privately and publish.",
      narration: "The finished GIF is ready to share privately and publish.",
      beats: [
        {
          id: "bt_publish",
          captureId: "cap_short",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: { startSec: 0, endSec: 9.1 },
          transition: "cut",
          videoFit: "speed-to-fit"
        }
      ]
    });
    const timeline = planSequenceTimeline(scene, timing(scene.scriptLine, 9.6));
    const diagnostics = planSequenceMediaDiagnostics({
      scene,
      timeline,
      capturesById: new Map([["cap_short", capture("cap_short", "video", 4.204)]])
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beatId: "bt_publish",
          code: "media_trim_clamped"
        }),
        expect.objectContaining({
          beatId: "bt_publish",
          code: "video_fit",
          message: "Requested speed-to-fit would exceed rate limits; using freeze-end"
        })
      ])
    );
  });

  it("fails before expensive work when a beat capture is missing", () => {
    expect(() =>
      planSequenceScene({
        scene: sequenceScene(),
        capturesById: new Map([["cap_1", capture("cap_1", "image")]]),
        imagePathByCaptureId: new Map([["cap_1", "/tmp/cap_1.png"]]),
        narrationAudioPath: "/tmp/narration.mp3",
        speechTiming: timing()
      })
    ).toThrow(SequencePlannerError);
  });
});

describe("planSequenceTimeline", () => {
  it("returns resolved beat windows without requiring rendered capture inputs", () => {
    const scene = sequenceScene({
      beats: [
        {
          id: "bt_intro",
          captureId: "cap_1",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_phrase",
          captureId: "cap_2",
          timing: { kind: "phrase", phrase: "approve", occurrence: 1, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: { type: "push-left", durationSec: 0.18 },
          videoFit: "loop"
        }
      ]
    });

    const plan = planSequenceTimeline(scene, timing(scene.scriptLine, 4));

    expect(plan.durationSec).toBe(4);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.beatPlans).toHaveLength(2);
    expect(plan.beatPlans[0]!.transition).toBe("crossfade");
    expect(plan.beatPlans[1]!.captureId).toBe("cap_2");
    expect(plan.beatPlans[1]!.videoFit).toBe("loop");
    expect(plan.beatPlans[0]!.endSec).toBe(plan.beatPlans[1]!.startSec);
  });
});

describe("auto beat timing", () => {
  const autoBeat = (id: string): SizzleSequenceBeat => ({
    id,
    captureId: id,
    timing: { kind: "auto" },
    mediaTrim: null,
    transition: "cut",
    videoFit: "smart-fit"
  });

  it("divides auto beats evenly between an offset anchor and the timeline end (AE1/AE6)", () => {
    const scene = sequenceScene({
      durationOverrideSec: 10,
      beats: [
        autoBeat("bt_0"),
        {
          id: "bt_1",
          captureId: "bt_1",
          timing: { kind: "offset", startSec: 4, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        autoBeat("bt_2"),
        autoBeat("bt_3")
      ]
    });
    const plan = planSequenceTimeline(scene, timing("Open the wizard then approve pairing", 10));
    expect(plan.beatPlans.map((b) => b.startSec)).toEqual([0, 4, 6, 8]);
    // continuity: each non-final beat ends at the next beat's start
    expect(plan.beatPlans[0]!.endSec).toBe(plan.beatPlans[1]!.startSec);
    expect(plan.beatPlans[3]!.endSec).toBe(10);
  });

  it("spreads an all-auto sequence evenly (AE8)", () => {
    const scene = sequenceScene({
      durationOverrideSec: 8,
      beats: [autoBeat("a"), autoBeat("b"), autoBeat("c"), autoBeat("d")]
    });
    const plan = planSequenceTimeline(scene, timing("one two three four", 8));
    expect(plan.beatPlans.map((b) => b.startSec)).toEqual([0, 2, 4, 6]);
  });

  it("warns when even-division makes a beat too short to read (AE5)", () => {
    const scene = sequenceScene({
      durationOverrideSec: 1,
      beats: [autoBeat("a"), autoBeat("b"), autoBeat("c"), autoBeat("d")]
    });
    const plan = planSequenceTimeline(scene, timing("one two three four", 1));
    expect(plan.diagnostics.some((d) => d.code === "beat_too_short")).toBe(true);
  });
});
