import { EventEmitter } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { session } from "electron";
import type {
  RenderCacheMaintenanceMode,
  StorageBucket,
  StorageSnapshot,
  StorageSnapshotUpdate,
  StorageSummary
} from "@pwrsnap/shared";
import { getDb } from "../persistence/db";
import {
  getCacheRoot,
  getDataRoot,
  getDbPath,
  getDurableCapturesRoots,
  getLegacyCapturesRoot
} from "../persistence/paths";
import type { DurableCapturesRoot } from "../persistence/paths";
import { clearRenderCache, trimRenderCache } from "../persistence/render-cache-maintenance";

export const CHROMIUM_DISK_CACHE_LIMIT_BYTES = 128 * 1024 * 1024;
// Full filesystem accounting is intentionally coarse. Hot UI paths use
// SQLite-backed summaries; exact bucket totals are refreshed on explicit
// details/maintenance paths.
export const STORAGE_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;

type SizeResult = StorageBucket;
type StorageSnapshotOptions = {
  force?: boolean;
  audit?: boolean;
};
type InFlightStorageScan = {
  audit: boolean;
  promise: Promise<StorageSnapshot>;
};
type SnapshotParts = {
  capturedAt: string;
  audit: boolean;
  durableCapturesRoots: readonly DurableCapturesRoot[];
  durableCapturesRootsScanned: number;
  sourceStats: StorageSummary["sourceCaptures"];
  documentsCaptures?: SizeResult;
  homeCaptures?: SizeResult;
  appSupportCaptures?: SizeResult;
  appSupportTotal?: SizeResult;
  renderCache?: SizeResult;
  chromiumCacheDir?: SizeResult;
  chromiumCodeCache?: SizeResult;
  gpuCache?: SizeResult;
  dawnGraphiteCache?: SizeResult;
  dawnWebGpuCache?: SizeResult;
  dbFile?: SizeResult;
  dbWal?: SizeResult;
  dbShm?: SizeResult;
  chromiumReportedBytes?: number;
  databaseStats: {
    pageCount: number;
    pageSize: number;
    freelistCount: number;
  };
};

const EMPTY_SIZE: SizeResult = { bytes: 0, fileCount: 0 };
const storageEmitter = new EventEmitter();
let cachedStorageSnapshot: StorageSnapshot | null = null;
let cachedStorageSnapshotAudit = false;
let cachedCompletedAtMs = 0;
let inFlightStorageScan: InFlightStorageScan | null = null;
let queuedAuditStorageScan: Promise<StorageSnapshot> | null = null;
let queuedForceStorageScan: Promise<StorageSnapshot> | null = null;

export function getStorageSummary(): StorageSummary {
  const sourceCaptures = getLiveSourceCaptureStats();
  return {
    capturedAt: new Date().toISOString(),
    sourceCaptures
  };
}

export function getCachedStorageSnapshot(): StorageSnapshot | null {
  return cachedStorageSnapshot;
}

export function onStorageSnapshotUpdated(
  listener: (update: StorageSnapshotUpdate) => void
): () => void {
  storageEmitter.on("snapshot", listener);
  return () => storageEmitter.off("snapshot", listener);
}

export async function getStorageSnapshot(
  options: StorageSnapshotOptions = {}
): Promise<StorageSnapshot> {
  const force = options.force ?? false;
  const audit = options.audit ?? false;
  if (inFlightStorageScan !== null) {
    if (audit && !inFlightStorageScan.audit) {
      queuedAuditStorageScan ??= inFlightStorageScan.promise.then(
        () => getStorageSnapshot({ force: true, audit: true }),
        () => getStorageSnapshot({ force: true, audit: true })
      ).finally(() => {
        queuedAuditStorageScan = null;
      });
      return queuedAuditStorageScan;
    }
    if (force) {
      // The in-flight scan enumerated the filesystem BEFORE this
      // request, so joining it would silently return pre-request
      // state — the Library storage popover reopening right after a
      // capture/seed landed would show stale sizes forever (nothing
      // retriggers a scan inside the 5-minute TTL). A force caller is
      // owed a scan that STARTS at-or-after its request: chain one
      // trailing rescan behind the in-flight scan. The queue slot is
      // shared (??=) and cleared the moment the rescan begins, so any
      // number of force callers arriving during one scan collapse
      // into exactly one follow-up — no scan storms.
      queuedForceStorageScan ??= inFlightStorageScan.promise
        .catch(() => undefined)
        .then(() => {
          queuedForceStorageScan = null;
          return getStorageSnapshot({ force: true, audit });
        });
      return queuedForceStorageScan;
    }
    return inFlightStorageScan.promise;
  }

  const cachedAgeMs = Date.now() - cachedCompletedAtMs;
  if (
    !force &&
    cachedStorageSnapshot !== null &&
    cachedAgeMs < STORAGE_SNAPSHOT_CACHE_TTL_MS &&
    (!audit || cachedStorageSnapshotAudit)
  ) {
    return cachedStorageSnapshot;
  }

  const promise = scanStorageSnapshot({ audit }).finally(() => {
    inFlightStorageScan = null;
  });
  inFlightStorageScan = { audit, promise };
  return promise;
}

