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
import { getVideoMetadata, listVideoMetadata } from "./video-repo";

type CaptureRow = {
  id: string;
  kind: "image" | "video";
  captured_at: string;
  source_app_bundle_id: string | null;
  source_app_name: string | null;
  legacy_src_path: string | null;
  bundle_path: string | null;
  flat_png_path: string | null;
  bundle_modified_at: string | null;
  bundle_format_version: number;
  bundle_edits_version: number;
  width_px: number;
  height_px: number;
  device_pixel_ratio: number;
  byte_size: number;
  sha256: string;
  edits_version: number;
  deleted_at: string | null;
};

function rowToRecord(row: CaptureRow): CaptureRecord {
  return {
    id: row.id,
    kind: row.kind,
    captured_at: row.captured_at,
    legacy_src_path: row.legacy_src_path,
    bundle_path: row.bundle_path,
    flat_png_path: row.flat_png_path,
    bundle_modified_at: row.bundle_modified_at,
    bundle_format_version: row.bundle_format_version,
    bundle_edits_version: row.bundle_edits_version,
    width_px: row.width_px,
    height_px: row.height_px,
    device_pixel_ratio: row.device_pixel_ratio,
    byte_size: row.byte_size,
    sha256: row.sha256,
    source_app_bundle_id: row.source_app_bundle_id,
    source_app_name: row.source_app_name,
    edits_version: row.edits_version,
    deleted_at: row.deleted_at,
    // video metadata is hydrated separately by the read APIs below —
    // rowToRecord is shared with insert paths where the metadata
    // doesn't exist yet, so we default to null here.
    video: null
  };
}

export type InsertCapture = {
  id: string;
  kind: "image" | "video";
  captured_at: string;
  source_app_bundle_id: string | null;
  source_app_name: string | null;
  /**
   * Pre-bundle-migration source path. New captures (post-bundle-flow
   * rewire) pass `null` here and populate `bundle_path` instead. The
   * legacy migration walks rows where this is non-null and bundle_path
   * is null.
   */
  legacy_src_path: string | null;
  /**
   * Bundle pair paths. Optional for the legacy-data path (which uses
   * `legacy_src_path` only); required for new bundle-flow captures.
   */
  bundle_path?: string | null;
  flat_png_path?: string | null;
  bundle_modified_at?: string | null;
  /**
   * v1 = 1 (default; new captures created before v2 write path landed);
   * v2 = 2 (captures written via persistCaptureFromTempV2). Cached
   * projection; doctor reconciles from manifest at read time.
   */
  bundle_format_version?: number;
  bundle_edits_version?: number;
  width_px: number;
  height_px: number;
  device_pixel_ratio: number;
  byte_size: number;
  sha256: string;
};

/**
 * Insert a new capture row. If a row with the same `sha256` already
 * exists (UNIQUE constraint), returns the existing record instead —
 * dedup by content hash. The bundle / paired-PNG / legacy source files
 * should already be on disk before this is called; bundle_path /
 * flat_png_path / legacy_src_path columns point at them.
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
  return db.transaction(() => insertOrFindCaptureInTx(db, input))();
}

/**
 * Bulk variant of `insertOrFindCapture`. Runs every insert inside a
 * single SQLite transaction so the chain pays ONE commit + fsync
 * instead of N (better-sqlite3 commits per `db.transaction()`).
 *
 * Only used by the E2E test bridge today — the production capture
 * flow ingests captures one-at-a-time as the user fires them. If a
 * future feature wants bulk import (e.g. restore from backup), it
 * should call this directly rather than looping over the single
 * variant.
 */
export function insertOrFindCapturesBatch(
  inputs: InsertCapture[]
): Array<{ record: CaptureRecord; isNew: boolean }> {
  const db = getDb();
  return db.transaction(() => inputs.map((input) => insertOrFindCaptureInTx(db, input)))();
}

