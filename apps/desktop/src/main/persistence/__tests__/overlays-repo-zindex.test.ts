// Tests for `insertOverlay`'s z_index assignment. Regression coverage
// for: "I drew an arrow. Then drew another arrow crossing it. The 2nd
// arrow showed it would be on top during the drag. When I let the
// mouse go, the 2nd arrow 'dove under' the 1st arrow."
//
// Root cause: pre-fix every new overlay got z_index = 0. The render
// query is `ORDER BY z_index ASC, created_at ASC` — with both
// columns tied (two rapid clicks land in the same millisecond),
// SQLite's tiebreaker is implementation-defined. The user observed
// the implementation-defined order putting the older overlay AFTER
// the newer one, which paints the newer one BELOW the older one in
// the renderer's array-order SVG paint loop.
//
// Fix: insertOverlay computes the next z_index inline as
// `MAX(existing) + Z_GAP_V1` so newer rows always have a STRICTLY
// GREATER z_index than any current row. ORDER BY z_index ASC then
// puts newer rows LAST → painted last → on top, deterministically.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;

vi.mock("../db", () => ({
  getDb: () => testDb
}));

const { insertOverlay, listLiveOverlays, rejectOverlay } = await import(
  "../overlays-repo"
);

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

function seedV1Capture(id: string): void {
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
        NULL, NULL, NULL,
        NULL, 1, 0,
        1000, 1000, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, sha: `sha_${id}` });
}

beforeEach(() => {
  testDb = new Database(":memory:");
  applyAllMigrations();
  seedV1Capture("cap_test");
});

afterEach(() => {
  testDb.close();
});

describe("insertOverlay — monotonic z_index assignment", () => {
  test("first overlay gets z_index 0", () => {
    const row = insertOverlay({
      id: "ovl_test_first_a",
      captureId: "cap_test",
      data: {
        kind: "arrow",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        color: "auto"
      }
    });
    expect(row.z_index).toBe(0);
  });

  test("second overlay gets a STRICTLY GREATER z_index than the first", () => {
    // The user-reported bug. Pre-fix both rows landed at z_index = 0
    // and the renderer's ORDER BY z_index ASC, created_at ASC had
    // ties on both columns when the clicks landed in the same ms,
    // letting SQLite return them in implementation-defined order.
    // Post-fix the second row must be strictly > the first so the
    // ASC sort puts it later (= painted later = on top).
    const first = insertOverlay({
      id: "ovl_test_first_b",
      captureId: "cap_test",
      data: {
        kind: "arrow",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        color: "auto"
      }
    });
    const second = insertOverlay({
      id: "ovl_test_secnd_b",
      captureId: "cap_test",
      data: {
        kind: "arrow",
        from: { x: 0.2, y: 0.2 },
        to: { x: 0.8, y: 0.8 },
        color: "auto"
      }
    });
    expect(second.z_index).toBeGreaterThan(first.z_index);
  });

  test("listLiveOverlays returns overlays in insert order (newest LAST)", () => {
    // Direct check of the render-time order: the array the SVG
    // paints in MUST have the newer overlay later so the array-
    // order SVG paint puts it visually on top. Ties on z_index +
    // created_at made this non-deterministic pre-fix; the
    // monotonic z_index assignment makes it deterministic.
    insertOverlay({
      id: "ovl_test_order_a",
      captureId: "cap_test",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" }
    });
    insertOverlay({
      id: "ovl_test_order_b",
      captureId: "cap_test",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" }
    });
    insertOverlay({
      id: "ovl_test_order_c",
      captureId: "cap_test",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" }
    });
    const live = listLiveOverlays("cap_test");
    expect(live.map((r) => r.id)).toEqual([
      "ovl_test_order_a",
      "ovl_test_order_b",
      "ovl_test_order_c"
    ]);
  });

  test("re-inserting after a delete still goes ON TOP (z_index above the deleted row's)", () => {
    // Soft-deleted rows still have a z_index in the table; the
    // monotonic-increment must consider them so re-inserting
    // doesn't accidentally land BELOW a previously-deleted (and
    // potentially restored via undo) row. We MAX over ALL rows for
    // the capture, not just live ones, so the assignment is
    // monotonic regardless of soft-delete state.
    const first = insertOverlay({
      id: "ovl_test_delret_a",
      captureId: "cap_test",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" }
    });
    rejectOverlay(first.id);
    const second = insertOverlay({
      id: "ovl_test_delret_b",
      captureId: "cap_test",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" }
    });
    // Second row must be strictly greater than the (now-deleted)
    // first row's z_index so undo-of-delete restoring the first
    // row places it BELOW the second.
    expect(second.z_index).toBeGreaterThan(first.z_index);
  });

  test("explicit zIndex via opts still wins (caller override path)", () => {
    // The auto-monotonic path is only for callers that don't
    // explicitly pass a zIndex. If a future caller wants to insert
    // at a specific z_index (e.g. AI-suggested overlay at the
    // bottom of the stack), the opts.zIndex still takes precedence.
    insertOverlay({
      id: "ovl_test_optsox_a",
      captureId: "cap_test",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" }
    });
    const row = insertOverlay({
      id: "ovl_test_optsox_b",
      captureId: "cap_test",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" },
      zIndex: -500
    });
    expect(row.z_index).toBe(-500);
  });
});
