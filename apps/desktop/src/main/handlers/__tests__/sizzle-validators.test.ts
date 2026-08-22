import { describe, expect, it } from "vitest";
import {
  validateLibraryCounts,
  validateLibraryDiscovery,
  validateLibraryListByIds,
  validateLibrarySearch,
  validateSizzleCreate,
  validateSizzleDuplicate,
  validateSizzleIdRequest,
  validateSizzleOpenRequest,
  validateSizzlePreviewRequest,
  validateSizzleToggleScene,
  validateSizzleUpdate,
  SIZZLE_LIMITS
} from "../sizzle-validators";

describe("validateSizzleCreate", () => {
  it("accepts a string name", () => {
    const r = validateSizzleCreate({ name: "My Reel" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe("My Reel");
  });

  it("rejects non-object req", () => {
    const r = validateSizzleCreate("oops");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_object");
  });

  it("rejects missing name", () => {
    const r = validateSizzleCreate({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("name_required");
  });

  it("rejects name over the length cap", () => {
    const r = validateSizzleCreate({
      name: "x".repeat(SIZZLE_LIMITS.projectNameMax + 1)
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("name_too_long");
  });
});

describe("validateSizzleDuplicate", () => {
  it("accepts an id and defaults forkChat on", () => {
    const r = validateSizzleDuplicate({ id: "sz_1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ id: "sz_1", forkChat: true });
  });

  it("accepts an explicit name and forkChat false", () => {
    const r = validateSizzleDuplicate({
      id: "sz_1",
      name: "Alternate edit",
      forkChat: false
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        id: "sz_1",
        name: "Alternate edit",
        forkChat: false
      });
    }
  });

  it("rejects invalid optional fields", () => {
    const name = validateSizzleDuplicate({
      id: "sz_1",
      name: "x".repeat(SIZZLE_LIMITS.projectNameMax + 1)
    });
    expect(name.ok).toBe(false);
    if (!name.ok) expect(name.error.code).toBe("name_too_long");

    const forkChat = validateSizzleDuplicate({ id: "sz_1", forkChat: "yes" });
    expect(forkChat.ok).toBe(false);
    if (!forkChat.ok) expect(forkChat.error.code).toBe("forkChat_invalid");
  });
});

describe("validateSizzleUpdate", () => {
  it("accepts a minimal { id, patch: {} }", () => {
    const r = validateSizzleUpdate({ id: "sz_1", patch: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ id: "sz_1", patch: {} });
  });

  it("rejects server-owned fields in patch", () => {
    for (const key of ["id", "createdAt", "modifiedAt", "outputPath", "lastRenderedAt"]) {
      const r = validateSizzleUpdate({ id: "sz_1", patch: { [key]: "x" } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("server_owned_field");
        expect(r.error.message).toContain(JSON.stringify(key));
      }
    }
  });

  it("rejects empty id", () => {
    const r = validateSizzleUpdate({ id: "", patch: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("id_required");
  });

  it("accepts valid voice / ttsModel / ttsProvider / resolution", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        voice: "nova",
        ttsModel: "tts-1",
        ttsProvider: "openai",
        resolution: "720p",
        coverCaptureId: "cap_cover"
      }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.coverCaptureId).toBe("cap_cover");
  });

  it("accepts clearing the saved cover capture", () => {
    const r = validateSizzleUpdate({ id: "sz_1", patch: { coverCaptureId: null } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.coverCaptureId).toBeNull();
  });

  it("rejects invalid cover capture ids", () => {
    for (const coverCaptureId of ["", 123, {}]) {
      const r = validateSizzleUpdate({ id: "sz_1", patch: { coverCaptureId } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("coverCaptureId_invalid");
    }
  });

  it("rejects bogus voice", () => {
    const r = validateSizzleUpdate({ id: "sz_1", patch: { voice: "darth-vader" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("voice_invalid");
  });

  it("rejects bogus ttsModel", () => {
    const r = validateSizzleUpdate({ id: "sz_1", patch: { ttsModel: "tts-9000" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ttsModel_invalid");
  });

  it("rejects bogus resolution", () => {
    const r = validateSizzleUpdate({ id: "sz_1", patch: { resolution: "8k" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("resolution_invalid");
  });

  it("accepts a well-formed scenes array", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          { id: "sc1", captureId: "cap1", scriptLine: "hello", durationOverrideSec: null },
          { id: "sc2", captureId: "cap2", scriptLine: "world", durationOverrideSec: 3 }
        ]
      }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes).toHaveLength(2);
  });

  it("rejects scenes over the count limit", () => {
    const scenes = Array.from({ length: SIZZLE_LIMITS.scenesPerProjectMax + 1 }, (_, i) => ({
      id: `sc${i}`,
      captureId: `cap${i}`,
      scriptLine: "x",
      durationOverrideSec: null
    }));
    const r = validateSizzleUpdate({ id: "sz_1", patch: { scenes } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scenes_too_many");
  });

  it("rejects a scene with non-string scriptLine", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          { id: "sc1", captureId: "cap1", scriptLine: 42, durationOverrideSec: null }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_scriptLine_invalid");
  });

  it("rejects a scriptLine over the length cap", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          {
            id: "sc1",
            captureId: "cap1",
            scriptLine: "x".repeat(SIZZLE_LIMITS.sceneScriptLineMax + 1),
            durationOverrideSec: null
          }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_scriptLine_too_long");
  });

  it("rejects durationOverrideSec out of range", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          { id: "sc1", captureId: "cap1", scriptLine: "ok", durationOverrideSec: 999 }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_duration_out_of_range");
  });

  it("rejects durationOverrideSec of wrong type", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          { id: "sc1", captureId: "cap1", scriptLine: "ok", durationOverrideSec: "fast" }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_duration_invalid");
  });

  it("rejects scene with empty captureId", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [{ id: "sc1", captureId: "", scriptLine: "ok", durationOverrideSec: null }]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_captureId_invalid");
  });
});

describe("validateSizzleIdRequest", () => {
  it("accepts { id }", () => {
    const r = validateSizzleIdRequest({ id: "sz_1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe("sz_1");
  });
  it("rejects empty id", () => {
    const r = validateSizzleIdRequest({ id: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("id_required");
  });
  it("rejects non-string id", () => {
    const r = validateSizzleIdRequest({ id: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("id_required");
  });
});

describe("validateSizzlePreviewRequest", () => {
  it("accepts a valid pair", () => {
    const r = validateSizzlePreviewRequest({ projectId: "sz_1", sceneId: "sc_1" });
    expect(r.ok).toBe(true);
  });
  it("rejects missing sceneId", () => {
    const r = validateSizzlePreviewRequest({ projectId: "sz_1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("sceneId_required");
  });
});

describe("validateSizzleOpenRequest", () => {
  it("accepts an empty payload (no projectId)", () => {
    const r = validateSizzleOpenRequest({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projectId).toBeUndefined();
  });
  it("accepts a payload with projectId", () => {
    const r = validateSizzleOpenRequest({ projectId: "sz_1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projectId).toBe("sz_1");
  });
  it("rejects an empty-string projectId", () => {
    const r = validateSizzleOpenRequest({ projectId: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("projectId_invalid");
  });
});

// ---------------------------------------------------------------------
// Phase 3a additions — scene-level field validators
// ---------------------------------------------------------------------
//
// `validateSizzleUpdate.patch.scenes` runs through `validateScene` per
// element. The mediaTrim / audioSource / transition validators are
// internal helpers reached only through that path, so we exercise
// them via the update verb's scenes array.

// Helper — minimal scene shape that passes the existing required-field
// validators (id + captureId + scriptLine + durationOverrideSec). Each
// test overrides exactly the field under test.
function validSceneBase(): Record<string, unknown> {
  return {
    id: "sc_1",
    captureId: "cap_1",
    scriptLine: "Hello",
    durationOverrideSec: null
  };
}

describe("validateSizzleUpdate — Phase 3a mediaTrim validation", () => {
  it("accepts a valid mediaTrim object", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), mediaTrim: { startSec: 0, endSec: 2 } }] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.patch.scenes![0]!.mediaTrim).toEqual({ startSec: 0, endSec: 2 });
    }
  });

  it("accepts null mediaTrim (image scenes set it null)", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), mediaTrim: null }] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.mediaTrim).toBeNull();
  });

  it("accepts missing mediaTrim (back-compat — defaults to null)", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [validSceneBase()] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.mediaTrim).toBeNull();
  });

  it("rejects mediaTrim with negative startSec", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), mediaTrim: { startSec: -1, endSec: 2 } }] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_mediaTrim_start_invalid");
  });

  it("rejects mediaTrim with endSec ≤ startSec", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), mediaTrim: { startSec: 1, endSec: 1 } }] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_mediaTrim_end_invalid");
  });

  it("rejects mediaTrim duration over the 60s cap (matches TTS practical-length cap)", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          {
            ...validSceneBase(),
            mediaTrim: { startSec: 0, endSec: SIZZLE_LIMITS.mediaTrimSecMax + 1 }
          }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_mediaTrim_duration_out_of_range");
  });

  it("rejects mediaTrim duration below the 0.1s floor (vanishing trim)", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), mediaTrim: { startSec: 1.0, endSec: 1.05 } }] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_mediaTrim_duration_out_of_range");
  });

  it("rejects mediaTrim that is not an object", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), mediaTrim: "not an object" }] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_mediaTrim_invalid");
  });

  it("rejects mediaTrim with non-finite startSec", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), mediaTrim: { startSec: Infinity, endSec: 5 } }] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_mediaTrim_start_invalid");
  });
});

