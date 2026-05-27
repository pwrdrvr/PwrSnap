// IPC input validators for the `sizzle:*` namespace.
//
// TypeScript catches misuse from the renderer at build time, but the
// command bus is also reachable from Phase 7 HTTP RPC and (later)
// MCP — both accept arbitrary JSON. Each validator below hand-checks
// one verb's payload and returns either a narrowed value or a
// validation-error envelope the handler can short-circuit with.
//
// Specific concerns this file addresses:
//
//   1. Renderers (or hostile RPC callers) should not be able to write
//      to fields the SERVER owns — outputPath, lastRenderedAt,
//      modifiedAt, createdAt. Those drift the disk state into shapes
//      the renderer's never seen.
//   2. Unbounded strings (scriptLine, name) need length caps so a
//      misbehaving caller can't blow up the JSON store with a 1GB
//      script.
//   3. Enum-shaped fields (voice, ttsModel, ttsProvider, resolution)
//      need allow-list checks so they don't reach ffmpeg or the TTS
//      cache as arbitrary strings.
//
// We do NOT pull in zod here — settings-validators.ts established
// the inline-functions precedent for this codebase and the
// validators here stay surgical (one verb each, shallow shape).

import {
  SIZZLE_VOICES,
  type SizzleProject,
  type SizzleScene,
  type SizzleTtsModel,
  type SizzleTtsProvider,
  type SizzleVoice,
  type PwrSnapError
} from "@pwrsnap/shared";

/** Hard caps. Generous for legitimate use, tight enough to keep
 *  the JSON store small and TTS calls bounded. OpenAI's TTS API
 *  itself caps `input` at ~4096 chars per request, so 4000 here
 *  leaves room for trimming + diagnostic prefixes. */
export const SIZZLE_LIMITS = {
  projectNameMax: 200,
  sceneScriptLineMax: 4000,
  scenesPerProjectMax: 200,
  durationOverrideSecMin: 0.5,
  durationOverrideSecMax: 60
} as const;

const TTS_MODELS: readonly SizzleTtsModel[] = ["tts-1", "tts-1-hd"];
const TTS_PROVIDERS: readonly SizzleTtsProvider[] = ["openai", "xai"];
const RESOLUTIONS: readonly SizzleProject["resolution"][] = ["1080p", "720p"];

function validationError(code: string, message: string): PwrSnapError {
  return { kind: "validation", code, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isVoice(v: unknown): v is SizzleVoice {
  return typeof v === "string" && (SIZZLE_VOICES as readonly string[]).includes(v);
}

function isTtsModel(v: unknown): v is SizzleTtsModel {
  return typeof v === "string" && (TTS_MODELS as readonly string[]).includes(v);
}

function isTtsProvider(v: unknown): v is SizzleTtsProvider {
  return typeof v === "string" && (TTS_PROVIDERS as readonly string[]).includes(v);
}

function isResolution(v: unknown): v is SizzleProject["resolution"] {
  return typeof v === "string" && (RESOLUTIONS as readonly string[]).includes(v);
}

/** Fields the renderer is NOT allowed to set on the project — those
 *  are server-owned (the render handler writes them when a render
 *  completes; the store writes modifiedAt). Including any of these
 *  in a `sizzle:update` patch is treated as a hostile or buggy call
 *  and rejected. */
const SERVER_OWNED_FIELDS = new Set([
  "id",
  "createdAt",
  "modifiedAt",
  "outputPath",
  "lastRenderedAt"
]);

export type ValidatedScene = SizzleScene;

export type ValidatedSizzleUpdate = {
  id: string;
  patch: Partial<Omit<SizzleProject, "id" | "createdAt">>;
};

export function validateSizzleCreate(
  req: unknown
): { ok: true; name: string } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) return { ok: false, error: validationError("not_object", "create payload must be an object") };
  const name = req.name;
  if (typeof name !== "string") {
    return { ok: false, error: validationError("name_required", "name must be a string") };
  }
  if (name.length > SIZZLE_LIMITS.projectNameMax) {
    return {
      ok: false,
      error: validationError(
        "name_too_long",
        `name must be ≤ ${SIZZLE_LIMITS.projectNameMax} chars (got ${name.length})`
      )
    };
  }
  return { ok: true, name };
}

export function validateSizzleUpdate(
  req: unknown
): { ok: true; value: ValidatedSizzleUpdate } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "update payload must be an object") };
  }
  const { id, patch } = req;
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: validationError("id_required", "id must be a non-empty string") };
  }
  if (!isRecord(patch)) {
    return { ok: false, error: validationError("patch_required", "patch must be an object") };
  }

  // Reject any field the server owns.
  for (const key of Object.keys(patch)) {
    if (SERVER_OWNED_FIELDS.has(key)) {
      return {
        ok: false,
        error: validationError(
          "server_owned_field",
          `field ${JSON.stringify(key)} is server-owned and cannot be set by clients`
        )
      };
    }
  }

  const out: Partial<Omit<SizzleProject, "id" | "createdAt">> = {};

  if (patch.name !== undefined) {
    if (typeof patch.name !== "string") {
      return { ok: false, error: validationError("name_invalid", "name must be a string") };
    }
    if (patch.name.length > SIZZLE_LIMITS.projectNameMax) {
      return {
        ok: false,
        error: validationError(
          "name_too_long",
          `name must be ≤ ${SIZZLE_LIMITS.projectNameMax} chars`
        )
      };
    }
    out.name = patch.name;
  }

  if (patch.voice !== undefined) {
    if (!isVoice(patch.voice)) {
      return { ok: false, error: validationError("voice_invalid", `voice must be one of ${SIZZLE_VOICES.join(", ")}`) };
    }
    out.voice = patch.voice;
  }

  if (patch.ttsModel !== undefined) {
    if (!isTtsModel(patch.ttsModel)) {
      return { ok: false, error: validationError("ttsModel_invalid", `ttsModel must be one of ${TTS_MODELS.join(", ")}`) };
    }
    out.ttsModel = patch.ttsModel;
  }

  if (patch.ttsProvider !== undefined) {
    if (!isTtsProvider(patch.ttsProvider)) {
      return { ok: false, error: validationError("ttsProvider_invalid", `ttsProvider must be one of ${TTS_PROVIDERS.join(", ")}`) };
    }
    out.ttsProvider = patch.ttsProvider;
  }

  if (patch.resolution !== undefined) {
    if (!isResolution(patch.resolution)) {
      return { ok: false, error: validationError("resolution_invalid", `resolution must be one of ${RESOLUTIONS.join(", ")}`) };
    }
    out.resolution = patch.resolution;
  }

  if (patch.scenes !== undefined) {
    const scenesResult = validateScenesArray(patch.scenes);
    if (!scenesResult.ok) return { ok: false, error: scenesResult.error };
    out.scenes = scenesResult.value;
  }

  return { ok: true, value: { id, patch: out } };
}

