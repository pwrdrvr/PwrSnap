import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null
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
  captured_at: "2026-08-23T10:00:00.000Z",
  source_app_bundle_id: "com.example.Editor",
  source_app_name: "Editor",
  legacy_src_path: null,
  bundle_path: "/tmp/window-title.pwrsnap",
  bundle_modified_at: "2026-08-23T10:00:00.000Z",
  bundle_format_version: 2,
  bundle_edits_version: 0,
  width_px: 800,
  height_px: 600,
  device_pixel_ratio: 2,
  byte_size: 1024,
  sha256: "d".repeat(64)
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

describe("captures-repo source_window_title", () => {
  test("normalizes whitespace and controls while preserving Unicode", async () => {
    const { getCaptureById, insertCapture } = await import("../captures-repo");
    const sourceTitle = " \tRésumé 👩🏽‍💻 — 設計\u0000Draft\r\n ";
    const expected = "Résumé 👩🏽‍💻 — 設計 Draft";

    const { record } = insertCapture({
      ...baseInput,
      id: "unicode-title",
      source_window_title: sourceTitle
    });

    expect(record.source_window_title).toBe(expected);
    expect(getCaptureById("unicode-title")?.source_window_title).toBe(expected);
    expect(
      mocks.db!
        .prepare("SELECT source_window_title FROM captures WHERE id = ?")
        .get("unicode-title")
    ).toEqual({ source_window_title: expected });
  });

  test("bounds titles to 512 Unicode code points without splitting a surrogate pair", async () => {
    const {
      insertCapture,
      SOURCE_WINDOW_TITLE_MAX_CODE_POINTS
    } = await import("../captures-repo");
    const input = `${"😀".repeat(SOURCE_WINDOW_TITLE_MAX_CODE_POINTS - 1)}AB`;

    const { record } = insertCapture({
      ...baseInput,
      id: "bounded-title",
      source_window_title: input
    });

    expect([...(record.source_window_title ?? "")]).toHaveLength(
      SOURCE_WINDOW_TITLE_MAX_CODE_POINTS
    );
    expect(record.source_window_title?.endsWith("A")).toBe(true);
    expect(record.source_window_title?.endsWith("\ud83d")).toBe(false);
  });

  test("stores null for omitted, explicit-null, and control-only titles", async () => {
    const { insertCapture } = await import("../captures-repo");
    const omitted = insertCapture({ ...baseInput, id: "title-omitted" }).record;
    const explicitNull = insertCapture({
      ...baseInput,
      id: "title-null",
      source_window_title: null
    }).record;
    const controlOnly = insertCapture({
      ...baseInput,
      id: "title-controls",
      source_window_title: "\u0000\u001f\u007f\u0085\u009f \t\r\n"
    }).record;

    expect(omitted.source_window_title).toBeNull();
    expect(explicitNull.source_window_title).toBeNull();
    expect(controlOnly.source_window_title).toBeNull();
  });

  test("identical source bytes retain independent window titles", async () => {
    const { insertCapture } = await import("../captures-repo");
    const first = insertCapture({
      ...baseInput,
      id: "same-bytes-one",
      source_window_title: "First document"
    }).record;
    const second = insertCapture({
      ...baseInput,
      id: "same-bytes-two",
      source_window_title: "Second document"
    }).record;

    expect(first.id).not.toBe(second.id);
    expect(first.sha256).toBe(second.sha256);
    expect(first.source_window_title).toBe("First document");
    expect(second.source_window_title).toBe("Second document");
  });
});
