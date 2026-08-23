import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const migrationsDir = fileURLToPath(new URL("../persistence/migrations", import.meta.url));

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

describe("database migrations", () => {
  test("use unique numeric versions", () => {
    const versions = migrationFiles().map((name) => name.slice(0, 4));
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("apply cleanly in filename order on a fresh database", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      for (const file of migrationFiles()) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      }
    } finally {
      db.close();
    }
  });

  test("avoid AUTOINCREMENT tables that create sqlite_sequence churn", () => {
    for (const file of migrationFiles()) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      expect(sql.toUpperCase(), file).not.toContain("AUTOINCREMENT");
    }
  });

  test("ai enrichment migration tolerates dev databases that already have old AI tables", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      for (const file of migrationFiles()) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      }

      db.exec(readFileSync(join(migrationsDir, "0006_ai_enrichment.sql"), "utf8"));
    } finally {
      db.close();
    }
  });

  test("0029 preserves existing capture and search data while adding a nullable window title", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      for (const file of migrationFiles().filter((name) => Number(name.slice(0, 4)) <= 28)) {
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        const needsFkOff = sql.startsWith("-- @no-foreign-keys");
        if (needsFkOff) db.pragma("foreign_keys = OFF");
        try {
          db.exec(sql);
        } finally {
          if (needsFkOff) db.pragma("foreign_keys = ON");
        }
      }

      db.prepare(
        `INSERT INTO captures (
           id, kind, captured_at, source_app_bundle_id, source_app_name,
           legacy_src_path, width_px, height_px, device_pixel_ratio,
           byte_size, sha256, edits_version, deleted_at, has_alpha
         ) VALUES (
           'upgrade-window-title', 'image', '2026-08-23T12:00:00.000Z',
           'com.example.Editor', 'Editor', '/tmp/existing.png',
           800, 600, 2, 4096, 'existing-sha', 0, NULL, 1
         )`
      ).run();
      db.prepare(
        `INSERT INTO capture_enrichments (
           capture_id, latest_ai_run_id, ocr_text,
           suggested_title, accepted_title, title_accepted_at,
           suggested_description, accepted_description, description_accepted_at
         ) VALUES (
           'upgrade-window-title', NULL, 'release checklist',
           'Existing title', 'Existing title', '2026-08-23T12:01:00.000Z',
           'Existing description', 'Existing description', '2026-08-23T12:01:00.000Z'
         )`
      ).run();
      db.prepare(
        `INSERT INTO tags (id, label, normalized_label, kind)
         VALUES ('upgrade-tag', 'Release blocker', 'release blocker', 'content')`
      ).run();
      db.prepare(
        `INSERT INTO capture_tags (capture_id, tag_id, source, ai_run_id)
         VALUES ('upgrade-window-title', 'upgrade-tag', 'user', NULL)`
      ).run();

      db.exec(
        readFileSync(join(migrationsDir, "0029_capture_source_window_title.sql"), "utf8")
      );

      expect(
        db.prepare(
          `SELECT id, source_app_bundle_id, source_app_name, source_window_title,
                  sha256, has_alpha
             FROM captures WHERE id = 'upgrade-window-title'`
        ).get()
      ).toEqual({
        id: "upgrade-window-title",
        source_app_bundle_id: "com.example.Editor",
        source_app_name: "Editor",
        source_window_title: null,
        sha256: "existing-sha",
        has_alpha: 1
      });
      expect(
        db.prepare(
          `SELECT title, description, ocr_text, source_app_name,
                  source_window_title, accepted_tags
             FROM capture_search_fts WHERE capture_id = 'upgrade-window-title'`
        ).get()
      ).toEqual({
        title: "Existing title",
        description: "Existing description",
        ocr_text: "release checklist",
        source_app_name: "Editor",
        source_window_title: null,
        accepted_tags: "Release blocker"
      });
    } finally {
      db.close();
    }
  });
});

// The `migrations: "verify"` open path (two-process split §D6): the
// library process never migrates — it computes the pending set and
// fails closed when the agent hasn't migrated yet.
describe("pendingMigrationFiles", () => {
  test("fresh database (nothing applied) reports every migration pending, sorted", async () => {
    const { pendingMigrationFiles } = await import("../persistence/migration-pending");
    const files = migrationFiles();
    expect(pendingMigrationFiles([...files].reverse(), new Set())).toEqual(files);
  });

  test("fully-applied database reports nothing pending", async () => {
    const { pendingMigrationFiles, migrationVersionOf } = await import(
      "../persistence/migration-pending"
    );
    const files = migrationFiles();
    const applied = new Set(files.map((f) => migrationVersionOf(f)!));
    expect(pendingMigrationFiles(files, applied)).toEqual([]);
  });

  test("reports only the gap when the agent is ahead of the library's last run", async () => {
    const { pendingMigrationFiles, migrationVersionOf } = await import(
      "../persistence/migration-pending"
    );
    const files = migrationFiles();
    const allButLast = new Set(files.slice(0, -1).map((f) => migrationVersionOf(f)!));
    expect(pendingMigrationFiles(files, allButLast)).toEqual(files.slice(-1));
  });

  test("ignores non-migration files", async () => {
    const { pendingMigrationFiles } = await import("../persistence/migration-pending");
    expect(
      pendingMigrationFiles(["README.md", "0001_init.sql.bak", "notes.txt"], new Set())
    ).toEqual([]);
  });
});
