// SQLite connection + migration runner. Single writer, synchronous API
// (better-sqlite3) — fits Electron's main-process model without async
// connection-pool overhead.
//
// Path resolution lives in ./paths.ts — every persistence path
// composes from `getDataRoot()` so the dev seeder + integration tests
// can reroot via `PWRSNAP_DATA_ROOT`. This module never calls
// `app.getPath("userData")` directly.
//
// Pragmas chosen for desktop workloads (per better-sqlite3 research):
//   • WAL + synchronous=NORMAL  — concurrent readers, single writer,
//     crash-safe (FULL is overkill for desktop; NORMAL trades a tiny
//     durability window for ~2× write throughput).
//   • mmap_size=256MB           — DB file is small; mmap the whole
//     thing for faster cold reads on the timeline grid.
//   • cache_size=-64MB          — 64MB page cache (negative = KiB).
//   • foreign_keys=ON           — required for ON DELETE CASCADE on
//     render_cache → captures.
//   • PRAGMA optimize=0x10002   — SQLite team's recommendation since
//     3.46. The 0x10002 mask forces analysis on a fresh connection
//     (no query history yet); 3.46+ self-limits runtime so it doesn't
//     stall startup. Re-run `PRAGMA optimize` (no mask) at quit so
//     stats reflect the session's workload.
//
// Migrations are numbered raw `.sql` files under ./migrations/. A
// `schema_migrations` table tracks applied versions. Each file is one
// logical change, applied in a transaction. Never edit an applied
// migration — write a new one.

import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getMainLogger } from "../log";
import { getNativeBinding } from "./native-binding";
import { getDbPath } from "./paths";

const log = getMainLogger("pwrsnap:db");

let dbInstance: Database.Database | null = null;

export type SchemaMigration = {
  version: number;
  appliedAt: string;
};

/**
 * Open the database, run pending migrations, and return the connection.
 * Idempotent — safe to call from a hot reload boot path.
 *
 * Eager warmup matters: the first INSERT after process boot includes
 * native binding load + journal-mode setup + statement compile. For
 * Phase 1's <120ms ⌘⇧P SLA, we touch the DB at app.whenReady() so the
 * cold path is paid before the user fires the shortcut.
 */
export async function openDatabase(): Promise<Database.Database> {
  if (dbInstance) return dbInstance;

  const dbPath = getDbPath();
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    await mkdir(dbDir, { recursive: true });
  }

  log.info("opening database", { dbPath });
  const db = new Database(dbPath, { nativeBinding: getNativeBinding() });

  // Pragmas. All except foreign_keys are persistent; foreign_keys is
  // per-connection and must be set at every open.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("mmap_size = 268435456"); // 256 MB
  db.pragma("cache_size = -65536"); // 64 MB
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  runMigrations(db);

  // PRAGMA optimize must run AFTER migrations so any new indexes
  // exist and have stats populated on first use. The 0x10002 mask is
  // SQLite's recommended "fresh-connection" form — it analyzes
  // tables that benefit from it without scheduling a full ANALYZE.
  db.pragma("optimize = 0x10002");

  dbInstance = db;

  // Dev-only invariant self-check: app_stats sum should match live
  // captures count. Auto-heals on drift via recomputeAppStats() —
  // catches the realistic dev-workflow case of switching branches
  // where one branch's code path doesn't keep app_stats in sync
  // (e.g. main inserted captures pre-bumpAppStat) and surfaces a
  // single one-line warning instead of crashing boot.
  //
  // Skipped before the 0003 migration lands (app_stats table
  // doesn't exist yet) — that migration is required before this
  // check can run.
  if (import.meta.env.DEV) {
    try {
      const drift = db
        .prepare(
          `SELECT
             (SELECT COALESCE(SUM(count), 0) FROM app_stats)
           - (SELECT COUNT(*) FROM captures WHERE deleted_at IS NULL)
           AS d`
        )
        .get() as { d: number };
      if (drift.d !== 0) {
        log.warn("app_stats drift detected — auto-healing", { drift: drift.d });
        // Inline recompute to avoid the import cycle with captures-repo
        // (which imports getDb from this module). Same body as
        // recomputeAppStats() in captures-repo.ts — kept in sync by
        // proximity since both touch app_stats only.
        db.transaction(() => {
          db.exec("DELETE FROM app_stats");
          db.exec(
            `INSERT INTO app_stats (source_app_bundle_id, count)
             SELECT source_app_bundle_id, COUNT(*)
             FROM captures
             WHERE deleted_at IS NULL
             GROUP BY source_app_bundle_id`
          );
        })();
      }
    } catch (err) {
      // Pre-0003 DB → app_stats doesn't exist. That's fine; the
      // migration will land on next open. Anything else (actual SQL
      // error, repair failure) should fail loud.
      const msg = err instanceof Error ? err.message : String(err);
      const isMissingTable = msg.includes("no such table: app_stats");
      if (!isMissingTable) throw err;
    }
  }

  return db;
}

