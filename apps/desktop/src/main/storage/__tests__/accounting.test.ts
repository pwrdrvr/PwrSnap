import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StorageSnapshot } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  dataRoot: "",
  capturesRoot: "",
  homeCapturesRoot: "",
  legacyCapturesRoot: "",
  dbPath: "",
  captureCount: 0,
  sourceBytes: 0
}));

vi.mock("electron", () => ({
  session: {
    defaultSession: {
      getCacheSize: vi.fn(async () => 0)
    }
  }
}));

vi.mock("../../persistence/db", () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () =>
        sql.includes("COUNT(*) AS captureCount")
          ? { captureCount: mocks.captureCount, bytes: mocks.sourceBytes }
          : undefined,
      pluck: () => ({
        get: () => (sql.includes("COUNT(*) FROM captures") ? mocks.captureCount : 0)
      })
    }),
    pragma: (name: string) => {
      if (name === "page_size") return 4096;
      return 0;
    }
  })
}));

vi.mock("../../persistence/paths", () => ({
  getCacheRoot: () => join(mocks.dataRoot, "render-cache"),
  getDataRoot: () => mocks.dataRoot,
  getDbPath: () => mocks.dbPath,
  getDurableCapturesRoots: () =>
    mocks.capturesRoot === mocks.legacyCapturesRoot
      ? [{ kind: "override", path: mocks.capturesRoot }]
      : [
          { kind: "documents", path: mocks.capturesRoot },
          { kind: "home", path: mocks.homeCapturesRoot }
        ],
  getLegacyCapturesRoot: () => mocks.legacyCapturesRoot
}));

let tempRoot: string;

