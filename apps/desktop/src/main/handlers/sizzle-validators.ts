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
  SIZZLE_AUDIO_SOURCES,
  SIZZLE_TRANSITIONS,
  SIZZLE_VIDEO_FIT_POLICIES,
  SIZZLE_VOICES,
  normalizeSizzleSequenceBeatContinuity,
  normalizeSizzleTransition,
  type SizzleAudioSource,
  type SizzleBeatTiming,
  type SizzleMediaTrim,
  type SizzleProject,
  type SizzleScene,
  type SizzleSequenceBeat,
  type SizzleTransition,
  type SizzleTransitionType,
  type SizzleVideoFitPolicy,
  type SizzleTtsModel,
  type SizzleTtsProvider,
  type SizzleVoice,
  type PwrSnapError
} from "@pwrsnap/shared";
import { SEARCH_MAX_LIMIT } from "../persistence/captures-repo";

/** Hard caps. Generous for legitimate use, tight enough to keep
 *  the JSON store small and TTS calls bounded. OpenAI's TTS API
 *  itself caps `input` at ~4096 chars per request, so 4000 here
 *  leaves room for trimming + diagnostic prefixes. */
export const SIZZLE_LIMITS = {
  projectNameMax: 200,
  sceneScriptLineMax: 4000,
  sequenceBeatsMax: 80,
  beatPhraseMax: 160,
  scenesPerProjectMax: 200,
  durationOverrideSecMin: 0.5,
  durationOverrideSecMax: 60,
  /** Hard cap on a video scene's trim range. Matches the OpenAI TTS
   *  practical-length cap and keeps the rendered reel under a few
   *  minutes per scene. */
  mediaTrimSecMin: 0.1,
  mediaTrimSecMax: 60,
  beatTimingSecMax: 600,
  transitionDurationSecMax: 3,
  /** Cap on bulk capture lookups via `library:listByIds`. The Library
   *  project view fetches a project's scenes in one go; 500 is well
   *  beyond the scenes-per-project cap and gives any caller a generous
   *  headroom. */
  listByIdsMax: 500
} as const;

const TTS_MODELS: readonly SizzleTtsModel[] = ["tts-1", "tts-1-hd"];
const TTS_PROVIDERS: readonly SizzleTtsProvider[] = ["openai"];
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

