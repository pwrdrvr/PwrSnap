// Layers table read/write surface. v2 bundle format ships a layer tree
// instead of v1's flat overlays array. Every layer write flows through
// this module — handlers in `handlers/layers-handlers.ts` validate the
// user-provided blob via the zod schemas in @pwrsnap/shared, then call
// here. Soft-delete + supersede chains mirror overlays-repo verbatim
// (undo + AI-regenerate stay uniform).
//
// Three pieces of correctness this module owns:
//
//   1. Tree depth bound. listLayerTree refuses bundles deeper than 32
//      levels — bounded recursion + DoS guard for malicious bundles.
//
//   2. Reparent cycle prevention. The naive "walk parent_id chain in
//      TypeScript, check for the moving id" is racy under concurrent
//      reparents from different IPC dispatchers. Solution: BEGIN
//      IMMEDIATE transaction + recursive CTE check + UPDATE in the
//      same TX. SQLite's serialized writer makes this race-free.
//
//   3. Transitive soft-delete cascade. rejectLayer(groupId) stamps
//      rejected_at on every descendant in one transaction. Without
//      this, soft-deleting a group leaves orphaned-but-live children
//      that the live-rows filter treats as legitimate.

import type { BundleLayerNode } from "@pwrsnap/shared";
import { BundleLayerNode as BundleLayerNodeSchema } from "@pwrsnap/shared";
import { getDb } from "./db";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:layers-repo");

const MAX_TREE_DEPTH = 32;

type DbLayerRow = {
  id: string;
  capture_id: string;
  parent_id: string | null;
  kind: "group" | "raster" | "vector" | "effect";
  z_index: number;
  name: string;
  visible: number; // 0 | 1
  locked: number; // 0 | 1
  opacity: number;
  blend_mode: string;
  transform_json: string;
  data: string; // kind-specific JSON
  schema_version: number;
  source: "user" | "codex" | "draft";
  ai_run_id: string | null;
  applied_at: string | null;
  rejected_at: string | null;
  superseded_by: string | null;
  created_at: string;
};

/**
 * Hydrate a DB row into a BundleLayerNode, or return `null` when the row
 * doesn't match the schema THIS build understands.
 *
 * Forward-compatibility (cross-branch reality): we ship layer/shape
 * types incrementally across parallel branches. A capture edited on a
 * newer build can carry a layer kind — or, more commonly, a vector
 * `shape.kind` (circle / oval / square / triangle … ) — that an older /
 * sibling build's discriminated unions don't include. Re-validating on
 * read is the right discipline, but a STRICT `.parse()` would throw on
 * the first such row and take the WHOLE capture's render down with it
 * (blank thumbnail, 500 from the cache protocol handler). Instead we
 * `safeParse` per row, return null on failure, and let the caller skip
 * it — the rest of the capture renders, and we log a dense breadcrumb so
 * the gap is diagnosable rather than silent. Write paths (`insertLayer`)
 * stay STRICT: we never persist a layer this build can't construct.
 */
