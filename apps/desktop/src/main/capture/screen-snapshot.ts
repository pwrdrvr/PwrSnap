// Registry for the per-pickRegion screenshot. The selector freezes
// the screen at show() time, paints the snapshot in the renderer as a
// full-window background, and crops THAT snapshot on commit (rather
// than re-shooting the live screen). This is the SnagIt model:
// architectural immunity to apps starting / stopping / popping in
// during the selection, and the only model where "drag against what
// you see" is literally true.
//
// Snapshots are short-lived — one per pickRegion call, deleted when
// the selector hides. The registry is keyed by a nanoid so each show
// gets a stable URL we can hand to the renderer.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { NativeImage } from "electron";
import { nanoid } from "nanoid";
import { getMainLogger } from "../log";
import {
  captureScreen,
  captureWindowsPickerSnapshot,
  type PickerSnapshotMode,
  type PickerSnapshotStageTimings,
  type Rect
} from "./screencapture";

const log = getMainLogger("pwrsnap:screen-snapshot");

type FileEntry = {
  kind: "file";
  /** Path to the temp PNG. Physical pixels (logical * scaleFactor). */
  filePath: string;
  /** Display id this snapshot was captured for — needed at commit
   *  time so we can apply the right scale factor when cropping. */
  displayId: number;
};

type MemoryEntry = {
  kind: "memory";
  previewBytes: Buffer;
  previewMimeType: "image/jpeg";
  /** Cleared immediately after a successful crop and again on release. */
  fullImage: NativeImage | null;
  displayId: number;
  displayBounds: { x: number; y: number; width: number; height: number };
  mode: PickerSnapshotMode;
  timings: PickerSnapshotStageTimings;
};

type Entry = FileEntry | MemoryEntry;

const registry = new Map<string, Entry>();

export type FileScreenSnapshot = {
  kind: "file";
  /** Stable id; embed in `pwrsnap-screen://r/<id>` for the renderer. */
  id: string;
  /** Absolute filesystem path. Useful when sharp-cropping at commit. */
  filePath: string;
  /** Display the snapshot covers. */
  displayId: number;
  /** File-backed fallback does not expose the Windows in-memory stage split. */
  timing: null;
};

export type InMemoryScreenSnapshot = {
  kind: "memory";
  id: string;
  displayId: number;
  mode: PickerSnapshotMode;
  timing: PickerSnapshotStageTimings;
};

/** Public handle used by the selector regardless of backing representation. */
export type ScreenSnapshot = FileScreenSnapshot | InMemoryScreenSnapshot;
export type RegisteredScreenSnapshot = ScreenSnapshot;

export type SnapshotPreview = {
  bytes: Buffer;
  mimeType: "image/jpeg";
};

export type SnapshotProtocolSource =
  | { kind: "file"; filePath: string }
  | { kind: "memory"; bytes: Buffer; mimeType: "image/jpeg" };

export type RegisteredSnapshotCropTimings = {
  cropMs: number;
  pngEncodeMs: number;
  writeMs: number;
  totalMs: number;
  outputByteSize: number;
  physicalRect: { x: number; y: number; width: number; height: number };
};

export type RegisteredSnapshotCropResult =
  | {
      ok: true;
      tempPath: string;
      displayId: number;
      timings: RegisteredSnapshotCropTimings;
    }
  | { ok: false; reason: "validation" | "error"; message: string };

export type CaptureAndRegisterOptions = {
  mode: PickerSnapshotMode;
};

/**
 * Capture the named display and register the file so the
 * `pwrsnap-screen://` protocol handler can resolve it. Throws on
 * capture failure (TCC revoke, screencapture error, unknown display).
 */
