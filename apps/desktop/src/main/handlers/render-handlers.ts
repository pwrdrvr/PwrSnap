// Bus handler for `render:composite` — renders a capture's current
// composite (source + applied layers) to a downscaled PNG and returns
// it base64-encoded. The Library chat agent's `render_composite` vision
// tool calls this so it can SEE the canvas (e.g. to locate a credit-card
// field before redacting it).
//
// Routes through `renderViaCoordinator` (the content-addressed bake
// cache) exactly like clipboard:copy — so a re-render of an unchanged
// composite is a cache hit, and we inherit future cache improvements.
// Does NOT bump BAKE_PIPELINE_VERSION (adding a read-only consumer that
// doesn't touch composeV2 — see docs/solutions/2026-05-28-bake-render-
// cache-orphans.md "do NOT bump when…").

import { readFile } from "node:fs/promises";
import { err, ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { getCaptureById } from "../persistence/captures-repo";
import { ensureEffectiveSrcPath } from "../persistence/source-store";
import { renderViaCoordinator } from "../render/coordinator";

const log = getMainLogger("pwrsnap:render-handlers");

/** Default + hard cap on the longest output edge. 720 keeps the PNG +
 *  the LLM image-token cost modest; 1440 is the ceiling for "look
 *  closer" requests. */
const DEFAULT_MAX_EDGE_PX = 720;
const HARD_MAX_EDGE_PX = 1440;

export function registerRenderHandlers(): void {
  bus.register("render:composite", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }
    if (record.kind !== "image") {
      return err({
        kind: "validation",
        code: "not_an_image",
        message: `render:composite only supports image captures (got kind=${record.kind})`
      });
    }

    // Clamp the requested longest-edge into [1, HARD_MAX], default 720.
    const requested =
      typeof req.maxEdgePx === "number" && Number.isFinite(req.maxEdgePx)
        ? Math.floor(req.maxEdgePx)
        : DEFAULT_MAX_EDGE_PX;
    const maxEdge = Math.max(1, Math.min(HARD_MAX_EDGE_PX, requested));

    // renderViaCoordinator scales to a target WIDTH (aspect preserved).
    // Convert "longest edge ≤ maxEdge" into a target width, never
    // upscaling past the source.
    const longest = Math.max(record.width_px, record.height_px);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const targetWidth = Math.max(1, Math.round(record.width_px * scale));

    try {
      const result = await renderViaCoordinator({
        captureId: record.id,
        srcPath: await ensureEffectiveSrcPath(record),
        imageWidthPx: record.width_px,
        imageHeightPx: record.height_px,
        width: targetWidth,
        format: "png"
      });
      const buf = await readFile(result.cachePath);
      const widthPx = targetWidth;
      const heightPx = Math.max(1, Math.round(record.height_px * scale));
      log.info("rendered composite for agent vision", {
        captureId: record.id,
        targetWidth,
        byteSize: buf.length,
        fromCache: result.fromCache
      });
      return ok({
        base64: buf.toString("base64"),
        mimeType: "image/png" as const,
        widthPx,
        heightPx
      });
    } catch (cause) {
      log.error("render:composite failed", {
        captureId: record.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "render",
        code: "render_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });
}