describe("validateSizzleUpdate — Phase 3a audioSource validation", () => {
  it.each(["auto", "native", "voiceover", "muted"] as const)("accepts %s", (audioSource) => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), audioSource }] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.audioSource).toBe(audioSource);
  });

  it("defaults missing audioSource to 'auto' (back-compat)", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [validSceneBase()] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.audioSource).toBe("auto");
  });

  it("defaults null audioSource to 'auto'", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), audioSource: null }] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.audioSource).toBe("auto");
  });

  it("rejects an unknown audioSource value", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), audioSource: "loud" }] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_audioSource_invalid");
  });
});

describe("validateSizzleUpdate — Phase 3a transition validation", () => {
  it.each(["cut", "crossfade"] as const)("accepts %s", (transition) => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), transition }] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.transition).toBe(transition);
  });

  it("defaults missing transition to 'crossfade' (back-compat — visual win)", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [validSceneBase()] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.transition).toBe("crossfade");
  });

  it("rejects an unknown transition value", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), transition: "swirl" }] }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_transition_invalid");
  });

  it("accepts an object transition with an explicit duration", () => {
    const transition = { type: "dip-black", durationSec: 0.25 };
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: { scenes: [{ ...validSceneBase(), transition }] }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.transition).toEqual(transition);
  });

  it("rejects an object transition duration over the cap", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          {
            ...validSceneBase(),
            transition: {
              type: "dip-black",
              durationSec: SIZZLE_LIMITS.transitionDurationSecMax + 1
            }
          }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_transition_duration_invalid");
  });
});

