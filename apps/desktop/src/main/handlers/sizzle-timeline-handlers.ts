import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  SizzleTimelineSchema,
  buildSizzleLaunchTemplate,
  ok,
  err,
  type SizzleProject
} from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { relayCancellationToPeer } from "../process-split/event-relay";
import type { SizzleStore } from "../sizzle/sizzle-store";
import { getSizzleAssetsRoot } from "../persistence/paths";
import { resolveFfmpegPath } from "../recording/ffmpeg-resolver";
import { importTimelineAsset } from "../sizzle/timeline-assets";
import {
  captureNotBefore,
  isCapturedAtOrAfter
} from "../local-agents/local-agent-search";

export function timelineAssetsRoot(): string {
  return getSizzleAssetsRoot();
}

export async function dispatchTimelineJob(
  project: SizzleProject,
  mode: "preview" | "full",
  ctx: CommandContext,
  frames?: number[]
) {
  const cancellationKey = `sizzle-job:${randomUUID()}`;
  const cancel = (): void => {
    bus.cancel(cancellationKey);
    relayCancellationToPeer(cancellationKey);
  };
  const pending = bus.dispatch(
    "sizzle:runTimelineJob",
    { project, mode, ...(frames ? { frames } : {}) },
    { principal: "bridge", cancellationKey }
  );
  await Promise.resolve();
  ctx.signal.addEventListener("abort", cancel, { once: true });
  if (ctx.signal.aborted) cancel();
  try {
    return await pending;
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
    cancel();
  }
}

