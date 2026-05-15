// Captures table read/write surface. Every persistent capture flows
// through this module — no other module touches the `captures` table
// directly. Pairs with `source-store.ts` which owns the on-disk PNG
// files; this module only stores the metadata row.
//
// app_stats invariant (added in 0003_perf_app_stats):
//   SUM(app_stats.count) == COUNT(captures WHERE deleted_at IS NULL)
//
// To keep the invariant intact:
//   - insertOrFindCapture wraps INSERT … ON CONFLICT(sha256) DO NOTHING
//     RETURNING * + bumpAppStat(+1) in a single db.transaction().
//   - softDeleteCapture wraps the UPDATE + bumpAppStat(-1) in a
//     transaction.
//   - hardDeleteCapture is defensive — reads `(deleted_at, bundle_id)`
//     first; decrements only if `deleted_at IS NULL` (i.e., the row
//     was hard-deleted without prior soft-delete; the GC sweep that
//     hard-deletes already-soft-deleted rows is unaffected).
//
// db.ts boots with a dev-only invariant self-check that throws on
// drift, so a broken mutation path fails on next boot.

import type { CaptureRecord, LibraryAppStat, LibraryCursor } from "@pwrsnap/shared";
import { getDb } from "./db";

type CaptureRow = {
  id: string;
  kind: "image" | "video";
  captured_at: string;
  source_app_bundle_id: string | null;
  source_app_name: string | null;
  src_path: string;
  width_px: number;
  height_px: number;
  device_pixel_ratio: number;
  byte_size: number;
  sha256: string;
  overlays_version: number;
  deleted_at: string | null;
};

function rowToRecord(row: CaptureRow): CaptureRecord {
  return {
    id: row.id,
    kind: row.kind,
    captured_at: row.captured_at,
    src_path: row.src_path,
    width_px: row.width_px,
    height_px: row.height_px,
    device_pixel_ratio: row.device_pixel_ratio,
    byte_size: row.byte_size,
    sha256: row.sha256,
    source_app_bundle_id: row.source_app_bundle_id,
    source_app_name: row.source_app_name,
    overlays_version: row.overlays_version,
    deleted_at: row.deleted_at
  };
}

export type InsertCapture = {
  id: string;
  kind: "image" | "video";
  captured_at: string;
  source_app_bundle_id: string | null;
  source_app_name: string | null;
  src_path: string;
  width_px: number;
  height_px: number;
  device_pixel_ratio: number;
  byte_size: number;
  sha256: string;
};

/**
 * Insert a new capture row. If a row with the same `sha256` already
 * exists (UNIQUE constraint), returns the existing record instead —
 * dedup by content hash. Source PNG should already be persisted via
 * `source-store.put()` before this is called.
 *
 * Implementation: `INSERT … ON CONFLICT(sha256) DO NOTHING RETURNING *`
 * collapses the existing-row check + insert into a single round trip.
 * When the conflict path fires, RETURNING produces no row, and we
 * re-fetch the existing row by sha256.
 *
 * Wrapped in `db.transaction()` with `bumpAppStat(+1)` so the
 * `SUM(app_stats.count) == COUNT(live captures)` invariant cannot
 * drift on partial failure.
 */
