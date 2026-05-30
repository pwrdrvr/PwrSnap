// Regression test for the "New from Clipboard re-opens source"
// bug: pasting the same image bytes twice MUST produce two distinct
// captures. The captures.sha256 column was UNIQUE through migration
// 0007 and dedup'd on insert; migration 0021 drops the constraint and
// `insertCapture` no longer collapses identical-bytes inserts.
//
// Real-world scenario: a user copies a v2 capture with no visible
// overlays to the clipboard at MED preset, then "New from Clipboard"
// to start an edit fork. Round-tripping bake → toPNG → clipboard →
// paste produces byte-identical bytes (same sha256); under the old
// dedup, the paste silently returned the source capture. Pasting the
// same image five times to edit each differently is a valid workflow.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null
}));

vi.mock("../db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) {
      throw new Error("test db not initialized");
    }
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

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const needsFkOff = sql.startsWith("-- @no-foreign-keys");
    if (needsFkOff) db.pragma("foreign_keys = OFF");
    try {
      db.exec(sql);
    } finally {
      if (needsFkOff) db.pragma("foreign_keys = ON");
    }
  }
}

beforeEach(() => {
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(() => {
  mocks.db?.close();
  mocks.db = null;
});

describe("captures-repo no-dedup", () => {
  test("two inserts with the same sha256 yield two distinct captures", async () => {
    const { insertCapture } = await import("../captures-repo");
    const sharedSha = "a".repeat(64);

    const first = insertCapture({
      id: "first-capture-id",
      kind: "image",
      captured_at: "2026-05-27T10:00:00.000Z",
      source_app_bundle_id: null,
      source_app_name: null,
      legacy_src_path: null,
      bundle_path: "/tmp/first.pwrsnap",
      bundle_modified_at: "2026-05-27T10:00:00.000Z",
      bundle_format_version: 2,
      bundle_edits_version: 0,
      width_px: 1440,
      height_px: 900,
      device_pixel_ratio: 2,
      byte_size: 1024,
      sha256: sharedSha
    });

    const second = insertCapture({
      id: "second-capture-id",
      kind: "image",
      captured_at: "2026-05-27T10:00:01.000Z",
      source_app_bundle_id: null,
      source_app_name: null,
      legacy_src_path: null,
      bundle_path: "/tmp/second.pwrsnap",
      bundle_modified_at: "2026-05-27T10:00:01.000Z",
      bundle_format_version: 2,
      bundle_edits_version: 0,
      width_px: 1440,
      height_px: 900,
      device_pixel_ratio: 2,
      byte_size: 1024,
      sha256: sharedSha
    });

    expect(first.record.id).toBe("first-capture-id");
    expect(second.record.id).toBe("second-capture-id");
    expect(first.record.id).not.toBe(second.record.id);

    // Both rows persist; the second insert didn't return the first.
    const rows = mocks.db!
      .prepare(
        "SELECT id FROM captures WHERE sha256 = ? ORDER BY captured_at"
      )
      .all(sharedSha) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([
      "first-capture-id",
      "second-capture-id"
    ]);
  });

  test("app_stats counts both rows (invariant intact after dedup removal)", async () => {
    const { insertCapture } = await import("../captures-repo");
    const sharedSha = "b".repeat(64);

    insertCapture({
      id: "stats-cap-1",
      kind: "image",
      captured_at: "2026-05-27T10:00:00.000Z",
      source_app_bundle_id: "com.app.test",
      source_app_name: "TestApp",
      legacy_src_path: null,
      bundle_path: "/tmp/stats-1.pwrsnap",
      bundle_modified_at: "2026-05-27T10:00:00.000Z",
      bundle_format_version: 2,
      bundle_edits_version: 0,
      width_px: 800,
      height_px: 600,
      device_pixel_ratio: 2,
      byte_size: 512,
      sha256: sharedSha
    });
    insertCapture({
      id: "stats-cap-2",
      kind: "image",
      captured_at: "2026-05-27T10:00:01.000Z",
      source_app_bundle_id: "com.app.test",
      source_app_name: "TestApp",
      legacy_src_path: null,
      bundle_path: "/tmp/stats-2.pwrsnap",
      bundle_modified_at: "2026-05-27T10:00:01.000Z",
      bundle_format_version: 2,
      bundle_edits_version: 0,
      width_px: 800,
      height_px: 600,
      device_pixel_ratio: 2,
      byte_size: 512,
      sha256: sharedSha
    });

    const stat = mocks.db!
      .prepare(
        "SELECT count FROM app_stats WHERE COALESCE(source_app_bundle_id, '') = ?"
      )
      .get("com.app.test") as { count: number } | undefined;
    expect(stat?.count).toBe(2);

    const liveCount = mocks.db!
      .prepare("SELECT COUNT(*) AS n FROM captures WHERE deleted_at IS NULL")
      .get() as { n: number };
    expect(liveCount.n).toBe(2);
  });
});
