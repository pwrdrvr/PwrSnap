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
  test("first vector layer with bumpZIndexToMax=true auto-bumps above the root group's z_index (=0)", () => {
    // beforeEach inserts the root group at z_index = 0. Fresh-draw
    // callers (commitArrow / commitRect / etc.) pass
    // `bumpZIndexToMax: true` so the new layer lands strictly above
    // existing layers. Without the explicit signal under the new API
    // the repo would store node.z_index = 0 verbatim.
    const node = makeArrow("vec_test_first_a", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node, bumpZIndexToMax: true });
    const row = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get(node.id);
    expect(row?.z_index).toBeGreaterThan(0);
  });

  test("second layer with bumpZIndexToMax=true gets STRICTLY GREATER z_index than the first", () => {
    // User-reported bug regression. Pre-fix both rows landed at
    // z_index = 0 and the renderer's render order was non-deterministic
    // (implementation-defined SQLite tiebreaker). The monotonic
    // auto-bump (now opt-in via bumpZIndexToMax) guarantees newer
    // rows always land above existing ones for the fresh-draw path.
    const a = makeArrow("vec_test_secnd_a", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: a, bumpZIndexToMax: true });
    const b = makeArrow("vec_test_secnd_b", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: b, bumpZIndexToMax: true });
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
      node: makeArrow("vec_test_order_a", "root_test_xxxxxx"),
      bumpZIndexToMax: true
    });
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_test_order_b", "root_test_xxxxxx"),
      bumpZIndexToMax: true
    });
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_test_order_c", "root_test_xxxxxx"),
      bumpZIndexToMax: true
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

  test("explicit non-zero z_index without bumpZIndexToMax preserves the value (reorder dispatcher path)", () => {
    // `layers:reorder` is a single-row UPDATE (not delete-plus-insert),
    // so it doesn't hit this code path — but the v1→v2 migration and
    // updateGeometry's restore path both insertLayer with a specific
    // z_index they want preserved. Verifies the default (no
    // bumpZIndexToMax) does NOT clobber the caller's value.
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

  // ───────────────────────────────────────────────────────────────────────
  // updateGeometry / updateOverlay z_index preservation (user-reported
  // bug on PR #150 follow-up):
  //
  //   "I right-clicked the rotated red rectangle and chose Send to Back.
  //   I then dragged it over to the arrows. It was behind them while
  //   dragging. I let go of the mouse and it jumped in front of them."
  //
  // The dispatcher's updateGeometry / updateOverlay implement edit-in-
  // place as DELETE + INSERT. Pre-fix, the INSERT path saw `z_index = 0`
  // on the merged node (because Send to Back legitimately set it to 0)
  // and the heuristic `if (node.z_index !== 0)` couldn't tell that case
  // apart from "fresh draw with default z_index = 0" — so the
  // intended-Send-to-Back rect got auto-bumped to MAX + GAP on every
  // drag-drop / nudge / style-patch.
  //
  // The fix changes the auto-bump from a heuristic on the value to an
  // EXPLICIT signal: callers pass `bumpZIndexToMax: true` ONLY when
  // they want the new-fresh-draw behavior. updateGeometry /
  // updateOverlay / undo-restore leave it off, and `node.z_index` is
  // honored verbatim — including 0.
  // ───────────────────────────────────────────────────────────────────────

  test("bumpZIndexToMax=true bumps to MAX(existing) + GAP regardless of node.z_index", () => {
    // Fresh-draw path: caller passes a stub z_index (typically 0) and
    // asks us to figure out the right top-of-stack value. Same shape
    // as the legacy implicit auto-bump but now opted into.
    const existing = makeArrow("vec_explbu_xxxx1", "root_test_xxxxxx", 3000);
    insertLayer({ captureId: "cap_test", node: existing });
    const fresh = makeArrow("vec_explbu_xxxx2", "root_test_xxxxxx", 0);
    insertLayer({
      captureId: "cap_test",
      node: fresh,
      bumpZIndexToMax: true
    });
    const row = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get(fresh.id);
    expect(row?.z_index).toBe(3000 + 1000);
  });

  test("bumpZIndexToMax omitted preserves node.z_index = 0 verbatim (Send-to-Back regression)", () => {
    // The load-bearing assertion. A row at z_index = 0 (legitimately
    // sent to the back via the reorder pipeline) goes through
    // updateGeometry's delete-plus-insert. The merged node still
    // carries z_index = 0; the repo must store it as 0, not bump it.
    // Pre-fix THIS TEST FAILS — the heuristic auto-bumped.
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_zixzro_xxxx1", "root_test_xxxxxx", 5000),
      bumpZIndexToMax: true
    });
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_zixzro_xxxx2", "root_test_xxxxxx", 0)
      // bumpZIndexToMax omitted → preserve z_index = 0
    });
    const row = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get("vec_zixzro_xxxx2");
    expect(row?.z_index).toBe(0);
  });

  test("bumpZIndexToMax omitted preserves node.z_index > 0 verbatim", () => {
    // Mid-stack preservation. updateGeometry on a row at z_index = 1000
    // should keep it at 1000 across the delete-plus-insert. Pre-fix
    // the heuristic-based check happened to preserve this case (because
    // z_index !== 0), so this test passes before AND after the fix —
    // included as a regression guard that the new explicit signal
    // doesn't accidentally break the formerly-working case.
    insertLayer({
      captureId: "cap_test",
      node: makeArrow("vec_zixnon_xxxx1", "root_test_xxxxxx", 1000)
    });
    const row = testDb
      .prepare<[string], { z_index: number }>(
        `SELECT z_index FROM layers WHERE id = ?`
      )
      .get("vec_zixnon_xxxx1");
    expect(row?.z_index).toBe(1000);
  });

  test("fresh-draw re-insert after delete still goes ON TOP (above the deleted layer's z_index)", () => {
    // bumpZIndexToMax-mode considers ALL rows in the MAX (including
    // soft-deleted) so a fresh draw made after a delete still lands
    // above the deleted row's z_index — important because the bake
    // doesn't see the deleted row but the renderer's render-order
    // sort would otherwise produce ambiguous results if we re-used
    // the same z_index.
    const first = makeArrow("vec_delret_xxxx1", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: first, bumpZIndexToMax: true });
    rejectLayer(first.id);
    const second = makeArrow("vec_delret_xxxx2", "root_test_xxxxxx");
    insertLayer({ captureId: "cap_test", node: second, bumpZIndexToMax: true });
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
