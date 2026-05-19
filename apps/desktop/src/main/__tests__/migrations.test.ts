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