/**
 * Apply pending migrations from ./migrations/. Each migration runs in
 * its own transaction; partial failure leaves the schema unchanged.
 */
function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set<number>(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version)
  );

  // Migrations live next to the compiled main bundle; electron-vite
  // emits them via a `?asset` import side-effect or — simpler — via
  // a copy step. For Phase 1 we resolve relative to __dirname (which
  // is `out/main` in production, `apps/desktop/src/main` in dev).
  // Both paths reach the migrations dir.
  const migrationsDir = resolveMigrationsDir();
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();

  const insertMigration = db.prepare("INSERT INTO schema_migrations(version) VALUES (?)");

  for (const file of files) {
    const versionStr = file.slice(0, 4);
    const version = Number.parseInt(versionStr, 10);
    if (Number.isNaN(version) || applied.has(version)) continue;

    log.info("applying migration", { file, version });
    const sql = readFileSync(join(migrationsDir, file), "utf8");

    // SQLite's "12-step ALTER TABLE" pattern (recreating a table to
    // change a column constraint) requires foreign_keys=OFF, and that
    // pragma is silently ignored inside a transaction. Migrations that
    // need it opt in via a `-- @no-foreign-keys` marker on the first
    // line. See sqlite.org/lang_altertable.html.
    const needsFkOff = sql.startsWith("-- @no-foreign-keys");
    if (needsFkOff) db.pragma("foreign_keys = OFF");
    try {
      const tx = db.transaction(() => {
        db.exec(sql);
        insertMigration.run(version);
      });
      tx();
    } finally {
      if (needsFkOff) db.pragma("foreign_keys = ON");
    }
  }
}

function resolveMigrationsDir(): string {
  // electron-vite ships the main bundle as `out/main/index.js`. Migrations
  // are copied alongside via a small copy step (see Phase 1.3 build wiring
  // — for dev, __dirname is the source dir).
  return join(__dirname, "migrations");
}

/**
 * Close the database. Call from `before-quit`. Performs a WAL
 * checkpoint truncate + `PRAGMA optimize` (SQLite-team recommended
 * shutdown sequence as of 3.46) so the next open starts with a clean
 * WAL and refreshed stats.
 */
export function closeDatabase(): void {
  if (!dbInstance) return;
  try {
    dbInstance.pragma("optimize");
  } catch (err) {
    log.warn("pragma optimize failed at close", {
      message: err instanceof Error ? err.message : String(err)
    });
  }
  try {
    dbInstance.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    log.warn("wal checkpoint failed at close", {
      message: err instanceof Error ? err.message : String(err)
    });
  }
  dbInstance.close();
  dbInstance = null;
}

/**
 * Sync access to the singleton. Throws if `openDatabase()` hasn't
 * resolved yet — call sites should be downstream of `app.whenReady()`.
 */
export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error("db: not opened — call openDatabase() in app.whenReady()");
  }
  return dbInstance;
}