function tryRowToNode(row: DbLayerRow, captureId: string): BundleLayerNode | null {
  let data: Record<string, unknown>;
  let transform: [number, number, number, number, number, number];
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
    transform = JSON.parse(row.transform_json) as [
      number, number, number, number, number, number
    ];
  } catch (cause) {
    log.warn("layers-repo: skipping a layer with unparseable JSON columns", {
      captureId,
      layerId: row.id,
      layerKind: row.kind,
      schemaVersion: row.schema_version,
      source: row.source,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return null;
  }
  // Common props get re-built from the row columns; kind-specific
  // props come from the JSON blob. zod parses the whole thing.
  const common = {
    id: row.id,
    parent_id: row.parent_id,
    name: row.name,
    visible: row.visible !== 0,
    locked: row.locked !== 0,
    opacity: row.opacity,
    blend_mode: row.blend_mode,
    transform,
    z_index: row.z_index,
    source: row.source,
    ai_run_id: row.ai_run_id,
    applied_at: row.applied_at,
    rejected_at: row.rejected_at,
    superseded_by: row.superseded_by,
    created_at: row.created_at
  };
  const result = BundleLayerNodeSchema.safeParse({ ...common, kind: row.kind, ...data });
  if (result.success) return result.data;

  // Best-effort extraction of the discriminator(s) this build didn't
  // recognize, so the log names the actual unknown type instead of just
  // "validation failed".
  const shape =
    typeof data.shape === "object" && data.shape !== null
      ? (data.shape as Record<string, unknown>)
      : null;
  const effect =
    typeof data.effect === "object" && data.effect !== null
      ? (data.effect as Record<string, unknown>)
      : null;
  log.warn(
    "layers-repo: skipping a layer this build can't parse — likely a newer " +
      "layer/shape type from another branch; rendering the rest of the capture " +
      "without it. Add support (or rebuild on the branch that introduced it) to " +
      "surface this layer.",
    {
      captureId,
      layerId: row.id,
      layerKind: row.kind,
      unknownShapeKind: shape && typeof shape.kind === "string" ? shape.kind : undefined,
      unknownEffectType: effect && typeof effect.type === "string" ? effect.type : undefined,
      schemaVersion: row.schema_version,
      source: row.source,
      zodIssues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    }
  );
  return null;
}

/**
 * Read every "live" layer for a capture (applied, not rejected, not
 * superseded). Returns a flat array of BundleLayerNode, ordered by
 * (parent_id, z_index) so the caller can build a tree by parent_id
 * pointer in one O(n) pass.
 *
 * Throws if the tree depth exceeds MAX_TREE_DEPTH — malicious bundles
 * with 100k-deep parent_id chains could otherwise stall the
 * compositor.
 */
export function listLayerTree(captureId: string): BundleLayerNode[] {
  const rows = getDb()
    .prepare<[string], DbLayerRow>(
      `SELECT id, capture_id, parent_id, kind, z_index, name, visible,
              locked, opacity, blend_mode, transform_json, data,
              schema_version, source, ai_run_id, applied_at,
              rejected_at, superseded_by, created_at
         FROM layers
        WHERE capture_id = ?
          AND applied_at IS NOT NULL
          AND rejected_at IS NULL
          AND superseded_by IS NULL
        ORDER BY parent_id ASC NULLS FIRST, z_index ASC, created_at ASC`
    )
    .all(captureId);
  // Skip (don't throw on) rows this build can't parse — see tryRowToNode.
  // A single unknown layer must not blank the whole capture's render.
  const nodes: BundleLayerNode[] = [];
  for (const row of rows) {
    const node = tryRowToNode(row, captureId);
    if (node !== null) nodes.push(node);
  }
  assertTreeDepthBounded(nodes);
  return nodes;
}

function assertTreeDepthBounded(nodes: readonly BundleLayerNode[]): void {
  const byId = new Map<string, BundleLayerNode>();
  for (const node of nodes) byId.set(node.id, node);
  for (const node of nodes) {
    let depth = 0;
    let cur: BundleLayerNode | undefined = node;
    while (cur !== undefined && cur.parent_id !== null) {
      depth += 1;
      if (depth > MAX_TREE_DEPTH) {
        throw new Error(
          `layers-repo: layer-tree depth exceeded ${MAX_TREE_DEPTH} for capture (refusing to render)`
        );
      }
      cur = byId.get(cur.parent_id);
    }
  }
}

export type InsertLayerInput = {
  node: BundleLayerNode;
  captureId: string;
  /** Opt into the monotonic auto-bump behavior: when `true`, the
   *  resolved z_index for this insert is `MAX(existing z_index for
   *  this capture) + Z_INDEX_INSERT_GAP`, regardless of what
   *  `node.z_index` says. Use this for the fresh-draw paths (new
   *  arrow / rect / text / blur committed by the user) so the new
   *  layer lands STRICTLY ABOVE every existing layer.
   *
   *  When omitted / false, `node.z_index` is stored VERBATIM —
   *  including the legitimate value `0` (the position a layer
   *  reaches via "Send to Back" or via the `layers:reorder` /
   *  `computeNewOrder` pipeline which assigns `position × Z_GAP =
   *  0 × 1000 = 0` to whatever lands at the bottom of the stack).
   *
   *  Pre-fix this distinction was a HEURISTIC inside this function
   *  (`if (node.z_index !== 0) preserve else auto-bump`), which
   *  collided with the Send-to-Back case: a row at z_index = 0 sent
   *  through the dispatcher's updateGeometry delete-plus-insert was
   *  auto-bumped on the INSERT side, undoing the user's reorder
   *  every time they drag-dropped, nudged, or style-edited the
   *  rect. User repro: "I right-clicked the rotated red rectangle
   *  and chose Send to Back. I dragged it over to the arrows. It
   *  was behind them while dragging. I let go and it jumped in
   *  front of them."
   *
   *  Same fix shape in `overlays-repo.ts` — both v1 and v2 share
   *  the discipline. */
  bumpZIndexToMax?: boolean;
};

/**
 * Insert (or restore) a layer. Bumps `captures.edits_version` in the
 * same transaction so the cache buster + scheduleRepack convergence
 * checkpoint advance atomically with the layer write.
 *
 * Restore semantics: when a row with `node.id` already exists AND is
 * soft-deleted (`rejected_at IS NOT NULL`), this function un-rejects
 * the existing row and re-writes every mutable column from the
 * incoming node — the SAME table state a fresh INSERT would produce,
 * but without a primary-key violation. This is the load-bearing path
 * for delete-undo: `useUndoRedo.applyInverse` for the `delete` op
 * dispatches `layers:upsert` with the deleted node's original id, and
 * `layers:delete` is itself soft-delete-only (stamps `rejected_at`),
 * so a raw INSERT would always hit a UNIQUE constraint and silently
 * fail (`Result.err` swallowed by applyInverse → user reports
 * "Cmd+Z does nothing").
 *
 * Restore-with-update lets the caller pass a node whose mutable
 * fields (parent_id, z_index, transform, data, etc.) differ from
 * what was soft-deleted, and the restore lands in the new shape.
 * For delete-undo the shapes are identical so the UPDATE is a no-op
 * beyond clearing `rejected_at`, but the symmetry keeps the verb
 * honest as an UPSERT.
 *
 * If a LIVE row already exists at `node.id` (rejected_at IS NULL),
 * this is treated as a genuine conflict and the INSERT path runs —
 * SQLite raises the UNIQUE constraint, the handler returns
 * `insert_failed`. Callers that need to MUTATE a live layer should
 * use a dedicated update verb (none today; Phase 7 task).
 */
/** Gap between consecutive z_index values for monotonic-insert.
 *  Matches the renderer's `z-order.ts` Z_GAP and overlays-repo's
 *  Z_INDEX_INSERT_GAP — kept numerically consistent for mental
 *  modeling across the v1 / v2 / renderer boundary. */
const Z_INDEX_INSERT_GAP = 1000;

export function insertLayer(input: InsertLayerInput): BundleLayerNode {
  // zod-validate the node BEFORE persisting. The IPC handler also
  // validates, but a future internal caller could skip that path.
  const node = BundleLayerNodeSchema.parse(input.node);
  const db = getDb();
  const tx = db.transaction(() => {
    const { kindSpecificData, transformJson } = splitNodeForStorage(node);
    // Probe for an existing soft-deleted row at this id. We check
    // `rejected_at` (not just existence) so a colliding LIVE id
    // still hits the UNIQUE constraint on INSERT below — restoring
    // a live row would silently overwrite user state, which is
    // exactly the surprise the soft-delete pattern is designed to
    // prevent.
    const existing = db
      .prepare<[string], { rejected_at: string | null }>(
        `SELECT rejected_at FROM layers WHERE id = ?`
      )
      .get(node.id);
    if (existing !== undefined && existing.rejected_at !== null) {
      // Restore path. Clear rejected_at + refresh every mutable
      // column from the incoming node. The unchanged columns
      // (capture_id, created_at, schema_version) stay as-is —
      // capture_id can't change without rewriting FKs, created_at
      // is historical, schema_version is repo-managed.
      db.prepare(
        `UPDATE layers
            SET parent_id = @parent_id,
                kind = @kind,
                z_index = @z_index,
                name = @name,
                visible = @visible,
                locked = @locked,
                opacity = @opacity,
                blend_mode = @blend_mode,
                transform_json = @transform_json,
                data = @data,
                source = @source,
                ai_run_id = @ai_run_id,
                applied_at = @applied_at,
                rejected_at = NULL,
                superseded_by = @superseded_by
          WHERE id = @id`
      ).run({
        id: node.id,
        parent_id: node.parent_id,
        kind: node.kind,
        z_index: node.z_index,
        name: node.name,
        visible: node.visible ? 1 : 0,
        locked: node.locked ? 1 : 0,
        opacity: node.opacity,
        blend_mode: node.blend_mode,
        transform_json: transformJson,
        data: kindSpecificData,
        source: node.source,
        ai_run_id: node.ai_run_id,
        applied_at: node.applied_at,
        superseded_by: node.superseded_by
      });
      bumpEditsVersion(input.captureId);
      return;
    }
    // Compute the z_index for the INSERT path. The caller's
    // EXPLICIT `bumpZIndexToMax` flag determines behavior:
    //
    //   • `bumpZIndexToMax: true` — the fresh-draw path. Resolve to
    //     `MAX(existing z_index for this capture) + Z_INDEX_INSERT_GAP`
    //     so the new layer lands STRICTLY ABOVE every existing layer
    //     in `ORDER BY z_index ASC`. MAX considers ALL rows including
    //     soft-deleted so a re-insert after undo-of-delete still lands
    //     above any layers added in the meantime.
    //
    //   • Omitted / false — preserve `node.z_index` verbatim, including
    //     0. This is the update-in-place path (drag-drop, nudge, multi-
    //     drag, style patch, undo restore) where the caller already
    //     knows the right z_index and just wants the row materialized
    //     with it.
    //
    // Pre-fix this branch checked `if (node.z_index !== 0)` as a
    // heuristic, which collided with the Send-to-Back case (z_index
    // legitimately 0). See the `bumpZIndexToMax` doc-block on
    // InsertLayerInput above for the full repro.
    let resolvedZIndex: number;
    if (input.bumpZIndexToMax === true) {
      const row = db
        .prepare<[string], { max_z: number | null }>(
          `SELECT MAX(z_index) AS max_z FROM layers WHERE capture_id = ?`
        )
        .get(input.captureId);
      resolvedZIndex =
        row?.max_z !== null && row?.max_z !== undefined
          ? row.max_z + Z_INDEX_INSERT_GAP
          : 0;
    } else {
      resolvedZIndex = node.z_index;
    }
    db.prepare(
      `INSERT INTO layers
         (id, capture_id, parent_id, kind, z_index, name, visible,
          locked, opacity, blend_mode, transform_json, data,
          schema_version, source, ai_run_id, applied_at,
          rejected_at, superseded_by, created_at)
       VALUES
         (@id, @capture_id, @parent_id, @kind, @z_index, @name, @visible,
          @locked, @opacity, @blend_mode, @transform_json, @data,
          1, @source, @ai_run_id, @applied_at,
          @rejected_at, @superseded_by, @created_at)`
    ).run({
      id: node.id,
      capture_id: input.captureId,
      parent_id: node.parent_id,
      kind: node.kind,
      z_index: resolvedZIndex,
      name: node.name,
      visible: node.visible ? 1 : 0,
      locked: node.locked ? 1 : 0,
      opacity: node.opacity,
      blend_mode: node.blend_mode,
      transform_json: transformJson,
      data: kindSpecificData,
      source: node.source,
      ai_run_id: node.ai_run_id,
      applied_at: node.applied_at,
      rejected_at: node.rejected_at,
      superseded_by: node.superseded_by,
      created_at: node.created_at
    });
    bumpEditsVersion(input.captureId);
  });
  tx();
  return loadLayer(node.id);
}

export type UpdateLayerInput = {
  node: BundleLayerNode;
  captureId: string;
};

export function updateLayer(input: UpdateLayerInput): BundleLayerNode | null {
  const node = BundleLayerNodeSchema.parse(input.node);
  const db = getDb();
  let updated = false;
  const tx = db.transaction(() => {
    const existing = db
      .prepare<[string], { capture_id: string; rejected_at: string | null; superseded_by: string | null }>(
        `SELECT capture_id, rejected_at, superseded_by FROM layers WHERE id = ?`
      )
      .get(node.id);
    if (
      existing === undefined ||
      existing.capture_id !== input.captureId ||
      existing.rejected_at !== null ||
      existing.superseded_by !== null
    ) {
      return;
    }

    const { kindSpecificData, transformJson } = splitNodeForStorage(node);
    db.prepare(
      `UPDATE layers
          SET parent_id = @parent_id,
              kind = @kind,
              z_index = @z_index,
              name = @name,
              visible = @visible,
              locked = @locked,
              opacity = @opacity,
              blend_mode = @blend_mode,
              transform_json = @transform_json,
              data = @data,
              source = @source,
              ai_run_id = @ai_run_id,
              applied_at = @applied_at,
              rejected_at = NULL,
              superseded_by = NULL
        WHERE id = @id
          AND capture_id = @capture_id
          AND rejected_at IS NULL
          AND superseded_by IS NULL`
    ).run({
      id: node.id,
      capture_id: input.captureId,
      parent_id: node.parent_id,
      kind: node.kind,
      z_index: node.z_index,
      name: node.name,
      visible: node.visible ? 1 : 0,
      locked: node.locked ? 1 : 0,
      opacity: node.opacity,
      blend_mode: node.blend_mode,
      transform_json: transformJson,
      data: kindSpecificData,
      source: node.source,
      ai_run_id: node.ai_run_id,
      applied_at: node.applied_at
    });
    bumpEditsVersion(input.captureId);
    updated = true;
  });
  tx();
  return updated ? loadLayer(node.id) : null;
}

/**
 * Bulk insert — used by the legacy migration + the future v1→v2
 * migration to populate a tree atomically. Validates each node;
 * bumps edits_version once at the end.
 */
export function insertLayerTreeForCapture(
  captureId: string,
  nodes: readonly BundleLayerNode[]
): void {
  for (const node of nodes) BundleLayerNodeSchema.parse(node);
  const db = getDb();
  const tx = db.transaction(() => {
    for (const node of nodes) {
      const { kindSpecificData, transformJson } = splitNodeForStorage(node);
      db.prepare(
        `INSERT INTO layers
           (id, capture_id, parent_id, kind, z_index, name, visible,
            locked, opacity, blend_mode, transform_json, data,
            schema_version, source, ai_run_id, applied_at,
            rejected_at, superseded_by, created_at)
         VALUES
           (@id, @capture_id, @parent_id, @kind, @z_index, @name, @visible,
            @locked, @opacity, @blend_mode, @transform_json, @data,
            1, @source, @ai_run_id, @applied_at,
            @rejected_at, @superseded_by, @created_at)`
      ).run({
        id: node.id,
        capture_id: captureId,
        parent_id: node.parent_id,
        kind: node.kind,
        z_index: node.z_index,
        name: node.name,
        visible: node.visible ? 1 : 0,
        locked: node.locked ? 1 : 0,
        opacity: node.opacity,
        blend_mode: node.blend_mode,
        transform_json: transformJson,
        data: kindSpecificData,
        source: node.source,
        ai_run_id: node.ai_run_id,
        applied_at: node.applied_at,
        rejected_at: node.rejected_at,
        superseded_by: node.superseded_by,
        created_at: node.created_at
      });
    }
    if (nodes.length > 0) bumpEditsVersion(captureId);
  });
  tx();
}

/**
 * Reparent a layer to a new parent (or root via newParentId = null).
 * Wrapped in BEGIN IMMEDIATE so the cycle check + UPDATE serialize
 * with other writers — without this, two concurrent reparents could
 * each pass their independent check but commit a cycle.
 *
 * Refuses cycles via a recursive CTE inside the same TX: walk
 * parent_id from newParentId; if movingId appears, refuse.
 */
export function reparent(
  movingId: string,
  newParentId: string | null
): "ok" | "would_create_cycle" | "not_found" {
  if (movingId === newParentId) return "would_create_cycle";
  const db = getDb();
  let result: "ok" | "would_create_cycle" | "not_found" = "not_found";
  // db.transaction wraps in BEGIN/COMMIT (DEFERRED by default in
  // better-sqlite3 v12). Use exclusive() to upgrade to IMMEDIATE so
  // the write lock is acquired BEFORE the cycle check — closes the
  // race window between check and UPDATE.
  const tx = db.transaction(() => {
    const row = db
      .prepare<[string], { capture_id: string }>(
        `SELECT capture_id FROM layers WHERE id = ?`
      )
      .get(movingId);
    if (row === undefined) {
      result = "not_found";
      return;
    }
    if (newParentId !== null) {
      // Verify the new parent exists and lives in the same capture.
      const parent = db
        .prepare<[string], { capture_id: string }>(
          `SELECT capture_id FROM layers WHERE id = ?`
        )
        .get(newParentId);
      if (parent === undefined || parent.capture_id !== row.capture_id) {
        result = "not_found";
        return;
      }
      // Cycle check: walk parent_id chain from newParentId. If
      // movingId appears anywhere in the ancestor chain, reparenting
      // would create a cycle.
      const cycle = db
        .prepare<{ start: string; moving: string }, { id: string }>(
          `WITH RECURSIVE chain(id, depth) AS (
             SELECT @start AS id, 0 AS depth
             UNION ALL
             SELECT l.parent_id AS id, chain.depth + 1
               FROM layers l
               JOIN chain ON l.id = chain.id
              WHERE l.parent_id IS NOT NULL
                AND chain.depth < ${MAX_TREE_DEPTH}
           )
           SELECT id FROM chain WHERE id = @moving LIMIT 1`
        )
        .get({ start: newParentId, moving: movingId });
      if (cycle !== undefined) {
        result = "would_create_cycle";
        return;
      }
    }
    db.prepare<[string | null, string]>(
      `UPDATE layers SET parent_id = ? WHERE id = ?`
    ).run(newParentId, movingId);
    bumpEditsVersion(row.capture_id);
    result = "ok";
  });
  // .exclusive() returns a wrapped transaction that uses BEGIN IMMEDIATE.
  tx.exclusive();
  return result;
}

/**
 * Reorder a layer within its parent's siblings. Atomic UPDATE on
 * z_index. Caller computes the new z_index value (renderer typically
 * uses gaps like 1000-step increments so most reorders avoid touching
 * neighbors).
 */
export function setLayerZIndex(id: string, zIndex: number): void {
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare<[string], { capture_id: string }>(
        `SELECT capture_id FROM layers WHERE id = ?`
      )
      .get(id);
    if (row === undefined) return;
    db.prepare<[number, string]>(`UPDATE layers SET z_index = ? WHERE id = ?`).run(zIndex, id);
    bumpEditsVersion(row.capture_id);
  });
  tx();
}

