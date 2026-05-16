import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { session } from "electron";
import type {
  RenderCacheMaintenanceMode,
  StorageBucket,
  StorageSnapshot,
  StorageSummary
} from "@pwrsnap/shared";
import { getDb } from "../persistence/db";
import {
  getCacheRoot,
  getCapturesRoot,
  getDataRoot,
  getDbPath,
  getLegacyCapturesRoot
} from "../persistence/paths";
import { clearRenderCache, trimRenderCache } from "../persistence/render-cache-maintenance";

export const CHROMIUM_DISK_CACHE_LIMIT_BYTES = 128 * 1024 * 1024;

type SizeResult = StorageBucket;

const EMPTY_SIZE: SizeResult = { bytes: 0, fileCount: 0 };

export function getStorageSummary(): StorageSummary {
  const sourceCaptures = getLiveSourceCaptureStats();
  return {
    capturedAt: new Date().toISOString(),
    sourceCaptures
  };
}

export async function getStorageSnapshot(): Promise<StorageSnapshot> {
  const dataRoot = getDataRoot();
  const dbPath = getDbPath();
  const capturesRoot = getCapturesRoot();
  const capturesInsideDataRoot = isPathWithinOrEqual(capturesRoot, dataRoot);
  const documentsCaptures = await sizePath(capturesRoot);
  const appSupportCaptures = capturesRoot === getLegacyCapturesRoot()
    ? EMPTY_SIZE
    : await sizePath(getLegacyCapturesRoot());
  const [
    appSupportTotal,
    renderCache,
    chromiumCacheDir,
    chromiumCodeCache,
    gpuCache,
    dawnGraphiteCache,
    dawnWebGpuCache,
    dbFile,
    dbWal,
    dbShm
  ] = await Promise.all([
    sizePath(dataRoot),
    sizePath(getCacheRoot()),
    sizePath(join(dataRoot, "Cache")),
    sizePath(join(dataRoot, "Code Cache")),
    sizePath(join(dataRoot, "GPUCache")),
    sizePath(join(dataRoot, "DawnGraphiteCache")),
    sizePath(join(dataRoot, "DawnWebGPUCache")),
    sizePath(dbPath),
    sizePath(`${dbPath}-wal`),
    sizePath(`${dbPath}-shm`)
  ]);

  const chromiumReportedBytes = await session.defaultSession.getCacheSize().catch(() => 0);
  const databaseStats = getDatabaseStats();
  const chromiumGpuCaches = combineBuckets(gpuCache, dawnGraphiteCache, dawnWebGpuCache);
  const knownAppSupportBytes =
    (capturesInsideDataRoot ? documentsCaptures.bytes : 0) +
    appSupportCaptures.bytes +
    renderCache.bytes +
    chromiumCacheDir.bytes +
    chromiumCodeCache.bytes +
    chromiumGpuCaches.bytes +
    dbFile.bytes +
    dbWal.bytes +
    dbShm.bytes;

  return {
    capturedAt: new Date().toISOString(),
    totalBytes: appSupportTotal.bytes + (capturesInsideDataRoot ? 0 : documentsCaptures.bytes),
    sourceCaptures: {
      bytes: documentsCaptures.bytes + appSupportCaptures.bytes,
      fileCount: documentsCaptures.fileCount + appSupportCaptures.fileCount,
      captureCount: getCaptureCount(),
      documentsBytes: documentsCaptures.bytes,
      appSupportBytes: appSupportCaptures.bytes
    },
    renderCache,
    chromiumHttpCache: {
      ...chromiumCacheDir,
      reportedBytes: chromiumReportedBytes,
      limitBytes: CHROMIUM_DISK_CACHE_LIMIT_BYTES
    },
    chromiumCodeCache,
    chromiumGpuCaches,
    database: {
      bytes: dbFile.bytes,
      walBytes: dbWal.bytes,
      shmBytes: dbShm.bytes,
      ...databaseStats
    },
    otherAppSupport: {
      bytes: Math.max(0, appSupportTotal.bytes - knownAppSupportBytes),
      fileCount: Math.max(
        0,
        appSupportTotal.fileCount -
          (capturesInsideDataRoot ? documentsCaptures.fileCount : 0) -
          appSupportCaptures.fileCount -
          renderCache.fileCount -
          chromiumCacheDir.fileCount -
          chromiumCodeCache.fileCount -
          chromiumGpuCaches.fileCount -
          dbFile.fileCount -
          dbWal.fileCount -
          dbShm.fileCount
      )
    }
  };
}

function isPathWithinOrEqual(path: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export async function maintainRenderCache(
  mode: RenderCacheMaintenanceMode
): Promise<{ snapshot: StorageSnapshot; clearedBytes: number }> {
  const before = await getStorageSnapshot();
  if (mode === "clear") {
    await clearRenderCache();
  } else {
    await trimRenderCache();
  }
  const snapshot = await getStorageSnapshot();
  return {
    snapshot,
    clearedBytes: Math.max(0, before.renderCache.bytes - snapshot.renderCache.bytes)
  };
}

async function sizePath(path: string): Promise<SizeResult> {
  try {
    const stats = await stat(path);
    const bytes = statBytes(stats);
    if (!stats.isDirectory()) return { bytes, fileCount: stats.isFile() ? 1 : 0 };

    let totalBytes = bytes;
    let fileCount = 0;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = await sizePath(join(path, entry.name));
      totalBytes += child.bytes;
      fileCount += child.fileCount;
    }
    return { bytes: totalBytes, fileCount };
  } catch {
    return EMPTY_SIZE;
  }
}

function statBytes(stats: Awaited<ReturnType<typeof stat>>): number {
  const blocks = stats.blocks;
  if (typeof blocks === "number" && blocks > 0) return blocks * 512;
  if (typeof blocks === "bigint" && blocks > 0n) return Number(blocks * 512n);
  return Number(stats.size);
}

function combineBuckets(...buckets: StorageBucket[]): StorageBucket {
  return buckets.reduce(
    (acc, bucket) => ({
      bytes: acc.bytes + bucket.bytes,
      fileCount: acc.fileCount + bucket.fileCount
    }),
    { bytes: 0, fileCount: 0 }
  );
}

function getDatabaseStats(): {
  pageCount: number;
  pageSize: number;
  freelistCount: number;
} {
  const db = getDb();
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const freelistCount = db.pragma("freelist_count", { simple: true }) as number;
  return { pageCount, pageSize, freelistCount };
}

function getCaptureCount(): number {
  return getLiveSourceCaptureStats().captureCount;
}

function getLiveSourceCaptureStats(): {
  bytes: number;
  captureCount: number;
} {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS captureCount,
         COALESCE(SUM(byte_size), 0) AS bytes
       FROM captures
       WHERE deleted_at IS NULL`
    )
    .get() as { captureCount: number; bytes: number | bigint };
  return {
    captureCount: row.captureCount,
    bytes: Number(row.bytes)
  };
}