function insertOrFindCaptureInTx(
  db: ReturnType<typeof getDb>,
  input: InsertCapture
): { record: CaptureRecord; isNew: boolean } {
  // Bundle columns are optional on InsertCapture (legacy-data path uses
  // legacy_src_path only). Normalize undefined → null/0 before binding
  // so the prepared statement always sees a value for every @-param.
  const params = {
    ...input,
    bundle_path: input.bundle_path ?? null,
    flat_png_path: input.flat_png_path ?? null,
    bundle_modified_at: input.bundle_modified_at ?? null,
    bundle_format_version: input.bundle_format_version ?? 1,
    bundle_edits_version: input.bundle_edits_version ?? 0,
    legacy_composite_v2_migrated_at:
      input.bundle_path === null || input.bundle_path === undefined
        ? null
        : (input.bundle_modified_at ?? input.captured_at)
  };
  const inserted = db
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name, legacy_src_path,
        bundle_path, flat_png_path, bundle_modified_at,
        bundle_format_version, bundle_edits_version,
        legacy_composite_v2_migrated_at,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, edits_version, deleted_at
      ) VALUES (
        @id, @kind, @captured_at,
        @source_app_bundle_id, @source_app_name, @legacy_src_path,
        @bundle_path, @flat_png_path, @bundle_modified_at,
        @bundle_format_version, @bundle_edits_version,
        @legacy_composite_v2_migrated_at,
        @width_px, @height_px, @device_pixel_ratio,
        @byte_size, @sha256, 0, NULL
      )
      ON CONFLICT(sha256) DO NOTHING
      RETURNING *`
    )
    .get(params) as CaptureRow | undefined;

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
}

/**
 * Look up a capture by sha256. Used by the bundle-flow capture
 * orchestrator to dedup BEFORE packing a bundle: identical pixels
 * produce one bundle, not two. The existing `sha256 UNIQUE`
 * constraint is the safety net; this lookup is the optimization
 * that avoids wasted pack/write work.
 */
export function findCaptureBySha256(sha256: string): CaptureRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM captures WHERE sha256 = ?").get(sha256) as
    | CaptureRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Update bundle convergence columns after a successful re-pack.
 * Called from `bundle-store.runRepack` once the new bundle has been
 * written; this advances `bundle_edits_version` to match the row's
 * `edits_version` at pack time. The doctor's mid-debounce recovery
 * rule (`edits_version > bundle_edits_version` means re-pack owed)
 * reads these columns to decide whether to re-pack on boot.
 *
 * Renamed from updateCaptureBundleAfterRepack's earlier signature in
 * migration 0004 — `bundle_overlays_version` → `bundle_edits_version`.
 * Same semantics work for both v1 (overlays) and v2 (layers); the
 * table being read is gated by `bundle_format_version`.
 */
export function updateCaptureBundleAfterRepack(
  captureId: string,
  fields: { bundle_modified_at: string; bundle_edits_version: number }
): void {
  const db = getDb();
  db.prepare(
    `UPDATE captures
     SET bundle_modified_at = @bundle_modified_at,
         bundle_edits_version = @bundle_edits_version
     WHERE id = @id`
  ).run({ id: captureId, ...fields });
}

/**
 * Update the canvas dimensions (width_px, height_px) of a capture and
 * bump its edits_version atomically. Returns the PREVIOUS dims so the
 * caller can stash them for undo. Returns null if no row matched.
 *
 * Used by `bundle:updateCanvasDimensions` for the v2-native crop op
 * (Option A from the v2-editor plan): cropping doesn't rewrite the
 * source raster bytes — it just shrinks the canvas the compositor
 * paints into. The next scheduled repack reads the new dims from
 * the captures row when building the bundle manifest.
 */
export function updateCaptureCanvasDimensions(
  captureId: string,
  fields: { widthPx: number; heightPx: number }
): { widthPx: number; heightPx: number } | null {
  const db = getDb();
  const tx = db.transaction((): { widthPx: number; heightPx: number } | null => {
    const row = db
      .prepare<[string], { width_px: number; height_px: number }>(
        `SELECT width_px, height_px FROM captures WHERE id = ?`
      )
      .get(captureId);
    if (row === undefined) return null;
    db.prepare<{
      id: string;
      width_px: number;
      height_px: number;
    }>(
      `UPDATE captures
          SET width_px = @width_px,
              height_px = @height_px,
              edits_version = edits_version + 1
        WHERE id = @id`
    ).run({
      id: captureId,
      width_px: fields.widthPx,
      height_px: fields.heightPx
    });
    return { widthPx: row.width_px, heightPx: row.height_px };
  });
  return tx();
}

export function getCaptureById(id: string): CaptureRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as CaptureRow | undefined;
  if (row === undefined) return null;
  const record = rowToRecord(row);
  if (record.kind === "video") {
    record.video = getVideoMetadata(record.id);
  }
  return record;
}

/**
 * Batched id-lookup. Returns rows in the SAME ORDER as the input
 * `ids` array — missing ids are silently dropped. Soft-deleted rows
 * (`deleted_at IS NOT NULL`) are returned by this function; callers
 * that want only live rows should filter the result themselves
 * (matches `getCaptureById` semantics — that returns the row even if
 * soft-deleted, the deletion is just a status flag).
 *
 * Pairs `WHERE id IN (?, ?, …)` for the captures table with a single
 * batched `listVideoMetadata` for any video rows in the result —
 * total 2 round-trips regardless of input size (vs. 2N for an N-id
 * `getCaptureById` loop).
 *
 * Used by `library:listByIds` to render an arbitrary capture set
 * (e.g. a sizzle project's scene list) without paying N point lookups.
 *
 * Throws `RangeError` if `ids.length > 999` — SQLite's default
 * `SQLITE_LIMIT_VARIABLE_NUMBER` is 999 and we'd silently start
 * losing trailing ids past that without the explicit check.
 */
export function getCapturesByIds(ids: readonly string[]): CaptureRecord[] {
  if (ids.length === 0) return [];
  // The validator layer caps at 500; defend in depth here against a
  // caller that bypasses the validator. SQLite's compile-time
  // SQLITE_LIMIT_VARIABLE_NUMBER is 999 (default); blowing past it
  // throws a confusing "too many SQL variables" error.
  if (ids.length > 999) {
    throw new RangeError(
      `getCapturesByIds: ${ids.length} ids exceeds SQLite parameter limit (999)`
    );
  }
  const db = getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM captures WHERE id IN (${placeholders})`)
    .all(...ids) as CaptureRow[];
  // Map by id so we can return in input order. Rows from `IN` come
  // back in an arbitrary (typically rowid) order, NOT the input order.
  const byId = new Map<string, CaptureRow>();
  for (const row of rows) byId.set(row.id, row);

  // Single batched video-metadata fetch for any video rows in the
  // result set. Avoids N+1 the way the per-id loop would.
  const videoIds: string[] = [];
  for (const row of rows) {
    if (row.kind === "video") videoIds.push(row.id);
  }
  const videoById = listVideoMetadata(videoIds);

  const out: CaptureRecord[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) continue; // missing id — silently dropped
    const record = rowToRecord(row);
    if (record.kind === "video") {
      record.video = videoById.get(id) ?? null;
    }
    out.push(record);
  }
  return out;
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
  // Hydrate video metadata in one bulk query rather than N round-
  // trips. The Library list path goes through here and would otherwise
  // pay N×(SELECT) on every grid render when video captures appear.
  const videoIds = rows
    .filter((r) => r.kind === "video")
    .map((r) => r.id);
  if (videoIds.length > 0) {
    const meta = listVideoMetadata(videoIds);
    for (const r of rows) {
      if (r.kind === "video") {
        r.video = meta.get(r.id) ?? null;
      }
    }
  }
  const last = rows[rows.length - 1];
  const nextCursor: LibraryCursor | null =
    rows.length === limit && last !== undefined
      ? { capturedAt: last.captured_at, id: last.id }
      : null;
  return { rows, nextCursor };
}

