// SQLite connection + migration runner. Single writer, synchronous API
// (better-sqlite3) — fits Electron's main-process model without async
// connection-pool overhead.
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
//
// Migrations are numbered raw `.sql` files under ./migrations/. A
// `schema_migrations` table tracks applied versions. Each file is one
// logical change, applied in a transaction. Never edit an applied
// migration — write a new one.

import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:db");

let dbInstance: Database.Database | null = null;

export type SchemaMigration = {
  version: number;
  appliedAt: string;
};

/**
 * On-disk layout. Most things live under `app.getPath('userData')`
 * (an opaque Application Support folder users don't browse):
 *   pwrsnap.db
 *   cache/<capture_id>/<hash>.<format>  — managed by render-cache (Phase 1.6)
 *   .trash/<uuid>.png                   — soft-deleted captures
 *
 * Source captures (the originals — what users actually want to look
 * at, attach to tickets, drag elsewhere) live in a USER-VISIBLE place
 * instead, under `~/Documents/PwrSnap/<uuid>.png`. Two reasons to
 * keep them outside userData:
 *   1. Discoverability — Documents shows up in Finder, in Spotlight,
 *      in cloud-sync clients. Application Support is hidden by
 *      default and most users never see it.
 *   2. Survives an app uninstall — `~/Documents/PwrSnap` doesn't get
 *      blown away when someone trashes the .app.
 *
 * No yyyy/mm date subfolders: filenames are nanoid-shaped, sort fine
 * in Finder by mtime, and the DB indexes captured_at — the file
 * system is asked only "give me this exact path", not "list me
 * everything from May 2026".
 *
 * Existing rows from before this change keep absolute src_paths
 * pointing at the old userData layout; they continue to resolve.
 * No automated migration — files in Application Support are still
 * readable, and a user who wants them in Documents can copy them
 * over manually.
 */
export function getDbPath(): string {
  return join(app.getPath("userData"), "pwrsnap.db");
}

export function getCapturesRoot(): string {
  return join(app.getPath("documents"), "PwrSnap");
}

export function getCacheRoot(): string {
  return join(app.getPath("userData"), "cache");
}

export function getTrashRoot(): string {
  return join(app.getPath("userData"), ".trash");
}

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
  const db = new Database(dbPath);

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

  dbInstance = db;
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
    const tx = db.transaction(() => {
      db.exec(sql);
      insertMigration.run(version);
    });
    tx();
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
 * checkpoint truncate so the next open starts with a clean WAL.
 */
export function closeDatabase(): void {
  if (!dbInstance) return;
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
