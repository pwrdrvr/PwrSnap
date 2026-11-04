import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documentsRoot: "",
  homeRoot: "",
  cacheRoot: "",
  dbPath: "",
  link: vi.fn(),
  copyFile: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  link: mocks.link,
  copyFile: mocks.copyFile
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
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  mocks.link.mockReset().mockImplementation(actual.link);
  mocks.copyFile.mockReset().mockImplementation(actual.copyFile);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("exportLibrary", () => {
  test("admits at most two file transfers and publishes the manifest only after all roots drain", async () => {
    await mkdir(join(mocks.documentsRoot, "nested"), { recursive: true });
    await mkdir(mocks.homeRoot, { recursive: true });
    await mkdir(mocks.cacheRoot, { recursive: true });
    for (const name of ["a", "b", "c", "d", "e"]) await writeFile(join(mocks.documentsRoot, name), name);
    await writeFile(join(mocks.documentsRoot, "nested", "f"), "f");
    await writeFile(join(mocks.homeRoot, "g"), "g");
    await writeFile(join(mocks.cacheRoot, "h"), "h");
    const destination = join(tempRoot, "backup");
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    let finished = 0;
    mocks.link.mockImplementation(async () => {
      expect(existsSync(join(destination, "pwrsnap.db"))).toBe(true);
      expect(existsSync(join(destination, "manifest.json"))).toBe(false);
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active--;
      finished++;
    });
    const { exportLibrary } = await import("../export-handler");
    const pending = exportLibrary(destination);
    try {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      expect(releases).toHaveLength(2);
      expect(active).toBe(2);
      // Complete one transfer, admitting just one replacement.
      releases[1]!();
      await vi.waitFor(() => expect(releases).toHaveLength(3));
      expect(active).toBe(2);
    } finally {
      mocks.link.mockResolvedValue(undefined);
      for (const release of releases) release();
      await pending;
    }
    const result = await pending;
    expect(peak).toBe(2);
    expect(finished).toBe(3);
    expect(mocks.link).toHaveBeenCalledTimes(8);
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      capture_files: 7, cache_files: 1
    });
  });

  test("a failed fallback stops admission, drains an active transfer, and invalidates a previous manifest", async () => {
    await mkdir(mocks.documentsRoot, { recursive: true });
    for (const name of ["a", "b", "c"]) await writeFile(join(mocks.documentsRoot, name), name);
    const destination = join(tempRoot, "backup");
    await mkdir(destination);
    await writeFile(join(destination, "manifest.json"), "previous completed backup");
    let failFirst!: (error: Error) => void;
    let finishSecond!: () => void;
    mocks.link.mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishSecond = resolve; }));
    mocks.copyFile.mockRejectedValue(new Error("copy permission denied"));
    const { exportLibrary } = await import("../export-handler");
    let settled = false;
    const outcome = exportLibrary(destination).catch((error: unknown) => error)
      .finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(mocks.link).toHaveBeenCalled());
      expect(mocks.link).toHaveBeenCalledTimes(2);
      failFirst(new Error("EXDEV"));
      await vi.waitFor(() => expect(mocks.copyFile).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(existsSync(join(destination, "manifest.json"))).toBe(false);
      finishSecond();
      expect((await outcome as Error).message).toBe("copy permission denied");
      expect(mocks.link).toHaveBeenCalledTimes(2);
    } finally {
      failFirst?.(new Error("cleanup"));
      finishSecond?.();
      await outcome;
    }
  });

  test("fallback copies preserve bytes and permissions, skip symlinks, and keep secrets out of the backup", async () => {
    await mkdir(join(mocks.documentsRoot, "nested"), { recursive: true });
    const source = join(mocks.documentsRoot, "nested", "capture.pwrsnap");
    await writeFile(source, "fixture-capture", { mode: 0o600 });
    await writeFile(join(tempRoot, "pwrsnap-secrets.bin"), "fixture-secret");
    if (process.platform !== "win32") await symlink(join(tempRoot, "pwrsnap-secrets.bin"), join(mocks.documentsRoot, "secret-link"));
    mocks.link.mockRejectedValue(new Error("EXDEV"));
    const { exportLibrary } = await import("../export-handler");
    const destination = join(tempRoot, "backup");
    const result = await exportLibrary(destination);
    const copy = join(destination, "captures", "nested", "capture.pwrsnap");
    expect(await readFile(copy, "utf8")).toBe("fixture-capture");
    if (process.platform !== "win32") expect((await stat(copy)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(destination, "pwrsnap-secrets.bin"))).toBe(false);
    expect(existsSync(join(destination, "captures", "secret-link"))).toBe(false);
    expect(mocks.copyFile).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.capture_files).toBe(1);
    expect(manifest.db_byte_size).toBe(11);
    expect(manifest.db_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a failed re-export removes the previous completion manifest", async () => {
    await mkdir(mocks.documentsRoot, { recursive: true });
    await writeFile(join(mocks.documentsRoot, "capture"), "fixture");
    const destination = join(tempRoot, "backup");
    await mkdir(destination);
    await writeFile(join(destination, "manifest.json"), "old manifest");
    mocks.link.mockRejectedValue(new Error("EXDEV"));
    mocks.copyFile.mockRejectedValue(new Error("disk full"));
    const { exportLibrary } = await import("../export-handler");
    await expect(exportLibrary(destination)).rejects.toThrow("disk full");
    expect(existsSync(join(destination, "manifest.json"))).toBe(false);
  });

  test("cancellation stops admission and drains active transfers before rejecting without a manifest", async () => {
    await mkdir(mocks.documentsRoot, { recursive: true });
    for (const name of ["a", "b", "c"]) await writeFile(join(mocks.documentsRoot, name), name);
    const releases: Array<() => void> = [];
    mocks.link.mockImplementation(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const abort = new AbortController();
    const destination = join(tempRoot, "backup");
    const { exportLibrary } = await import("../export-handler");
    let settled = false;
    const outcome = exportLibrary(destination, abort.signal).catch((error: unknown) => error)
      .finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      expect(releases).toHaveLength(2);
      abort.abort();
      releases[0]!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      releases[1]!();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(mocks.link).toHaveBeenCalledTimes(2);
      expect(existsSync(join(destination, "manifest.json"))).toBe(false);
    } finally {
      mocks.link.mockResolvedValue(undefined);
      for (const release of releases) release();
      await outcome;
    }
  });

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