/**
 * Soft-delete a layer + transitively cascade rejected_at to every
 * descendant in one transaction. Without the transitive cascade,
 * children remain "live" (`rejected_at IS NULL`) while their parent
 * group is rejected — the live-rows filter treats them as legitimate,
 * the compositor renders orphans-at-root, undefined behavior follows.
 *
 * Returns the capture id so the caller can broadcast layersChanged.
 */
export function rejectLayer(id: string): string | null {
  const now = new Date().toISOString();
  const db = getDb();
  let captureId: string | null = null;
  const tx = db.transaction(() => {
    const row = db
      .prepare<[string], { capture_id: string }>(
        `SELECT capture_id FROM layers WHERE id = ? AND rejected_at IS NULL`
      )
      .get(id);
    if (row === undefined) return;
    captureId = row.capture_id;

    // Recursive CTE: collect this node + every descendant. Bounded
    // by MAX_TREE_DEPTH to defend against pathological trees.
    db.prepare<{ root: string; stamp: string }>(
      `WITH RECURSIVE descendants(id, depth) AS (
         SELECT @root AS id, 0 AS depth
         UNION ALL
         SELECT l.id, descendants.depth + 1
           FROM layers l
           JOIN descendants ON l.parent_id = descendants.id
          WHERE descendants.depth < ${MAX_TREE_DEPTH}
       )
       UPDATE layers
          SET rejected_at = @stamp
        WHERE id IN (SELECT id FROM descendants)
          AND rejected_at IS NULL`
    ).run({ root: id, stamp: now });

    bumpEditsVersion(row.capture_id);
  });
  tx();
  return captureId;
}

