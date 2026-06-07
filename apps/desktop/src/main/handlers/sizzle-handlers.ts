import { BrowserWindow, app, shell } from "electron";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  EVENT_CHANNELS,
  err,
  ok,
  resolveSizzleAudioSource,
  type CaptureRecord,
  type EventPayloads,
  type PwrSnapError,
  type Result,
  type SizzleProject,
  type SizzleRenderProgressEvent,
  type SizzleScene,
  type SizzleSequencePreviewPlan
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { getSizzleStore, SizzleProjectNotFoundError } from "../sizzle/sizzle-store";
import { cleanupProjectChats, forkProjectChats } from "./sizzle-chat-handlers";
import {
  pruneTtsCache,
  readAudio,
  synthesize,
  ttsCacheDir,
  ttsCacheFilename,
  TtsError
} from "../sizzle/tts";
import {
  buildTranscriptPhraseSuggestions,
  resolveCachedSpeechTiming,
  resolveSpeechTiming
} from "../sizzle/speech-timing";
import {
  planSequencePreviewMedia,
  planSequenceScene,
  planSequenceTimeline,
  SequencePlannerError
} from "../sizzle/sequence-planner";
import { mediaTrimWasClamped, normalizeVideoMediaTrim } from "../sizzle/media-trim";
import {
  compose,
  ComposeError,
  probeDurationSec,
  type SceneInput
} from "../sizzle/composer";
import {
  AudioExtractError,
  extractVideoAudio,
  synthesizeSilence
} from "../sizzle/audio-extract";
import {
  createSizzleWindow,
  findSizzleWindow,
  positionSizzleWindowForSource
} from "../window";
import {
  DesktopSecretStore,
  SecretUnavailableError
} from "../settings/desktop-secret-store";
import { resolveCacheFile } from "../render/coordinator";
import { resolveFfmpegPath } from "../recording/ffmpeg-resolver";
import {
  validateSizzleCreate,
  validateSizzleDuplicate,
  validateSizzleIdRequest,
  validateSizzleOpenRequest,
  validateSizzlePreviewRequest,
  validateSizzleToggleScene,
  validateSizzleUpdate
} from "./sizzle-validators";

const log = getMainLogger("pwrsnap:sizzle-handlers");

let secretStore: DesktopSecretStore | null = null;

function getSecrets(): DesktopSecretStore {
  if (secretStore === null) {
    secretStore = new DesktopSecretStore({
      filePath: join(app.getPath("userData"), "pwrsnap-secrets.bin")
    });
  }
  return secretStore;
}

function broadcastRenderProgress(event: SizzleRenderProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT_CHANNELS.sizzleRenderProgress, event);
  }
}

/**
 * Broadcast the latest project list to every BrowserWindow. The
 * Library sidebar's "Sizzle Reels" section + the DetailRail Project
 * tab subscribe here so they refresh without polling.
 *
 * SYNCHRONOUS — `webContents.send` is fire-and-forget. The previous
 * `async` wrapper was misleading: it forced every mutation handler
 * to write `await broadcastProjectsChanged(...)` even though no I/O
 * was happening. Callers now pass the already-known project list
 * (returned from `store.create / update / delete / updateScenes`)
 * rather than re-reading from disk on every mutation.
 */
function broadcastProjectsChanged(projects: SizzleProject[]): void {
  const payload: EventPayloads[typeof EVENT_CHANNELS.sizzleProjectsChanged] = {
    projects
  };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT_CHANNELS.sizzleProjectsChanged, payload);
  }
}

function toError(cause: unknown, fallbackCode: string): PwrSnapError {
  if (cause instanceof TtsError) {
    return { kind: "render", code: cause.code, message: cause.message };
  }
  if (cause instanceof ComposeError) {
    return {
      kind: "render",
      code: cause.code,
      message: cause.message,
      cause: cause.details
    };
  }
  if (cause instanceof AudioExtractError) {
    return {
      kind: "render",
      code: cause.code,
      message: cause.message,
      cause: cause.details
    };
  }
  if (cause instanceof SceneError) {
    return { kind: "validation", code: "scene_invalid", message: cause.message };
  }
  if (cause instanceof SequencePlannerError) {
    return { kind: "validation", code: cause.code, message: cause.message };
  }
  if (cause instanceof SizzleProjectNotFoundError) {
    return { kind: "validation", code: "not_found", message: cause.message };
  }
  if (cause instanceof SecretUnavailableError) {
    return { kind: "settings", code: "secret_unavailable", message: cause.message };
  }
  if (cause instanceof Error) {
    return { kind: "unknown", code: fallbackCode, message: cause.message, cause };
  }
  return { kind: "unknown", code: fallbackCode, message: String(cause), cause };
}

