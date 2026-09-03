// Registry for the per-pickRegion frozen screen. One registry id owns one
// pixel generation from selector paint through commit crop.
//
// Windows prefers a pagefile-backed Win32 mapping. The mapping name and
// native handle stay behind main; the selector renderer receives only a
// validated RGBA copy through a purpose-built preload method. macOS/Linux,
// and any Windows fast-path failure, retain the PNG/temp-file transport.

import { mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { screen } from "electron";
import { getMainLogger } from "../log";
import type { CaptureLatencyTrace } from "./capture-latency-trace";
import { captureDisplayBitmap, captureScreen } from "./screencapture";
import {
  createWindowsSharedSnapshot,
  type WindowsSharedSnapshot
} from "./windows-shared-snapshot";
import type { WindowsSnapshotHeader } from "./windows-snapshot-format";

const log = getMainLogger("pwrsnap:screen-snapshot");

export type SelectorMappedSnapshotDescriptor = Readonly<{
  id: string;
  transport: "windows-shared-memory";
  version: 1;
  width: number;
  height: number;
  stride: number;
  pixelFormat: 1;
  byteLength: number;
}>;

type SnapshotMetrics = {
  sourceBitmapBytes: number;
  mappingWriteBytes: number;
  mappingReadBytes: number;
  rendererTransferBytes: number;
  cropReadBytes: number;
  fullScreenPngEncodeCount: number;
  fullScreenPngBytes: number;
  fullScreenTempFileWriteBytes: number;
  rendererCanvasUploadBytes: number;
};

type BaseEntry = {
  displayId: number;
  /** Kept in main so a PNG protocol fallback can correlate file I/O with
   *  the capture invocation without exposing trace identity to renderer. */
  latencyTrace?: CaptureLatencyTrace;
  metrics: SnapshotMetrics;
  operations: number;
  releaseRequested: boolean;
  releasePromise: Promise<void> | null;
  releaseWaiters: Array<() => void>;
};

type FileEntry = BaseEntry & {
  kind: "png-file";
  filePath: string;
};

type MappedEntry = BaseEntry & {
  kind: "windows-shared-memory";
  mapping: WindowsSharedSnapshot;
  fallbackFilePath: string | null;
  fallbackPromise: Promise<string> | null;
};

type Entry = FileEntry | MappedEntry;

const registry = new Map<string, Entry>();
const releasing = new Map<string, Promise<void>>();

export type ScreenSnapshot = Readonly<{
  id: string;
  displayId: number;
  transport: "png-file" | "windows-shared-memory";
  selectorDescriptor?: SelectorMappedSnapshotDescriptor;
  acquisition: Readonly<{
    sourceBitmapBytes: number;
    mappingWriteBytes: number;
    fullScreenPngEncodeCount: number;
    fullScreenPngBytes: number;
    fullScreenTempFileWriteBytes: number;
  }>;
}>;

export type SnapshotRasterLease = Readonly<{
  source:
    | { kind: "png-file"; filePath: string }
    | {
        kind: "rgba8";
        data: Buffer;
        width: number;
        height: number;
        stride: number;
      };
  release: () => Promise<void>;
}>;

function emptyMetrics(): SnapshotMetrics {
  return {
    sourceBitmapBytes: 0,
    mappingWriteBytes: 0,
    mappingReadBytes: 0,
    rendererTransferBytes: 0,
    cropReadBytes: 0,
    fullScreenPngEncodeCount: 0,
    fullScreenPngBytes: 0,
    fullScreenTempFileWriteBytes: 0,
    rendererCanvasUploadBytes: 0
  };
}

function publicDescriptor(
  id: string,
  header: WindowsSnapshotHeader
): SelectorMappedSnapshotDescriptor {
  return {
    id,
    transport: "windows-shared-memory",
    version: header.version,
    width: header.width,
    height: header.height,
    stride: header.stride,
    pixelFormat: header.pixelFormat,
    byteLength: header.byteLength
  };
}

function snapshotFromEntry(id: string, entry: Entry): ScreenSnapshot {
  const acquisition = {
    sourceBitmapBytes: entry.metrics.sourceBitmapBytes,
    mappingWriteBytes: entry.metrics.mappingWriteBytes,
    fullScreenPngEncodeCount: entry.metrics.fullScreenPngEncodeCount,
    fullScreenPngBytes: entry.metrics.fullScreenPngBytes,
    fullScreenTempFileWriteBytes: entry.metrics.fullScreenTempFileWriteBytes
  };
  return entry.kind === "png-file"
    ? { id, displayId: entry.displayId, transport: entry.kind, acquisition }
    : {
        id,
        displayId: entry.displayId,
        transport: entry.kind,
        selectorDescriptor: publicDescriptor(id, entry.mapping.header),
        acquisition
      };
}

/** Capture and register one immutable generation, preferring Win32 mapping storage. */
export async function captureAndRegister(
  displayId: number,
  latencyTrace?: CaptureLatencyTrace
): Promise<ScreenSnapshot> {
  const id = nanoid();
  if (process.platform === "win32") {
    const display = screen.getAllDisplays().find((candidate) => candidate.id === displayId);
    if (display === undefined) {
      throw new Error(`screen snapshot failed: unknown display id: ${displayId}`);
    }
    try {
      const captured = await captureDisplayBitmap(display, latencyTrace);
      const mapping = await createWindowsSharedSnapshot(captured);
      const metrics = emptyMetrics();
      metrics.sourceBitmapBytes = captured.bitmap.byteLength;
      metrics.mappingWriteBytes = mapping.header.totalByteLength;
      const entry: MappedEntry = {
        kind: "windows-shared-memory",
        displayId,
        ...(latencyTrace !== undefined ? { latencyTrace } : {}),
        mapping,
        fallbackFilePath: null,
        fallbackPromise: null,
        metrics,
        operations: 0,
        releaseRequested: false,
        releasePromise: null,
        releaseWaiters: []
      };
      registry.set(id, entry);
      log.info("snapshot registered", {
        id,
        displayId,
        transport: entry.kind,
        width: mapping.header.width,
        height: mapping.header.height,
        bytes: mapping.header.byteLength,
        fullScreenPngEncodeCount: 0,
        fullScreenTempFileWriteBytes: 0
      });
      return snapshotFromEntry(id, entry);
    } catch (cause) {
      // Do not mix generations: no selector was shown yet, so it is safe to
      // take a fresh PNG fallback. That fallback file then backs BOTH paint
      // and crop exactly as before.
      log.warn("Windows shared snapshot unavailable; falling back to PNG/file", {
        displayId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  const result = await captureScreen(displayId, latencyTrace);
  if (!result.ok) {
    throw new Error(`screen snapshot failed: ${result.reason}: ${result.message}`);
  }
  const metrics = emptyMetrics();
  metrics.fullScreenPngEncodeCount = 1;
  const pngStats = await stat(result.tempPath).catch(() => null);
  if (pngStats !== null) {
    metrics.fullScreenPngBytes = pngStats.size;
    metrics.fullScreenTempFileWriteBytes = pngStats.size;
  }
  const entry: FileEntry = {
    kind: "png-file",
    filePath: result.tempPath,
    displayId,
    ...(latencyTrace !== undefined ? { latencyTrace } : {}),
    metrics,
    operations: 0,
    releaseRequested: false,
    releasePromise: null,
    releaseWaiters: []
  };
  registry.set(id, entry);
  log.info("snapshot registered", { id, displayId, transport: entry.kind });
  return snapshotFromEntry(id, entry);
}

function beginOperation(id: string): Entry | null {
  const entry = registry.get(id);
  if (entry === undefined || entry.releaseRequested) return null;
  entry.operations += 1;
  return entry;
}

async function endOperation(entry: Entry): Promise<void> {
  entry.operations = Math.max(0, entry.operations - 1);
  if (entry.releaseRequested && entry.operations === 0) await finalizeEntry(entry);
}

async function finalizeEntry(entry: Entry): Promise<void> {
  if (entry.releasePromise !== null) return await entry.releasePromise;
  entry.releasePromise = (async () => {
    if (entry.kind === "windows-shared-memory") {
      await entry.mapping.release();
      if (entry.fallbackFilePath !== null) {
        await rm(dirname(entry.fallbackFilePath), { recursive: true, force: true });
      }
      return;
    }
    await rm(dirname(entry.filePath), { recursive: true, force: true });
  })();
  try {
    await entry.releasePromise;
  } catch (cause) {
    log.warn("snapshot cleanup failed", {
      transport: entry.kind,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  } finally {
    for (const resolve of entry.releaseWaiters.splice(0)) resolve();
  }
}

/** Acquire one stable source lease for the eventual same-generation crop. */
export async function acquireSnapshotRaster(
  id: string,
  purpose: "renderer" | "crop" | "fallback"
): Promise<SnapshotRasterLease | null> {
  const entry = beginOperation(id);
  if (entry === null) return null;
  let leaseReleased = false;
  const release = async (): Promise<void> => {
    if (leaseReleased) return;
    leaseReleased = true;
    await endOperation(entry);
  };
  try {
    if (entry.kind === "png-file") {
      return { source: { kind: "png-file", filePath: entry.filePath }, release };
    }
    const data = await entry.mapping.read();
    entry.metrics.mappingReadBytes += entry.mapping.header.totalByteLength;
    if (purpose === "renderer") entry.metrics.rendererTransferBytes += data.byteLength;
    if (purpose === "crop") entry.metrics.cropReadBytes += data.byteLength;
    return {
      source: {
        kind: "rgba8",
        data,
        width: entry.mapping.header.width,
        height: entry.mapping.header.height,
        stride: entry.mapping.header.stride
      },
      release
    };
  } catch (cause) {
    await release();
    throw cause;
  }
}

/** Sender-authenticated region-selector handler calls this; other renderers cannot. */
export async function readSnapshotForRenderer(id: string): Promise<
  | {
      ok: true;
      header: Omit<SelectorMappedSnapshotDescriptor, "id" | "transport">;
      data: Buffer;
    }
  | { ok: false; code: "not_found" | "not_mapped" | "read_failed" }
> {
  const entry = registry.get(id);
  if (entry === undefined || entry.releaseRequested) return { ok: false, code: "not_found" };
  if (entry.kind !== "windows-shared-memory") return { ok: false, code: "not_mapped" };
  try {
    const lease = await acquireSnapshotRaster(id, "renderer");
    if (lease === null || lease.source.kind !== "rgba8") {
      await lease?.release();
      return { ok: false, code: "not_found" };
    }
    const descriptor = publicDescriptor(id, entry.mapping.header);
    const result = {
      ok: true as const,
      header: {
        version: descriptor.version,
        width: descriptor.width,
        height: descriptor.height,
        stride: descriptor.stride,
        pixelFormat: descriptor.pixelFormat,
        byteLength: descriptor.byteLength
      },
      data: lease.source.data
    };
    await lease.release();
    return result;
  } catch (cause) {
    log.warn("mapped snapshot renderer read failed", {
      id,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return { ok: false, code: "read_failed" };
  }
}

/** Record bytes copied into the canvas backing store (reported by renderer). */
export function recordSnapshotCanvasUpload(id: string, byteLength: number): void {
  const entry = registry.get(id);
  if (
    entry === undefined ||
    entry.kind !== "windows-shared-memory" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > entry.mapping.header.byteLength
  ) {
    return;
  }
  entry.metrics.rendererCanvasUploadBytes += byteLength;
}

/**
 * Resolve the custom-protocol PNG. For a mapping this is a lazy, same-generation
 * fallback: the fast path performs no PNG encode or temp-file write unless the
 * selector explicitly falls back to its existing <img> transport.
 */
export async function getSnapshotPngPath(id: string): Promise<string | null> {
  const entry = registry.get(id);
  if (entry === undefined || entry.releaseRequested) return null;
  if (entry.kind === "png-file") return entry.filePath;
  if (entry.fallbackFilePath !== null) return entry.fallbackFilePath;
  if (entry.fallbackPromise !== null) return await entry.fallbackPromise;
  entry.fallbackPromise = (async () => {
    const lease = await acquireSnapshotRaster(id, "fallback");
    if (lease === null || lease.source.kind !== "rgba8") {
      await lease?.release();
      throw new Error("mapped snapshot disappeared before fallback encode");
    }
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), "pwrsnap-screen-fallback-"));
      const filePath = join(dir, `${Date.now()}.png`);
      const info = await sharp(lease.source.data, {
        raw: { width: lease.source.width, height: lease.source.height, channels: 4 }
      })
        .png({ palette: false })
        .toFile(filePath);
      entry.fallbackFilePath = filePath;
      entry.metrics.fullScreenPngEncodeCount += 1;
      entry.metrics.fullScreenPngBytes += info.size;
      entry.metrics.fullScreenTempFileWriteBytes += info.size;
      log.warn("mapped snapshot used lazy PNG/file fallback", {
        id,
        pngBytes: info.size,
        sourceBytes: lease.source.data.byteLength
      });
      return filePath;
    } catch (cause) {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
      throw cause;
    } finally {
      await lease.release();
    }
  })();
  try {
    return await entry.fallbackPromise;
  } finally {
    entry.fallbackPromise = null;
  }
}

/** Resolve the PNG protocol target plus its owning latency trace. For a
 * mapped snapshot, this creates the same-generation PNG only when the canvas
 * transport requests its fallback. Neither the trace nor path crosses IPC. */
export async function getSnapshotProtocolTarget(id: string): Promise<{
  filePath: string;
  latencyTrace?: CaptureLatencyTrace;
} | null> {
  const entry = registry.get(id);
  if (entry === undefined || entry.releaseRequested) return null;
  const filePath = await getSnapshotPngPath(id);
  if (filePath === null) return null;
  return {
    filePath,
    ...(entry.latencyTrace !== undefined ? { latencyTrace: entry.latencyTrace } : {})
  };
}

/** Release is idempotent and waits for any already-admitted reader/crop lease. */
export async function releaseSnapshot(id: string): Promise<void> {
  const alreadyReleasing = releasing.get(id);
  if (alreadyReleasing !== undefined) return await alreadyReleasing;
  const entry = registry.get(id);
  if (entry === undefined) return;
  registry.delete(id);
  const release = (async () => {
    entry.releaseRequested = true;
    log.info("snapshot released", {
      id,
      displayId: entry.displayId,
      transport: entry.kind,
      ...entry.metrics
    });
    if (entry.operations === 0) {
      await finalizeEntry(entry);
      return;
    }
    await new Promise<void>((resolve) => entry.releaseWaiters.push(resolve));
  })();
  releasing.set(id, release);
  try {
    await release;
  } finally {
    releasing.delete(id);
  }
}

/** Shutdown/crash-teardown hook: stop every mapping owner and delete temp fallbacks. */
export async function releaseAllSnapshots(): Promise<void> {
  await Promise.all([
    ...[...registry.keys()].map(async (id) => await releaseSnapshot(id)),
    ...releasing.values()
  ]);
}