describe("validateSizzleUpdate — sequence scene validation", () => {
  it("accepts a sequence scene and mirrors narration into scriptLine", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          {
            id: "sc_sequence",
            kind: "sequence",
            scriptLine: "",
            narration: "Open the wizard, then enable Telegram in Settings.",
            audioSource: "muted",
            durationOverrideSec: null,
            beats: [
              {
                id: "bt_wizard",
                captureId: "cap_wizard",
                timing: { kind: "offset", startSec: 0, endSec: 1.2 },
                mediaTrim: null,
                transition: "cut",
                videoFit: "smart-fit"
              },
              {
                id: "bt_settings",
                captureId: "cap_settings",
                timing: {
                  kind: "phrase",
                  phrase: "Settings",
                  occurrence: 1,
                  offsetSec: -0.1,
                  durationSec: 0.8
                },
                mediaTrim: null,
                transition: { type: "push-left", durationSec: 0.18 },
                videoFit: "loop"
              }
            ]
          }
        ]
      }
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const scene = r.value.patch.scenes![0]!;
      expect(scene.kind).toBe("sequence");
      expect(scene.captureId).toBe("cap_wizard");
      expect(scene.scriptLine).toBe("Open the wizard, then enable Telegram in Settings.");
      expect(scene.narration).toBe(scene.scriptLine);
      expect(scene.audioSource).toBe("voiceover");
      expect(scene.beats).toHaveLength(2);
      expect(scene.beats![1]!.transition).toEqual({ type: "push-left", durationSec: 0.18 });
      expect(scene.beats![1]!.videoFit).toBe("loop");
    }
  });

  it("rejects a sequence scene with no beats", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          {
            id: "sc_sequence",
            kind: "sequence",
            captureId: "cap_1",
            scriptLine: "Narration",
            durationOverrideSec: null,
            beats: []
          }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_beats_empty");
  });

  it("rejects a sequence beat with an unknown videoFit policy", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          {
            id: "sc_sequence",
            kind: "sequence",
            scriptLine: "Narration",
            durationOverrideSec: null,
            beats: [
              {
                id: "bt_1",
                captureId: "cap_1",
                timing: { kind: "offset", startSec: 0, endSec: null },
                videoFit: "stretch"
              }
            ]
          }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_beat_videoFit_invalid");
  });

  it("accepts a sequence beat with auto timing", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          {
            id: "sc_sequence",
            kind: "sequence",
            scriptLine: "Narration",
            durationOverrideSec: null,
            beats: [
              { id: "bt_1", captureId: "cap_1", timing: { kind: "auto" }, videoFit: "smart-fit", transition: "cut" }
            ]
          }
        ]
      }
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.patch.scenes![0]!.beats![0]!.timing).toEqual({ kind: "auto" });
  });

  it("rejects an auto beat that carries timing fields", () => {
    const r = validateSizzleUpdate({
      id: "sz_1",
      patch: {
        scenes: [
          {
            id: "sc_sequence",
            kind: "sequence",
            scriptLine: "Narration",
            durationOverrideSec: null,
            beats: [
              { id: "bt_1", captureId: "cap_1", timing: { kind: "auto", startSec: 3 }, videoFit: "smart-fit", transition: "cut" }
            ]
          }
        ]
      }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("scene_beat_timing_invalid");
  });
});

