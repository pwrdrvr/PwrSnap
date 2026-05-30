import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { BundleDocumentV2, BundleManifestV2 } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  filenameTimestampZone: "utc" as "local" | "utc"
}));

vi.mock("../db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) throw new Error("test db not initialized");
    return mocks.db;
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

vi.mock("../bundle-filename-settings", () => ({
  readBundleFilenameTimestampZone: async (): Promise<"local" | "utc"> =>
    mocks.filenameTimestampZone
}));

const { buildCaptureBundleFilenameStem } = await import("../bundle-filename");
const { packBundleV2, runExclusiveBundleFileOperation } = await import("../bundle-store");
const {
  expectedBundleStemForCapture,
  renameBundleToEffectiveFilename,
  runBundleFilenameMaintenanceOnBoot
} = await import("../bundle-filename-maintenance");

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

let workDir: string;

function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (sql.startsWith("-- @no-foreign-keys")) db.pragma("foreign_keys = OFF");
    try {
      db.exec(sql);
    } finally {
      if (sql.startsWith("-- @no-foreign-keys")) db.pragma("foreign_keys = ON");
    }
  }
}

function insertCapture(args: {
  id: string;
  kind?: "image" | "video";
  bundlePath: string;
  sourceAppName: string | null;
  sha256: string;
}): void {
  mocks.db!
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name,
        legacy_src_path, bundle_path, flat_png_path, bundle_modified_at,
        bundle_format_version, bundle_edits_version,
        width_px, height_px, device_pixel_ratio, byte_size,
        sha256, edits_version, deleted_at
      ) VALUES (
        @id, @kind, '2026-05-29T18:38:12.000Z',
        NULL, @sourceAppName,
        NULL, @bundlePath, NULL, '2026-05-29T18:38:12.000Z',
        2, 0,
        100, 80, 2, 1024,
        @sha256, 0, NULL
      )`
    )
    .run({ kind: "image", ...args });
}

function insertEnrichment(args: {
  captureId: string;
  suggested: string | null;
  accepted: string | null;
}): void {
  mocks.db!
    .prepare(
      `INSERT INTO capture_enrichments (
        capture_id, suggested_filename_stem, accepted_filename_stem, updated_at
      ) VALUES (
        @captureId, @suggested, @accepted, datetime('now')
      )`
    )
    .run(args);
}

async function writeBundleFixture(path: string, captureId: string): Promise<void> {
  const sourceSha = "a1b2c3d4".repeat(8);
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: captureId,
    canvas_dimensions: { width_px: 100, height_px: 80 },
    paired_png_filename: `${captureId}.png`,
    created_at: "2026-05-29T18:38:12.000Z",
    bundle_modified_at: "2026-05-29T18:38:12.000Z"
  };
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 0,
    layers: [],
    tags: [],
    description: null,
    ai_runs: []
  };
  const bytes = await packBundleV2({
    manifest,
    document,
    sources: new Map([[sourceSha, Buffer.from("fake-source")]]),
    layerBytes: new Map(),
    thumbnailJpg: Buffer.from("fake-thumb")
  });
  await writeFile(path, bytes);
}

beforeEach(async () => {
  mocks.filenameTimestampZone = "utc";
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-bundle-filenames-"));
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(async () => {
  mocks.db?.close();
  mocks.db = null;
  await rm(workDir, { recursive: true, force: true });
});

describe("bundle filename policy", () => {
  test("builds ISO-time source-app effective-stem short-hash filenames", () => {
    expect(
      buildCaptureBundleFilenameStem({
        capturedAt: "2026-05-29T18:38:12.345Z",
        sourceAppName: "Safari",
        effectiveFilenameStem: "Checkout Flow!",
        sha256: "a1b2c3d4".repeat(8),
        timestampZone: "utc"
      })
    ).toBe("2026-05-29T18-38-12_safari_checkout-flow_a1b2c3d4");
  });

  test("formats local-time prefixes when requested", () => {
    const capturedAt = "2026-05-29T18:38:12.345Z";
    const date = new Date(capturedAt);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const expectedLocalPrefix = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    expect(
      buildCaptureBundleFilenameStem({
        capturedAt,
        sourceAppName: "Safari",
        effectiveFilenameStem: "Checkout Flow!",
        sha256: "a1b2c3d4".repeat(8),
        timestampZone: "local"
      })
    ).toBe(`${expectedLocalPrefix}_safari_checkout-flow_a1b2c3d4`);
  });
});

describe("bundle filename maintenance", () => {
  test("renames random bundle files using suggested filename when no override exists", async () => {
    const captureId = "cap_random_name";
    const oldPath = join(workDir, "nanoid-trash.pwrsnap");
    await writeBundleFixture(oldPath, captureId);
    insertCapture({
      id: captureId,
      bundlePath: oldPath,
      sourceAppName: "Safari",
      sha256: "a1b2c3d4".repeat(8)
    });
    insertEnrichment({
      captureId,
      suggested: "checkout-flow",
      accepted: null
    });

    await expect(renameBundleToEffectiveFilename(captureId)).resolves.toBe("renamed");
    const expected = join(
      workDir,
      "2026-05-29T18-38-12_safari_checkout-flow_a1b2c3d4.pwrsnap"
    );
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(expected)).toBe(true);
    const row = mocks.db!
      .prepare("SELECT bundle_path FROM captures WHERE id = ?")
      .get(captureId) as { bundle_path: string };
    expect(row.bundle_path).toBe(expected);
  });

  test("accepted filename overrides the suggested filename", async () => {
    const captureId = "cap_override";
    const oldPath = join(workDir, "nanoid-trash.pwrsnap");
    await writeBundleFixture(oldPath, captureId);
    insertCapture({
      id: captureId,
      bundlePath: oldPath,
      sourceAppName: "Terminal",
      sha256: "deadbeef".repeat(8)
    });
    insertEnrichment({
      captureId,
      suggested: "codex-draft",
      accepted: "user-override"
    });

    await renameBundleToEffectiveFilename(captureId);
    expect(expectedBundleStemForCapture(captureId, "utc")).toBe(
      "2026-05-29T18-38-12_terminal_user-override_deadbeef"
    );
    expect(
      existsSync(join(workDir, "2026-05-29T18-38-12_terminal_user-override_deadbeef.pwrsnap"))
    ).toBe(true);
  });

  test("waits for in-flight bundle file operations before renaming", async () => {
    const captureId = "cap_repack_race";
    const oldPath = join(workDir, "nanoid-trash.pwrsnap");
    await writeBundleFixture(oldPath, captureId);
    insertCapture({
      id: captureId,
      bundlePath: oldPath,
      sourceAppName: "Safari",
      sha256: "a1b2c3d4".repeat(8)
    });
    insertEnrichment({
      captureId,
      suggested: "checkout-flow",
      accepted: null
    });

    let releaseOperation!: () => void;
    const operationReleased = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const inFlightOperation = runExclusiveBundleFileOperation(captureId, async () => {
      await operationReleased;
    });

    const renamePromise = renameBundleToEffectiveFilename(captureId);
    let renameSettled = false;
    void renamePromise.then(() => {
      renameSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renameSettled).toBe(false);
    expect(existsSync(oldPath)).toBe(true);
    expect(
      (
        mocks.db!
          .prepare("SELECT bundle_path FROM captures WHERE id = ?")
          .get(captureId) as { bundle_path: string }
      ).bundle_path
    ).toBe(oldPath);

    releaseOperation();
    await inFlightOperation;
    await expect(renamePromise).resolves.toBe("renamed");

    const expected = join(
      workDir,
      "2026-05-29T18-38-12_safari_checkout-flow_a1b2c3d4.pwrsnap"
    );
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(expected)).toBe(true);
    expect(
      (
        mocks.db!
          .prepare("SELECT bundle_path FROM captures WHERE id = ?")
          .get(captureId) as { bundle_path: string }
      ).bundle_path
    ).toBe(expected);
  });

  test("repairs a stale DB path when the bundle already has the expected name", async () => {
    const captureId = "cap_repair";
    const actualPath = join(
      workDir,
      "2026-05-29T18-38-12_finder_capture-list_abcdef12.pwrsnap"
    );
    await writeBundleFixture(actualPath, captureId);
    insertCapture({
      id: captureId,
      bundlePath: join(workDir, "missing-random.pwrsnap"),
      sourceAppName: "Finder",
      sha256: "abcdef12".repeat(8)
    });
    insertEnrichment({
      captureId,
      suggested: "capture-list",
      accepted: null
    });

    const result = await runBundleFilenameMaintenanceOnBoot();
    expect(result.repaired).toBe(1);
    const row = mocks.db!
      .prepare("SELECT bundle_path FROM captures WHERE id = ?")
      .get(captureId) as { bundle_path: string };
    expect(row.bundle_path).toBe(actualPath);
  });

  test("skips video captures even if a bundle path is present", async () => {
    const captureId = "vid_with_bundle_path";
    const oldPath = join(workDir, "video-legacy-name.pwrsnap");
    await writeBundleFixture(oldPath, captureId);
    insertCapture({
      id: captureId,
      kind: "video",
      bundlePath: oldPath,
      sourceAppName: "QuickTime Player",
      sha256: "facefeed".repeat(8)
    });
    insertEnrichment({
      captureId,
      suggested: "demo-recording",
      accepted: null
    });

    await expect(renameBundleToEffectiveFilename(captureId)).resolves.toBe("skipped");
    const result = await runBundleFilenameMaintenanceOnBoot();
    expect(result.attempted).toBe(0);
    expect(existsSync(oldPath)).toBe(true);

    const row = mocks.db!
      .prepare("SELECT bundle_path FROM captures WHERE id = ?")
      .get(captureId) as { bundle_path: string };
    expect(row.bundle_path).toBe(oldPath);
  });
});