async function scanStorageSnapshot(options: { audit: boolean }): Promise<StorageSnapshot> {
  const dataRoot = getDataRoot();
  const dbPath = getDbPath();
  const durableCapturesRoots = getDurableCapturesRoots();
  const parts: SnapshotParts = {
    capturedAt: new Date().toISOString(),
    audit: options.audit,
    durableCapturesRoots,
    durableCapturesRootsScanned: 0,
    sourceStats: getLiveSourceCaptureStats(),
    databaseStats: getDatabaseStats()
  };

  publishStorageSnapshot(buildStorageSnapshot(parts), true);

  const scanTasks: Array<() => Promise<void>> = [
    ...durableCapturesRoots.map((root) => async () => {
      const size = await sizePath(root.path);
      if (root.kind === "documents") parts.documentsCaptures = size;
      else if (root.kind === "home") parts.homeCaptures = size;
      else parts.appSupportCaptures = size;
      parts.durableCapturesRootsScanned += 1;
      publishStorageSnapshot(buildStorageSnapshot(parts), true);
    }),
    async () => {
      const legacyRoot = getLegacyCapturesRoot();
      if (!durableCapturesRoots.some((root) => pathsEqual(root.path, legacyRoot))) {
        parts.appSupportCaptures = await sizePath(legacyRoot);
      }
      publishStorageSnapshot(buildStorageSnapshot(parts), true);
    },
    async () => {
      parts.renderCache = await sizePath(getCacheRoot());
      publishStorageSnapshot(buildStorageSnapshot(parts), true);
    },
    async () => {
      parts.dbFile = await sizePath(dbPath);
      publishStorageSnapshot(buildStorageSnapshot(parts), true);
    },
    async () => {
      parts.dbWal = await sizePath(`${dbPath}-wal`);
      publishStorageSnapshot(buildStorageSnapshot(parts), true);
    },
    async () => {
      parts.dbShm = await sizePath(`${dbPath}-shm`);
      publishStorageSnapshot(buildStorageSnapshot(parts), true);
    },
    async () => {
      parts.chromiumReportedBytes = await session.defaultSession.getCacheSize().catch(() => 0);
      publishStorageSnapshot(buildStorageSnapshot(parts), true);
    }
  ];
  if (options.audit) {
    scanTasks.push(
      async () => {
        parts.appSupportTotal = await sizePath(dataRoot);
        publishStorageSnapshot(buildStorageSnapshot(parts), true);
      },
      async () => {
        parts.chromiumCacheDir = await sizePath(join(dataRoot, "Cache"));
        publishStorageSnapshot(buildStorageSnapshot(parts), true);
      },
      async () => {
        parts.chromiumCodeCache = await sizePath(join(dataRoot, "Code Cache"));
        publishStorageSnapshot(buildStorageSnapshot(parts), true);
      },
      async () => {
        parts.gpuCache = await sizePath(join(dataRoot, "GPUCache"));
        publishStorageSnapshot(buildStorageSnapshot(parts), true);
      },
      async () => {
        parts.dawnGraphiteCache = await sizePath(join(dataRoot, "DawnGraphiteCache"));
        publishStorageSnapshot(buildStorageSnapshot(parts), true);
      },
      async () => {
        parts.dawnWebGpuCache = await sizePath(join(dataRoot, "DawnWebGPUCache"));
        publishStorageSnapshot(buildStorageSnapshot(parts), true);
      }
    );
  }

  await Promise.all(scanTasks.map((task) => task()));

  const snapshot = buildStorageSnapshot(parts);
  cachedStorageSnapshotAudit = options.audit;
  cachedCompletedAtMs = Date.now();
  publishStorageSnapshot(snapshot, false);
  return snapshot;
}