export function captureAndRegister(displayId: number): Promise<FileScreenSnapshot>;
export function captureAndRegister(
  displayId: number,
  options: CaptureAndRegisterOptions
): Promise<RegisteredScreenSnapshot>;
export async function captureAndRegister(
  displayId: number,
  options?: CaptureAndRegisterOptions
): Promise<RegisteredScreenSnapshot> {
  // The optimized representation is intentionally opt-in until the selector
  // and commit caller both understand memory previews. The one-argument API
  // remains byte-for-byte compatible for macOS, Linux, and older call sites.
  if (process.platform === "win32" && options !== undefined) {
    let captured;
    try {
      captured = await captureWindowsPickerSnapshot(displayId, options.mode);
    } catch (cause) {
      throw new Error(
        `screen snapshot failed: error: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    const id = nanoid();
    const entry: MemoryEntry = {
      kind: "memory",
      previewBytes: captured.previewBytes,
      previewMimeType: captured.previewMimeType,
      fullImage: captured.fullImage,
      displayId,
      displayBounds: captured.displayBounds,
      mode: options.mode,
      timings: captured.timings
    };
    registry.set(id, entry);
    log.info("in-memory Windows snapshot registered", {
      id,
      displayId,
      mode: options.mode,
      ...captured.timings
    });
    return {
      kind: "memory",
      id,
      displayId,
      mode: options.mode,
      timing: captured.timings
    };
  }

  const result = await captureScreen(displayId);
  if (!result.ok) {
    throw new Error(`screen snapshot failed: ${result.reason}: ${result.message}`);
  }
  const id = nanoid();
  const entry: FileEntry = { kind: "file", filePath: result.tempPath, displayId };
  registry.set(id, entry);
  log.info("snapshot registered", { id, filePath: result.tempPath, displayId });
  return { kind: "file", id, filePath: result.tempPath, displayId, timing: null };
}

/**
 * Look up the file path for a registered snapshot. Returns null when
 * the id is unknown — protocol handler maps that to a 404.
 */
export function getSnapshotPath(id: string): string | null {
  const entry = registry.get(id);
  return entry?.kind === "file" ? entry.filePath : null;
}

/** Return an in-memory Windows picker preview without copying its bytes. */
export function getSnapshotPreview(id: string): SnapshotPreview | null {
  const entry = registry.get(id);
  if (entry?.kind !== "memory") return null;
  return { bytes: entry.previewBytes, mimeType: entry.previewMimeType };
}

/** Resolve exactly one protocol representation for a registered snapshot. */
export function getSnapshotProtocolSource(id: string): SnapshotProtocolSource | null {
  const entry = registry.get(id);
  if (entry === undefined) return null;
  if (entry.kind === "file") return { kind: "file", filePath: entry.filePath };
  return {
    kind: "memory",
    bytes: entry.previewBytes,
    mimeType: entry.previewMimeType
  };
}

/**
 * Look up the full snapshot record (path + displayId) by id. Used by
 * the commit path to know which display's scaleFactor to apply when
 * sharp-cropping.
 */
export function getSnapshot(id: string): RegisteredScreenSnapshot | null {
  const entry = registry.get(id);
  if (entry === undefined) return null;
  if (entry.kind === "file") {
    return {
      kind: "file",
      id,
      filePath: entry.filePath,
      displayId: entry.displayId,
      timing: null
    };
  }
  return {
    kind: "memory",
    id,
    displayId: entry.displayId,
    mode: entry.mode,
    timing: entry.timings
  };
}

function validRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.w) &&
    Number.isFinite(rect.h) &&
    rect.w > 0 &&
    rect.h > 0
  );
}

/**
 * Materialize one trigger-time crop from a retained Windows NativeImage.
 * The returned PNG lives in its own caller-owned temp directory, so releasing
 * the picker snapshot immediately after this call cannot delete the capture.
 */
export async function cropRegisteredSnapshot(
  id: string,
  rect: Rect,
  displayId?: number
): Promise<RegisteredSnapshotCropResult> {
  const totalStartedAt = performance.now();
  const entry = registry.get(id);
  if (entry?.kind !== "memory") {
    return { ok: false, reason: "error", message: "screen snapshot is not available in memory" };
  }
  if (displayId !== undefined && displayId !== entry.displayId) {
    return {
      ok: false,
      reason: "validation",
      message: `snapshot display mismatch: expected ${entry.displayId}, got ${displayId}`
    };
  }
  if (!validRect(rect)) {
    return { ok: false, reason: "validation", message: `invalid crop rect: ${JSON.stringify(rect)}` };
  }
  const bounds = entry.displayBounds;
  // A selector rect can legitimately span displays or overhang an edge.
  // Preserve the legacy file-crop contract by intersecting it with the
  // trigger display, rather than rejecting the whole selection. Half-open
  // edges avoid manufacturing a one-pixel crop for a rect that merely touches
  // the display from outside.
  const logicalLeft = Math.max(rect.x, bounds.x);
  const logicalTop = Math.max(rect.y, bounds.y);
  const logicalRight = Math.min(rect.x + rect.w, bounds.x + bounds.width);
  const logicalBottom = Math.min(rect.y + rect.h, bounds.y + bounds.height);
  if (logicalRight <= logicalLeft || logicalBottom <= logicalTop) {
    return {
      ok: false,
      reason: "validation",
      message: `crop rect ${JSON.stringify(rect)} does not intersect snapshot bounds ${JSON.stringify(bounds)}`
    };
  }

  const fullImage = entry.fullImage;
  if (fullImage === null) {
    return {
      ok: false,
      reason: "error",
      message: "screen snapshot full image was not retained or was already consumed"
    };
  }

  let outputDir: string | null = null;
  try {
    const imageSize = fullImage.getSize();
    if (imageSize.width <= 0 || imageSize.height <= 0) {
      return { ok: false, reason: "error", message: "screen snapshot full image was empty" };
    }
    const sx = imageSize.width / bounds.width;
    const sy = imageSize.height / bounds.height;
    // Map both intersection endpoints, not origin + original size. That keeps
    // a left/top overhang from incorrectly adding its clipped-away extent to
    // the output and avoids independent-rounding drift at the far edge.
    const rawX = Math.round((logicalLeft - bounds.x) * sx);
    const rawY = Math.round((logicalTop - bounds.y) * sy);
    const rawRight = Math.round((logicalRight - bounds.x) * sx);
    const rawBottom = Math.round((logicalBottom - bounds.y) * sy);
    const x = Math.max(0, Math.min(rawX, imageSize.width - 1));
    const y = Math.max(0, Math.min(rawY, imageSize.height - 1));
    const right = Math.max(x + 1, Math.min(rawRight, imageSize.width));
    const bottom = Math.max(y + 1, Math.min(rawBottom, imageSize.height));
    const width = right - x;
    const height = bottom - y;
    const physicalRect = { x, y, width, height };

    const cropStartedAt = performance.now();
    const cropped = fullImage.crop(physicalRect);
    const cropMs = Math.max(0, performance.now() - cropStartedAt);

    const encodeStartedAt = performance.now();
    const png = cropped.toPNG();
    const pngEncodeMs = Math.max(0, performance.now() - encodeStartedAt);
    if (png.length === 0) {
      return { ok: false, reason: "error", message: "screen snapshot crop was empty" };
    }

    outputDir = await mkdtemp(join(tmpdir(), "pwrsnap-"));
    const tempPath = join(outputDir, `${Date.now()}.png`);
    const writeStartedAt = performance.now();
    await writeFile(tempPath, png);
    const writeMs = Math.max(0, performance.now() - writeStartedAt);

    // One materialization per interaction. Drop full display pixels as soon as
    // the selected PNG is durable; the preview remains valid until release.
    entry.fullImage = null;
    const timings: RegisteredSnapshotCropTimings = {
      cropMs,
      pngEncodeMs,
      writeMs,
      totalMs: Math.max(0, performance.now() - totalStartedAt),
      outputByteSize: png.length,
      physicalRect
    };
    log.info("in-memory Windows snapshot cropped", {
      id,
      displayId: entry.displayId,
      ...timings
    });
    return { ok: true, tempPath, displayId: entry.displayId, timings };
  } catch (cause) {
    if (outputDir !== null) {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      ok: false,
      reason: "error",
      message: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

/**
 * Delete the underlying temp file and unregister. Idempotent — calling
 * release twice on the same id is a no-op. Errors deleting are logged
 * but not thrown (the GC sweep at boot picks up leaked tmp files).
 */
export async function releaseSnapshot(id: string): Promise<void> {
  const entry = registry.get(id);
  if (entry === undefined) return;
  registry.delete(id);
  if (entry.kind === "memory") {
    // NativeImage has no dispose API. Removing both strong references makes
    // the interaction-scoped pixels collectible immediately after this turn.
    entry.fullImage = null;
    entry.previewBytes = Buffer.alloc(0);
    log.info("in-memory Windows snapshot released", {
      id,
      displayId: entry.displayId,
      mode: entry.mode
    });
    return;
  }
  try {
    // The capture writes into a fresh mkdtemp directory; remove the
    // whole directory so we don't leave empty `pwrsnap-screen-*`
    // shells littering /tmp.
    await rm(dirname(entry.filePath), { recursive: true, force: true });
  } catch (err) {
    log.warn("snapshot cleanup failed", {
      id,
      filePath: entry.filePath,
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
