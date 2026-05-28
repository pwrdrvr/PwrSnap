// Overlays table read/write surface. Every overlay write goes
// through this module — handlers in `handlers/overlays-handlers.ts`
// validate the user-provided blob via the zod schemas in
// @pwrsnap/shared, then call into here.
//
// Insertion is append-only by `source='user'` convention: editor
// edits produce new rows, never UPDATEs. Even drag-resize of an
// existing overlay is modeled as INSERT-then-supersede so undo /
// redo / regenerate all work uniformly.
//
// Phase 2 starter: reads + writes for the user-drawn path. AI
// suggestion lifecycle (regenerate, reject, supersede) lands with
// Phase 4. The schema already supports both — the queries here just
// don't exercise the AI columns yet.

import type { Overlay, OverlayRow } from "@pwrsnap/shared";
import { Overlay as OverlaySchema } from "@pwrsnap/shared";
import { getDb } from "./db";

type DbRow = {
  id: string;
  capture_id: string;
  data: string;
  schema_version: number;
  source: "user" | "codex" | "draft";
  ai_run_id: string | null;
  applied_at: string | null;
  rejected_at: string | null;
  superseded_by: string | null;
  z_index: number;
  created_at: string;
};

function rowToRecord(row: DbRow): OverlayRow {
  // Re-validate the blob on every read. Never trust the column
  // blindly — a future migration may have rewritten the shape, and
  // an LLM-routed Phase 4 row should never escape the boundary
  // un-validated.
  const data = OverlaySchema.parse(JSON.parse(row.data));
  return {
    id: row.id,
    capture_id: row.capture_id,
    data,
    schema_version: row.schema_version,
    source: row.source,
    ai_run_id: row.ai_run_id,
    applied_at: row.applied_at,
    rejected_at: row.rejected_at,
    superseded_by: row.superseded_by,
    z_index: row.z_index,
    created_at: row.created_at
  };
}

/** All "live" overlays for a capture — applied, not rejected, not
 *  superseded. Returned in render order (z_index asc, created_at asc). */
export function listLiveOverlays(captureId: string): OverlayRow[] {
  const rows = getDb()
    .prepare<[string], DbRow>(
      `SELECT id, capture_id, data, schema_version, source, ai_run_id,
              applied_at, rejected_at, superseded_by, z_index, created_at
         FROM overlays
        WHERE capture_id = ?
          AND applied_at IS NOT NULL
          AND rejected_at IS NULL
          AND superseded_by IS NULL
        ORDER BY z_index ASC, created_at ASC`
    )
    .all(captureId);
  return rows.map(rowToRecord);
}

export type UpsertOverlay = {
  id: string;
  captureId: string;
  data: Overlay;
  source?: "user" | "codex" | "draft";
  zIndex?: number;
};

/**
 * Insert a brand-new overlay. The Phase 2 editor calls this on every
 * pointerup for a finished tool; mid-drag coalescing happens in the
 * renderer (no IPC during drag). Returns the inserted row, validated
 * back through the schema.
 *
 * Bumps `captures.edits_version` in the same transaction so a
 * concurrent Phase 2 render coordinator notices the cache is stale.
 * Renamed from `overlays_version` in migration 0004 to unify v1
 * (overlays) and v2 (layers) convergence semantics.
 */
/** Gap between consecutive z_index values for monotonic-insert. Same
 *  constant as the renderer's `z-order.ts` Z_GAP — keeping them
 *  numerically equal isn't load-bearing (the renderer's reorder
 *  helper computes from the current sort order, not from the gap),
 *  but matching makes mental modeling easier across the boundary. */
const Z_INDEX_INSERT_GAP = 1000;