export function validateSizzleDuplicate(
  req: unknown
):
  | { ok: true; value: { id: string; name?: string; forkChat: boolean } }
  | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "duplicate payload must be an object") };
  }
  const id = req.id;
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: validationError("id_required", "id must be a non-empty string") };
  }
  const out: { id: string; name?: string; forkChat: boolean } = {
    id,
    forkChat: req.forkChat !== false
  };
  if (req.name !== undefined) {
    if (typeof req.name !== "string") {
      return { ok: false, error: validationError("name_invalid", "name must be a string") };
    }
    if (req.name.length > SIZZLE_LIMITS.projectNameMax) {
      return {
        ok: false,
        error: validationError(
          "name_too_long",
          `name must be ≤ ${SIZZLE_LIMITS.projectNameMax} chars`
        )
      };
    }
    out.name = req.name;
  }
  if (req.forkChat !== undefined && typeof req.forkChat !== "boolean") {
    return { ok: false, error: validationError("forkChat_invalid", "forkChat must be a boolean") };
  }
  return { ok: true, value: out };
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

  if (patch.coverCaptureId !== undefined) {
    if (patch.coverCaptureId !== null && (typeof patch.coverCaptureId !== "string" || patch.coverCaptureId.length === 0)) {
      return {
        ok: false,
        error: validationError("coverCaptureId_invalid", "coverCaptureId must be a non-empty string or null")
      };
    }
    out.coverCaptureId = patch.coverCaptureId;
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

function isAudioSource(v: unknown): v is SizzleAudioSource {
  return typeof v === "string" && (SIZZLE_AUDIO_SOURCES as readonly string[]).includes(v);
}

function isTransitionType(v: unknown): v is SizzleTransitionType {
  return typeof v === "string" && (SIZZLE_TRANSITIONS as readonly string[]).includes(v);
}

function isVideoFitPolicy(v: unknown): v is SizzleVideoFitPolicy {
  return typeof v === "string" && (SIZZLE_VIDEO_FIT_POLICIES as readonly string[]).includes(v);
}

function validateMediaTrim(
  v: unknown,
  idx: number
):
  | { ok: true; value: SizzleMediaTrim | null }
  | { ok: false; error: PwrSnapError } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (!isRecord(v)) {
    return {
      ok: false,
      error: validationError("scene_mediaTrim_invalid", `scene[${idx}].mediaTrim must be an object`)
    };
  }
  const startSec = v.startSec;
  const endSec = v.endSec;
  if (typeof startSec !== "number" || !Number.isFinite(startSec) || startSec < 0) {
    return {
      ok: false,
      error: validationError(
        "scene_mediaTrim_start_invalid",
        `scene[${idx}].mediaTrim.startSec must be a finite number ≥ 0`
      )
    };
  }
  if (typeof endSec !== "number" || !Number.isFinite(endSec) || endSec <= startSec) {
    return {
      ok: false,
      error: validationError(
        "scene_mediaTrim_end_invalid",
        `scene[${idx}].mediaTrim.endSec must be a finite number > startSec`
      )
    };
  }
  const duration = endSec - startSec;
  if (duration < SIZZLE_LIMITS.mediaTrimSecMin || duration > SIZZLE_LIMITS.mediaTrimSecMax) {
    return {
      ok: false,
      error: validationError(
        "scene_mediaTrim_duration_out_of_range",
        `scene[${idx}].mediaTrim duration must be in [${SIZZLE_LIMITS.mediaTrimSecMin}, ${SIZZLE_LIMITS.mediaTrimSecMax}]`
      )
    };
  }
  return { ok: true, value: { startSec, endSec } };
}

function validateTransition(
  v: unknown,
  _idx: number,
  field: string,
  defaults: { type?: SizzleTransitionType; durationSec?: number } = {}
): { ok: true; value: SizzleTransition } | { ok: false; error: PwrSnapError } {
  if (v === undefined || v === null) {
    return { ok: true, value: normalizeSizzleTransition(undefined, defaults) };
  }
  if (typeof v === "string") {
    if (!isTransitionType(v)) {
      return {
        ok: false,
        error: validationError(
          "scene_transition_invalid",
          `${field} must be one of ${SIZZLE_TRANSITIONS.join(", ")}`
        )
      };
    }
    return { ok: true, value: normalizeSizzleTransition(v, defaults) };
  }
  if (!isRecord(v)) {
    return {
      ok: false,
      error: validationError("scene_transition_invalid", `${field} must be a string or object`)
    };
  }
  if (!isTransitionType(v.type)) {
    return {
      ok: false,
      error: validationError(
        "scene_transition_invalid",
        `${field}.type must be one of ${SIZZLE_TRANSITIONS.join(", ")}`
      )
    };
  }
  if (
    typeof v.durationSec !== "number" ||
    !Number.isFinite(v.durationSec) ||
    v.durationSec < 0 ||
    v.durationSec > SIZZLE_LIMITS.transitionDurationSecMax
  ) {
    return {
      ok: false,
      error: validationError(
        "scene_transition_duration_invalid",
        `${field}.durationSec must be a finite number in [0, ${SIZZLE_LIMITS.transitionDurationSecMax}]`
      )
    };
  }
  return {
    ok: true,
    value: normalizeSizzleTransition(
      { type: v.type, durationSec: v.durationSec },
      defaults
    )
  };
}