/**
 * Inverse of rejectLayer. Only un-stamps descendants whose
 * rejected_at matches the parent group's stamp — children that were
 * independently rejected before the group stay rejected.
 */
export function restoreLayer(id: string): string | null {
  const db = getDb();
  let captureId: string | null = null;
  const tx = db.transaction(() => {
    const row = db
      .prepare<[string], { capture_id: string; rejected_at: string | null }>(
        `SELECT capture_id, rejected_at FROM layers WHERE id = ?`
      )
      .get(id);
    if (row === undefined || row.rejected_at === null) return;
    captureId = row.capture_id;
    const stamp = row.rejected_at;
    db.prepare<{ root: string; stamp: string }>(
      `WITH RECURSIVE descendants(id, depth) AS (
         SELECT @root AS id, 0 AS depth
         UNION ALL
         SELECT l.id, descendants.depth + 1
           FROM layers l
           JOIN descendants ON l.parent_id = descendants.id
          WHERE descendants.depth < ${MAX_TREE_DEPTH}
       )
       UPDATE layers
          SET rejected_at = NULL
        WHERE id IN (SELECT id FROM descendants)
          AND rejected_at = @stamp`
    ).run({ root: id, stamp });
    bumpEditsVersion(row.capture_id);
  });
  tx();
  return captureId;
}

