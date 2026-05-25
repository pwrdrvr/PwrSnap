// Phase 5 multi-image paste/drop — editor-handlers.
//
// Two bus verbs:
//
//   • editor:pasteImageAsLayer — ⌘V on the editor canvas. Reads the
//     image bytes off the system clipboard, runs the same 5-defense
//     pipeline as clipboard:pasteLayerFragment (size cap, sha256,
//     sharp decode-probe, dimension cap, sanitized errors), inserts
//     the result as a new raster layer on the v2 capture.
//
//   • editor:dropImageAsLayer — Finder drag-drop onto the canvas.
//     Same pipeline, plus assertSafePastedFile up front (symlink +
//     privileged-dir reject) so a hostile drag payload can't redirect
//     us at ~/.ssh/id_rsa or similar.
//
// Both refuse v1 captures with `v1_capture_use_v2`. The renderer
// surfaces a toast pointing at the v2-only nature; Phase 6 flipped
// v2 to the default for new captures so most live captures hit this
// path natively.
//
// Performance: sharp decode + sha256 runs in a worker_threads worker
// (paste-image-worker.ts) so the IPC main thread doesn't stall for
// 80-150ms on a 4K PNG. The renderer renders a "Pasting…" affordance
// immediately; this handler resolves with the layer id when the
// worker returns.

import { clipboard } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import type { BundleLayerNode } from "@pwrsnap/shared";
import { ok, err } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getCaptureById } from "../persistence/captures-repo";
import { insertLayerTreeForCapture, listLayerTree } from "../persistence/layers-repo";
import { scheduleRepack } from "../persistence/bundle-store";
import { getCacheSourcePath } from "../persistence/paths";
import { getMainLogger } from "../log";
import { assertSafePastedFile, UnsafePastedFileError } from "../security/assertSafePastedFile";
import { runPasteImageWorker } from "../workers/paste-image-worker-client";
import type { PasteWorkerErrorCode } from "../workers/paste-image-worker";

const log = getMainLogger("pwrsnap:editor");

/**
 * Translate the worker's error code into a bus-shaped PwrSnapError.
 * Mirrors the discipline in clipboard-handlers — sanitized strings,
 * stable codes the renderer can branch on.
 */
function workerErrorToBusError(code: PasteWorkerErrorCode, message: string): {
  kind: "validation" | "render";
  code: string;
  message: string;
} {
  switch (code) {
    case "size_cap_exceeded":
      return {
        kind: "validation",
        code: "image_too_large",
        message: "Image exceeds size cap"
      };
    case "invalid_dimensions":
      return {
        kind: "validation",
        code: "image_invalid_dimensions",
        message: "Image dimensions invalid or exceed cap"
      };
    case "decode_failed":
      return {
        kind: "render",
        code: "image_decode_failed",
        message: "Image failed to decode"
      };
    case "read_failed":
      return {
        kind: "validation",
        code: "image_read_failed",
        message: "Image bytes unreadable"
      };
    default: {
      // Exhaustiveness check — TypeScript catches missing cases.
      const _exhaustive: never = code;
      void _exhaustive;
      log.warn("editor: unknown worker error code", { code, message });
      return {
        kind: "validation",
        code: "image_read_failed",
        message: "Image rejected"
      };
    }
  }
}

/**
 * Build a translation transform that puts the new raster layer's
 * top-left at the given normalized [0,1] canvas position. The layer's
 * `transform` is a 2D affine matrix [a, b, c, d, tx, ty] in canvas-pixel
 * space — identity scale (no resize on insert), translation = position
 * × canvas dims.
 *
 * Defaults: center the layer on the canvas if no position provided.
 */
function buildTransform(
  positionXn: number | undefined,
  positionYn: number | undefined,
  canvasWidthPx: number,
  canvasHeightPx: number,
  naturalWidthPx: number,
  naturalHeightPx: number
): [number, number, number, number, number, number] {
  // Normalize the position to [0,1]; default to center anchor.
  const xn = clampN(positionXn, 0.5);
  const yn = clampN(positionYn, 0.5);
  // Anchor the IMAGE'S CENTER at (xn, yn) on the canvas — most natural
  // mental model for "paste here." Top-left translation = anchor - half.
  const tx = xn * canvasWidthPx - naturalWidthPx / 2;
  const ty = yn * canvasHeightPx - naturalHeightPx / 2;
  return [1, 0, 0, 1, tx, ty];
}

