import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { session } from "electron";
import type { StorageBucket, StorageSnapshot } from "@pwrsnap/shared";
import { getDb } from "../persistence/db";
import {
  getCacheRoot,
  getCapturesRoot,
  getDataRoot,
  getDbPath,
  getLegacyCapturesRoot
} from "../persistence/paths";

export const CHROMIUM_DISK_CACHE_LIMIT_BYTES = 128 * 1024 * 1024;

type SizeResult = StorageBucket;

const EMPTY_SIZE: SizeResult = { bytes: 0, fileCount: 0 };

export async function getStorageSnapshot(): Promise<StorageSnapshot> {
  const dataRoot = getDataRoot();
  const dbPath = getDbPath();
  const documentsCaptures = await sizePath(getCapturesRoot());
  const appSupportCaptures = getCapturesRoot() === getLegacyCapturesRoot()
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
    totalBytes: appSupportTotal.bytes + documentsCaptures.bytes,
    sourceCaptures: {
      bytes: documentsCaptures.bytes + appSupportCaptures.bytes,
      fileCount: documentsCaptures.fileCount + appSupportCaptures.fileCount,
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
