import { app } from "electron";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ok,
  err,
  SizzleTimelineSchema,
  SizzleAssetSchema,
  validateSizzleTimelineAssets,
  sizzleTimelineFrames
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import {
  getCacheRoot,
  getSizzleAssetsRoot,
  getDataRoot
} from "../persistence/paths";
import { runGatedCacheWrite } from "../persistence/derived-cache-gate";
import { DesktopSecretStore } from "../settings/desktop-secret-store";
import { resolveFfmpegPath } from "../recording/ffmpeg-resolver";
import { assertSizzleRenderPlatform } from "../sizzle/composer";
import {
  prepareTimelineAudio,
  TIMELINE_AUDIO_VERSION
} from "../sizzle/timeline-audio";
import { renderTimelineInChild } from "../sizzle/timeline-worker-client";
import { TIMELINE_RENDER_VERSION } from "../sizzle/timeline-render";
import { inspectTimelineAudio } from "../sizzle/timeline-audio-qa";

/** Register with the agent process, which owns every cache deleter's gate. */
export function registerSizzleTimelineRenderHandlers(): void {
  bus.register("sizzle:runAudioQaJob", async (req, ctx) => {
    if (ctx.principal !== "bridge")
      return err({
        kind: "permission",
        code: "internal_job",
        message: "Audio QA must enter through the Sizzle handlers"
      });
    const ffmpeg = resolveFfmpegPath();
    if (!ffmpeg)
      return err({
        kind: "render",
        code: "ffmpeg_missing",
        message: "FFmpeg is unavailable"
      });
    try {
      const key = createHash("sha256").update(req.outputPath).digest("hex");
      return await runGatedCacheWrite(
        "sizzle-audio-qa",
        key,
        async (signal) => {
          const apiKey = await new DesktopSecretStore({
            filePath: join(getDataRoot(), "pwrsnap-secrets.bin")
          }).getValue("openaiApiKey");
          if (!apiKey)
            throw new Error(
              "Set an OpenAI API key before transcribing the mixed audio"
            );
          return ok(
            await inspectTimelineAudio({
              outputPath: req.outputPath,
              cacheRoot: getCacheRoot(),
              ffmpeg,
              apiKey,
              signal
            })
          );
        },
        ctx.signal
      );
    } catch (cause) {
      const message =
        cause instanceof Error &&
        /^(Set an OpenAI|Audio QA is|Narration transcription failed)/.test(
          cause.message
        )
          ? cause.message
          : "Could not verify the mixed audio";
      return err({ kind: "render", code: "audio_qa_failed", message });
    }
  });
  bus.register("sizzle:runTimelineJob", async (req, ctx) => {
    if (ctx.principal !== "bridge")
      return err({
        kind: "permission",
        code: "internal_job",
        message: "Timeline jobs must enter through the Sizzle command handlers"
      });
    try {
      if (!/^sz_[a-zA-Z0-9_-]{1,80}$/.test(req.project.id))
        throw new Error("Invalid project identity");
      req.project.assets = SizzleAssetSchema.array()
        .max(500)
        .parse(req.project.assets ?? []);
      assertSizzleRenderPlatform(process.platform);
      const platform = process.platform as "darwin" | "win32";
      const timeline = SizzleTimelineSchema.parse(req.project.timeline);
      validateSizzleTimelineAssets(timeline, req.project.assets ?? []);
      const ffmpeg = resolveFfmpegPath();
      if (!ffmpeg) throw new Error("FFmpeg unavailable");
      const renderId = createHash("sha256")
        .update(
          JSON.stringify({
            version: TIMELINE_RENDER_VERSION,
            audioVersion: TIMELINE_AUDIO_VERSION,
            projectId: req.project.id,
            timeline,
            assets: req.project.assets,
            mode: req.mode,
            frames: req.frames
          })
        )
        .digest("hex");
      return await runGatedCacheWrite(
        `sizzle:${req.project.id}`,
        renderId,
        async (signal) => {
          const cacheRoot = join(getCacheRoot(), "sizzle-timeline");
          const outputRoot =
            req.frames || req.mode === "preview"
              ? cacheRoot
              : join(app.getPath("videos"), "PwrSnap");
          await mkdir(outputRoot, { recursive: true });
          const scale =
            req.frames || req.mode === "preview"
              ? Math.min(1, 640 / timeline.width)
              : 1;
          const width = Math.max(
              2,
              Math.round((timeline.width * scale) / 2) * 2
            ),
            height = Math.max(2, Math.round((timeline.height * scale) / 2) * 2);
          const outputPath = join(
            outputRoot,
            `${req.project.name.replace(/[^\p{L}\p{N} _-]/gu, "_").slice(0, 80) || "Sizzle"}-${req.project.id}-${renderId.slice(0, 12)}.${req.frames ? "png" : "mp4"}`
          );
          const assetsRoot = getSizzleAssetsRoot();
          let apiKey: string | null = null;
          if (
            !req.frames &&
            timeline.audio.some(
              (a) => a.source.kind === "speech" || a.expectedText
            )
          )
            apiKey = await new DesktopSecretStore({
              filePath: join(getDataRoot(), "pwrsnap-secrets.bin")
            }).getValue("openaiApiKey");
          const audio = req.frames
            ? { reports: [] }
            : await prepareTimelineAudio({
                timeline,
                assets: req.project.assets ?? [],
                assetsRoot,
                cacheRoot: join(cacheRoot, "audio"),
                ffmpeg,
                apiKey,
                signal
              });
          const rendered = await renderTimelineInChild(
            {
              timeline,
              assets: req.project.assets ?? [],
              assetsRoot,
              cacheRoot,
              outputPath,
              width,
              height,
              ffmpeg,
              platform,
              ...(audio.path ? { audioPath: audio.path } : {}),
              ...(req.frames ? { frames: req.frames } : {})
            },
            signal
          );
          const result = {
            outputPath,
            durationSec: sizzleTimelineFrames(timeline) / timeline.fps,
            renderId,
            widthPx: rendered.widthPx,
            heightPx: rendered.heightPx,
            cachedScenes: rendered.cachedScenes,
            renderedScenes: rendered.renderedScenes,
            audioReports: audio.reports
          };
          if (!req.frames && req.mode === "full") {
            // User-visible source and diagnostics accompany the final movie.
            for (const [suffix, value] of [
              ["timeline", timeline],
              ["report", { ...result, outputPath: undefined }]
            ] as const) {
              const destination = `${outputPath}.${suffix}.json`,
                temporary = `${destination}.${randomUUID()}.partial`;
              try {
                await writeFile(temporary, JSON.stringify(value, null, 2));
                await rename(temporary, destination);
              } finally {
                await unlink(temporary).catch(() => undefined);
              }
            }
          }
          return ok(result);
        },
        ctx.signal
      );
    } catch (cause) {
      const safe =
        cause instanceof Error &&
        /^(Audio needs|Narration QA failed|Set an OpenAI|Spoken text|Audio has no|Narration source|Speech generation failed|Narration transcription failed)/.test(
          cause.message
        )
          ? cause.message
          : "Timeline rendering failed; check the assets, time slots, and configured speech credentials";
      return err({
        kind: "render",
        code: ctx.signal.aborted ? "cancelled" : "timeline_render_failed",
        message: safe
      });
    }
  });
}
