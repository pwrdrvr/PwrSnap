import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documentsRoot: "",
  homeRoot: "",
  cacheRoot: "",
  dbPath: ""
}));

vi.mock("../../command-bus", () => ({
  bus: {
    unregister: vi.fn(),
    register: vi.fn()
  }
}));

vi.mock("../../persistence/db", () => ({
  getDb: () => ({
    exec: (sql: string) => {
      const match = /^VACUUM INTO '(.+)'$/.exec(sql);
      if (match === null) throw new Error(`unexpected SQL: ${sql}`);
      writeFileSync(match[1]!.replace(/''/g, "'"), "snapshot-db");
    }
  })
}));

vi.mock("../../persistence/paths", () => ({
  getCacheRoot: () => mocks.cacheRoot,
  getDbPath: () => mocks.dbPath,
  getDurableCapturesRoots: () => [
    { kind: "documents", path: mocks.documentsRoot },
    { kind: "home", path: mocks.homeRoot }
  ]
}));

let tempRoot: string;

beforeEach(async () => {
  vi.resetModules();
  tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-export-roots-"));
  mocks.documentsRoot = join(tempRoot, "Documents", "PwrSnap");
  mocks.homeRoot = join(tempRoot, "PwrSnap");
  mocks.cacheRoot = join(tempRoot, "render-cache");
  mocks.dbPath = join(tempRoot, "pwrsnap.db");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("exportLibrary", () => {
  test("backs up both durable capture roots and records their layout", async () => {
    await mkdir(mocks.documentsRoot, { recursive: true });
    await mkdir(mocks.homeRoot, { recursive: true });
    await writeFile(join(mocks.documentsRoot, "documents.pwrsnap"), "documents");
    await writeFile(join(mocks.homeRoot, "home.pwrsnap"), "home");

    const destination = join(tempRoot, "backup");
    const { exportLibrary } = await import("../export-handler");
    const result = await exportLibrary(destination);

    expect(existsSync(join(destination, "captures", "documents.pwrsnap"))).toBe(true);
    expect(existsSync(join(destination, "captures-home", "home.pwrsnap"))).toBe(true);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      schema_version: number;
      capture_files: number;
      capture_roots: Array<{
        kind: string;
        backup_directory: string;
        files: number;
      }>;
    };
    expect(manifest.schema_version).toBe(2);
    expect(manifest.capture_files).toBe(2);
    expect(manifest.capture_roots).toEqual([
      {
        kind: "documents",
        source_path: mocks.documentsRoot,
        backup_directory: "captures",
        files: 1
      },
      {
        kind: "home",
        source_path: mocks.homeRoot,
        backup_directory: "captures-home",
        files: 1
      }
    ]);
  });
});