async function loadCapture(captureId: string): Promise<CaptureRecord | null> {
  const result = await bus.dispatch(
    "library:byId",
    { id: captureId },
    { principal: "ipc" }
  );
  if (!result.ok) return null;
  return result.value;
}

async function resolveImagePath(
  captureId: string,
  width: number
): Promise<string | null> {
  // resolveCacheFile renders the capture at the requested width via
  // the same pipeline `pwrsnap-cache://` uses. Works for v1 + v2
  // bundles, soft-deleted rows, and legacy captures alike.
  return resolveCacheFile({ captureId, width, format: "png" });
}

/**
 * Per-scene audio policy resolver. Forwards to the canonical impl in
 * `@pwrsnap/shared` so the renderer's editor UI (which gates the
 * preview button + script placeholder) and the main-process render
 * path consult the SAME function. Previously duplicated in both
 * processes — a guaranteed-divergence footgun.
 */
export const resolveAudioSource = resolveSizzleAudioSource;

/**
 * Prepare a single scene's `SceneInput` — runs the per-scene audio
 * work (TTS synth, native-audio extract, or silence synth) plus the
 * image-path resolve for image scenes. Independent per-scene; safe
 * to run many in parallel via `Promise.all`.
 *
 * Extracted from the render handler so the prep loop can fan out
 * across scenes. Sequential prep used to be ~hundreds of ms × scene
 * count; parallel prep is bounded by the longest single scene plus
 * a small dispatch tax.
 */
async function prepareSceneInput(args: {
  scene: SizzleScene;
  capture: CaptureRecord;
  effectiveAudio: "native" | "voiceover" | "muted";
  project: SizzleProject;
  apiKey: string | null;
  sceneIdx: number;
  imageWidth: number;
}): Promise<SceneInput> {
  const { scene, capture, effectiveAudio, project, apiKey, sceneIdx, imageWidth } = args;
  let audioPath: string;
  let durationSec: number;

  if (capture.kind === "video") {
    const trim = normalizeVideoMediaTrim({
      trim: scene.mediaTrim,
      defaultRange: {
        start: capture.video?.defaultRange.start ?? 0,
        end: capture.video?.defaultRange.end ?? capture.video?.durationSec ?? 5
      },
      sourceDurationSec: capture.video?.durationSec ?? 5
    });
    if (mediaTrimWasClamped(scene.mediaTrim, trim)) {
      log.info("sizzle:render clamped media trim to source duration", {
        sceneIdx,
        requestedStartSec: scene.mediaTrim!.startSec,
        requestedEndSec: scene.mediaTrim!.endSec,
        sourceDurationSec: capture.video?.durationSec ?? null,
        startSec: trim.startSec,
        endSec: trim.endSec
      });
    }
    const trimDur = trim.endSec - trim.startSec;

    // Scene duration policy for video scenes:
    //   • durationOverrideSec wins if explicitly set.
    //   • Voiceover longer than the trim: extend to fit the voiceover.
    //     Composer holds the last frame via tpad for the remainder
    //     (documentary-style — narration is load-bearing, B-roll holds).
    //   • Native + muted: scene duration matches trim.
    if (effectiveAudio === "voiceover") {
      const tts = await synthesize({
        provider: project.ttsProvider,
        apiKey: apiKey!,
        text: scene.scriptLine.trim(),
        voice: project.voice,
        model: project.ttsModel
      });
      const voiceoverDur = await probeDurationSec(tts.audioPath);
      audioPath = tts.audioPath;
      durationSec = voiceoverDurationSec({
        durationOverrideSec: scene.durationOverrideSec,
        voiceoverDurationSec: voiceoverDur,
        minVisualDurationSec: trimDur
      });
      if (durationSec > trimDur + 0.05) {
        log.info("sizzle:render holding last frame for voiceover", {
          sceneIdx,
          trimDur: trimDur.toFixed(2),
          voiceoverDur: voiceoverDur.toFixed(2),
          sceneDur: durationSec.toFixed(2),
          freezeFrameSec: (durationSec - trimDur).toFixed(2)
        });
      }
    } else if (effectiveAudio === "native") {
      audioPath = await extractVideoAudio({
        videoPath: capture.legacy_src_path!,
        startSec: trim.startSec,
        durationSec: trimDur
      });
      durationSec =
        scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
          ? scene.durationOverrideSec
          : trimDur;
    } else {
      // muted
      durationSec =
        scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
          ? scene.durationOverrideSec
          : trimDur;
      audioPath = await synthesizeSilence(durationSec);
    }

    return {
      kind: "video",
      videoPath: capture.legacy_src_path!,
      startSec: trim.startSec,
      trimDurationSec: trimDur,
      durationSec,
      audioPath,
      transition: scene.transition
    };
  }

  // image scene
  const imagePath = await resolveImagePath(scene.captureId, imageWidth);
  if (imagePath === null) {
    throw new SceneError(`Scene ${sceneIdx}: could not render capture image`);
  }
  if (effectiveAudio === "voiceover") {
    const tts = await synthesize({
      provider: project.ttsProvider,
      apiKey: apiKey!,
      text: scene.scriptLine.trim(),
      voice: project.voice,
      model: project.ttsModel
    });
    const measured = await probeDurationSec(tts.audioPath);
    durationSec = voiceoverDurationSec({
      durationOverrideSec: scene.durationOverrideSec,
      voiceoverDurationSec: measured,
      minVisualDurationSec: 0
    });
    audioPath = tts.audioPath;
  } else {
    // image + muted (or image + native that fell back to muted)
    durationSec =
      scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
        ? scene.durationOverrideSec
        : 3.0;
    audioPath = await synthesizeSilence(durationSec);
  }
  return {
    kind: "image",
    imagePath,
    audioPath,
    durationSec,
    transition: scene.transition
  };
}

