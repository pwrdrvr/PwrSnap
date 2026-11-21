// The one way a brand-new still lands in the Library: persist the temp PNG
// as a v2 bundle under the captures-root guard, announce it, and queue its
// enrichment. `capture:*` snaps, clipboard pastes, a video frame saved as a
// snap, and every frame a burst keeps all come through here, so a new
// capture is indexed, broadcast and enriched the same way whatever made it.
//
// The temp PNG is CONSUMED (persistCaptureFromTempV2 unlinks it).

import { ok, err, type CaptureRecord, type Overlay, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { broadcastCapturesChanged } from "../events";
import { maybeEnqueueCaptureEnrichment } from "../handlers/codex-handlers";
import { getMainLogger } from "../log";
import { persistCaptureFromTempV2, scheduleRepack } from "../persistence/bundle-store";
import { addUserTag } from "../persistence/enrichment-repo";
import { CapturesLocationFallbackError, runWithCapturesDirFallback } from "./capture-storage-gate";
import type { CursorLayerPlacement } from "./cursor-sample";

const log = getMainLogger("pwrsnap:persist-still");

export type StillCaptureSource = { bundleId: string | null; appName: string | null } | null;

export type PersistStillOptions = {
  devicePixelRatio?: number | undefined;
  cursorLayer?: CursorLayerPlacement | undefined;
  sourceWindowTitle?: string | null | undefined;
  /** When the pixels were on screen, if not now (a burst frame, a frame
   *  pulled from a recording). ISO-8601. */
  capturedAt?: string | undefined;
  /** Annotation layers the capture starts with (see bundle-store). */
  annotations?: ReadonlyArray<{ name: string; shape: Overlay }> | undefined;
  /** User tags applied right after the row exists. */
  tags?: readonly string[] | undefined;
};

export async function persistStillCapture(
  tempPath: string,
  sourceApp: StillCaptureSource,
  options: PersistStillOptions = {}
): Promise<Result<CaptureRecord, PwrSnapError>> {
  // Prepare the immutable capture before taking the captures-root guard;
  // persistence enters that guard only for naming and durable publication.
  //
  // devicePixelRatio threads through so the clipboard-paste flow can pass
  // the scale it inferred from the pasted image's DPI metadata (pHYs /
  // TIFF resolution; 144 DPI → 2× Retina), falling back to 1 when the
  // source carried no density rather than defaulting to 2.
  let record: CaptureRecord;
  try {
    ({ record } = await persistCaptureFromTempV2(
      {
        tempPath,
        sourceApp:
          sourceApp === null
            ? null
            : { bundleId: sourceApp.bundleId, appName: sourceApp.appName },
        sourceWindowTitle: options.sourceWindowTitle ?? null,
        devicePixelRatio: options.devicePixelRatio,
        cursorLayer: options.cursorLayer,
        capturedAt: options.capturedAt,
        annotations: options.annotations
      },
      runWithCapturesDirFallback
    ));
  } catch (cause) {
    const fallbackError =
      cause instanceof CapturesLocationFallbackError ? cause.pwrSnapError : null;
    // Filesystem failures commonly embed absolute source/destination paths.
    // Keep disk logs on stable codes; callers that can safely surface a
    // domain-specific fallback error still receive it below.
    log.error("capture persist failed", {
      code: fallbackError?.code ?? "persist_failed"
    });
    return err(
      fallbackError ?? {
        kind: "capture",
        code: "persist_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      }
    );
  }

  log.info("capture persisted", {
    captureId: record.id,
    bundleFormatVersion: record.bundle_format_version,
    sourceAppBundleId: record.source_app_bundle_id,
    sourceAppName: record.source_app_name
  });
  let repack = (options.annotations?.length ?? 0) > 0;
  for (const tag of options.tags ?? []) {
    try {
      addUserTag(record.id, tag);
      repack = true;
    } catch (cause) {
      // A tag is a convenience; the capture itself is already safe.
      log.warn("capture tag skipped", {
        captureId: record.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
  // The initial bundle's thumbnail is the bare source. Starting layers and
  // tags belong in the bundle too, so let the debounced repack carry them.
  if (repack) scheduleRepack(record.id);
  broadcastCapturesChanged([record.id]);
  // PR #30's Codex enrichment fires once per new capture. Every
  // capture flowing through persistCaptureFromTempV2 is brand new —
  // dedup was removed (migration 0021) so there's no "this is the
  // same row again" branch to skip.
  maybeEnqueueCaptureEnrichment(record.id);
  return ok(record);
}
