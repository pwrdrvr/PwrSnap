import { describe, expect, it } from "vitest";
import {
  defaultSizzleProjectCoverCaptureId,
  resolveSizzleProjectCoverCaptureId,
  type SizzleProject,
  type SizzleScene
} from "../protocol";

function simpleScene(captureId: string): SizzleScene {
  return {
    id: "sc_simple",
    captureId,
    scriptLine: "",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "auto",
    transition: "crossfade"
  };
}

function sequenceScene(captureIds: string[]): SizzleScene {
  return {
    id: "sc_sequence",
    kind: "sequence",
    captureId: "",
    scriptLine: "Narration",
    narration: "Narration",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "voiceover",
    transition: "crossfade",
    beats: captureIds.map((captureId, index) => ({
      id: `bt_${index}`,
      captureId,
      timing: { kind: "auto" },
      mediaTrim: null,
      transition: "cut",
      videoFit: "smart-fit"
    }))
  };
}

function project(overrides: Partial<SizzleProject> = {}): SizzleProject {
  return {
    id: "sz_1",
    name: "Demo",
    createdAt: "2026-06-01T00:00:00.000Z",
    modifiedAt: "2026-06-01T00:00:00.000Z",
    coverCaptureId: null,
    scenes: [],
    voice: "onyx",
    ttsModel: "tts-1-hd",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null,
    ...overrides
  };
}

describe("sizzle project cover resolution", () => {
  it("uses the saved cover before inspecting scenes", () => {
    expect(
      resolveSizzleProjectCoverCaptureId(
        project({
          coverCaptureId: "cap_saved",
          scenes: [simpleScene("cap_scene")]
        })
      )
    ).toBe("cap_saved");
  });

  it("falls back to the first sequence beat for old projects without a saved cover", () => {
    expect(defaultSizzleProjectCoverCaptureId([sequenceScene(["cap_a", "cap_b"])])).toBe("cap_a");
  });
});
