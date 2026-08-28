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

  test("0032 preserves existing capture and search data while adding a nullable window title", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      for (const file of migrationFiles().filter((name) => Number(name.slice(0, 4)) <= 30)) {
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
        readFileSync(join(migrationsDir, "0032_capture_source_window_title.sql"), "utf8")
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

  test("repairs databases that ran the pre-renumbered title migration as version 29", async () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      for (const file of migrationFiles().filter((name) => Number(name.slice(0, 4)) <= 28)) {
        const version = Number(file.slice(0, 4));
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        const needsFkOff = sql.startsWith("-- @no-foreign-keys");
        if (needsFkOff) db.pragma("foreign_keys = OFF");
        try {
          db.exec(sql);
          db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
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
           'pre-renumbered-title', 'image', '2026-08-27T12:00:00.000Z',
           'com.example.Editor', 'Editor', '/tmp/existing.png',
           800, 600, 2, 4096, 'pre-renumbered-sha', 0, NULL, 1
         )`
      ).run();

      // Recreate the exact persisted drift from the former branch head: the
      // title schema ran, but its migration row claimed version 29, displacing
      // main's import-recovery migration with the same number.
      db.exec(
        readFileSync(join(migrationsDir, "0032_capture_source_window_title.sql"), "utf8")
      );
      db.prepare("INSERT INTO schema_migrations(version) VALUES (29)").run();
      db.prepare(
        "UPDATE captures SET source_window_title = ? WHERE id = ?"
      ).run("Recovered title — 東京", "pre-renumbered-title");

      expect(
        db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capture_bundle_carriers'"
        ).get()
      ).toBeUndefined();

      const { runMigrations } = await import("../persistence/db");
      expect(() => runMigrations(db)).not.toThrow();

      expect(
        db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pwrsnap_import_intents'"
        ).get()
      ).toBeDefined();
      expect(
        db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capture_bundle_carriers'"
        ).get()
      ).toBeDefined();
      expect(
        (db.pragma("table_info(capture_bundle_carriers)") as Array<{ name: string }>).map(
          (column) => column.name
        )
      ).toContain("portable_metadata_json");
      expect(
        (db.pragma("table_info(captures)") as Array<{ name: string }>).filter(
          (column) => column.name === "source_window_title"
        )
      ).toHaveLength(1);
      expect(
        db.prepare(
          "SELECT source_window_title FROM captures WHERE id = 'pre-renumbered-title'"
        ).get()
      ).toEqual({ source_window_title: "Recovered title — 東京" });
      expect(
        db.prepare(
          "SELECT source_window_title FROM capture_search_fts WHERE capture_id = 'pre-renumbered-title'"
        ).get()
      ).toEqual({ source_window_title: "Recovered title — 東京" });
      expect(
        db.prepare(
          "SELECT version FROM schema_migrations WHERE version IN (29, 30, 31, 32) ORDER BY version"
        ).all()
      ).toEqual([{ version: 29 }, { version: 30 }, { version: 31 }, { version: 32 }]);
    } finally {
      db.close();
    }
  });

  test("repairs databases that ran the pre-renumbered title migration as version 31", async () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      for (const file of migrationFiles().filter((name) => Number(name.slice(0, 4)) <= 30)) {
        const version = Number(file.slice(0, 4));
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        const needsFkOff = sql.startsWith("-- @no-foreign-keys");
        if (needsFkOff) db.pragma("foreign_keys = OFF");
        try {
          db.exec(sql);
          db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
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
           'version-31-title', 'image', '2026-08-29T12:00:00.000Z',
           'com.example.Editor', 'Editor', '/tmp/existing.png',
           800, 600, 2, 4096, 'version-31-sha', 0, NULL, 1
         )`
      ).run();

      // Recreate the next persisted branch state: official 0029 and 0030 ran,
      // then the title schema claimed version 31 before main assigned that
      // number to the carrier repack-state columns.
      db.exec(
        readFileSync(join(migrationsDir, "0032_capture_source_window_title.sql"), "utf8")
      );
      db.prepare("INSERT INTO schema_migrations(version) VALUES (31)").run();
      db.prepare(
        "UPDATE captures SET source_window_title = ? WHERE id = ?"
      ).run("Changed during upgrade — 🚀", "version-31-title");

      expect(
        (db.pragma("table_info(capture_bundle_carriers)") as Array<{ name: string }>).map(
          (column) => column.name
        )
      ).not.toContain("full_tags_json");

      const { runMigrations } = await import("../persistence/db");
      expect(() => runMigrations(db)).not.toThrow();

      const carrierColumns = (
        db.pragma("table_info(capture_bundle_carriers)") as Array<{ name: string }>
      ).map((column) => column.name);
      expect(carrierColumns).toContain("full_tags_json");
      expect(carrierColumns).toContain("layer_order_json");
      expect(
        (db.pragma("table_info(captures)") as Array<{ name: string }>).filter(
          (column) => column.name === "source_window_title"
        )
      ).toHaveLength(1);
      expect(
        db.prepare(
          "SELECT source_window_title FROM captures WHERE id = 'version-31-title'"
        ).get()
      ).toEqual({ source_window_title: "Changed during upgrade — 🚀" });
      expect(
        db.prepare(
          "SELECT source_window_title FROM capture_search_fts WHERE capture_id = 'version-31-title'"
        ).get()
      ).toEqual({ source_window_title: "Changed during upgrade — 🚀" });
      expect(
        db.prepare(
          "SELECT version FROM schema_migrations WHERE version IN (29, 30, 31, 32) ORDER BY version"
        ).all()
      ).toEqual([{ version: 29 }, { version: 30 }, { version: 31 }, { version: 32 }]);
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