export function insertOverlay(input: UpsertOverlay): OverlayRow {
  const now = new Date().toISOString();
  const blob = JSON.stringify(input.data);
  const db = getDb();
  const tx = db.transaction(() => {
    // Compute the z_index. Caller-supplied `input.zIndex` wins; when
    // omitted, the new row gets MAX(existing z_index for this
    // capture) + Z_INDEX_INSERT_GAP so it lands STRICTLY ABOVE
    // every existing row in the render-order sort. Pre-fix every
    // new row got z_index = 0 and the renderer's `ORDER BY
    // z_index ASC, created_at ASC` had TIES on both columns when
    // two quick clicks landed in the same millisecond — SQLite's
    // tiebreaker is implementation-defined, so the user observed
    // "second arrow dove under the first" deterministically on
    // their machine even though the bug class is non-deterministic
    // in spec.
    //
    // We MAX over ALL rows for the capture (not just live ones)
    // so a re-insert AFTER a soft-delete still lands above the
    // deleted row's z_index — important for undo-of-delete to
    // restore the row at its original position (which would be
    // below any newer rows added between the delete and the undo).
    let resolvedZIndex: number;
    if (input.zIndex !== undefined) {
      resolvedZIndex = input.zIndex;
    } else {
      const row = db
        .prepare<[string], { max_z: number | null }>(
          `SELECT MAX(z_index) AS max_z FROM overlays WHERE capture_id = ?`
        )
        .get(input.captureId);
      resolvedZIndex =
        row?.max_z !== null && row?.max_z !== undefined
          ? row.max_z + Z_INDEX_INSERT_GAP
          : 0;
    }
    // 7 ? placeholders: id, capture_id, data, source, applied_at,
    // z_index, created_at. The other columns (schema_version,
    // ai_run_id, rejected_at, superseded_by) are literal in the SQL.
    db.prepare<[string, string, string, string, string, number, string]>(
      `INSERT INTO overlays
         (id, capture_id, data, schema_version, source, ai_run_id,
          applied_at, rejected_at, superseded_by, z_index, created_at)
       VALUES (?, ?, ?, 1, ?, NULL, ?, NULL, NULL, ?, ?)`
    ).run(
      input.id,
      input.captureId,
      blob,
      input.source ?? "user",
      // User-drawn overlays apply immediately. Phase 4 AI
      // suggestions arrive with applied_at = null until the user
      // accepts (sensitive-data blurs auto-apply at insert time
      // via a separate code path).
      now,
      resolvedZIndex,
      now
    );
    db.prepare<[string]>(
      `UPDATE captures SET edits_version = edits_version + 1 WHERE id = ?`
    ).run(input.captureId);
  });
  tx();
  return rowToRecord(
    db
      .prepare<[string], DbRow>(
        `SELECT id, capture_id, data, schema_version, source, ai_run_id,
                applied_at, rejected_at, superseded_by, z_index, created_at
           FROM overlays WHERE id = ?`
      )
      .get(input.id)!
  );
}

/**
 * Soft-delete: set rejected_at = now. The row stays in the table so
 * undo can resurrect it; the live-overlays query filters it out.
 * Returns the capture id of the affected overlay (or null if no row
 * matched) so the caller can broadcast `overlaysChanged` accurately.
 */
/**
 * Update an overlay's `z_index`. Atomic UPDATE; id is preserved
 * (unlike upsert which would mint a new id on every move). Bumps
 * `captures.edits_version` so any in-flight render cache invalidates.
 * Returns the affected overlay's capture id so the caller can
 * broadcast `overlaysChanged`; null when the id doesn't match a row.
 *
 * Caller picks new z_index values with a gap (~1000-step increments)
 * so most reorders avoid touching neighbors — same convention the v2
 * `setLayerZIndex` uses, so the renderer side of reorder ships one
 * algorithm across both formats.
 */
export function setOverlayZIndex(id: string, zIndex: number): string | null {
  const db = getDb();
  const row = db
    .prepare<[string], { capture_id: string }>(
      `SELECT capture_id FROM overlays WHERE id = ?`
    )
    .get(id);
  if (row === undefined) return null;
  const tx = db.transaction(() => {
    db.prepare<[number, string]>(
      `UPDATE overlays SET z_index = ? WHERE id = ?`
    ).run(zIndex, id);
    db.prepare<[string]>(
      `UPDATE captures SET edits_version = edits_version + 1 WHERE id = ?`
    ).run(row.capture_id);
  });
  tx();
  return row.capture_id;
}

export function rejectOverlay(id: string): string | null {
  const now = new Date().toISOString();
  const db = getDb();
  const row = db
    .prepare<[string], { capture_id: string }>(
      `SELECT capture_id FROM overlays WHERE id = ?`
    )
    .get(id);
  if (row === undefined) return null;
  const tx = db.transaction(() => {
    db.prepare<[string, string]>(
      `UPDATE overlays SET rejected_at = ? WHERE id = ?`
    ).run(now, id);
    db.prepare<[string]>(
      `UPDATE captures SET edits_version = edits_version + 1 WHERE id = ?`
    ).run(row.capture_id);
  });
  tx();
  return row.capture_id;
}
