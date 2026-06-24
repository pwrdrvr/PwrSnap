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
