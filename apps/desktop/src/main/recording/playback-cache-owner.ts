import { err, ok, type Req } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import type { ProcessRole } from "../process-role";
import { getCaptureById } from "../persistence/captures-repo";
import { ensureEffectiveSrcPath, purgeCacheForCapture } from "../persistence/source-store";
import { clearRenderCache, trimRenderCache } from "../persistence/render-cache-maintenance";
import { installVideoPlaybackCacheCleanupForwarder } from "../persistence/video-playback-cache";
import { prepareVideoPlayback } from "../sizzle/audio-extract";

const internalOnly = () => err({
  kind: "permission" as const, code: "internal_command", message: "Playback cache ownership is main-process-only"
});
const invalidRequest = () => err({
  kind: "validation" as const, code: "invalid_request", message: "Invalid playback cache request"
});
const validCaptureId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);

/** Protocols always dispatch by ID, so Library cannot start an untracked
 * encode against a stale source path in a second process. */
export async function resolvePreparedVideoPlayback(captureId: string): Promise<string | null> {
  const result = await bus.dispatch("video:preparePlayback", { captureId }, { principal: "bridge" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.path;
}

async function requestCleanup(req: Req<"storage:runRenderCacheCleanup">): Promise<void> {
  const result = await bus.dispatch("storage:runRenderCacheCleanup", req, { principal: "bridge" });
  if (!result.ok) throw new Error(result.error.message);
}

/** Install before the split bridge's readiness hello. A disconnected Library
 * fails closed; it never falls back to uncoordinated cache writes/removals. */
export function installVideoPlaybackCacheOwner(role: ProcessRole): void {
  if (role === "library") {
    installVideoPlaybackCacheCleanupForwarder(requestCleanup);
    return;
  }

  bus.register("video:preparePlayback", async (req, ctx) => {
    if (ctx.principal !== "bridge") return internalOnly();
    if (!validCaptureId(req?.captureId)) return invalidRequest();
    const record = getCaptureById(req.captureId);
    if (record === null) return ok({ path: null });
    const sourcePath = await ensureEffectiveSrcPath(record);
    // Source resolution can await storage/extraction while another process
    // purges the DB row. Recheck immediately before synchronous job admission.
    if (getCaptureById(req.captureId) === null) return ok({ path: null });
    if (sourcePath === null || record.kind !== "video" || !record.video) return ok({ path: sourcePath });
    const path = await prepareVideoPlayback({
      captureId: record.id,
      videoPath: sourcePath,
      hasSystemAudio: record.video.hasSystemAudio,
      hasMicrophoneAudio: record.video.hasMicrophoneAudio
    });
    return ok({ path });
  });
  bus.register("storage:runRenderCacheCleanup", async (req, ctx) => {
    if (ctx.principal !== "bridge") return internalOnly();
    switch (req?.operation) {
      case "purge":
        if (!validCaptureId(req.captureId)) return invalidRequest();
        await purgeCacheForCapture(req.captureId);
        break;
      case "clear":
        await clearRenderCache();
        break;
      case "trim":
        await trimRenderCache();
        break;
      default:
        return invalidRequest();
    }
    return ok({});
  });
}