function validateBeatTiming(
  v: unknown,
  sceneIdx: number,
  beatIdx: number
): { ok: true; value: SizzleBeatTiming } | { ok: false; error: PwrSnapError } {
  const field = `scene[${sceneIdx}].beats[${beatIdx}].timing`;
  if (!isRecord(v)) {
    return {
      ok: false,
      error: validationError("scene_beat_timing_invalid", `${field} must be an object`)
    };
  }
  if (v.kind === "offset") {
    if (typeof v.startSec !== "number" || !Number.isFinite(v.startSec) || v.startSec < 0) {
      return {
        ok: false,
        error: validationError("scene_beat_timing_invalid", `${field}.startSec must be a finite number ≥ 0`)
      };
    }
    if (v.startSec > SIZZLE_LIMITS.beatTimingSecMax) {
      return {
        ok: false,
        error: validationError("scene_beat_timing_out_of_range", `${field}.startSec is too large`)
      };
    }
    if (v.endSec !== null && v.endSec !== undefined) {
      if (typeof v.endSec !== "number" || !Number.isFinite(v.endSec) || v.endSec <= v.startSec) {
        return {
          ok: false,
          error: validationError("scene_beat_timing_invalid", `${field}.endSec must be > startSec or null`)
        };
      }
      if (v.endSec > SIZZLE_LIMITS.beatTimingSecMax) {
        return {
          ok: false,
          error: validationError("scene_beat_timing_out_of_range", `${field}.endSec is too large`)
        };
      }
    }
    return {
      ok: true,
      value: { kind: "offset", startSec: v.startSec, endSec: typeof v.endSec === "number" ? v.endSec : null }
    };
  }
  if (v.kind === "phrase") {
    if (typeof v.phrase !== "string" || v.phrase.trim().length === 0) {
      return {
        ok: false,
        error: validationError("scene_beat_phrase_invalid", `${field}.phrase must be a non-empty string`)
      };
    }
    if (v.phrase.length > SIZZLE_LIMITS.beatPhraseMax) {
      return {
        ok: false,
        error: validationError("scene_beat_phrase_too_long", `${field}.phrase is too long`)
      };
    }
    const occurrence =
      typeof v.occurrence === "number" && Number.isInteger(v.occurrence) && v.occurrence > 0
        ? v.occurrence
        : null;
    const offsetSec =
      typeof v.offsetSec === "number" && Number.isFinite(v.offsetSec)
        ? v.offsetSec
        : 0;
    if (Math.abs(offsetSec) > SIZZLE_LIMITS.beatTimingSecMax) {
      return {
        ok: false,
        error: validationError("scene_beat_timing_out_of_range", `${field}.offsetSec is too large`)
      };
    }
    if (v.durationSec !== null && v.durationSec !== undefined) {
      if (typeof v.durationSec !== "number" || !Number.isFinite(v.durationSec) || v.durationSec <= 0) {
        return {
          ok: false,
          error: validationError("scene_beat_timing_invalid", `${field}.durationSec must be a positive number or null`)
        };
      }
      if (v.durationSec > SIZZLE_LIMITS.beatTimingSecMax) {
        return {
          ok: false,
          error: validationError("scene_beat_timing_out_of_range", `${field}.durationSec is too large`)
        };
      }
    }
    return {
      ok: true,
      value: {
        kind: "phrase",
        phrase: v.phrase.trim(),
        occurrence,
        offsetSec,
        durationSec: typeof v.durationSec === "number" ? v.durationSec : null
      }
    };
  }
  if (v.kind === "auto") {
    // Auto beats carry no timing fields. Reject any that sneak in so a
    // malformed agent/HTTP payload fails closed rather than silently
    // dropping data.
    for (const stray of ["startSec", "endSec", "phrase", "offsetSec", "occurrence", "durationSec"] as const) {
      if (v[stray] !== undefined && v[stray] !== null) {
        return {
          ok: false,
          error: validationError("scene_beat_timing_invalid", `${field}.${stray} is not allowed on an auto beat`)
        };
      }
    }
    return { ok: true, value: { kind: "auto" } };
  }
  return {
    ok: false,
    error: validationError("scene_beat_timing_invalid", `${field}.kind must be offset, phrase, or auto`)
  };
}

