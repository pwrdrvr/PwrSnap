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
 * Hydrate a DB row into a BundleLayerNode. The zod schema is the
 * authoritative shape — re-validate on every read so a future
 * migration that re-shapes `data` doesn't escape the boundary
 * un-typed. Same discipline as overlays-repo's rowToRecord.
 */
function rowToNode(row: DbLayerRow): BundleLayerNode {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  const transform = JSON.parse(row.transform_json) as [
    number, number, number, number, number, number
  ];
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
  return BundleLayerNodeSchema.parse({ ...common, kind: row.kind, ...data });
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
  const nodes = rows.map(rowToNode);
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
};

/**
 * Insert a brand-new layer. Bumps `captures.edits_version` in the same
 * transaction so the cache buster + scheduleRepack convergence checkpoint
 * advance atomically with the layer write.
 */
export function insertLayer(input: InsertLayerInput): BundleLayerNode {
  // zod-validate the node BEFORE persisting. The IPC handler also
  // validates, but a future internal caller could skip that path.
  const node = BundleLayerNodeSchema.parse(input.node);
  const db = getDb();
  const tx = db.transaction(() => {
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
  return rowToNode(row);
}