function buildStorageSnapshot(parts: SnapshotParts): StorageSnapshot {
  let documentsCaptures = parts.documentsCaptures ?? EMPTY_SIZE;
  let homeCaptures = parts.homeCaptures ?? EMPTY_SIZE;
  let appSupportCaptures = parts.appSupportCaptures ?? EMPTY_SIZE;
  // Publish a useful immediate snapshot before the async filesystem walk has
  // completed. Once any durable root has been scanned we report only measured
  // buckets, avoiding a DB-derived placeholder being double-counted beside a
  // completed root.
  if (parts.durableCapturesRootsScanned === 0) {
    const placeholder = {
      bytes: parts.sourceStats.bytes,
      fileCount: parts.sourceStats.captureCount
    };
    const soleRoot = parts.durableCapturesRoots.length === 1
      ? parts.durableCapturesRoots[0]
      : undefined;
    if (soleRoot?.kind === "override") appSupportCaptures = placeholder;
    else documentsCaptures = placeholder;
  }
  const appSupportTotal = parts.appSupportTotal ?? EMPTY_SIZE;
  const renderCache = parts.renderCache ?? EMPTY_SIZE;
  const chromiumCacheDir = parts.chromiumCacheDir ?? EMPTY_SIZE;
  const chromiumCodeCache = parts.chromiumCodeCache ?? EMPTY_SIZE;
  const gpuCache = parts.gpuCache ?? EMPTY_SIZE;
  const dawnGraphiteCache = parts.dawnGraphiteCache ?? EMPTY_SIZE;
  const dawnWebGpuCache = parts.dawnWebGpuCache ?? EMPTY_SIZE;
  const dbFile = parts.dbFile ?? EMPTY_SIZE;
  const dbWal = parts.dbWal ?? EMPTY_SIZE;
  const dbShm = parts.dbShm ?? EMPTY_SIZE;
  const chromiumReportedBytes = parts.chromiumReportedBytes ?? 0;
  const databaseStats = parts.databaseStats;
  const chromiumGpuCaches = combineBuckets(gpuCache, dawnGraphiteCache, dawnWebGpuCache);
  const chromiumHttpCache: StorageBucket & { reportedBytes: number; limitBytes: number } = {
    ...(parts.audit ? chromiumCacheDir : { bytes: chromiumReportedBytes, fileCount: 0 }),
    reportedBytes: chromiumReportedBytes,
    limitBytes: CHROMIUM_DISK_CACHE_LIMIT_BYTES
  };
  const knownTotalBytes =
    documentsCaptures.bytes +
    homeCaptures.bytes +
    appSupportCaptures.bytes +
    renderCache.bytes +
    chromiumHttpCache.bytes +
    chromiumCodeCache.bytes +
    chromiumGpuCaches.bytes +
    dbFile.bytes +
    dbWal.bytes +
    dbShm.bytes;
  const knownAppSupportBytes =
    appSupportCaptures.bytes +
    renderCache.bytes +
    chromiumHttpCache.bytes +
    chromiumCodeCache.bytes +
    chromiumGpuCaches.bytes +
    dbFile.bytes +
    dbWal.bytes +
    dbShm.bytes;

  return {
    capturedAt: parts.capturedAt,
    totalBytes: parts.audit && parts.appSupportTotal !== undefined
      ? appSupportTotal.bytes + documentsCaptures.bytes + homeCaptures.bytes
      : knownTotalBytes,
    sourceCaptures: {
      bytes: documentsCaptures.bytes + homeCaptures.bytes + appSupportCaptures.bytes,
      fileCount:
        documentsCaptures.fileCount + homeCaptures.fileCount + appSupportCaptures.fileCount,
      captureCount: parts.sourceStats.captureCount,
      documentsBytes: documentsCaptures.bytes,
      homeBytes: homeCaptures.bytes,
      appSupportBytes: appSupportCaptures.bytes
    },
    renderCache,
    chromiumHttpCache,
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

function publishStorageSnapshot(snapshot: StorageSnapshot, scanning: boolean): void {
  cachedStorageSnapshot = snapshot;
  storageEmitter.emit("snapshot", { snapshot, scanning } satisfies StorageSnapshotUpdate);
}

function pathsEqual(first: string, second: string): boolean {
  return resolve(first) === resolve(second);
}

export async function maintainRenderCache(
  mode: RenderCacheMaintenanceMode
): Promise<{ snapshot: StorageSnapshot; clearedBytes: number }> {
  const before = await getStorageSnapshot({ force: true });
  if (mode === "clear") {
    await clearRenderCache();
  } else {
    await trimRenderCache();
  }
  const snapshot = await getStorageSnapshot({ force: true });
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
