import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

const {
  renameVideoSourceToEffectiveFilename,
  runVideoFilenameMaintenanceOnBoot
} = await import("../video-filename-maintenance");

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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function insertVideoCapture(args: {
  id: string;
  sourcePath: string;
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
        @id, 'video', '2026-05-29T18:38:12.000Z',
        NULL, @sourceAppName,
        @sourcePath, NULL, NULL, NULL,
        1, 0,
        1920, 1080, 1, 1024,
        @sha256, 0, NULL
      )`
    )
    .run(args);
}

function insertImageCapture(args: {
  id: string;
  sourcePath: string;
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
        @id, 'image', '2026-05-29T18:38:12.000Z',
        NULL, @sourceAppName,
        @sourcePath, NULL, NULL, NULL,
        1, 0,
        100, 80, 2, 1024,
        @sha256, 0, NULL
      )`
    )
    .run(args);
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

beforeEach(async () => {
  mocks.filenameTimestampZone = "utc";
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-video-filenames-"));
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(async () => {
  mocks.db?.close();
  mocks.db = null;
  await rm(workDir, { recursive: true, force: true });
});

describe("video filename maintenance", () => {
  test("renames random video files using suggested filename when no override exists", async () => {
    const captureId = "vid_random_name";
    const oldPath = join(workDir, "nanoid-trash.mp4");
    const bytes = Buffer.from("fake-video-source");
    await writeFile(oldPath, bytes);
    insertVideoCapture({
      id: captureId,
      sourcePath: oldPath,
      sourceAppName: "Safari",
      sha256: sha256(bytes)
    });
    insertEnrichment({
      captureId,
      suggested: "checkout-flow",
      accepted: null
    });

    await expect(renameVideoSourceToEffectiveFilename(captureId)).resolves.toBe("renamed");

    const expected = join(
      workDir,
      `2026-05-29T18-38-12_safari_checkout-flow_${sha256(bytes).slice(0, 8)}.mp4`
    );
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(expected)).toBe(true);
    const row = mocks.db!
      .prepare("SELECT legacy_src_path FROM captures WHERE id = ?")
      .get(captureId) as { legacy_src_path: string };
    expect(row.legacy_src_path).toBe(expected);
  });

  test("uses source app before AI filename arrives", async () => {
    const captureId = "vid_initial_name";
    const oldPath = join(workDir, "nanoid-trash.mov");
    const bytes = Buffer.from("fake-mov-source");
    await writeFile(oldPath, bytes);
    insertVideoCapture({
      id: captureId,
      sourcePath: oldPath,
      sourceAppName: "QuickTime Player",
      sha256: sha256(bytes)
    });

    await expect(renameVideoSourceToEffectiveFilename(captureId)).resolves.toBe("renamed");

    const expected = join(
      workDir,
      `2026-05-29T18-38-12_quicktime-player_${sha256(bytes).slice(0, 8)}.mov`
    );
    expect(existsSync(expected)).toBe(true);
  });

  test("does not hash videos that already use the expected filename", async () => {
    const captureId = "vid_already_named";
    const bytes = Buffer.from("fake-already-named-video");
    const storedSha = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const currentPath = join(
      workDir,
      `2026-05-29T18-38-12_safari_demo_${storedSha.slice(0, 8)}.mp4`
    );
    await writeFile(currentPath, bytes);
    insertVideoCapture({
      id: captureId,
      sourcePath: currentPath,
      sourceAppName: "Safari",
      sha256: storedSha
    });
    insertEnrichment({
      captureId,
      suggested: "demo",
      accepted: null
    });

    await expect(renameVideoSourceToEffectiveFilename(captureId)).resolves.toBe("skipped");
    expect(existsSync(currentPath)).toBe(true);
  });

  test("repairs a stale DB path by matching source sha256", async () => {
    const captureId = "vid_repair";
    const bytes = Buffer.from("fake-video-repair");
    const actualPath = join(
      workDir,
      `2026-05-29T18-38-12_terminal_demo_${sha256(bytes).slice(0, 8)}.mp4`
    );
    await writeFile(actualPath, bytes);
    insertVideoCapture({
      id: captureId,
      sourcePath: join(workDir, "missing-random.mp4"),
      sourceAppName: "Terminal",
      sha256: sha256(bytes)
    });
    insertEnrichment({
      captureId,
      suggested: "demo",
      accepted: null
    });

    const result = await runVideoFilenameMaintenanceOnBoot();
    expect(result.repaired).toBe(1);
    const row = mocks.db!
      .prepare("SELECT legacy_src_path FROM captures WHERE id = ?")
      .get(captureId) as { legacy_src_path: string };
    expect(row.legacy_src_path).toBe(actualPath);
  });

  test("skips image legacy source files", async () => {
    const captureId = "img_legacy";
    const oldPath = join(workDir, "legacy-random.png");
    const bytes = Buffer.from("fake-png-source");
    await writeFile(oldPath, bytes);
    insertImageCapture({
      id: captureId,
      sourcePath: oldPath,
      sourceAppName: "Preview",
      sha256: sha256(bytes)
    });
    insertEnrichment({
      captureId,
      suggested: "annotated",
      accepted: null
    });

    await expect(renameVideoSourceToEffectiveFilename(captureId)).resolves.toBe("skipped");
    const result = await runVideoFilenameMaintenanceOnBoot();
    expect(result.attempted).toBe(0);
    expect(existsSync(oldPath)).toBe(true);
  });
});
