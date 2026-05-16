import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataRoot: "",
  capturesRoot: "",
  legacyCapturesRoot: "",
  dbPath: "",
  captureCount: 0
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
  mocks.dataRoot = join(tempRoot, "data");
  mocks.capturesRoot = join(tempRoot, "Documents", "PwrSnap");
  mocks.legacyCapturesRoot = join(mocks.dataRoot, "captures");
  mocks.dbPath = join(mocks.dataRoot, "pwrsnap.db");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("getStorageSnapshot", () => {
  test("does not double-count captures when the active captures root is inside dataRoot", async () => {
    mocks.capturesRoot = join(mocks.dataRoot, "captures");
    mocks.legacyCapturesRoot = mocks.capturesRoot;
    mocks.captureCount = 1;
    await mkdir(mocks.capturesRoot, { recursive: true });
    await writeFile(join(mocks.capturesRoot, "capture-a.png"), Buffer.alloc(1024 * 1024));

    const { getStorageSnapshot } = await import("../accounting");
    const snapshot = await getStorageSnapshot();

    expect(snapshot.sourceCaptures.captureCount).toBe(1);
    expect(snapshot.sourceCaptures.bytes).toBeGreaterThan(1024 * 1024);
    expect(snapshot.totalBytes).toBeLessThan(snapshot.sourceCaptures.bytes + 128 * 1024);
    expect(snapshot.otherAppSupport.bytes).toBeLessThan(128 * 1024);
  });
});
