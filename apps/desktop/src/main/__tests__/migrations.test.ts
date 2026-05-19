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

  test("runner detects bundle-migration schema drift and replays 0007/0008/0009", async () => {
    // Reproduces a dev DB where a previous branch had migrations
    // 7-8 mapped to ai-enrichment-title/filename. Their content was
    // applied (capture_enrichments has title columns), but the
    // current branch's 7-9 (bundle storage / layers / legacy
    // attempts) never ran. The runner should detect the drift and
    // replay 7-9 so the captures table reaches its current shape.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      db.exec(readFileSync(join(migrationsDir, "0001_init.sql"), "utf8"));
      db.exec(readFileSync(join(migrationsDir, "0002_overlays.sql"), "utf8"));
      db.exec(readFileSync(join(migrationsDir, "0003_perf_app_stats.sql"), "utf8"));
      db.exec(readFileSync(join(migrationsDir, "0004_electron_source_app_repair.sql"), "utf8"));
      db.exec(readFileSync(join(migrationsDir, "0005_video_captures.sql"), "utf8"));
      db.exec(readFileSync(join(migrationsDir, "0006_ai_enrichment.sql"), "utf8"));
      // Simulate the previous branch's title/filename columns.
      db.exec(`
        ALTER TABLE capture_enrichments ADD COLUMN suggested_title TEXT;
        ALTER TABLE capture_enrichments ADD COLUMN accepted_title TEXT;
        ALTER TABLE capture_enrichments ADD COLUMN title_accepted_at TEXT;
        ALTER TABLE capture_enrichments ADD COLUMN suggested_filename_stem TEXT;
        ALTER TABLE capture_enrichments ADD COLUMN accepted_filename_stem TEXT;
        ALTER TABLE capture_enrichments ADD COLUMN filename_accepted_at TEXT;
      `);
      // Mark all eleven as "applied" (the state on the affected dev
      // DB after the runner's duplicate-column tolerance ran on its
      // own — 7-8 were marked under wrong content, 9 ran, 10-11
      // skipped via tolerance).
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL PRIMARY KEY);
        INSERT INTO schema_migrations(version)
        VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11);
      `);

      // Seed one capture row so we can verify data survives the
      // bundle replay.
      db.prepare(
        `INSERT INTO captures (
          id, kind, captured_at, src_path,
          width_px, height_px, device_pixel_ratio,
          byte_size, sha256, overlays_version
        ) VALUES (?, 'image', '2026-05-19T18:00:00.000Z', '/tmp/x.png', 1, 1, 2, 1, 'sha', 0)`
      ).run("cap_pre_bundle");

      const { applyMigrationsForTest } = await import("../persistence/db");
      expect(() => applyMigrationsForTest(db)).not.toThrow();

      // captures table is now in bundle-storage shape.
      const cols = (
        db.prepare("SELECT name FROM pragma_table_info('captures')").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(cols).toContain("legacy_src_path");
      expect(cols).not.toContain("src_path");

      // The capture row survived the bundle replay, with src_path
      // copied across to legacy_src_path.
      const surviving = db
        .prepare("SELECT id, legacy_src_path FROM captures WHERE id = ?")
        .get("cap_pre_bundle") as { id: string; legacy_src_path: string } | undefined;
      expect(surviving?.legacy_src_path).toBe("/tmp/x.png");
    } finally {
      db.close();
    }
  });

  test("runner skips duplicate-column ALTER TABLE errors and marks the migration applied", async () => {
    // Reproduces the renumber-collision case a dev branch hits: a
    // local DB has a previous incarnation of a migration applied
    // under a different version number, so the column already
    // exists when the renumbered file tries to add it.
    //
    // The runner should NOT throw — it should log + mark applied.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      db.exec(readFileSync(join(migrationsDir, "0001_init.sql"), "utf8"));
      db.exec(readFileSync(join(migrationsDir, "0006_ai_enrichment.sql"), "utf8"));
      // Pretend a previous branch added these columns under a
      // different version — schema_migrations gets only the new
      // version markers below.
      db.exec(`
        ALTER TABLE capture_enrichments ADD COLUMN suggested_title TEXT;
        ALTER TABLE capture_enrichments ADD COLUMN accepted_title TEXT;
        ALTER TABLE capture_enrichments ADD COLUMN title_accepted_at TEXT;
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL PRIMARY KEY);
        INSERT INTO schema_migrations(version) VALUES (1), (6);
      `);

      const { applyMigrationsForTest } = await import("../persistence/db");
      expect(() => applyMigrationsForTest(db)).not.toThrow();

      // 0010_ai_enrichment_title is recorded as applied even though
      // its ADD COLUMNs were no-ops.
      const versions = (
        db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version);
      expect(versions).toContain(10);
      expect(versions).toContain(11);
    } finally {
      db.close();
    }
  });
});
