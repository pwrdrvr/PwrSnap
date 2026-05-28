// Tests for `insertLayer`'s z_index assignment. Mirror of
// `overlays-repo-zindex.test.ts` for the v2 layer-tree side. Same
// user-reported bug class: "I drew an arrow then another over it.
// The 2nd arrow showed it would be on top during the drag, then
// dove under the first on commit." Pre-fix every new v2 layer was
// inserted at z_index = 0 (the renderer's overlayToBundleLayerNode
// hardcoded it); ties on z_index + created_at within the same
// millisecond produced implementation-defined SQLite ordering.
//
// Fix: insertLayer auto-bumps to MAX(existing) + Z_GAP when the
// caller passes z_index = 0 (the default from
// overlayToBundleLayerNode). Caller-supplied non-zero z_index wins
// — that path is used by `layers:reorder` and v1-to-v2 migration.

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

function makeArrow(id: string, parentId: string, zIndex: number = 0): BundleLayerNode {
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
    z_index: zIndex,
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

describe("insertLayer — monotonic z_index assignment", () => {
  test("first vector layer auto-bumps above the root group's z_index (=0)", () => {
    // beforeEach inserts the root group at z_index = 0. With the
    // monotonic-insert auto-bump, the first vector lands at
    // MAX(existing) + GAP = 0 + 1000 = 1000. Exact value isn't
    // load-bearing; what matters is it's STRICTLY GREATER than the
    // root group (so the root group renders first → painted below).
    const node = makeArrow("vec_test_first_a", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node });
    const row = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get(node.id);
    expect(row?.z_index).toBeGreaterThan(0);
  });

  test("second layer with z_index=0 gets STRICTLY GREATER z_index than the first (auto-bump)", () => {
    // The user-reported bug. Pre-fix both rows landed at z_index = 0
    // and the renderer's render order was non-deterministic
    // (implementation-defined SQLite behavior on full ties). The
    // fix auto-bumps when the caller passes 0 so newer rows
    // always land above existing ones.
    const a = makeArrow("vec_test_secnd_a", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: a });
    const b = makeArrow("vec_test_secnd_b", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: b });
    const rowA = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get(a.id);
    const rowB = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get(b.id);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowB!.z_index).toBeGreaterThan(rowA!.z_index);
  });

  test("listLayerTree returns layers in z_index ASC + created_at ASC order (newest LAST)", async () => {
    const { listLayerTree } = await import("../layers-repo");
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_test_order_a", "root_test_xxxxxx")
    });
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_test_order_b", "root_test_xxxxxx")
    });
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_test_order_c", "root_test_xxxxxx")
    });
    const tree = listLayerTree("cap_test");
    // Filter to vectors (root group is first, ordered NULLS FIRST).
    const arrows = tree.filter((n) => n.kind === "vector");
    expect(arrows.map((n) => n.id)).toEqual([
      "vec_test_order_a",
      "vec_test_order_b",
      "vec_test_order_c"
    ]);
  });

  test("explicit non-zero z_index wins (reorder dispatcher path)", () => {
    // `layers:reorder` and the v1→v2 migration both pass explicit
    // z_index values. Auto-bump must NOT clobber them; only the
    // "caller didn't care" case (z_index === 0) gets the bump.
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_explzi_xxxx1", "root_test_xxxxxx", 5000)
    });
    const row = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get("vec_explzi_xxxx1");
    expect(row?.z_index).toBe(5000);
  });

  test("re-inserting after delete still goes ON TOP (above the deleted layer's z_index)", () => {
    // Same monotonic discipline as overlays-repo: MAX over ALL
    // rows (not just live ones) so an undo-of-delete restoring
    // the deleted layer puts it BELOW any rows added in the
    // meantime, not on top.
    const first = makeArrow("vec_delret_xxxx1", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: first });
    rejectLayer(first.id);
    const second = makeArrow("vec_delret_xxxx2", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: second });
    const rowFirst = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get(first.id);
    const rowSecond = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get(second.id);
    expect(rowSecond!.z_index).toBeGreaterThan(rowFirst!.z_index);
  });
});
