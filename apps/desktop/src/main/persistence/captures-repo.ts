// Captures table read/write surface. Every persistent capture flows
// through this module — no other module touches the `captures` table
// directly. Pairs with `source-store.ts` which owns the on-disk PNG
// files; this module only stores the metadata row.

import type { CaptureRecord } from "@pwrsnap/shared";
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
 */
export function insertOrFindCapture(input: InsertCapture): {
  record: CaptureRecord;
  isNew: boolean;
} {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM captures WHERE sha256 = ?")
    .get(input.sha256) as CaptureRow | undefined;

  if (existing) {
    return { record: rowToRecord(existing), isNew: false };
  }

  db.prepare(
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
    )`
  ).run(input);

  const inserted = db.prepare("SELECT * FROM captures WHERE id = ?").get(input.id) as CaptureRow;
  return { record: rowToRecord(inserted), isNew: true };
}

export function getCaptureById(id: string): CaptureRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as CaptureRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function listCaptures(filter: {
  before?: string | undefined;
  limit?: number | undefined;
  appBundleId?: string | undefined;
  includeDeleted?: boolean | undefined;
}): CaptureRecord[] {
  const db = getDb();
  const limit = filter.limit ?? 500;
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };

  if (!filter.includeDeleted) where.push("deleted_at IS NULL");
  if (filter.before !== undefined) {
    where.push("captured_at < @before");
    params.before = filter.before;
  }
  if (filter.appBundleId !== undefined) {
    where.push("source_app_bundle_id = @appBundleId");
    params.appBundleId = filter.appBundleId;
  }

  const sql = `SELECT * FROM captures
    ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY captured_at DESC
    LIMIT @limit`;
  const rows = db.prepare(sql).all(params) as CaptureRow[];
  return rows.map(rowToRecord);
}

/**
 * Soft-delete: set `deleted_at` to now. Caller (`source-store.delete`)
 * also moves the PNG to <root>/.trash/. Atomic ordering: DB write
 * first, then file move — on crash, the file is reachable via src_path
 * but the row is soft-deleted, so library queries skip it.
 */
export function softDeleteCapture(id: string): void {
  const db = getDb();
  db.prepare("UPDATE captures SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").run(id);
}

/**
 * Inverse of softDeleteCapture: clear deleted_at so the row reappears
 * in live library queries. Caller is responsible for moving the trash
 * file back to its original src_path.
 */
export function restoreCapture(id: string): void {
  const db = getDb();
  db.prepare("UPDATE captures SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").run(id);
}

export function hardDeleteCapture(id: string): void {
  const db = getDb();
  // ON DELETE CASCADE removes the render_cache rows; future Phase 2+
  // tables (overlays etc) will cascade similarly.
  db.prepare("DELETE FROM captures WHERE id = ?").run(id);
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