/**
 * Soft-delete: set `deleted_at` to now and decrement `app_stats` for
 * the row's bundle. Caller (`source-store.moveSourceToTrash` or the
 * bundle-pair trash path) handles the file move. Wrapped in
 * db.transaction() so the invariant cannot drift on partial failure.
 *
 * Atomic ordering: DB write first, then file move — on crash, the file
 * is reachable via the record's path columns (legacy_src_path for
 * pre-bundle captures; bundle_path / flat_png_path for bundle captures)
 * but the row is soft-deleted, so library queries skip it.
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
 * original location (legacy_src_path for pre-bundle captures;
 * bundle_path / flat_png_path for bundle captures). Wrapped in
 * db.transaction() so the SUM(app_stats.count) == COUNT(live captures)
 * invariant cannot drift on partial failure.
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
 * Read the denormalized per-app counts plus a representative display
 * name. Returned in the head-page response of `library:list` so the
 * sidebar binds without a separate round-trip. The display name comes
 * from the latest live capture in the bucket that has a non-empty
 * OS-supplied `source_app_name`; this keeps labels correct even when
 * all rows for the bucket are outside the first keyset page.
 */
export function getAppStats(): LibraryAppStat[] {
  const db = getDb();
  const rows = db
    .prepare(
      `WITH latest_names AS (
         SELECT bundleKey, source_app_name
         FROM (
           SELECT
             COALESCE(source_app_bundle_id, '') AS bundleKey,
             source_app_name,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(source_app_bundle_id, '')
               ORDER BY captured_at DESC, id DESC
             ) AS rn
           FROM captures
           WHERE deleted_at IS NULL
             AND source_app_name IS NOT NULL
             AND source_app_name != ''
         )
         WHERE rn = 1
       )
       SELECT
         s.source_app_bundle_id AS bundleId,
         s.count AS count,
         n.source_app_name AS sourceAppName
       FROM app_stats s
       LEFT JOIN latest_names n
         ON n.bundleKey = COALESCE(s.source_app_bundle_id, '')
       ORDER BY s.count DESC`
    )
    .all() as Array<{ bundleId: string | null; count: number; sourceAppName: string | null }>;
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
