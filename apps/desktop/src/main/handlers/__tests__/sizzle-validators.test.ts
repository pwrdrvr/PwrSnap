import { describe, expect, it } from "vitest";
import {
  validateSizzleCreate,
  validateSizzleIdRequest,
  validateSizzleOpenRequest,
  validateSizzlePreviewRequest,
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