function validateScenesArray(
  v: unknown
): { ok: true; value: ValidatedScene[] } | { ok: false; error: PwrSnapError } {
  if (!Array.isArray(v)) {
    return { ok: false, error: validationError("scenes_invalid", "scenes must be an array") };
  }
  if (v.length > SIZZLE_LIMITS.scenesPerProjectMax) {
    return {
      ok: false,
      error: validationError(
        "scenes_too_many",
        `scenes must be ≤ ${SIZZLE_LIMITS.scenesPerProjectMax} (got ${v.length})`
      )
    };
  }
  const out: ValidatedScene[] = [];
  for (let i = 0; i < v.length; i++) {
    const r = validateScene(v[i], i);
    if (!r.ok) return { ok: false, error: r.error };
    out.push(r.value);
  }
  return { ok: true, value: out };
}

function validateScene(
  v: unknown,
  idx: number
): { ok: true; value: ValidatedScene } | { ok: false; error: PwrSnapError } {
  if (!isRecord(v)) {
    return { ok: false, error: validationError("scene_invalid", `scene[${idx}] must be an object`) };
  }
  if (typeof v.id !== "string" || v.id.length === 0) {
    return { ok: false, error: validationError("scene_id_invalid", `scene[${idx}].id must be a non-empty string`) };
  }
  if (typeof v.captureId !== "string" || v.captureId.length === 0) {
    return {
      ok: false,
      error: validationError("scene_captureId_invalid", `scene[${idx}].captureId must be a non-empty string`)
    };
  }
  if (typeof v.scriptLine !== "string") {
    return {
      ok: false,
      error: validationError("scene_scriptLine_invalid", `scene[${idx}].scriptLine must be a string`)
    };
  }
  if (v.scriptLine.length > SIZZLE_LIMITS.sceneScriptLineMax) {
    return {
      ok: false,
      error: validationError(
        "scene_scriptLine_too_long",
        `scene[${idx}].scriptLine must be ≤ ${SIZZLE_LIMITS.sceneScriptLineMax} chars`
      )
    };
  }
  let durationOverrideSec: number | null;
  if (v.durationOverrideSec === null || v.durationOverrideSec === undefined) {
    durationOverrideSec = null;
  } else if (typeof v.durationOverrideSec === "number" && Number.isFinite(v.durationOverrideSec)) {
    if (
      v.durationOverrideSec < SIZZLE_LIMITS.durationOverrideSecMin ||
      v.durationOverrideSec > SIZZLE_LIMITS.durationOverrideSecMax
    ) {
      return {
        ok: false,
        error: validationError(
          "scene_duration_out_of_range",
          `scene[${idx}].durationOverrideSec must be in [${SIZZLE_LIMITS.durationOverrideSecMin}, ${SIZZLE_LIMITS.durationOverrideSecMax}]`
        )
      };
    }
    durationOverrideSec = v.durationOverrideSec;
  } else {
    return {
      ok: false,
      error: validationError(
        "scene_duration_invalid",
        `scene[${idx}].durationOverrideSec must be a finite number or null`
      )
    };
  }
  return {
    ok: true,
    value: {
      id: v.id,
      captureId: v.captureId,
      scriptLine: v.scriptLine,
      durationOverrideSec
    }
  };
}

export function validateSizzleIdRequest(
  req: unknown
): { ok: true; id: string } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (typeof req.id !== "string" || req.id.length === 0) {
    return { ok: false, error: validationError("id_required", "id must be a non-empty string") };
  }
  return { ok: true, id: req.id };
}

export function validateSizzlePreviewRequest(
  req: unknown
):
  | { ok: true; projectId: string; sceneId: string }
  | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (typeof req.projectId !== "string" || req.projectId.length === 0) {
    return { ok: false, error: validationError("projectId_required", "projectId must be a non-empty string") };
  }
  if (typeof req.sceneId !== "string" || req.sceneId.length === 0) {
    return { ok: false, error: validationError("sceneId_required", "sceneId must be a non-empty string") };
  }
  return { ok: true, projectId: req.projectId, sceneId: req.sceneId };
}

export function validateSizzleOpenRequest(
  req: unknown
): { ok: true; projectId: string | undefined } | { ok: false; error: PwrSnapError } {
  if (req === null || req === undefined) return { ok: true, projectId: undefined };
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (req.projectId === undefined) return { ok: true, projectId: undefined };
  if (typeof req.projectId !== "string" || req.projectId.length === 0) {
    return { ok: false, error: validationError("projectId_invalid", "projectId must be a non-empty string when provided") };
  }
  return { ok: true, projectId: req.projectId };
}
