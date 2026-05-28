import { describe, expect, it } from "vitest";
import {
  validateLibraryListByIds,
  validateSizzleCreate,
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
        resolution: "720p"
      }
    });
    expect(r.ok).toBe(true);
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