export function insertOrFindCapture(input: InsertCapture): {
  record: CaptureRecord;
  isNew: boolean;
} {
  const db = getDb();
  return db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT INTO captures (
          id, kind, captured_at,
          source_app_bundle_id, source_app_name, src_path,
          width_px, height_px, device_pixel_ratio,
          byte_size, sha256, overlays_version, deleted_at
        ) VALUES (
          @id, @kind, @captured_at,
          @source_app_bundle_id, @source_app_name, @src_path,
          @width_px, @height_px, @device_pixel_ratio,
          @byte_size, @sha256, 0, NULL
        )
        ON CONFLICT(sha256) DO NOTHING
        RETURNING *`
      )
      .get(input) as CaptureRow | undefined;

    if (inserted !== undefined) {
      bumpAppStat(input.source_app_bundle_id, +1);
      return { record: rowToRecord(inserted), isNew: true };
    }
    // Dedup path: a row with this sha256 already exists. Surface it
    // unchanged; do NOT bump app_stats (the existing row is already
    // counted).
    const existing = db
      .prepare("SELECT * FROM captures WHERE sha256 = ?")
      .get(input.sha256) as CaptureRow;
    return { record: rowToRecord(existing), isNew: false };
  })();
}

export function getCaptureById(id: string): CaptureRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as CaptureRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Keyset-paginated list. Cursor encodes the last (captured_at, id)
 * of the previous page; the new query requests rows strictly less
 * than that tuple (lexicographic — captured_at DESC, id DESC). When
 * `cursor` is omitted, returns the most-recent page.
 *
 * Index used: `idx_captures_recency (captured_at DESC, id DESC) WHERE
 * deleted_at IS NULL`. The tuple comparison `(captured_at, id) < (?, ?)`
 * is optimized into a range scan against this index by SQLite ≥3.15.
 * Confirm with EXPLAIN QUERY PLAN — if it ever falls back to SCAN,
 * rewrite to the disjunctive form `captured_at < ? OR (captured_at = ?
 * AND id < ?)`.
 */
export type ListCapturesArgs = {
  cursor?: LibraryCursor | undefined;
  limit?: number | undefined;
  appBundleId?: string | undefined;
  appBundleIds?: Array<string | null> | undefined;
  includeDeleted?: boolean | undefined;
};

export type ListCapturesResult = {
  rows: CaptureRecord[];
  nextCursor: LibraryCursor | null;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export function listCaptures(filter: ListCapturesArgs): ListCapturesResult {
  const db = getDb();
  const limit = Math.min(MAX_LIMIT, filter.limit ?? DEFAULT_LIMIT);
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };

  if (!filter.includeDeleted) where.push("deleted_at IS NULL");
  if (filter.cursor !== undefined) {
    where.push("(captured_at, id) < (@cursor_at, @cursor_id)");
    params.cursor_at = filter.cursor.capturedAt;
    params.cursor_id = filter.cursor.id;
  }
  const appBundleIds =
    filter.appBundleIds !== undefined
      ? filter.appBundleIds
      : filter.appBundleId !== undefined
      ? [filter.appBundleId]
      : undefined;
  if (appBundleIds !== undefined) {
    const exactBundleClauses: string[] = [];
    let includesNullBundle = false;
    for (const [index, bundleId] of appBundleIds.entries()) {
      if (bundleId === null) {
        includesNullBundle = true;
        continue;
      }
      const key = `appBundleId${index}`;
      exactBundleClauses.push(`source_app_bundle_id = @${key}`);
      params[key] = bundleId;
    }
    const bundleWhere = [
      ...exactBundleClauses,
      ...(includesNullBundle ? ["source_app_bundle_id IS NULL"] : [])
    ];
    where.push(bundleWhere.length > 0 ? `(${bundleWhere.join(" OR ")})` : "0 = 1");
  } else if (filter.appBundleId !== undefined) {
    where.push("source_app_bundle_id = @appBundleId");
    params.appBundleId = filter.appBundleId;
  }

  const sql = `SELECT * FROM captures
    ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY captured_at DESC, id DESC
    LIMIT @limit`;
  const rawRows = db.prepare(sql).all(params) as CaptureRow[];
  const rows = rawRows.map(rowToRecord);
  const last = rows[rows.length - 1];
  const nextCursor: LibraryCursor | null =
    rows.length === limit && last !== undefined
      ? { capturedAt: last.captured_at, id: last.id }
      : null;
  return { rows, nextCursor };
}

/**
 * Soft-delete: set `deleted_at` to now and decrement `app_stats` for
 * the row's bundle. Caller (`source-store.moveSourceToTrash`) handles
 * the file move. Wrapped in db.transaction() so the invariant cannot
 * drift on partial failure.
 *
 * Idempotent: a second call on an already-deleted row is a no-op
 * (the WHERE deleted_at IS NULL clause filters it).
 */
export function softDeleteCapture(id: string): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare("SELECT source_app_bundle_id FROM captures WHERE id = ? AND deleted_at IS NULL")
      .get(id) as { source_app_bundle_id: string | null } | undefined;
    if (row === undefined) return; // already deleted or unknown id
    db.prepare("UPDATE captures SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").run(id);
    bumpAppStat(row.source_app_bundle_id, -1);
  })();
}

/**
 * Inverse of softDeleteCapture: clear deleted_at so the row reappears
 * in live library queries, and re-increment the app_stats bucket.
 * Caller is responsible for moving the trash file back to its
 * original src_path. Wrapped in db.transaction() so the
 * SUM(app_stats.count) == COUNT(live captures) invariant cannot drift
 * on partial failure.
 */
export function restoreCapture(id: string): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare(
        "SELECT source_app_bundle_id FROM captures WHERE id = ? AND deleted_at IS NOT NULL"
      )
      .get(id) as { source_app_bundle_id: string | null } | undefined;
    if (row === undefined) return; // already live or unknown id
    db.prepare("UPDATE captures SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").run(id);
    bumpAppStat(row.source_app_bundle_id, +1);
  })();
}

/**
 * Hard-delete: remove the row + cascade. Defensive — if the caller
 * forgot to soft-delete first, we still need to keep `app_stats` in
 * sync, so we read `(deleted_at, bundle_id)` and decrement only when
 * `deleted_at IS NULL` (the GC sweep path soft-deletes first, so
 * this branch fires only for unexpected callers; failing-loud is
 * not appropriate here because the row is going away anyway).
 */
export function hardDeleteCapture(id: string): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare("SELECT source_app_bundle_id, deleted_at FROM captures WHERE id = ?")
      .get(id) as { source_app_bundle_id: string | null; deleted_at: string | null } | undefined;
    if (row === undefined) return;
    if (row.deleted_at === null) {
      bumpAppStat(row.source_app_bundle_id, -1);
    }
    // ON DELETE CASCADE removes the render_cache + overlays rows.
    db.prepare("DELETE FROM captures WHERE id = ?").run(id);
  })();
}

// ── app_stats maintenance ──────────────────────────────────────────

/**
 * UPSERT a delta into the app_stats bucket for `bundleId` (treating
 * NULL as its own bucket via COALESCE). Always called from inside
 * another `db.transaction()` so it composes safely with the captures
 * mutation that triggered it.
 *
 * Module-private — callers go through `insertOrFindCapture` /
 * `softDeleteCapture` / `hardDeleteCapture`.
 */
function bumpAppStat(bundleId: string | null, delta: number): void {
  const db = getDb();
  // The unique index is on COALESCE(source_app_bundle_id, ''), so we
  // can't use the standard ON CONFLICT shortcut on the column itself.
  // Two-statement UPSERT instead — cheap, both indexed.
  const updated = db
    .prepare(
      `UPDATE app_stats
         SET count = count + @delta
       WHERE COALESCE(source_app_bundle_id, '') = COALESCE(@bundleId, '')`
    )
    .run({ bundleId, delta });
  if (updated.changes === 0) {
    // First time we see this bundle — insert with `delta` (which is
    // +1 in the only call site that can create a new bucket). On a
    // negative delta into an unknown bucket, `count >= 0` would fire,
    // which is the right behavior (decrement of a non-existent
    // bucket is a logic bug worth surfacing).
    db.prepare(
      "INSERT INTO app_stats (source_app_bundle_id, count) VALUES (@bundleId, @delta)"
    ).run({ bundleId, delta });
  }
}

/**
 * Read the denormalized per-app counts. Returned in the head-page
 * response of `library:list` so the sidebar binds without a separate
 * round-trip. Sorted by count desc so the heaviest bundles appear
 * first in the sidebar.
 */
export function getAppStats(): LibraryAppStat[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT source_app_bundle_id AS bundleId, count FROM app_stats ORDER BY count DESC")
    .all() as Array<{ bundleId: string | null; count: number }>;
  return rows;
}

/** Total live row count derived from `app_stats`. No COUNT(*). */
export function getTotalLive(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COALESCE(SUM(count), 0) AS total FROM app_stats")
    .get() as { total: number };
  return row.total;
}

/**
 * Reconciliation. Recompute `app_stats` from the live captures table
 * and overwrite. Cheap (one indexed scan + bulk insert via UPSERT).
 * Called from a hidden "Repair stats" dev tray entry and on startup
 * if the dev-only invariant self-check fires (db.ts).
 */
export function recomputeAppStats(): void {
  const db = getDb();
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

/** Every currently-soft-deleted capture id. Used by Empty-Trash. */
export function listSoftDeletedIds(): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM captures WHERE deleted_at IS NOT NULL")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * IDs of captures soft-deleted long enough to physically remove. Used
 * by the boot-time GC sweep.
 */
export function listExpiredTrash(maxAgeDays: number): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id FROM captures
       WHERE deleted_at IS NOT NULL
         AND deleted_at < datetime('now', @offset)`
    )
    .all({ offset: `-${maxAgeDays} days` }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