function validateSequenceBeats(
  v: unknown,
  sceneIdx: number
): { ok: true; value: SizzleSequenceBeat[] } | { ok: false; error: PwrSnapError } {
  if (!Array.isArray(v)) {
    return {
      ok: false,
      error: validationError("scene_beats_invalid", `scene[${sceneIdx}].beats must be an array`)
    };
  }
  if (v.length === 0) {
    return {
      ok: false,
      error: validationError("scene_beats_empty", `scene[${sceneIdx}].beats must not be empty`)
    };
  }
  if (v.length > SIZZLE_LIMITS.sequenceBeatsMax) {
    return {
      ok: false,
      error: validationError("scene_beats_too_many", `scene[${sceneIdx}].beats has too many entries`)
    };
  }
  const out: SizzleSequenceBeat[] = [];
  for (let i = 0; i < v.length; i++) {
    const beat = v[i];
    const field = `scene[${sceneIdx}].beats[${i}]`;
    if (!isRecord(beat)) {
      return {
        ok: false,
        error: validationError("scene_beat_invalid", `${field} must be an object`)
      };
    }
    if (typeof beat.id !== "string" || beat.id.length === 0) {
      return {
        ok: false,
        error: validationError("scene_beat_id_invalid", `${field}.id must be a non-empty string`)
      };
    }
    if (typeof beat.captureId !== "string" || beat.captureId.length === 0) {
      return {
        ok: false,
        error: validationError("scene_beat_captureId_invalid", `${field}.captureId must be a non-empty string`)
      };
    }
    const timing = validateBeatTiming(beat.timing, sceneIdx, i);
    if (!timing.ok) return timing;
    const trim = validateMediaTrim(beat.mediaTrim, sceneIdx);
    if (!trim.ok) return trim;
    const transition = validateTransition(beat.transition, sceneIdx, `${field}.transition`, {
      type: "cut",
      durationSec: 0
    });
    if (!transition.ok) return transition;
    const videoFit =
      beat.videoFit === undefined || beat.videoFit === null
        ? "smart-fit"
        : beat.videoFit;
    if (!isVideoFitPolicy(videoFit)) {
      return {
        ok: false,
        error: validationError(
          "scene_beat_videoFit_invalid",
          `${field}.videoFit must be one of ${SIZZLE_VIDEO_FIT_POLICIES.join(", ")}`
        )
      };
    }
    out.push({
      id: beat.id,
      captureId: beat.captureId,
      timing: timing.value,
      mediaTrim: trim.value,
      transition: transition.value,
      videoFit
    });
  }
  return { ok: true, value: normalizeSizzleSequenceBeatContinuity(out) };
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
  if (v.kind !== undefined && v.kind !== null && v.kind !== "simple" && v.kind !== "sequence") {
    return {
      ok: false,
      error: validationError("scene_kind_invalid", `scene[${idx}].kind must be simple or sequence`)
    };
  }
  const kind = v.kind === "sequence" ? "sequence" : "simple";
  const beatsResult =
    kind === "sequence" ? validateSequenceBeats(v.beats, idx) : null;
  if (beatsResult !== null && !beatsResult.ok) return beatsResult;

  const fallbackCaptureId =
    beatsResult !== null && beatsResult.ok ? beatsResult.value[0]!.captureId : null;
  if (
    (typeof v.captureId !== "string" || v.captureId.length === 0) &&
    fallbackCaptureId === null
  ) {
    return {
      ok: false,
      error: validationError("scene_captureId_invalid", `scene[${idx}].captureId must be a non-empty string`)
    };
  }
  const scriptSource =
    kind === "sequence" && typeof v.narration === "string"
      ? v.narration
      : v.scriptLine;
  if (typeof scriptSource !== "string") {
    return {
      ok: false,
      error: validationError("scene_scriptLine_invalid", `scene[${idx}].scriptLine must be a string`)
    };
  }
  if (scriptSource.length > SIZZLE_LIMITS.sceneScriptLineMax) {
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
  const trimResult = validateMediaTrim(v.mediaTrim, idx);
  if (!trimResult.ok) return trimResult;
  // audioSource is optional in the wire format (older projects predate
  // this field); absent / undefined defaults to "auto".
  let audioSource: SizzleAudioSource = "auto";
  if (v.audioSource !== undefined && v.audioSource !== null) {
    if (!isAudioSource(v.audioSource)) {
      return {
        ok: false,
        error: validationError(
          "scene_audioSource_invalid",
          `scene[${idx}].audioSource must be one of ${SIZZLE_AUDIO_SOURCES.join(", ")}`
        )
      };
    }
    audioSource = v.audioSource;
  }
  const transitionResult = validateTransition(v.transition, idx, `scene[${idx}].transition`, {
    type: "crossfade"
  });
  if (!transitionResult.ok) return transitionResult;
  const value: ValidatedScene = {
    id: v.id,
    captureId:
      typeof v.captureId === "string" && v.captureId.length > 0
        ? v.captureId
        : fallbackCaptureId!,
    scriptLine: scriptSource,
    durationOverrideSec,
    mediaTrim: trimResult.value,
    audioSource: kind === "sequence" ? "voiceover" : audioSource,
    transition: transitionResult.value
  };
  if (kind === "sequence") {
    value.kind = "sequence";
    value.narration = scriptSource;
    value.beats = beatsResult!.value;
  }
  return {
    ok: true,
    value
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

export function validateSizzleToggleScene(
  req: unknown
):
  | { ok: true; projectId: string; captureId: string }
  | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (typeof req.projectId !== "string" || req.projectId.length === 0) {
    return { ok: false, error: validationError("projectId_required", "projectId must be a non-empty string") };
  }
  if (typeof req.captureId !== "string" || req.captureId.length === 0) {
    return { ok: false, error: validationError("captureId_required", "captureId must be a non-empty string") };
  }
  return { ok: true, projectId: req.projectId, captureId: req.captureId };
}

export function validateLibraryListByIds(
  req: unknown
): { ok: true; ids: string[] } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (!Array.isArray(req.ids)) {
    return { ok: false, error: validationError("ids_required", "ids must be an array of strings") };
  }
  if (req.ids.length > SIZZLE_LIMITS.listByIdsMax) {
    return {
      ok: false,
      error: validationError(
        "ids_too_many",
        `ids must be ≤ ${SIZZLE_LIMITS.listByIdsMax} (got ${req.ids.length})`
      )
    };
  }
  const out: string[] = [];
  for (let i = 0; i < req.ids.length; i++) {
    const id = req.ids[i];
    if (typeof id !== "string" || id.length === 0) {
      return {
        ok: false,
        error: validationError(
          "id_invalid",
          `ids[${i}] must be a non-empty string`
        )
      };
    }
    out.push(id);
  }
  return { ok: true, ids: out };
}

/**
 * Validate `library:search` request. Every field is optional;
 * supplied fields combine conjunctively.
 *
 * Why this lives in sizzle-validators.ts: same reason
 * `validateLibraryListByIds` does — these library bus surfaces were
 * added FOR the sizzle reels feature (chat agent + cart need them).
 * A future house-keeping refactor can split out a dedicated
 * `library-validators.ts` once there's enough material to warrant it.
 */
export function validateLibrarySearch(
  req: unknown
):
  | {
      ok: true;
      value: {
        query?: string;
        appBundleIds?: Array<string | null>;
        kinds?: Array<"image" | "video">;
        dateRange?: { start: string; end: string };
        hasOcr?: boolean;
        limit?: number;
      };
    }
  | { ok: false; error: PwrSnapError } {
  if (req === null || req === undefined) {
    return { ok: true, value: {} };
  }
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  const out: {
    query?: string;
    appBundleIds?: Array<string | null>;
    kinds?: Array<"image" | "video">;
    dateRange?: { start: string; end: string };
    hasOcr?: boolean;
    limit?: number;
  } = {};

  if (req.query !== undefined && req.query !== null) {
    if (typeof req.query !== "string") {
      return {
        ok: false,
        error: validationError("query_invalid", "query must be a string when provided")
      };
    }
    // Cap raw query length so a malicious / runaway agent can't pass
    // megabytes of text into FTS5. 2 KB is way above any reasonable
    // search input; the sanitizer in `buildFts5Query` trims further.
    if (req.query.length > 2048) {
      return {
        ok: false,
        error: validationError(
          "query_too_long",
          "query must be ≤ 2048 characters"
        )
      };
    }
    out.query = req.query;
  }

  if (req.appBundleIds !== undefined && req.appBundleIds !== null) {
    if (!Array.isArray(req.appBundleIds)) {
      return {
        ok: false,
        error: validationError(
          "appBundleIds_invalid",
          "appBundleIds must be an array of strings (or nulls) when provided"
        )
      };
    }
    const ids: Array<string | null> = [];
    for (let i = 0; i < req.appBundleIds.length; i++) {
      const v = req.appBundleIds[i];
      if (v === null) {
        ids.push(null);
      } else if (typeof v === "string" && v.length > 0) {
        ids.push(v);
      } else {
        return {
          ok: false,
          error: validationError(
            "appBundleId_invalid",
            `appBundleIds[${i}] must be a non-empty string or null`
          )
        };
      }
    }
    out.appBundleIds = ids;
  }

  if (req.kinds !== undefined && req.kinds !== null) {
    if (!Array.isArray(req.kinds)) {
      return {
        ok: false,
        error: validationError(
          "kinds_invalid",
          "kinds must be an array of 'image' | 'video' when provided"
        )
      };
    }
    const kinds: Array<"image" | "video"> = [];
    for (let i = 0; i < req.kinds.length; i++) {
      const v = req.kinds[i];
      if (v !== "image" && v !== "video") {
        return {
          ok: false,
          error: validationError(
            "kind_invalid",
            `kinds[${i}] must be 'image' or 'video'`
          )
        };
      }
      kinds.push(v);
    }
    out.kinds = kinds;
  }

  if (req.dateRange !== undefined && req.dateRange !== null) {
    if (!isRecord(req.dateRange)) {
      return {
        ok: false,
        error: validationError(
          "dateRange_invalid",
          "dateRange must be { start, end } when provided"
        )
      };
    }
    const { start, end } = req.dateRange;
    if (
      typeof start !== "string" ||
      typeof end !== "string" ||
      start.length === 0 ||
      end.length === 0
    ) {
      return {
        ok: false,
        error: validationError(
          "dateRange_invalid",
          "dateRange.start and dateRange.end must be non-empty ISO strings"
        )
      };
    }
    if (start > end) {
      return {
        ok: false,
        error: validationError(
          "dateRange_inverted",
          "dateRange.start must be ≤ dateRange.end"
        )
      };
    }
    out.dateRange = { start, end };
  }

  if (req.hasOcr !== undefined && req.hasOcr !== null) {
    if (typeof req.hasOcr !== "boolean") {
      return {
        ok: false,
        error: validationError("hasOcr_invalid", "hasOcr must be a boolean when provided")
      };
    }
    out.hasOcr = req.hasOcr;
  }

  if (req.limit !== undefined && req.limit !== null) {
    if (typeof req.limit !== "number" || !Number.isFinite(req.limit) || req.limit < 1) {
      return {
        ok: false,
        error: validationError("limit_invalid", "limit must be a positive number when provided")
      };
    }
    // Reference the canonical SEARCH_MAX_LIMIT from captures-repo
    // rather than hardcoding 500 — keeps the validator and the
    // repo in lockstep if the cap ever moves.
    if (req.limit > SEARCH_MAX_LIMIT) {
      return {
        ok: false,
        error: validationError(
          "limit_too_large",
          `limit must be ≤ ${SEARCH_MAX_LIMIT}`
        )
      };
    }
    out.limit = Math.floor(req.limit);
  }

  return { ok: true, value: out };
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
