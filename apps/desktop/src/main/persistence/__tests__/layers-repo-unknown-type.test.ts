// Forward-compatibility: a capture edited on a newer / sibling build can
// carry a layer kind — or, more often, a vector `shape.kind` (circle /
// oval / square / triangle …) — that THIS build's discriminated unions
// don't include yet. listLayerTree must SKIP such rows (with a dense
// log) rather than throw, so one unknown layer doesn't blank the whole
// capture's render (the symptom was a 500 from the pwrsnap-cache://
// protocol handler → broken thumbnail). Write paths stay strict.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BundleLayerNode } from "@pwrsnap/shared";

let testDb: Database.Database;

vi.mock("../db", () => ({
  getDb: () => testDb
}));

const { insertLayer, listLayerTree } = await import("../layers-repo");

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

function makeArrow(id: string, parentId: string): BundleLayerNode {
  return {
    id,
    parent_id: parentId,
    kind: "vector",
    shape: { kind: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.9 }, color: "auto" },
    name: "Arrow",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 10,
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

describe("listLayerTree forward-compat (unknown layer/shape types)", () => {
  test("skips a vector layer with an unknown shape.kind, keeps the rest", () => {
    insertLayer({ captureId: "cap_test", node: makeArrow("arrowvalid000001", "root_test_xxxxxx") });
    insertLayer({ captureId: "cap_test", node: makeArrow("arrowunknown0001", "root_test_xxxxxx") });

    // Simulate a newer build's shape type by rewriting the row's `data`
    // blob to a shape.kind this build's Overlay union doesn't include.
    // insertLayer itself is strict, so we go around it via direct SQL —
    // exactly the cross-branch situation: the row was written by a build
    // that DID understand "circle".
    testDb
      .prepare(`UPDATE layers SET data = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          shape: { kind: "circle", center: { x: 0.5, y: 0.5 }, radius: 0.1, color: "auto" }
        }),
        "arrowunknown0001"
      );

    let nodes: BundleLayerNode[] = [];
    expect(() => {
      nodes = listLayerTree("cap_test");
    }).not.toThrow();

    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("root_test_xxxxxx");
    expect(ids).toContain("arrowvalid000001");
    expect(ids).not.toContain("arrowunknown0001");
  });

  test("skips an effect layer with an unknown effect.type, keeps the rest", () => {
    insertLayer({ captureId: "cap_test", node: makeArrow("arrowvalid000002", "root_test_xxxxxx") });
    insertLayer({ captureId: "cap_test", node: makeArrow("futurekind000001", "root_test_xxxxxx") });

    // A future EFFECT type (the other discriminated union). The row's
    // top-level `kind` stays 'effect' (the layers.kind CHECK constraint
    // only permits group/raster/vector/effect), but the inner
    // effect.type discriminator is one this build doesn't know — e.g. a
    // "duotone" effect a later build introduces.
    testDb
      .prepare(`UPDATE layers SET kind = ?, data = ? WHERE id = ?`)
      .run(
        "effect",
        JSON.stringify({ effect: { type: "duotone" }, clip_rect: { x: 1, y: 1, w: 1, h: 1 } }),
        "futurekind000001"
      );

    let nodes: BundleLayerNode[] = [];
    expect(() => {
      nodes = listLayerTree("cap_test");
    }).not.toThrow();

    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("arrowvalid000002");
    expect(ids).not.toContain("futurekind000001");
  });
});
