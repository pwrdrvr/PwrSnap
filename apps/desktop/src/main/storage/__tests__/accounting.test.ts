import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StorageSnapshot } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  dataRoot: "",
  capturesRoot: "",
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
  getCapturesRoot: () => mocks.capturesRoot,
  getDataRoot: () => mocks.dataRoot,
  getDbPath: () => mocks.dbPath,
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
    expect(snapshot.sourceCaptures.documentsBytes).toBeGreaterThan(1024 * 1024);
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
    expect(snapshot.sourceCaptures.bytes).toBeGreaterThan(1024 * 1024);
    expect(snapshot.totalBytes).toBeLessThan(snapshot.sourceCaptures.bytes + 128 * 1024);
    expect(snapshot.otherAppSupport.bytes).toBeLessThan(128 * 1024);
  });

  test("coalesces concurrent full storage scans and publishes progress", async () => {
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
      const first = getStorageSnapshot({ force: true });
      const second = getStorageSnapshot({ force: true });
      const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

      expect(firstSnapshot).toBe(secondSnapshot);
      expect(updates.some((update) => update.scanning)).toBe(true);
      expect(updates.at(-1)).toEqual({ scanning: false });
    } finally {
      unsubscribe();
    }
  });

  test("normal snapshots use Chromium cache API instead of crawling Chromium cache dirs", async () => {
    await mkdir(join(mocks.dataRoot, "Cache"), { recursive: true });
    await writeFile(join(mocks.dataRoot, "Cache", "chromium-cache.bin"), Buffer.alloc(1024 * 1024));

    const { getStorageSnapshot } = await import("../accounting");
    const normal = await getStorageSnapshot({ force: true });
    const audit = await getStorageSnapshot({ force: true, audit: true });

    expect(normal.chromiumHttpCache.bytes).toBe(0);
    expect(normal.totalBytes).toBeLessThan(128 * 1024);
    expect(audit.chromiumHttpCache.bytes).toBeGreaterThan(1024 * 1024);
    expect(audit.totalBytes).toBeGreaterThan(1024 * 1024);
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
      expect(audit.chromiumHttpCache.bytes).toBeGreaterThan(1024 * 1024);
    } finally {
      unsubscribe();
    }
  });
});