beforeEach(async () => {
  vi.resetModules();
  tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-storage-accounting-"));
  mocks.captureCount = 0;
  mocks.sourceBytes = 0;
  mocks.dataRoot = join(tempRoot, "data");
  mocks.capturesRoot = join(tempRoot, "Documents", "PwrSnap");
  mocks.homeCapturesRoot = join(tempRoot, "PwrSnap");
  mocks.legacyCapturesRoot = join(mocks.dataRoot, "captures");
  mocks.dbPath = join(mocks.dataRoot, "pwrsnap.db");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("getStorageSnapshot", () => {
  test("adds user-visible documents captures to the app-support total in default layout", async () => {
    mocks.captureCount = 1;
    mocks.sourceBytes = 1024 * 1024;
    await mkdir(mocks.dataRoot, { recursive: true });
    await mkdir(mocks.capturesRoot, { recursive: true });
    await writeFile(join(mocks.dataRoot, "pwrsnap.db"), Buffer.alloc(256 * 1024));
    await writeFile(join(mocks.capturesRoot, "capture-a.png"), Buffer.alloc(1024 * 1024));

    const { getStorageSnapshot } = await import("../accounting");
    const snapshot = await getStorageSnapshot();

    expect(snapshot.sourceCaptures.captureCount).toBe(1);
    // >= not >: the bucket holds the 1 MiB file's bytes. macOS reports
    // block-allocated size (rounds up) via stat.blocks; Windows leaves blocks
    // unset, so the walk falls back to logical size — exactly 1 MiB. Both count
    // the file; the strict `>` only held by relying on macOS allocation slack.
    expect(snapshot.sourceCaptures.documentsBytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(snapshot.totalBytes).toBeGreaterThan(snapshot.sourceCaptures.documentsBytes);
    expect(snapshot.otherAppSupport.bytes).toBeLessThan(128 * 1024);
  });

  test("does not double-count captures when the active captures root is inside dataRoot", async () => {
    mocks.capturesRoot = join(mocks.dataRoot, "captures");
    mocks.legacyCapturesRoot = mocks.capturesRoot;
    mocks.captureCount = 1;
    mocks.sourceBytes = 1024 * 1024;
    await mkdir(mocks.capturesRoot, { recursive: true });
    await writeFile(join(mocks.capturesRoot, "capture-a.png"), Buffer.alloc(1024 * 1024));

    const { getStorageSnapshot } = await import("../accounting");
    const snapshot = await getStorageSnapshot();

    expect(snapshot.sourceCaptures.captureCount).toBe(1);
    expect(snapshot.sourceCaptures.bytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(snapshot.totalBytes).toBeLessThan(snapshot.sourceCaptures.bytes + 128 * 1024);
    expect(snapshot.otherAppSupport.bytes).toBeLessThan(128 * 1024);
  });

  test("accounts for durable captures in both Documents and the home fallback", async () => {
    mocks.captureCount = 2;
    mocks.sourceBytes = 3 * 1024 * 1024;
    await mkdir(mocks.capturesRoot, { recursive: true });
    await mkdir(mocks.homeCapturesRoot, { recursive: true });
    await writeFile(
      join(mocks.capturesRoot, "capture-a.pwrsnap"),
      Buffer.alloc(1024 * 1024)
    );
    await writeFile(
      join(mocks.homeCapturesRoot, "capture-b.pwrsnap"),
      Buffer.alloc(2 * 1024 * 1024)
    );

    const { getStorageSnapshot } = await import("../accounting");
    const snapshot = await getStorageSnapshot({ force: true });

    expect(snapshot.sourceCaptures.documentsBytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(snapshot.sourceCaptures.homeBytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(snapshot.sourceCaptures.bytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect(snapshot.sourceCaptures.fileCount).toBe(2);
  });

  test("force requests during an in-flight scan share one trailing rescan", async () => {
    mocks.captureCount = 1;
    mocks.sourceBytes = 512 * 1024;
    await mkdir(mocks.dataRoot, { recursive: true });
    await mkdir(mocks.capturesRoot, { recursive: true });
    await writeFile(join(mocks.capturesRoot, "capture-a.png"), Buffer.alloc(512 * 1024));

    const updates: Array<{ scanning: boolean }> = [];
    const { getStorageSnapshot, onStorageSnapshotUpdated } = await import("../accounting");
    const unsubscribe = onStorageSnapshotUpdated((update) => {
      updates.push({ scanning: update.scanning });
    });

    try {
      // A force request whose scan is already running gets a trailing
      // rescan (its scan must START at-or-after the request), but every
      // force caller arriving during the same scan shares ONE queued
      // rescan — N callers collapse to exactly 2 scans, no storms.
      const first = getStorageSnapshot({ force: true });
      const second = getStorageSnapshot({ force: true });
      const third = getStorageSnapshot({ force: true });
      const [firstSnapshot, secondSnapshot, thirdSnapshot] = await Promise.all([
        first,
        second,
        third
      ]);

      expect(secondSnapshot).toBe(thirdSnapshot);
      expect(firstSnapshot).not.toBe(secondSnapshot);
      expect(updates.filter((update) => !update.scanning)).toHaveLength(2);
      expect(updates.some((update) => update.scanning)).toBe(true);
      expect(updates.at(-1)).toEqual({ scanning: false });
    } finally {
      unsubscribe();
    }
  });

  test("a force request issued mid-scan sees files written after the first scan started", async () => {
    await mkdir(mocks.dataRoot, { recursive: true });

    // Wedge the first scan open on its Chromium getCacheSize task so
    // the spec can deterministically land a filesystem write while the
    // scan is in flight — the exact shape of the storage-popover bug
    // (reopen forces a refresh, but a scan begun pre-seed is still
    // running and used to satisfy the force caller with stale sizes).
    const { session } = await import("electron");
    let releaseCacheSize: () => void = () => undefined;
    const cacheSizeGate = new Promise<void>((resolve) => {
      releaseCacheSize = resolve;
    });
    vi.mocked(session.defaultSession.getCacheSize).mockImplementationOnce(async () => {
      await cacheSizeGate;
      return 0;
    });

    const { getStorageSnapshot } = await import("../accounting");
    const first = getStorageSnapshot({ force: true });

    const renderDir = join(mocks.dataRoot, "render-cache", "capture-a");
    await mkdir(renderDir, { recursive: true });
    await writeFile(join(renderDir, "rebuilt.webp"), Buffer.alloc(1024 * 1024));

    const second = getStorageSnapshot({ force: true });
    releaseCacheSize();
    const [, secondSnapshot] = await Promise.all([first, second]);

    expect(secondSnapshot.renderCache.bytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(secondSnapshot.renderCache.fileCount).toBe(1);
  });

  test("normal snapshots use Chromium cache API instead of crawling Chromium cache dirs", async () => {
    await mkdir(join(mocks.dataRoot, "Cache"), { recursive: true });
    await writeFile(join(mocks.dataRoot, "Cache", "chromium-cache.bin"), Buffer.alloc(1024 * 1024));

    const { getStorageSnapshot } = await import("../accounting");
    const normal = await getStorageSnapshot({ force: true });
    const audit = await getStorageSnapshot({ force: true, audit: true });

    expect(normal.chromiumHttpCache.bytes).toBe(0);
    expect(normal.totalBytes).toBeLessThan(128 * 1024);
    expect(audit.chromiumHttpCache.bytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(audit.totalBytes).toBeGreaterThanOrEqual(1024 * 1024);
  });

  test("audit requests do not join an in-flight normal scan", async () => {
    await mkdir(join(mocks.dataRoot, "Cache"), { recursive: true });
    await writeFile(join(mocks.dataRoot, "Cache", "chromium-cache.bin"), Buffer.alloc(1024 * 1024));

    const { getStorageSnapshot, onStorageSnapshotUpdated } = await import("../accounting");
    let auditRequested = false;
    let auditPromise: Promise<StorageSnapshot> | undefined;
    const unsubscribe = onStorageSnapshotUpdated((update) => {
      if (update.scanning && !auditRequested) {
        auditRequested = true;
        auditPromise = getStorageSnapshot({ force: true, audit: true });
      }
    });

    try {
      const normal = await getStorageSnapshot({ force: true });
      if (auditPromise === undefined) throw new Error("audit scan was not requested");
      const audit = await auditPromise;

      expect(normal.chromiumHttpCache.bytes).toBe(0);
      expect(audit.chromiumHttpCache.bytes).toBeGreaterThanOrEqual(1024 * 1024);
    } finally {
      unsubscribe();
    }
  });
});