function clampN(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Refuse `editor:*` paste verbs on v1 captures. Phase 5 is v2-only —
 * raster layers don't exist in the v1 overlay model. The renderer is
 * supposed to gate this earlier, but defense-in-depth at the bus
 * boundary closes the bypass.
 */
function refuseIfV1Capture(captureId: string):
  | { kind: "validation"; code: "v1_capture_use_v2"; message: string }
  | { kind: "validation"; code: "not_found"; message: string }
  | { record: ReturnType<typeof getCaptureById> & object } {
  const record = getCaptureById(captureId);
  if (record === null) {
    return {
      kind: "validation",
      code: "not_found",
      message: `capture not found: ${captureId}`
    };
  }
  if (record.bundle_format_version < 2 || record.bundle_path === null) {
    return {
      kind: "validation",
      code: "v1_capture_use_v2",
      message: `editor paste/drop requires a v2 capture (only v2 captures support multi-image)`
    };
  }
  return { record };
}

/**
 * Insert a raster layer into the target capture and materialize its
 * source bytes into the per-capture cache. Shared between paste +
 * drop paths. Returns the inserted layer id.
 *
 * Cache write happens BEFORE the layer insert so a render kicked off
 * by the events:overlays:changed broadcast can find the source bytes
 * via `sources/<sha>.png` on first read.
 */
async function persistRasterFromBytes(args: {
  captureId: string;
  bundlePath: string;
  canvasWidthPx: number;
  canvasHeightPx: number;
  positionXn: number | undefined;
  positionYn: number | undefined;
  sha256: string;
  pngBytes: Buffer;
  widthPx: number;
  heightPx: number;
  parentId: string | null;
}): Promise<string> {
  // Write the source PNG into the per-capture cache under
  // `<sha>.png` (NOT `source.png` — that name is reserved for the
  // capture's primary raster). The cache directory is per-capture so
  // cleanup is tied to the capture's lifecycle. scheduleRepack picks
  // up the new sha and adds a `sources/<sha>.png` entry to the bundle
  // on next pack — same convention as clipboard:pasteLayerFragment.
  const baseCachePath = getCacheSourcePath(args.captureId);
  await mkdir(dirname(baseCachePath), { recursive: true });
  const sourceCachePath = baseCachePath.replace(/source\.png$/, `${args.sha256}.png`);
  await writeFile(sourceCachePath, args.pngBytes);

  const now = new Date().toISOString();
  const rasterId = nanoid(16);
  const rasterLayer: BundleLayerNode = {
    id: rasterId,
    parent_id: args.parentId,
    kind: "raster",
    source_ref: { kind: "embedded", sha256: args.sha256 },
    natural_width_px: args.widthPx,
    natural_height_px: args.heightPx,
    name: "Pasted Image",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: buildTransform(
      args.positionXn,
      args.positionYn,
      args.canvasWidthPx,
      args.canvasHeightPx,
      args.widthPx,
      args.heightPx
    ),
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: now,
    rejected_at: null,
    superseded_by: null,
    created_at: now
  };
  insertLayerTreeForCapture(args.captureId, [rasterLayer]);
  return rasterId;
}

/** Find the canonical root group for a capture so pasted rasters
 *  attach to it rather than the document root (which Phase 8 may
 *  forbid for non-group children). Falls back to null when the
 *  capture has no group at the root — the insert layer call will
 *  treat null parent as document root. */
function findRootGroupParent(captureId: string): string | null {
  const layers = listLayerTree(captureId);
  for (const layer of layers) {
    if (layer.parent_id === null && layer.kind === "group") {
      return layer.id;
    }
  }
  return null;
}

export function registerEditorHandlers(): void {
  // ── editor:pasteImageAsLayer ──────────────────────────────────────
  bus.register("editor:pasteImageAsLayer", async (req) => {
    const refusal = refuseIfV1Capture(req.captureId);
    if ("kind" in refusal) return err(refusal);
    const record = refusal.record;
    if (record.bundle_path === null) {
      // refuseIfV1Capture already guards but TS narrowing needs this
      return err({
        kind: "validation",
        code: "v1_capture_use_v2",
        message: `editor paste requires a v2 bundle path`
      });
    }

    // Read the clipboard image. nativeImage.toPNG() returns the bytes
    // in the standard image slot; if empty, the clipboard either
    // holds something non-image (text only) or nothing at all.
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return err({
        kind: "clipboard",
        code: "no_image",
        message: "Clipboard does not contain an image"
      });
    }
    const inputBytes = image.toPNG();
    if (inputBytes.length === 0) {
      return err({
        kind: "clipboard",
        code: "no_image",
        message: "Clipboard image was empty"
      });
    }

    // Off-main-thread decode + sha256 + dimension probe.
    const result = await runPasteImageWorker({
      kind: "decode-buffer",
      bytes: new Uint8Array(inputBytes)
    });
    if (!result.ok) {
      log.warn("editor:pasteImageAsLayer worker rejected input", {
        captureId: req.captureId,
        code: result.code
      });
      return err(workerErrorToBusError(result.code, result.message));
    }

    try {
      const parentId = findRootGroupParent(req.captureId);
      const layerId = await persistRasterFromBytes({
        captureId: req.captureId,
        bundlePath: record.bundle_path,
        canvasWidthPx: record.width_px,
        canvasHeightPx: record.height_px,
        positionXn: req.positionXn,
        positionYn: req.positionYn,
        sha256: result.sha256,
        pngBytes: Buffer.from(result.pngBytes),
        widthPx: result.widthPx,
        heightPx: result.heightPx,
        parentId
      });
      // Schedule a repack so the new sources/<sha>.png entry lands in
      // the bundle. broadcast layers:changed via the layers-handlers
      // helper would be cleaner, but we duplicate the broadcast cost
      // for simplicity — events:overlays:changed is what the editor
      // model subscribes to and what triggers the re-render that
      // makes the new layer visible.
      scheduleRepack(req.captureId);
      broadcastLayersChanged(req.captureId);
      log.info("editor: pasted image as raster layer", {
        captureId: req.captureId,
        layerId,
        widthPx: result.widthPx,
        heightPx: result.heightPx,
        byteSize: result.pngBytes.byteLength
      });
      return ok({ layerId });
    } catch (cause) {
      log.error("editor:pasteImageAsLayer persistence failed", {
        captureId: req.captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "insert_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  });

  // ── editor:dropImageAsLayer ───────────────────────────────────────
  bus.register("editor:dropImageAsLayer", async (req) => {
    const refusal = refuseIfV1Capture(req.captureId);
    if ("kind" in refusal) return err(refusal);
    const record = refusal.record;
    if (record.bundle_path === null) {
      return err({
        kind: "validation",
        code: "v1_capture_use_v2",
        message: `editor drop requires a v2 bundle path`
      });
    }

    // Security gate FIRST — refuse symlinks + privileged-dir paths
    // before we even read the bytes. Sanitized error never leaks the
    // attacker-controlled path to the renderer.
    let safePath: string;
    try {
      safePath = await assertSafePastedFile(req.filePath);
    } catch (cause) {
      if (cause instanceof UnsafePastedFileError) {
        log.warn("editor:dropImageAsLayer refused unsafe file", {
          captureId: req.captureId,
          code: cause.code
          // path intentionally omitted from log — could include a
          // privileged dir we don't want in disk logs
        });
        return err({
          kind: "validation",
          code: `unsafe_${cause.code}`,
          message: cause.sanitizedMessage
        });
      }
      throw cause;
    }

    // Off-main-thread decode + sha256 + dimension probe. The worker
    // reads the file itself — keeping the read off the main thread.
    const result = await runPasteImageWorker({
      kind: "decode-path",
      path: safePath
    });
    if (!result.ok) {
      log.warn("editor:dropImageAsLayer worker rejected input", {
        captureId: req.captureId,
        code: result.code
      });
      return err(workerErrorToBusError(result.code, result.message));
    }

    try {
      const parentId = findRootGroupParent(req.captureId);
      const layerId = await persistRasterFromBytes({
        captureId: req.captureId,
        bundlePath: record.bundle_path,
        canvasWidthPx: record.width_px,
        canvasHeightPx: record.height_px,
        positionXn: req.positionXn,
        positionYn: req.positionYn,
        sha256: result.sha256,
        pngBytes: Buffer.from(result.pngBytes),
        widthPx: result.widthPx,
        heightPx: result.heightPx,
        parentId
      });
      scheduleRepack(req.captureId);
      broadcastLayersChanged(req.captureId);
      log.info("editor: dropped image as raster layer", {
        captureId: req.captureId,
        layerId,
        widthPx: result.widthPx,
        heightPx: result.heightPx
      });
      return ok({ layerId });
    } catch (cause) {
      log.error("editor:dropImageAsLayer persistence failed", {
        captureId: req.captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "insert_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  });
}

// ── Broadcast helper ──────────────────────────────────────────────
//
// Mirrors layers-handlers' broadcast pattern. Dynamic import of
// electron so the test mock can stub it cleanly (vi.mock("electron"))
// without forcing every caller of editor-handlers to also pull in
// BrowserWindow.

async function broadcastLayersChanged(captureId: string): Promise<void> {
  const { BrowserWindow } = await import("electron");
  const { EVENT_CHANNELS } = await import("@pwrsnap/shared");
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.overlaysChanged, { captureId });
    win.webContents.send(EVENT_CHANNELS.capturesChanged, {
      changedIds: [captureId]
    });
  }
}
