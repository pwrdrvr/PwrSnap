// clipboard:copy command handler. Resolves the capture, renders at
// the requested preset width, and writes image pixels to the system
// clipboard. Stays entirely in the main process — never round-trips
// the buffer through the renderer (Electron's structured-clone boundary
// turns multi-MB PNGs into noticeable jank).
//
// Phase 4 adds a "Codex sensitive-data must complete first" gate; for
// Phase 1 the write fires immediately on dispatch.

import { clipboard, nativeImage } from "electron";
import { readFile } from "node:fs/promises";
import { ok, err } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getCaptureById } from "../persistence/captures-repo";
import { renderViaCoordinator } from "../render/coordinator";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:clipboard");

const PRESET_WIDTHS = {
  low: 800,
  med: 1440,
  high: 0 // 0 = source width (no resize)
} as const;

export function registerClipboardHandlers(): void {
  bus.register("clipboard:copy", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }

    const presetWidth = PRESET_WIDTHS[req.preset];
    const targetWidth = presetWidth === 0 ? record.width_px : presetWidth;

    try {
      const result = await renderViaCoordinator({
        captureId: record.id,
        srcPath: record.src_path,
        imageWidthPx: record.width_px,
        imageHeightPx: record.height_px,
        width: targetWidth,
        format: "png"
      });
      const buf = await readFile(result.cachePath);
      const image = nativeImage.createFromBuffer(buf);
      if (image.isEmpty()) {
        return err({
          kind: "render",
          code: "decode_failed",
          message: "nativeImage decoded to empty buffer"
        });
      }
      clipboard.write({ image });
      log.info("copied to clipboard", {
        captureId: record.id,
        preset: req.preset,
        targetWidth,
        byteSize: buf.length,
        fromCache: result.fromCache
      });
      return ok(undefined);
    } catch (cause) {
      log.error("clipboard copy failed", {
        captureId: record.id,
        preset: req.preset,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "render_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  bus.register("clipboard:copy-path", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }

    const presetWidth = PRESET_WIDTHS[req.preset];
    const targetWidth = presetWidth === 0 ? record.width_px : presetWidth;

    try {
      const result = await renderViaCoordinator({
        captureId: record.id,
        srcPath: record.src_path,
        imageWidthPx: record.width_px,
        imageHeightPx: record.height_px,
        width: targetWidth,
        format: "png"
      });
      clipboard.writeText(result.cachePath);
      log.info("copied path to clipboard", {
        captureId: record.id,
        preset: req.preset,
        targetWidth,
        fromCache: result.fromCache
      });
      return ok({ path: result.cachePath });
    } catch (cause) {
      log.error("clipboard copy-path failed", {
        captureId: record.id,
        preset: req.preset,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "render_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });
}