export function registerSizzleTimelineHandlers(
  store: SizzleStore,
  changed: () => Promise<void>
): void {
  bus.register("sizzle:audioQa", async (req, ctx) => {
    const project =
      typeof req?.id === "string" ? await store.get(req.id) : null;
    if (!project?.outputPath)
      return err({
        kind: "validation",
        code: "render_required",
        message: "Render the full reel before checking its mixed audio"
      });
    const cancellationKey = `sizzle-audio-qa:${randomUUID()}`;
    const cancel = (): void => {
      bus.cancel(cancellationKey);
      relayCancellationToPeer(cancellationKey);
    };
    const pending = bus.dispatch(
      "sizzle:runAudioQaJob",
      { outputPath: project.outputPath },
      { principal: "bridge", cancellationKey }
    );
    await Promise.resolve();
    ctx.signal.addEventListener("abort", cancel, { once: true });
    if (ctx.signal.aborted) cancel();
    try {
      return await pending;
    } finally {
      ctx.signal.removeEventListener("abort", cancel);
      cancel();
    }
  });
  bus.register("sizzle:applyLaunchTemplate", async (req, ctx) => {
    try {
      const timeline = buildSizzleLaunchTemplate(req.template);
      return await bus.dispatch(
        "sizzle:setTimeline",
        { id: req.id, timeline, expectedModifiedAt: req.expectedModifiedAt },
        {
          principal: ctx.principal,
          ...(ctx.localAgent ? { localAgent: ctx.localAgent } : {})
        }
      );
    } catch {
      return err({
        kind: "validation",
        code: "invalid_template",
        message: "Launch template data is invalid; check its asset IDs and copy"
      });
    }
  });
  bus.register("sizzle:importCapture", async (req, ctx) => {
    if (
      typeof req?.id !== "string" ||
      typeof req?.captureId !== "string" ||
      !(await store.get(req.id))
    )
      return err({
        kind: "validation",
        code: "not_found",
        message: "Sizzle project not found"
      });
    const options = {
      principal: ctx.principal,
      ...(ctx.localAgent ? { localAgent: ctx.localAgent } : {})
    };
    const capture = await bus.dispatch(
      "library:byId",
      { id: req.captureId },
      options
    );
    const notBefore = captureNotBefore(ctx.localAgent?.maxCaptureAgeDays);
    if (!capture.ok) return capture;
    if (
      !capture.value ||
      capture.value.deleted_at !== null ||
      (notBefore !== undefined &&
        !isCapturedAtOrAfter(capture.value.captured_at, notBefore))
    )
      return err({
        kind: "validation",
        code: "not_found",
        message: "Capture not found"
      });
    try {
      const exported =
        capture.value.kind === "image"
          ? await bus.dispatch(
              "render:captureExport",
              {
                captureId: req.captureId,
                variant: "composite",
                format: "png",
                preset: "high"
              },
              options
            )
          : await bus.dispatch(
              "video:export",
              { captureId: req.captureId, format: "mp4", preset: "high" },
              { principal: "bridge" }
            );
      if (!exported.ok) return exported;
      const ffmpeg = resolveFfmpegPath();
      const asset = await importTimelineAsset(
        timelineAssetsRoot(),
        exported.value.path,
        ffmpeg,
        ctx.signal
      );
      await store.addAsset(req.id, asset);
      await changed();
      return ok(asset);
    } catch {
      return err({
        kind: "render",
        code: "capture_import_failed",
        message: "Could not prepare the edited capture as a reel asset"
      });
    }
  });
  bus.register("sizzle:setBindings", async (req) => {
    const project =
      typeof req?.id === "string" ? await store.get(req.id) : null;
    if (!project?.timeline)
      return err({
        kind: "validation",
        code: "timeline_required",
        message: "A versioned timeline is required"
      });
    const parsed = SizzleTimelineSchema.safeParse({
      ...project.timeline,
      bindings: { ...project.timeline.bindings, ...req.bindings }
    });
    if (!parsed.success || typeof req.expectedModifiedAt !== "string")
      return err({
        kind: "validation",
        code: "invalid_bindings",
        message:
          "Bindings must be named strings or finite numbers, with the current project revision"
      });
    try {
      const updated = await store.setTimeline(
        req.id,
        parsed.data,
        req.expectedModifiedAt
      );
      await changed();
      return ok(updated);
    } catch (cause) {
      return err({
        kind: "validation",
        code: "binding_update_failed",
        message:
          cause instanceof Error
            ? cause.message.slice(0, 500)
            : "Binding update failed"
      });
    }
  });
  bus.register("sizzle:inspectFrames", async (req, ctx) => {
    const project =
      typeof req?.id === "string" ? await store.get(req.id) : null;
    if (!project?.timeline)
      return err({
        kind: "validation",
        code: "timeline_required",
        message: "A versioned timeline is required"
      });
    if (
      !Array.isArray(req.frames) ||
      req.frames.length < 1 ||
      req.frames.length > 12 ||
      req.frames.some(
        (f) =>
          !Number.isInteger(f) ||
          f < 0 ||
          f >=
            project.timeline!.scenes.reduce((n, s) => n + s.durationFrames, 0)
      )
    )
      return err({
        kind: "validation",
        code: "invalid_frames",
        message: "Choose 1–12 frame indices within the timeline"
      });
    const result = await dispatchTimelineJob(
      project,
      "preview",
      ctx,
      req.frames
    );
    return result.ok
      ? ok({
          outputPath: result.value.outputPath,
          widthPx: result.value.widthPx,
          heightPx: result.value.heightPx,
          renderId: result.value.renderId
        })
      : result;
  });
  bus.register("sizzle:timelineFrame", async (req, ctx) => {
    const result = await bus.dispatch(
      "sizzle:inspectFrames",
      { id: req.id, frames: [req.frame] },
      {
        principal: ctx.principal,
        ...(ctx.localAgent ? { localAgent: ctx.localAgent } : {})
      }
    );
    return result.ok
      ? ok({
          pngBase64: (await readFile(result.value.outputPath)).toString(
            "base64"
          )
        })
      : result;
  });
  bus.register("sizzle:get", async (req) => {
    const project =
      typeof req?.id === "string" ? await store.get(req.id) : null;
    return project
      ? ok(project)
      : err({
          kind: "validation",
          code: "not_found",
          message: "Sizzle project not found"
        });
  });
  bus.register("sizzle:importAsset", async (req, ctx) => {
    if (
      typeof req?.id !== "string" ||
      typeof req?.path !== "string" ||
      !(await store.get(req.id))
    )
      return err({
        kind: "validation",
        code: "not_found",
        message: "Sizzle project not found"
      });
    const ffmpeg = resolveFfmpegPath();
    try {
      const asset = await importTimelineAsset(
        timelineAssetsRoot(),
        req.path,
        ffmpeg,
        ctx.signal
      );
      await store.addAsset(req.id, asset);
      await changed();
      return ok(asset);
    } catch {
      // File errors contain absolute source paths; the command boundary does not.
      return err({
        kind: "validation",
        code: "asset_import_failed",
        message:
          "Could not import local media. Check its format, size, and access permissions."
      });
    }
  });
  bus.register("sizzle:setTimeline", async (req) => {
    const parsed = SizzleTimelineSchema.safeParse(req?.timeline);
    if (!parsed.success)
      return err({
        kind: "validation",
        code: "invalid_timeline",
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .slice(0, 8)
          .join("; ")
      });
    if (
      typeof req.id !== "string" ||
      typeof req.expectedModifiedAt !== "string"
    )
      return err({
        kind: "validation",
        code: "invalid_revision",
        message:
          "A project ID and expectedModifiedAt from sizzle_get are required"
      });
    try {
      const project: SizzleProject = await store.setTimeline(
        req.id,
        parsed.data,
        req.expectedModifiedAt
      );
      await changed();
      return ok(project);
    } catch (cause) {
      return err({
        kind: "validation",
        code: "timeline_update_failed",
        message:
          cause instanceof Error
            ? cause.message.slice(0, 500)
            : "Timeline update failed"
      });
    }
  });
}