describe("validateSizzleToggleScene", () => {
  it("accepts a valid payload", () => {
    const r = validateSizzleToggleScene({ projectId: "sz_1", captureId: "cap-1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projectId).toBe("sz_1");
      expect(r.captureId).toBe("cap-1");
    }
  });

  it("rejects non-object payload", () => {
    const r = validateSizzleToggleScene(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_object");
  });

  it("rejects empty / missing projectId", () => {
    const r = validateSizzleToggleScene({ projectId: "", captureId: "cap-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("projectId_required");
  });

  it("rejects empty / missing captureId", () => {
    const r = validateSizzleToggleScene({ projectId: "sz_1", captureId: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("captureId_required");
  });

  it("rejects non-string ids", () => {
    const r = validateSizzleToggleScene({ projectId: 42, captureId: "cap-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("projectId_required");
  });
});

describe("validateLibraryListByIds", () => {
  it("accepts a valid array of ids", () => {
    const r = validateLibraryListByIds({ ids: ["a", "b", "c"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ids).toEqual(["a", "b", "c"]);
  });

  it("accepts an empty array (legitimate zero-length lookup)", () => {
    const r = validateLibraryListByIds({ ids: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ids).toEqual([]);
  });

  it("rejects non-object payload", () => {
    const r = validateLibraryListByIds("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_object");
  });

  it("rejects when ids is not an array", () => {
    const r = validateLibraryListByIds({ ids: "rec-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ids_required");
  });

  it("rejects when ids array contains a non-string element", () => {
    const r = validateLibraryListByIds({ ids: ["a", 2, "c"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("id_invalid");
      // Error message references the failing index for caller-side debug.
      expect(r.error.message).toContain("[1]");
    }
  });

  it("rejects when ids array contains an empty string", () => {
    const r = validateLibraryListByIds({ ids: ["a", "", "c"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("id_invalid");
  });

  it("rejects when ids.length exceeds the listByIdsMax cap", () => {
    const ids = Array.from({ length: SIZZLE_LIMITS.listByIdsMax + 1 }, (_, i) => `r-${i}`);
    const r = validateLibraryListByIds({ ids });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ids_too_many");
  });

  it("accepts ids.length exactly at the cap (boundary)", () => {
    const ids = Array.from({ length: SIZZLE_LIMITS.listByIdsMax }, (_, i) => `r-${i}`);
    const r = validateLibraryListByIds({ ids });
    expect(r.ok).toBe(true);
  });
});

describe("validateLibrarySearch", () => {
  it("accepts an empty payload (no filters → all-captures search)", () => {
    const r = validateLibrarySearch({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  it("accepts null/undefined payload as empty", () => {
    const r1 = validateLibrarySearch(null);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toEqual({});

    const r2 = validateLibrarySearch(undefined);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual({});
  });

  it("rejects a non-object payload", () => {
    const r = validateLibrarySearch("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_object");
  });

  describe("query field", () => {
    it("accepts a string query", () => {
      const r = validateLibrarySearch({ query: "telegram pairing" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.query).toBe("telegram pairing");
    });

    it("rejects non-string query", () => {
      const r = validateLibrarySearch({ query: 42 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("query_invalid");
    });

    it("rejects query > 2048 chars (defense against runaway agent)", () => {
      const r = validateLibrarySearch({ query: "x".repeat(2049) });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("query_too_long");
    });

    it("accepts query exactly at the 2048 cap (boundary)", () => {
      const r = validateLibrarySearch({ query: "x".repeat(2048) });
      expect(r.ok).toBe(true);
    });
  });

  describe("appBundleIds field", () => {
    it("accepts an array of non-empty strings and nulls", () => {
      const r = validateLibrarySearch({
        appBundleIds: ["com.tinyspeck.slackmacgap", null, "com.notion.Notion"]
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.appBundleIds).toEqual([
          "com.tinyspeck.slackmacgap",
          null,
          "com.notion.Notion"
        ]);
      }
    });

    it("rejects non-array appBundleIds", () => {
      const r = validateLibrarySearch({ appBundleIds: "com.slack" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("appBundleIds_invalid");
    });

    it("rejects empty-string entries", () => {
      const r = validateLibrarySearch({ appBundleIds: ["", "com.slack"] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("appBundleId_invalid");
    });

    it("rejects non-string non-null entries", () => {
      const r = validateLibrarySearch({ appBundleIds: [42, "com.slack"] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("appBundleId_invalid");
    });
  });

  describe("sourceAppNames field", () => {
    it("accepts human application names without requiring a bundle ID", () => {
      const r = validateLibrarySearch({ sourceAppNames: [" Claude ", "Figma"] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.sourceAppNames).toEqual(["Claude", "Figma"]);
    });

    it("rejects non-string and blank application names", () => {
      const nonString = validateLibrarySearch({ sourceAppNames: [42] });
      expect(nonString.ok).toBe(false);
      if (!nonString.ok) expect(nonString.error.code).toBe("sourceAppName_invalid");

      const blank = validateLibrarySearch({ sourceAppNames: ["   "] });
      expect(blank.ok).toBe(false);
      if (!blank.ok) expect(blank.error.code).toBe("sourceAppName_invalid");
    });

    it("bounds the number of names for direct command-bus callers", () => {
      const r = validateLibrarySearch({
        sourceAppNames: Array.from({ length: 101 }, (_, index) => `App ${index}`)
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("sourceAppNames_too_many");
    });
  });

  describe("tagFilter field", () => {
    it("normalizes exact labels and requires explicit any/all semantics", () => {
      const r = validateLibrarySearch({
        tagFilter: { labels: ["  Release   Blocker ", "release blocker"], match: "all" }
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.tagFilter).toEqual({
          labels: ["release blocker"],
          match: "all"
        });
      }
    });

    it("rejects empty labels and omitted/invalid match semantics", () => {
      const empty = validateLibrarySearch({ tagFilter: { labels: [], match: "any" } });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.error.code).toBe("tagFilter_labels_invalid");

      const missingMatch = validateLibrarySearch({ tagFilter: { labels: ["Important"] } });
      expect(missingMatch.ok).toBe(false);
      if (!missingMatch.ok) expect(missingMatch.error.code).toBe("tagFilter_match_invalid");
    });
  });

  describe("kinds field", () => {
    it("accepts an array of 'image' / 'video'", () => {
      const r = validateLibrarySearch({ kinds: ["image", "video"] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.kinds).toEqual(["image", "video"]);
    });

    it("accepts just ['image']", () => {
      const r = validateLibrarySearch({ kinds: ["image"] });
      expect(r.ok).toBe(true);
    });

    it("rejects unknown kind values", () => {
      const r = validateLibrarySearch({ kinds: ["image", "gif"] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("kind_invalid");
    });
  });

  describe("dateRange field", () => {
    it("accepts a well-formed dateRange", () => {
      const r = validateLibrarySearch({
        dateRange: { start: "2026-05-01", end: "2026-05-31" }
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.dateRange).toEqual({
          start: "2026-05-01",
          end: "2026-05-31"
        });
      }
    });

    it("rejects non-object dateRange", () => {
      const r = validateLibrarySearch({ dateRange: "today" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("dateRange_invalid");
    });

    it("rejects missing start or end", () => {
      const r = validateLibrarySearch({ dateRange: { start: "2026-05-01" } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("dateRange_invalid");
    });

    it("rejects inverted range (start > end)", () => {
      const r = validateLibrarySearch({
        dateRange: { start: "2026-05-31", end: "2026-05-01" }
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("dateRange_inverted");
    });
  });

  describe("hasOcr field", () => {
    it("accepts true / false", () => {
      const t = validateLibrarySearch({ hasOcr: true });
      expect(t.ok).toBe(true);
      const f = validateLibrarySearch({ hasOcr: false });
      expect(f.ok).toBe(true);
    });

    it("rejects non-boolean hasOcr", () => {
      const r = validateLibrarySearch({ hasOcr: "yes" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("hasOcr_invalid");
    });
  });

  describe("order field", () => {
    it("accepts explicit relevance/newest/oldest ordering", () => {
      for (const order of ["relevance", "newest", "oldest"] as const) {
        const r = validateLibrarySearch({
          ...(order === "relevance" ? { query: "pairing" } : {}),
          order
        });
        expect(r.ok).toBe(true);
      }
    });

    it("rejects relevance without a query", () => {
      const r = validateLibrarySearch({ order: "relevance" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("relevance_requires_query");
    });
  });

  describe("limit field", () => {
    it("accepts a positive integer", () => {
      const r = validateLibrarySearch({ limit: 50 });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.limit).toBe(50);
    });

    it("floors fractional limits", () => {
      const r = validateLibrarySearch({ limit: 50.7 });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.limit).toBe(50);
    });

    it("rejects 0 / negative", () => {
      const zero = validateLibrarySearch({ limit: 0 });
      expect(zero.ok).toBe(false);
      const neg = validateLibrarySearch({ limit: -1 });
      expect(neg.ok).toBe(false);
    });

    it("rejects > 500 (matches the SEARCH_MAX_LIMIT in captures-repo)", () => {
      const r = validateLibrarySearch({ limit: 501 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("limit_too_large");
    });

    it("rejects Infinity / NaN", () => {
      const inf = validateLibrarySearch({ limit: Infinity });
      expect(inf.ok).toBe(false);
      const nan = validateLibrarySearch({ limit: NaN });
      expect(nan.ok).toBe(false);
    });
  });

  describe("compositional", () => {
    it("accepts all fields together", () => {
      const r = validateLibrarySearch({
        query: "pairing",
        appBundleIds: ["com.tinyspeck.slackmacgap"],
        sourceAppNames: ["Slack"],
        tagFilter: { labels: ["important"], match: "any" },
        kinds: ["image"],
        dateRange: { start: "2026-05-01", end: "2026-05-31" },
        hasOcr: true,
        order: "newest",
        limit: 25
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toEqual({
          query: "pairing",
          appBundleIds: ["com.tinyspeck.slackmacgap"],
          sourceAppNames: ["Slack"],
          tagFilter: { labels: ["important"], match: "any" },
          kinds: ["image"],
          dateRange: { start: "2026-05-01", end: "2026-05-31" },
          hasOcr: true,
          order: "newest",
          limit: 25
        });
      }
    });

    it("null on any optional field is treated as absent", () => {
      const r = validateLibrarySearch({
        query: null,
        appBundleIds: null,
        sourceAppNames: null,
        tagFilter: null,
        kinds: null,
        dateRange: null,
        hasOcr: null,
        order: null,
        limit: null
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({});
    });
  });
});

describe("validateLibraryDiscovery", () => {
  it("accepts an absent request and a bounded integer limit", () => {
    expect(validateLibraryDiscovery(undefined)).toEqual({ ok: true, value: {} });
    expect(validateLibraryDiscovery({ limit: 25 })).toEqual({
      ok: true,
      value: { limit: 25 }
    });
  });

  it("rejects invalid discovery payloads", () => {
    const nonObject = validateLibraryDiscovery("nope");
    expect(nonObject.ok).toBe(false);
    if (!nonObject.ok) expect(nonObject.error.code).toBe("not_object");

    const fraction = validateLibraryDiscovery({ limit: 1.5 });
    expect(fraction.ok).toBe(false);
    if (!fraction.ok) expect(fraction.error.code).toBe("limit_invalid");

    const tooLarge = validateLibraryDiscovery({ limit: 501 });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.error.code).toBe("limit_too_large");
  });
});

describe("validateLibraryCounts", () => {
  it("treats an absent payload as 'count everything live'", () => {
    for (const empty of [null, undefined, {}]) {
      const r = validateLibraryCounts(empty);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({});
    }
  });

  it("rejects a non-object req", () => {
    const r = validateLibraryCounts("oops");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_object");
  });

  describe("scope", () => {
    it("accepts live and trash", () => {
      for (const scope of ["live", "trash"] as const) {
        const r = validateLibraryCounts({ scope });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.scope).toBe(scope);
      }
    });

    it("rejects the sidebar's 'today', which is a date predicate here", () => {
      const r = validateLibraryCounts({ scope: "today" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("scope_invalid");
    });
  });

  describe("kinds", () => {
    it("preserves an EMPTY array — it means 'no kinds', not 'both'", () => {
      const r = validateLibraryCounts({ kinds: [] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.kinds).toEqual([]);
    });

    it("de-duplicates", () => {
      const r = validateLibraryCounts({ kinds: ["image", "image", "video"] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.kinds).toEqual(["image", "video"]);
    });

    it("rejects an unknown kind", () => {
      const r = validateLibraryCounts({ kinds: ["image", "audio"] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("kind_invalid");
    });

    it("rejects a non-array", () => {
      const r = validateLibraryCounts({ kinds: "image" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("kinds_invalid");
    });
  });

  describe("source-app facets", () => {
    it("accepts bundle ids and the null 'unknown app' bucket on both facets", () => {
      const r = validateLibraryCounts({
        appBundleIds: ["com.apple.Safari", null],
        excludeAppBundleIds: [null]
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.appBundleIds).toEqual(["com.apple.Safari", null]);
        expect(r.value.excludeAppBundleIds).toEqual([null]);
      }
    });

    it("rejects an empty-string bundle id", () => {
      const r = validateLibraryCounts({ appBundleIds: [""] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("appBundleIds_entry_invalid");
    });

    it("caps each facet independently", () => {
      const many = Array.from({ length: 501 }, (_, i) => `com.example.app${i}`);
      const a = validateLibraryCounts({ appBundleIds: many });
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.error.code).toBe("appBundleIds_too_many");
      const b = validateLibraryCounts({ excludeAppBundleIds: many });
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.error.code).toBe("excludeAppBundleIds_too_many");
    });
  });

  describe("date bounds", () => {
    it("accepts a half-open ISO-8601 interval", () => {
      const r = validateLibraryCounts({
        capturedAtStart: "2026-08-22T07:00:00.000Z",
        capturedAtEnd: "2026-08-23T07:00:00.000Z"
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.capturedAtStart).toBe("2026-08-22T07:00:00.000Z");
        expect(r.value.capturedAtEnd).toBe("2026-08-23T07:00:00.000Z");
      }
    });

    it("rejects an unparseable bound rather than letting it silently mis-count", () => {
      // Bounds are compared lexicographically against `captured_at`, so
      // a junk value would not error — it would quietly count the wrong
      // rows. That is the failure this check exists to prevent.
      for (const field of ["capturedAtStart", "capturedAtEnd"] as const) {
        const r = validateLibraryCounts({ [field]: "yesterday" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe(`${field}_unparseable`);
      }
    });

    it("rejects a non-string bound", () => {
      for (const field of ["capturedAtStart", "capturedAtEnd"] as const) {
        const r = validateLibraryCounts({ [field]: 1755840000000 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe(`${field}_invalid`);
      }
    });

    it("allows either bound alone — an open-ended range is still legal", () => {
      const a = validateLibraryCounts({ capturedAtStart: "2026-08-22T07:00:00.000Z" });
      expect(a.ok).toBe(true);
      if (a.ok) expect(a.value.capturedAtEnd).toBeUndefined();
      const b = validateLibraryCounts({ capturedAtEnd: "2026-08-23T07:00:00.000Z" });
      expect(b.ok).toBe(true);
      if (b.ok) expect(b.value.capturedAtStart).toBeUndefined();
    });
  });
});
