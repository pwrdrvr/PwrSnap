// Round-trip coverage for the `captures.has_alpha` column (migration
// 0025). The flag is the transparency signal the Library grid + editor
// read to decide whether to paint the checker, so the insert → row →
// CaptureRecord mapping must survive: a boolean in, the same boolean out,
// stored as 0/1, defaulted to 0 when the caller omits it (legacy-data
// path, older callers). The sharp `stats().isOpaque` computation that
// FEEDS this lives in bundle-store and is exercised at the persist level;
// here we pin the column plumbing in isolation.

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

const baseInput = {
  kind: "image" as const,
  captured_at: "2026-06-27T10:00:00.000Z",
  source_app_bundle_id: null,
  source_app_name: null,
  legacy_src_path: null,
  bundle_path: "/tmp/has-alpha.pwrsnap",
  bundle_modified_at: "2026-06-27T10:00:00.000Z",
  bundle_format_version: 2,
  bundle_edits_version: 0,
  width_px: 800,
  height_px: 600,
  device_pixel_ratio: 2,
  byte_size: 1024,
  sha256: "c".repeat(64)
};

beforeEach(() => {
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(() => {
  mocks.db?.close();
  mocks.db = null;
});

describe("captures-repo has_alpha", () => {
  test("has_alpha: true round-trips as boolean true and stores 1", async () => {
    const { insertCapture, getCaptureById } = await import("../captures-repo");
    const { record } = insertCapture({ ...baseInput, id: "alpha-on", has_alpha: true });
    expect(record.has_alpha).toBe(true);
    expect(getCaptureById("alpha-on")?.has_alpha).toBe(true);

    const raw = mocks.db!
      .prepare("SELECT has_alpha FROM captures WHERE id = ?")
      .get("alpha-on") as { has_alpha: number };
    expect(raw.has_alpha).toBe(1);
  });

  test("has_alpha: false round-trips as boolean false and stores 0", async () => {
    const { insertCapture, getCaptureById } = await import("../captures-repo");
    const { record } = insertCapture({ ...baseInput, id: "alpha-off", has_alpha: false });
    expect(record.has_alpha).toBe(false);
    expect(getCaptureById("alpha-off")?.has_alpha).toBe(false);

    const raw = mocks.db!
      .prepare("SELECT has_alpha FROM captures WHERE id = ?")
      .get("alpha-off") as { has_alpha: number };
    expect(raw.has_alpha).toBe(0);
  });

  test("omitting has_alpha defaults to opaque (false / 0)", async () => {
    const { insertCapture, getCaptureById } = await import("../captures-repo");
    const { record } = insertCapture({ ...baseInput, id: "alpha-default" });
    expect(record.has_alpha).toBe(false);
    expect(getCaptureById("alpha-default")?.has_alpha).toBe(false);

    const raw = mocks.db!
      .prepare("SELECT has_alpha FROM captures WHERE id = ?")
      .get("alpha-default") as { has_alpha: number };
    expect(raw.has_alpha).toBe(0);
  });
});
