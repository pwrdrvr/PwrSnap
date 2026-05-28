// Tests for `insertLayer`'s restore-soft-deleted-row path. Covers the
// load-bearing case for delete-undo: `useUndoRedo.applyInverse` for
// the `delete` op dispatches `layers:upsert` with the deleted node's
// ORIGINAL id, and `layers:delete` is itself soft-delete-only (stamps
// `rejected_at`). Pre-fix, `insertLayer` always did a raw INSERT →
// SQLite UNIQUE constraint violation against the soft-deleted row →
// error swallowed by applyInverse → user reports "Cmd+Z does nothing
// after deleting a layer."
//
// Three scenarios pinned here:
//   1. Re-insert with the same id as a soft-deleted row → restore
//      (clear rejected_at, refresh mutable fields).
//   2. Re-insert with the same id as a LIVE row → still throws
//      (UNIQUE constraint) — we don't want silent overwrite of an
//      active layer.
//   3. Restore preserves capture_id + created_at (immutable
//      columns), updates everything else from the incoming node.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BundleLayerNode } from "@pwrsnap/shared";

let testDb: Database.Database;

vi.mock("../db", () => ({
  getDb: () => testDb
}));

const { insertLayer, rejectLayer } = await import("../layers-repo");

function applyAllMigrations(): void {
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  testDb.pragma("foreign_keys = OFF");
  for (const file of files) {
    testDb.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  testDb.pragma("foreign_keys = ON");
}

function seedV2Capture(id: string): void {
  testDb
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name,
        legacy_src_path, bundle_path, flat_png_path,
        bundle_modified_at, bundle_format_version, bundle_edits_version,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, edits_version, deleted_at
      ) VALUES (
        @id, 'image', '2026-05-24T12:00:00.000Z',
        NULL, NULL,
        NULL, @bundlePath, NULL,
        '2026-05-24T12:00:00.000Z', 2, 0,
        1000, 1000, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, bundlePath: `/tmp/${id}.pwrsnap`, sha: `sha_${id}` });
}

function makeVectorNode(id: string, parentId: string): BundleLayerNode {
  // Arrow vector — the kind a user would draw and Delete + Cmd+Z. Body
  // is identical to what the renderer dispatches.
  return {
    id,
    parent_id: parentId,
    kind: "vector",
    shape: {
      kind: "arrow",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.9 },
      color: "auto"
    },
    name: "Arrow",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 1000,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-05-24T12:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-05-24T12:00:00.000Z"
  };
}

function makeRootGroup(id: string): BundleLayerNode {
  return {
    id,
    parent_id: null,
    kind: "group",
    collapsed: false,
    name: "Root",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-05-24T12:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-05-24T12:00:00.000Z"
  };
}

beforeEach(() => {
  testDb = new Database(":memory:");
  applyAllMigrations();
  seedV2Capture("cap_test");
  insertLayer({ captureId: "cap_test", node: makeRootGroup("root_test_xxxxxx") });
});

afterEach(() => {
  testDb.close();
});

describe("insertLayer — restore on soft-deleted id collision", () => {
  test("re-inserting a soft-deleted id un-rejects the row (delete-undo path)", () => {
    const node = makeVectorNode("vec_arrow_test_x", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node });

    // Simulate the user's Delete press — soft-deletes the layer.
    rejectLayer(node.id);
    const afterDelete = testDb
      .prepare<[string], { rejected_at: string | null }>(
        `SELECT rejected_at FROM layers WHERE id = ?`
      )
      .get(node.id);
    expect(afterDelete?.rejected_at).not.toBeNull();

    // Simulate Cmd+Z — applyInverse re-dispatches the original node
    // through `layers:upsert` (→ insertLayer). Pre-fix this threw a
    // UNIQUE constraint error; the fix restores instead.
    expect(() =>
      insertLayer({ captureId: "cap_test", node })
    ).not.toThrow();

    const afterRestore = testDb
      .prepare<[string], { rejected_at: string | null }>(
        `SELECT rejected_at FROM layers WHERE id = ?`
      )
      .get(node.id);
    expect(afterRestore?.rejected_at).toBeNull();
  });

  test("re-inserting a LIVE id still throws (no silent overwrite)", () => {
    // The restore path is gated on rejected_at !== null. If the row
    // is alive, the INSERT runs and SQLite raises UNIQUE constraint.
    // This protects against accidentally clobbering an active layer
    // via a buggy caller — the soft-delete pattern intentionally
    // keeps "delete then immediately re-create with same id" as a
    // distinct gesture from "mutate this live layer."
    const node = makeVectorNode("vec_live_collide", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node });

    expect(() =>
      insertLayer({ captureId: "cap_test", node })
    ).toThrow(/UNIQUE constraint failed/);
  });

  test("restore refreshes mutable fields from the incoming node", () => {
    // The applyInverse path passes the SAME node that was deleted,
    // so for delete-undo this is a no-op beyond clearing rejected_at.
    // But a defensive caller that needs to restore-with-update should
    // see the new fields land. This documents that the restore is a
    // true upsert, not a "just clear rejected_at and keep stale data"
    // shortcut.
    const original = makeVectorNode("vec_mut_test_yxx", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: original });
    rejectLayer(original.id);

    // Modify several mutable fields before re-inserting.
    const updated: BundleLayerNode = {
      ...original,
      z_index: 5000,
      opacity: 0.5,
      name: "Renamed Arrow",
      visible: false
    };
    insertLayer({ captureId: "cap_test", node: updated });

    const row = testDb
      .prepare<[string], { z_index: number; opacity: number; name: string; visible: number; rejected_at: string | null }>(
        `SELECT z_index, opacity, name, visible, rejected_at
           FROM layers WHERE id = ?`
      )
      .get(original.id);
    expect(row?.z_index).toBe(5000);
    expect(row?.opacity).toBe(0.5);
    expect(row?.name).toBe("Renamed Arrow");
    expect(row?.visible).toBe(0);
    expect(row?.rejected_at).toBeNull();
  });

  test("delete-then-undo cycle is repeatable (delete → undo → delete → undo)", () => {
    // Pin the inverse: after restoring, the row should be deletable
    // again, and the next undo should restore again. Without this,
    // a user who undid a delete and then re-deleted (or who undid
    // past a delete-restore boundary) would see the chain break.
    const node = makeVectorNode("vec_repeat_xxxx1", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node });

    rejectLayer(node.id);
    insertLayer({ captureId: "cap_test", node }); // undo 1
    rejectLayer(node.id);
    expect(() =>
      insertLayer({ captureId: "cap_test", node }) // undo 2
    ).not.toThrow();

    const final = testDb
      .prepare<[string], { rejected_at: string | null }>(
        `SELECT rejected_at FROM layers WHERE id = ?`
      )
      .get(node.id);
    expect(final?.rejected_at).toBeNull();
  });
});
