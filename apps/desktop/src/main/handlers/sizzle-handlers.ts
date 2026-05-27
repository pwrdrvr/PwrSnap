import { BrowserWindow, app, shell } from "electron";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  EVENT_CHANNELS,
  err,
  ok,
  type CaptureRecord,
  type PwrSnapError,
  type Result,
  type SizzleRenderProgressEvent
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { getSizzleStore, SizzleProjectNotFoundError } from "../sizzle/sizzle-store";
import { synthesize, TtsError } from "../sizzle/tts";
import {
  compose,
  ComposeError,
  probeDurationSec,
  type SceneInput
} from "../sizzle/composer";
import { createSizzleWindow, findSizzleWindow } from "../window";
import {
  DesktopSecretStore,
  SecretUnavailableError
} from "../settings/desktop-secret-store";
import { resolveCacheFile } from "../render/coordinator";

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

function broadcast(event: SizzleRenderProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT_CHANNELS.sizzleRenderProgress, event);
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
  // bundles, soft-deleted rows, and legacy captures alike — and
  // returns a real on-disk PNG/WebP we can hand to ffmpeg. Falling
  // back to record.flat_png_path would miss v2 captures (where the
  // sibling PNG is regenerated lazily and often null).
  return resolveCacheFile({ captureId, width, format: "png" });
}

export function registerSizzleHandlers(): void {
  const store = getSizzleStore();

  bus.register("sizzle:open", async (req) => {
    const existing = findSizzleWindow();
    const window = existing ?? createSizzleWindow();
    if (existing !== null && existing.isMinimized()) existing.restore();
    window.show();
    window.focus();
    if (req.projectId !== undefined) {
      window.webContents.send("events:sizzle:nav", { projectId: req.projectId });
    }
    return ok(undefined);
  });

  bus.register("sizzle:list", async () => {
    const projects = await store.list();
    return ok({ projects });
  });

  bus.register("sizzle:create", async (req) => {
    const project = await store.create(req.name);
    return ok(project);
  });

  bus.register("sizzle:update", async (req) => {
    try {
      const project = await store.update(req.id, req.patch);
      return ok(project);
    } catch (cause) {
      return err(toError(cause, "sizzle_update_failed"));
    }
  });

  bus.register("sizzle:delete", async (req) => {
    await store.delete(req.id);
    return ok(undefined);
  });

  bus.register("sizzle:revealOutput", async (req) => {
    const project = await store.get(req.id);
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

  bus.register("sizzle:render", async (req): Promise<Result<{ outputPath: string; durationSec: number }, PwrSnapError>> => {
    const project = await store.get(req.id);
    if (project === null) {
      return err({ kind: "validation", code: "not_found", message: `Project ${req.id} not found` });
    }
    if (project.scenes.length === 0) {
      return err({
        kind: "validation",
        code: "no_scenes",
        message: "Add at least one scene before rendering"
      });
    }

    broadcast({ projectId: project.id, phase: "tts", message: "Generating voiceover", ratio: 0 });

    let apiKey: string | null;
    try {
      apiKey = await getSecrets().getValue(
        project.ttsProvider === "openai" ? "openaiApiKey" : "grokApiKey"
      );
    } catch (cause) {
      const e = toError(cause, "secret_read_failed");
      broadcast({ projectId: project.id, phase: "failed", message: e.message, ratio: 0, error: { code: e.code, message: e.message } });
      return err(e);
    }
    if (apiKey === null || apiKey.length === 0) {
      const message = `Set your ${project.ttsProvider === "openai" ? "OpenAI" : "xAI"} API key in Settings → AI Providers`;
      broadcast({ projectId: project.id, phase: "failed", message, ratio: 0, error: { code: "no_api_key", message } });
      return err({ kind: "validation", code: "no_api_key", message });
    }

    const dims = project.resolution === "720p" ? { w: 1280, h: 720 } : { w: 1920, h: 1080 };

    const sceneInputs: SceneInput[] = [];
    try {
      for (let i = 0; i < project.scenes.length; i++) {
        const scene = project.scenes[i]!;
        const capture = await loadCapture(scene.captureId);
        if (capture === null) {
          throw new SceneError(`Capture ${scene.captureId} not found`);
        }
        const imagePath = await resolveImagePath(scene.captureId, dims.w);
        if (imagePath === null) {
          throw new SceneError(`Could not render capture ${scene.captureId}`);
        }
        const text = scene.scriptLine.trim() || ".";
        const tts = await synthesize({
          provider: project.ttsProvider,
          apiKey,
          text,
          voice: project.voice,
          model: project.ttsModel
        });
        const measured = await probeDurationSec(tts.audioPath);
        const durationSec =
          scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
            ? scene.durationOverrideSec
            : Math.max(1.4, measured + 0.35);
        sceneInputs.push({ imagePath, audioPath: tts.audioPath, durationSec });
        broadcast({
          projectId: project.id,
          phase: "tts",
          message: `Voiced scene ${i + 1}/${project.scenes.length}`,
          ratio: ((i + 1) / project.scenes.length) * 0.5
        });
      }
    } catch (cause) {
      const e = toError(cause, "tts_failed");
      broadcast({ projectId: project.id, phase: "failed", message: e.message, ratio: 0, error: { code: e.code, message: e.message } });
      return err(e);
    }

    broadcast({ projectId: project.id, phase: "compose", message: "Composing video", ratio: 0.5 });

    const outDir = join(app.getPath("videos"), "PwrSnap");
    await mkdir(outDir, { recursive: true });
    const safeName = project.name.replace(/[^\w.\- ]+/g, "_").slice(0, 60).trim() || "sizzle";
    const outputPath = join(outDir, `${safeName}-${project.id}.mp4`);

    try {
      await compose({
        scenes: sceneInputs,
        outputPath,
        width: dims.w,
        height: dims.h,
        fps: 30,
        onProgress: (ratio) => {
          broadcast({
            projectId: project.id,
            phase: "encode",
            message: "Encoding",
            ratio: 0.5 + ratio * 0.5
          });
        }
      });
    } catch (cause) {
      const e = toError(cause, "compose_failed");
      broadcast({ projectId: project.id, phase: "failed", message: e.message, ratio: 0, error: { code: e.code, message: e.message } });
      return err(e);
    }

    const totalSec = sceneInputs.reduce((acc, s) => acc + s.durationSec, 0);
    const next = await store.update(project.id, {
      outputPath,
      lastRenderedAt: new Date().toISOString()
    });
    log.info("sizzle:render done", { id: next.id, totalSec, outputPath });
    broadcast({ projectId: project.id, phase: "done", message: "Render complete", ratio: 1 });
    return ok({ outputPath, durationSec: totalSec });
  });
}

class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneError";
  }
}