function voiceoverDurationSec(args: {
  durationOverrideSec: number | null;
  voiceoverDurationSec: number;
  minVisualDurationSec: number;
}): number {
  const overrideSec =
    args.durationOverrideSec !== null && args.durationOverrideSec > 0
      ? args.durationOverrideSec
      : 0;
  return Math.max(
    args.minVisualDurationSec,
    args.voiceoverDurationSec + 0.35,
    overrideSec
  );
}

export function registerSizzleHandlers(): void {
  const store = getSizzleStore();

  bus.register("sizzle:open", async (req, ctx) => {
    const v = validateSizzleOpenRequest(req);
    if (!v.ok) return err(v.error);
    if (v.projectId !== undefined) {
      try {
        const repair = await store.persistDerivedFieldsForProject(v.projectId);
        if (repair?.repaired === true) {
          await pushProjectsChanged();
        }
      } catch (cause) {
        log.warn("sizzle:open cover repair failed", {
          projectId: v.projectId,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
    }
    const existing = findSizzleWindow();
    const placementSource: NonNullable<Parameters<typeof createSizzleWindow>[1]> = {};
    if (ctx.sourceWindowId !== undefined) {
      placementSource.sourceWindowId = ctx.sourceWindowId;
    }
    if (ctx.sourceBounds !== undefined) {
      placementSource.sourceBounds = ctx.sourceBounds;
    }
    if (existing !== null) {
      // Window already loaded → navigate via a live event (the renderer
      // is subscribed). Mirrors settings:open.
      if (existing.isMinimized()) existing.restore();
      positionSizzleWindowForSource(existing, placementSource);
      existing.show();
      existing.focus();
      if (v.projectId !== undefined) {
        existing.webContents.send(EVENT_CHANNELS.sizzleNav, { projectId: v.projectId });
      }
      return ok(undefined);
    }
    // New window → the target rides the URL hash so the renderer opens to
    // it on mount (no event race against the renderer's subscribe).
    const window = createSizzleWindow(
      v.projectId !== undefined ? `projectId=${encodeURIComponent(v.projectId)}` : undefined,
      placementSource
    );
    window.show();
    window.focus();
    return ok(undefined);
  });

  bus.register("sizzle:list", async () => {
    const projects = await store.list();
    return ok({ projects });
  });

  // Helper: snapshot+broadcast. The store's in-memory cache makes
  // `list()` cheap after a mutation (returns a clone of the just-
  // written blob, no disk I/O). The broadcast itself is synchronous.
  async function pushProjectsChanged(): Promise<void> {
    const all = await store.list();
    broadcastProjectsChanged(all);
  }

  bus.register("sizzle:create", async (req) => {
    const v = validateSizzleCreate(req);
    if (!v.ok) return err(v.error);
    const project = await store.create(v.name);
    await pushProjectsChanged();
    return ok(project);
  });

  bus.register("sizzle:duplicate", async (req) => {
    const v = validateSizzleDuplicate(req);
    if (!v.ok) return err(v.error);
    try {
      const project = await store.duplicate(v.value.id, v.value.name);
      await pushProjectsChanged();
      if (v.value.forkChat) {
        void forkProjectChats(v.value.id, project.id).catch((cause: unknown) => {
          log.warn("sizzle:duplicate chat fork failed", {
            sourceProjectId: v.value.id,
            targetProjectId: project.id,
            message: cause instanceof Error ? cause.message : String(cause)
          });
        });
      }
      return ok(project);
    } catch (cause) {
      return err(toError(cause, "sizzle_duplicate_failed"));
    }
  });

  bus.register("sizzle:update", async (req) => {
    const v = validateSizzleUpdate(req);
    if (!v.ok) return err(v.error);
    try {
      const project = await store.update(v.value.id, v.value.patch);
      await pushProjectsChanged();
      return ok(project);
    } catch (cause) {
      return err(toError(cause, "sizzle_update_failed"));
    }
  });

  bus.register("sizzle:delete", async (req) => {
    const v = validateSizzleIdRequest(req);
    if (!v.ok) return err(v.error);
    await store.delete(v.id);
    // Cascade: remove the project's chat thread(s) + their on-disk dirs so
    // deleting a reel leaves no orphan chat state (locked decision #6).
    // Best-effort — a cleanup failure must not block the delete.
    await cleanupProjectChats(v.id).catch((cause: unknown) => {
      log.warn("sizzle:delete chat cleanup failed", {
        projectId: v.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });
    await pushProjectsChanged();
    return ok(undefined);
  });

  bus.register("sizzle:toggleScene", async (req) => {
    const v = validateSizzleToggleScene(req);
    if (!v.ok) return err(v.error);
    const project = await store.get(v.projectId);
    if (project === null) {
      return err({ kind: "validation", code: "not_found", message: "Project not found" });
    }
    const existingIdx = project.scenes.findIndex((s) => s.captureId === v.captureId);
    let nextScenes: SizzleScene[];
    if (existingIdx >= 0) {
      // Remove the existing scene
      nextScenes = project.scenes.filter((_, i) => i !== existingIdx);
    } else {
      // Append a new scene with empty script — the user fills it in
      // from the sizzle editor. (The editor's "Add scene" flow does
      // a separate Codex enrichment prefill; for the in-library +/✓
      // toggle we keep it cheap and snappy.)
      const newScene: SizzleScene = {
        id: `sc_${randomUUID().slice(0, 10)}`,
        captureId: v.captureId,
        scriptLine: "",
        durationOverrideSec: null,
        mediaTrim: null,
        audioSource: "auto",
        transition: "crossfade"
      };
      nextScenes = [...project.scenes, newScene];
    }
    try {
      const updated = await store.update(project.id, { scenes: nextScenes });
      await pushProjectsChanged();
      return ok(updated);
    } catch (cause) {
      return err(toError(cause, "sizzle_toggle_failed"));
    }
  });

  bus.register("sizzle:previewSceneAudio", async (req) => {
    const v = validateSizzlePreviewRequest(req);
    if (!v.ok) return err(v.error);
    const project = await store.get(v.projectId);
    if (project === null) {
      return err({ kind: "validation", code: "not_found", message: "Project not found" });
    }
    const scene = project.scenes.find((s) => s.id === v.sceneId);
    if (scene === undefined) {
      return err({ kind: "validation", code: "not_found", message: "Scene not found" });
    }
    const capture = await loadCapture(scene.captureId);
    if (capture === null) {
      return err({
        kind: "validation",
        code: "capture_missing",
        message: "The capture for this scene was deleted"
      });
    }
    const effectiveAudio = resolveAudioSource(
      scene.audioSource,
      capture.kind,
      scene.scriptLine
    );
    log.info("sizzle:previewSceneAudio", {
      projectId: project.id,
      sceneId: scene.id,
      captureKind: capture.kind,
      effectiveAudio,
      voice: project.voice,
      model: project.ttsModel,
      scriptLen: scene.scriptLine.length
    });

    try {
      if (effectiveAudio === "voiceover") {
        const text = scene.scriptLine.trim();
        if (text.length === 0) {
          return err({
            kind: "validation",
            code: "empty_script",
            message: "Write a script line first, then preview"
          });
        }
        let apiKey: string | null;
        try {
          apiKey = await getSecrets().getValue(
            project.ttsProvider === "openai" ? "openaiApiKey" : "grokApiKey"
          );
        } catch (cause) {
          return err(toError(cause, "secret_read_failed"));
        }
        if (apiKey === null || apiKey.length === 0) {
          return err({
            kind: "validation",
            code: "no_api_key",
            message: `Set your ${project.ttsProvider === "openai" ? "OpenAI" : "xAI"} API key in Settings → AI Providers`
          });
        }
        const tts = await synthesize({
          provider: project.ttsProvider,
          apiKey,
          text,
          voice: project.voice,
          model: project.ttsModel
        });
        const durationSec = await probeDurationSec(tts.audioPath);
        const bytes = await readFile(tts.audioPath);
        return ok({
          audioBase64: bytes.toString("base64"),
          mimeType: "audio/mpeg" as const,
          durationSec
        });
      }
      if (effectiveAudio === "native") {
        // Preview the video's native audio for the trim range.
        const video = capture.kind === "video" ? capture.video : null;
        if (video === null || video === undefined) {
          return err({
            kind: "validation",
            code: "no_native_audio",
            message: "This scene's capture has no audio to preview"
          });
        }
        if (capture.legacy_src_path === null) {
          return err({
            kind: "validation",
            code: "no_video_path",
            message: "Video file path is not yet available for this capture"
          });
        }
        const trim = scene.mediaTrim ?? {
          startSec: video.defaultRange.start,
          endSec: video.defaultRange.end
        };
        const audioPath = await extractVideoAudio({
          videoPath: capture.legacy_src_path,
          startSec: trim.startSec,
          durationSec: trim.endSec - trim.startSec
        });
        const durationSec = await probeDurationSec(audioPath);
        const bytes = await readFile(audioPath);
        return ok({
          audioBase64: bytes.toString("base64"),
          mimeType: "audio/mp4" as const,
          durationSec
        });
      }
      // muted
      return err({
        kind: "validation",
        code: "muted_scene",
        message: "This scene is muted — nothing to preview"
      });
    } catch (cause) {
      return err(toError(cause, "preview_failed"));
    }
  });

  bus.register("sizzle:previewSequenceScenePlan", async (req) => {
    const v = validateSizzlePreviewRequest(req);
    if (!v.ok) return err(v.error);
    const project = await store.get(v.projectId);
    if (project === null) {
      return err({ kind: "validation", code: "not_found", message: "Project not found" });
    }
    const scene = project.scenes.find((s) => s.id === v.sceneId);
    if (scene === undefined) {
      return err({ kind: "validation", code: "not_found", message: "Scene not found" });
    }
    if (scene.kind !== "sequence") {
      return err({
        kind: "validation",
        code: "not_sequence",
        message: "Scene is not a sequence scene"
      });
    }
    const text = scene.scriptLine.trim();
    if (text.length === 0) {
      return err({
        kind: "validation",
        code: "empty_script",
        message: "Write narration first, then preview the sequence timeline"
      });
    }

    let apiKey: string | null;
    try {
      apiKey = await getSecrets().getValue(
        project.ttsProvider === "openai" ? "openaiApiKey" : "grokApiKey"
      );
    } catch (cause) {
      return err(toError(cause, "secret_read_failed"));
    }
    if (apiKey === null || apiKey.length === 0) {
      return err({
        kind: "validation",
        code: "no_api_key",
        message: `Set your ${project.ttsProvider === "openai" ? "OpenAI" : "xAI"} API key in Settings → AI Providers`
      });
    }

    try {
      const tts = await synthesize({
        provider: project.ttsProvider,
        apiKey,
        text,
        voice: project.voice,
        model: project.ttsModel
      });
      const durationSec = await probeDurationSec(tts.audioPath);
      const speechTiming = await resolveSpeechTiming({
        provider: project.ttsProvider,
        model: project.ttsModel,
        voice: project.voice,
        text,
        audioPath: tts.audioPath,
        durationSec,
        apiKey
      });
      const timeline = planSequenceTimeline(scene, speechTiming);
      const beatCaptureIds = [
        ...new Set((scene.beats ?? []).map((beat) => beat.captureId))
      ];
      const loadedCaptures = await Promise.all(
        beatCaptureIds.map(async (captureId) => [captureId, await loadCapture(captureId)] as const)
      );
      const capturesById = new Map<string, CaptureRecord>();
      for (const [captureId, capture] of loadedCaptures) {
        if (capture !== null) capturesById.set(captureId, capture);
      }
      const mediaPlan = planSequencePreviewMedia({
        scene,
        capturesById,
        timeline
      });
      const bytes = await readFile(tts.audioPath);
      const warnings: SizzleSequencePreviewPlan["warnings"] = [
        ...speechTiming.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message
        })),
        ...timeline.diagnostics.map((diagnostic) => ({
          beatId: diagnostic.beatId,
          code: diagnostic.code,
          message: diagnostic.message
        })),
        ...mediaPlan.diagnostics.map((diagnostic) => ({
          beatId: diagnostic.beatId,
          code: diagnostic.code,
          message: diagnostic.message
        }))
      ];
      return ok({
        audioBase64: bytes.toString("base64"),
        mimeType: "audio/mpeg" as const,
        durationSec: timeline.durationSec,
        timingQuality: speechTiming.quality,
        warnings,
        transcriptPhrases: buildTranscriptPhraseSuggestions(speechTiming),
        beats: mediaPlan.beatPlans
      });
    } catch (cause) {
      return err(toError(cause, "sizzle_sequence_preview_failed"));
    }
  });

  bus.register("sizzle:loadSequenceSceneAudio", async (req) => {
    const v = validateSizzlePreviewRequest(req);
    if (!v.ok) return err(v.error);
    const project = await store.get(v.projectId);
    if (project === null) {
      return err({ kind: "validation", code: "not_found", message: "Project not found" });
    }
    const scene = project.scenes.find((s) => s.id === v.sceneId);
    if (scene === undefined) {
      return err({ kind: "validation", code: "not_found", message: "Scene not found" });
    }
    if (scene.kind !== "sequence") {
      return err({
        kind: "validation",
        code: "not_sequence",
        message: "Scene is not a sequence scene"
      });
    }
    const text = scene.scriptLine.trim();
    if (text.length === 0) {
      return ok({ cached: false as const });
    }
    // Cache-only: this runs proactively on reel open, so it must NEVER
    // synthesize, resolve speech timing, or hit any API — it only reads
    // the content-addressed TTS file if a prior preview/render already
    // produced it. Same hash tuple as synthesize() so the filenames
    // agree. A missing file (or any read error) is a normal "not yet
    // generated" miss, not a failure.
    const audioPath = join(
      ttsCacheDir(),
      ttsCacheFilename({
        provider: project.ttsProvider,
        model: project.ttsModel,
        voice: project.voice,
        text
      })
    );
    try {
      const bytes = await readAudio(audioPath);
      const speechTiming = await resolveCachedSpeechTiming({
        provider: project.ttsProvider,
        model: project.ttsModel,
        voice: project.voice,
        text,
        audioPath
      });
      return ok({
        cached: true as const,
        audioBase64: bytes.toString("base64"),
        mimeType: "audio/mpeg" as const,
        transcriptPhrases:
          speechTiming === null ? [] : buildTranscriptPhraseSuggestions(speechTiming)
      });
    } catch {
      return ok({ cached: false as const });
    }
  });

  bus.register("sizzle:revealOutput", async (req) => {
    const v = validateSizzleIdRequest(req);
    if (!v.ok) return err(v.error);
    const project = await store.get(v.id);
    if (project === null || project.outputPath === null) {
      return err({
        kind: "validation",
        code: "no_output",
        message: "Project has no rendered output yet"
      });
    }
    shell.showItemInFolder(project.outputPath);
    return ok(undefined);
  });

  bus.register("sizzle:render", async (req, ctx): Promise<Result<{ outputPath: string; durationSec: number }, PwrSnapError>> => {
    const v = validateSizzleIdRequest(req);
    if (!v.ok) return err(v.error);
    const project = await store.get(v.id);
    if (project === null) {
      return err({ kind: "validation", code: "not_found", message: `Project ${v.id} not found` });
    }
    if (project.scenes.length === 0) {
      return err({
        kind: "validation",
        code: "no_scenes",
        message: "Add at least one scene before rendering"
      });
    }

    const dims = project.resolution === "720p" ? { w: 1280, h: 720 } : { w: 1920, h: 1080 };

    broadcastRenderProgress({ projectId: project.id, phase: "tts", message: "Resolving scenes", ratio: 0 });

    // Pre-load every scene's capture so we can validate audio policy
    // for the whole project before kicking off any TTS or extraction
    // work. Avoids spending OpenAI tokens / disk extraction on a
    // project that's about to fail with "scene 5 has no script".
    //
    // Parallel fetch — `loadCapture` is a bus dispatch and the per-id
    // round-trips are independent. For a 50-scene reel this turns a
    // 50× sequential await into one fan-out, cutting the pre-load
    // phase from ~hundreds of ms to single digits. The synchronous
    // validation walk that follows still emits errors in scene order
    // (first failing scene wins, matching the prior loop's behavior).
    const captureIds = [
      ...new Set(
        project.scenes.flatMap((scene) =>
          scene.kind === "sequence" && scene.beats !== undefined
            ? scene.beats.map((beat) => beat.captureId)
            : [scene.captureId]
        )
      )
    ];
    const loadedCaptures = await Promise.all(
      captureIds.map(async (captureId) => [captureId, await loadCapture(captureId)] as const)
    );
    const captureMap = new Map<string, CaptureRecord>();
    for (const [captureId, capture] of loadedCaptures) {
      if (capture !== null) captureMap.set(captureId, capture);
    }
    const captures: Array<{ scene: SizzleScene; capture: CaptureRecord; effectiveAudio: "native" | "voiceover" | "muted" }> = [];
    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i]!;
      const capture = captureMap.get(scene.captureId) ?? null;
      if (scene.kind === "sequence") {
        if (scene.scriptLine.trim().length === 0) {
          const message = `Scene ${i + 1}: sequence scenes require non-empty narration`;
          broadcastRenderProgress({
            projectId: project.id,
            phase: "failed",
            message,
            ratio: 0,
            error: { code: "empty_script", message }
          });
          return err({ kind: "validation", code: "empty_script", message });
        }
        for (const beat of scene.beats ?? []) {
          if (!captureMap.has(beat.captureId)) {
            const message = `Scene ${i + 1}, beat ${beat.id}: capture ${beat.captureId} not found (it may have been deleted)`;
            broadcastRenderProgress({
              projectId: project.id,
              phase: "failed",
              message,
              ratio: 0,
              error: { code: "capture_missing", message }
            });
            return err({ kind: "validation", code: "capture_missing", message });
          }
        }
        const firstBeatCapture = scene.beats?.[0] !== undefined ? captureMap.get(scene.beats[0].captureId) : capture;
        if (firstBeatCapture === undefined || firstBeatCapture === null) {
          const message = `Scene ${i + 1}: sequence scene has no loadable beats`;
          broadcastRenderProgress({
            projectId: project.id,
            phase: "failed",
            message,
            ratio: 0,
            error: { code: "capture_missing", message }
          });
          return err({ kind: "validation", code: "capture_missing", message });
        }
        captures.push({ scene, capture: firstBeatCapture, effectiveAudio: "voiceover" });
        continue;
      }
      if (capture === null) {
        const message = `Scene ${i + 1}: capture ${scene.captureId} not found (it may have been deleted)`;
        broadcastRenderProgress({
          projectId: project.id,
          phase: "failed",
          message,
          ratio: 0,
          error: { code: "capture_missing", message }
        });
        return err({ kind: "validation", code: "capture_missing", message });
      }
      const effectiveAudio = resolveAudioSource(
        scene.audioSource,
        capture.kind,
        scene.scriptLine
      );
      if (effectiveAudio === "voiceover" && scene.scriptLine.trim().length === 0) {
        const message = `Scene ${i + 1}: voiceover audio source requires a non-empty script line`;
        broadcastRenderProgress({
          projectId: project.id,
          phase: "failed",
          message,
          ratio: 0,
          error: { code: "empty_script", message }
        });
        return err({ kind: "validation", code: "empty_script", message });
      }
      if (effectiveAudio === "native" && (capture.kind !== "video" || capture.legacy_src_path === null)) {
        const message = `Scene ${i + 1}: native audio requires a video capture with a source file`;
        broadcastRenderProgress({
          projectId: project.id,
          phase: "failed",
          message,
          ratio: 0,
          error: { code: "no_native_audio", message }
        });
        return err({ kind: "validation", code: "no_native_audio", message });
      }
      captures.push({ scene, capture, effectiveAudio });
    }

    // Resolve OpenAI key once for the project (if any scene uses
    // voiceover). The early-out matches the validation strictness
    // above.
    const anyVoiceover = captures.some((c) => c.effectiveAudio === "voiceover");
    let apiKey: string | null = null;
    if (anyVoiceover) {
      try {
        apiKey = await getSecrets().getValue(
          project.ttsProvider === "openai" ? "openaiApiKey" : "grokApiKey"
        );
      } catch (cause) {
        const e = toError(cause, "secret_read_failed");
        broadcastRenderProgress({ projectId: project.id, phase: "failed", message: e.message, ratio: 0, error: { code: e.code, message: e.message } });
        return err(e);
      }
      if (apiKey === null || apiKey.length === 0) {
        const message = `Set your ${project.ttsProvider === "openai" ? "OpenAI" : "xAI"} API key in Settings → AI Providers`;
        broadcastRenderProgress({ projectId: project.id, phase: "failed", message, ratio: 0, error: { code: "no_api_key", message } });
        return err({ kind: "validation", code: "no_api_key", message });
      }
    }

    log.info("sizzle:render starting", {
      projectId: project.id,
      voice: project.voice,
      model: project.ttsModel,
      ffmpegPath: resolveFfmpegPath(),
      scenes: captures.map((c, i) => ({
        idx: i + 1,
        kind: c.capture.kind,
        effectiveAudio: c.effectiveAudio,
        transition: c.scene.transition
      }))
    });

    // Per-scene preparation runs in parallel — each scene's work
    // (TTS synth or audio extraction or silence synth, plus the
    // image-path resolve for image scenes) is independent: different
    // cache files, different network requests, no shared mutable
    // state. For a 50-scene reel this turns ~50 serial awaits into
    // one fan-out. TTS calls hit OpenAI's content-addressed cache so
    // duplicate-text scenes coalesce on the renderer side, and the
    // network rate-limit is well above what one render can produce.
    //
    // Progress broadcasts fire as each scene resolves, in completion
    // order — not scene order. That's fine for the progress bar
    // (which reads ratio, not scene-index). The final sceneInputs
    // array is rebuilt in scene order before the composer runs.
    const sceneInputGroups: SceneInput[][] = new Array(captures.length);
    let prepared = 0;
    try {
      await Promise.all(
        captures.map(async ({ scene, capture, effectiveAudio }, i) => {
          if (scene.kind === "sequence") {
            const tts = await synthesize({
              provider: project.ttsProvider,
              apiKey: apiKey!,
              text: scene.scriptLine.trim(),
              voice: project.voice,
              model: project.ttsModel
            });
            const durationSec = await probeDurationSec(tts.audioPath);
            const speechTiming = await resolveSpeechTiming({
              provider: project.ttsProvider,
              model: project.ttsModel,
              voice: project.voice,
              text: scene.scriptLine.trim(),
              audioPath: tts.audioPath,
              durationSec,
              apiKey
            });
            const imagePathByCaptureId = new Map<string, string>();
            await Promise.all(
              (scene.beats ?? []).map(async (beat) => {
                const beatCapture = captureMap.get(beat.captureId);
                if (beatCapture?.kind !== "image") return;
                const imagePath = await resolveImagePath(beat.captureId, dims.w);
                if (imagePath === null) {
                  throw new SceneError(`Scene ${i + 1}, beat ${beat.id}: could not render capture image`);
                }
                imagePathByCaptureId.set(beat.captureId, imagePath);
              })
            );
            sceneInputGroups[i] = planSequenceScene({
              scene,
              capturesById: captureMap,
              imagePathByCaptureId,
              narrationAudioPath: tts.audioPath,
              speechTiming
            }).sceneInputs;
          } else {
            const sceneInput = await prepareSceneInput({
              scene,
              capture,
              effectiveAudio,
              project,
              apiKey,
              sceneIdx: i + 1,
              imageWidth: dims.w
            });
            sceneInputGroups[i] = [sceneInput];
          }
          prepared += 1;
          broadcastRenderProgress({
            projectId: project.id,
            phase: "tts",
            message: `Prepared scene ${prepared}/${captures.length}`,
            ratio: (prepared / captures.length) * 0.5
          });
        })
      );
    } catch (cause) {
      const e = toError(cause, "scene_prep_failed");
      broadcastRenderProgress({ projectId: project.id, phase: "failed", message: e.message, ratio: 0, error: { code: e.code, message: e.message } });
      return err(e);
    }
    const sceneInputs = sceneInputGroups.flat();

    broadcastRenderProgress({ projectId: project.id, phase: "compose", message: "Composing video", ratio: 0.5 });

    const outDir = join(app.getPath("videos"), "PwrSnap");
    await mkdir(outDir, { recursive: true });
    const outputPath = join(outDir, `${sanitizeProjectFilename(project.name)}-${project.id}.mp4`);

    try {
      await compose({
        scenes: sceneInputs,
        outputPath,
        width: dims.w,
        height: dims.h,
        fps: 30,
        signal: ctx.signal,
        onProgress: (ratio) => {
          broadcastRenderProgress({
            projectId: project.id,
            phase: "encode",
            message: "Encoding",
            ratio: 0.5 + ratio * 0.5
          });
        }
      });
    } catch (cause) {
      const e = toError(cause, "compose_failed");
      broadcastRenderProgress({ projectId: project.id, phase: "failed", message: e.message, ratio: 0, error: { code: e.code, message: e.message } });
      return err(e);
    }

    const totalSec = sceneInputs.reduce((acc, s) => acc + s.durationSec, 0);
    const next = await store.update(project.id, {
      outputPath,
      lastRenderedAt: new Date().toISOString()
    });
    await pushProjectsChanged();
    log.info("sizzle:render done", { id: next.id, totalSec, outputPath });
    broadcastRenderProgress({ projectId: project.id, phase: "done", message: "Render complete", ratio: 1 });
    void store.list().then((projects) => pruneTtsCache(projects)).catch((cause) => {
      log.warn("tts cache sweep failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });
    return ok({ outputPath, durationSec: totalSec });
  });
}

class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneError";
  }
}

/**
 * Sanitize a user-supplied project name for use as the leading
 * component of the output filename. See sizzle-handlers.test.ts for
 * the full behavior contract.
 */
export function sanitizeProjectFilename(name: string): string {
  const stripped = name
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "_")
    .replace(/_+/g, "_")
    .trim()
    .slice(0, 60);
  return stripped.length > 0 ? stripped : "sizzle";
}
