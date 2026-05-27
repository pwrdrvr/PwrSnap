import { BrowserWindow, app, shell } from "electron";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  EVENT_CHANNELS,
  err,
  ok,
  type CaptureRecord,
  type PwrSnapError,
  type Result,
  type SizzleAudioSource,
  type SizzleProject,
  type SizzleRenderProgressEvent,
  type SizzleScene
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { getSizzleStore, SizzleProjectNotFoundError } from "../sizzle/sizzle-store";
import { pruneTtsCache, synthesize, TtsError } from "../sizzle/tts";
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
import { createSizzleWindow, findSizzleWindow } from "../window";
import {
  DesktopSecretStore,
  SecretUnavailableError
} from "../settings/desktop-secret-store";
import { resolveCacheFile } from "../render/coordinator";
import {
  validateSizzleCreate,
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
 * tab subscribe here so they refresh without polling. Fire-and-
 * forget — the caller doesn't await the broadcast itself, just
 * needs the snapshot read to happen.
 */
async function broadcastProjectsChanged(projects: SizzleProject[]): Promise<void> {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT_CHANNELS.sizzleProjectsChanged, { projects });
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
 * Per-scene audio policy resolver. `scene.audioSource === "auto"`
 * collapses to the natural default for the capture kind:
 *
 *   image capture → always "voiceover" (no native audio possible).
 *   video capture, no script → "native" (drop in the clip, hear it).
 *   video capture, with script → "voiceover" (TTS over muted video).
 *
 * Explicit `audioSource` values pass through, except `native` on an
 * image scene falls back to `muted` (image scenes have no source
 * audio to extract).
 */
export function resolveAudioSource(
  audioSource: SizzleAudioSource,
  captureKind: "image" | "video",
  scriptLine: string
): "native" | "voiceover" | "muted" {
  if (audioSource !== "auto") {
    if (captureKind === "image" && audioSource === "native") return "muted";
    return audioSource;
  }
  if (captureKind === "image") return "voiceover";
  return scriptLine.trim().length === 0 ? "native" : "voiceover";
}

export function registerSizzleHandlers(): void {
  const store = getSizzleStore();

  bus.register("sizzle:open", async (req) => {
    const v = validateSizzleOpenRequest(req);
    if (!v.ok) return err(v.error);
    const existing = findSizzleWindow();
    const window = existing ?? createSizzleWindow();
    if (existing !== null && existing.isMinimized()) existing.restore();
    window.show();
    window.focus();
    if (v.projectId !== undefined) {
      window.webContents.send("events:sizzle:nav", { projectId: v.projectId });
    }
    return ok(undefined);
  });

  bus.register("sizzle:list", async () => {
    const projects = await store.list();
    return ok({ projects });
  });

  bus.register("sizzle:create", async (req) => {
    const v = validateSizzleCreate(req);
    if (!v.ok) return err(v.error);
    const project = await store.create(v.name);
    const all = await store.list();
    await broadcastProjectsChanged(all);
    return ok(project);
  });

  bus.register("sizzle:update", async (req) => {
    const v = validateSizzleUpdate(req);
    if (!v.ok) return err(v.error);
    try {
      const project = await store.update(v.value.id, v.value.patch);
      const all = await store.list();
      await broadcastProjectsChanged(all);
      return ok(project);
    } catch (cause) {
      return err(toError(cause, "sizzle_update_failed"));
    }
  });

  bus.register("sizzle:delete", async (req) => {
    const v = validateSizzleIdRequest(req);
    if (!v.ok) return err(v.error);
    await store.delete(v.id);
    const all = await store.list();
    await broadcastProjectsChanged(all);
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
      const all = await store.list();
      await broadcastProjectsChanged(all);
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
          mimeType: "audio/mpeg" as const,
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
    const captures: Array<{ scene: SizzleScene; capture: CaptureRecord; effectiveAudio: "native" | "voiceover" | "muted" }> = [];
    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i]!;
      const capture = await loadCapture(scene.captureId);
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
      scenes: captures.map((c, i) => ({
        idx: i + 1,
        kind: c.capture.kind,
        effectiveAudio: c.effectiveAudio,
        transition: c.scene.transition
      }))
    });

    const sceneInputs: SceneInput[] = [];
    try {
      for (let i = 0; i < captures.length; i++) {
        const { scene, capture, effectiveAudio } = captures[i]!;

        // Resolve audio + duration first since durations depend on
        // either the TTS audio (image scenes) or the video trim
        // (video scenes).
        let audioPath: string;
        let durationSec: number;

        if (capture.kind === "video") {
          const trim = scene.mediaTrim ?? {
            startSec: capture.video?.defaultRange.start ?? 0,
            endSec:
              capture.video?.defaultRange.end ?? capture.video?.durationSec ?? 5
          };
          const trimDur = trim.endSec - trim.startSec;

          // Resolve audio + duration per audio source. Scene duration
          // policy for video scenes:
          //   • durationOverrideSec wins if explicitly set.
          //   • Voiceover longer than the trim: extend to fit the
          //     voiceover. Composer holds the last frame via tpad
          //     for the remainder (documentary-style — narration is
          //     load-bearing, the B-roll holds).
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
            durationSec =
              scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
                ? scene.durationOverrideSec
                : Math.max(trimDur, voiceoverDur + 0.35);
            if (durationSec > trimDur + 0.05) {
              log.info("sizzle:render holding last frame for voiceover", {
                sceneIdx: i + 1,
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

          sceneInputs.push({
            kind: "video",
            videoPath: capture.legacy_src_path!,
            startSec: trim.startSec,
            trimDurationSec: trimDur,
            durationSec,
            audioPath,
            transition: scene.transition
          });
        } else {
          // image
          const imagePath = await resolveImagePath(scene.captureId, dims.w);
          if (imagePath === null) {
            throw new SceneError(`Scene ${i + 1}: could not render capture image`);
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
            durationSec =
              scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
                ? scene.durationOverrideSec
                : measured + 0.35;
            audioPath = tts.audioPath;
          } else {
            // image + muted (or image + native that fell back to muted)
            durationSec =
              scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
                ? scene.durationOverrideSec
                : 3.0;
            audioPath = await synthesizeSilence(durationSec);
          }
          sceneInputs.push({
            kind: "image",
            imagePath,
            audioPath,
            durationSec,
            transition: scene.transition
          });
        }

        broadcastRenderProgress({
          projectId: project.id,
          phase: "tts",
          message: `Prepared scene ${i + 1}/${captures.length}`,
          ratio: ((i + 1) / captures.length) * 0.5
        });
      }
    } catch (cause) {
      const e = toError(cause, "scene_prep_failed");
      broadcastRenderProgress({ projectId: project.id, phase: "failed", message: e.message, ratio: 0, error: { code: e.code, message: e.message } });
      return err(e);
    }

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
    const all = await store.list();
    await broadcastProjectsChanged(all);
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