// ── helpers ─────────────────────────────────────────────────────────

function bumpEditsVersion(captureId: string): void {
  getDb()
    .prepare<[string]>(
      `UPDATE captures SET edits_version = edits_version + 1 WHERE id = ?`
    )
    .run(captureId);
}

/**
 * Stripe the columns out of a BundleLayerNode that live as their own
 * row columns (transform, common props) and serialize the kind-specific
 * remainder into the `data` JSON blob. Inverse of rowToNode.
 */
function splitNodeForStorage(node: BundleLayerNode): {
  transformJson: string;
  kindSpecificData: string;
} {
  // Strip the common props (which become row columns) from the
  // serialized JSON so we don't double-store them.
  const { kind } = node;
  let kindSpecific: Record<string, unknown>;
  switch (kind) {
    case "group":
      kindSpecific = { collapsed: node.collapsed };
      break;
    case "raster":
      kindSpecific = {
        source_ref: node.source_ref,
        natural_width_px: node.natural_width_px,
        natural_height_px: node.natural_height_px
      };
      break;
    case "vector":
      kindSpecific = { shape: node.shape };
      break;
    case "effect":
      kindSpecific = { effect: node.effect, clip_rect: node.clip_rect };
      break;
  }
  return {
    transformJson: JSON.stringify(node.transform),
    kindSpecificData: JSON.stringify(kindSpecific)
  };
}

function loadLayer(id: string): BundleLayerNode {
  const row = getDb()
    .prepare<[string], DbLayerRow>(
      `SELECT id, capture_id, parent_id, kind, z_index, name, visible,
              locked, opacity, blend_mode, transform_json, data,
              schema_version, source, ai_run_id, applied_at,
              rejected_at, superseded_by, created_at
         FROM layers WHERE id = ?`
    )
    .get(id);
  if (row === undefined) {
    throw new Error(`layers-repo: layer ${id} not found after insert (impossible)`);
  }
  // STRICT: this reloads a layer we just wrote + schema-validated, so a
  // parse failure here is a real bug (not a forward-compat unknown
  // type) — throw rather than silently drop it.
  const node = tryRowToNode(row, row.capture_id);
  if (node === null) {
    throw new Error(
      `layers-repo: just-written layer ${id} (kind=${row.kind}) failed to re-parse`
    );
  }
  return node;
}
