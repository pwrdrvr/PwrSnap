import { describe, expect, it } from "vitest";
import type { CaptureRecord, SizzleScene, SizzleSpeechTiming } from "@pwrsnap/shared";
import { approximateSpeechTiming } from "../speech-timing";
import { planSequenceScene, SequencePlannerError } from "../sequence-planner";

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
  });

  it("resolves phrase anchors using speech timing", () => {
    const scene = sequenceScene({
      beats: [
        {
          id: "bt_settings",
          captureId: "cap_1",
          timing: { kind: "phrase", phrase: "wizard then", occurrence: 1, offsetSec: 0, durationSec: 0.5 },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        }
      ]
    });
    const plan = planSequenceScene({
      scene,
      capturesById: new Map([["cap_1", capture("cap_1", "image")]]),
      imagePathByCaptureId: new Map([["cap_1", "/tmp/cap_1.png"]]),
      narrationAudioPath: "/tmp/narration.mp3",
      speechTiming: timing("Open the wizard then approve pairing", 3)
    });

    expect(plan.diagnostics).toEqual([]);
    expect(plan.beatPlans[0]!.startSec).toBeGreaterThan(0);
    expect(plan.beatPlans[0]!.endSec - plan.beatPlans[0]!.startSec).toBeCloseTo(0.5, 3);
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
