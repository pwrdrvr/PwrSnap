// Tests for overlays-handlers — covers the bus-boundary validation
// for the NEW `overlays:reorder` verb (per CLAUDE.md "Validate at the
// bus boundary. Per-verb validators... Add a validator when you add
// a verb.").
//
// Pre-fix the handler trusted the IPC envelope's `number` type and
// passed `req.zIndex` straight to `setOverlayZIndex`, which would
// run `UPDATE overlays SET z_index = ? WHERE id = ?` with NaN /
// Infinity / -Infinity. SQLite stores those as REAL but breaks any
// `ORDER BY z_index` from then on (NaN sorts unpredictably). The
// validator stops the bad payload before it touches the DB.
//
// Strategy: same as editor-handlers.test.ts — in-memory better-sqlite3
// with migrations applied + mocked electron/bundle-store. The DB
// doesn't actually need rows for these tests because the validator
// runs BEFORE the DB lookup, so the failing dispatch returns its
// error without ever calling setOverlayZIndex.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;

vi.mock("../../persistence/db", () => ({
  getDb: () => testDb
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

vi.mock("../../persistence/bundle-store", () => ({
  scheduleRepack: (_captureId: string): void => {
    // no-op
  }
}));

const { bus } = await import("../../command-bus");
const { registerOverlaysHandlers } = await import("../overlays-handlers");

registerOverlaysHandlers();

function applyAllMigrations(): void {
  const dir = new URL("../../persistence/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  testDb.pragma("foreign_keys = OFF");
  for (const file of files) {
    testDb.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  testDb.pragma("foreign_keys = ON");
}

beforeEach(() => {
  testDb = new Database(":memory:");
  applyAllMigrations();
});

afterEach(() => {
  testDb.close();
});

describe("overlays:reorder zIndex validation", () => {
  // Each test asserts the verb returns Result.err({ kind: "validation",
  // code: "schema_mismatch" }) and that the DB row was NOT touched
  // (we'd see a write happen via the missing-id 'null' branch
  // otherwise, but the row doesn't exist anyway — what we really
  // care about is that the validator short-circuits BEFORE any
  // SQL UPDATE).

  test("rejects NaN zIndex with schema_mismatch", async () => {
    const result = await bus.dispatch(
      "overlays:reorder",
      { id: "any-id", zIndex: Number.NaN },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("schema_mismatch");
    expect(result.error.message).toContain("zIndex must be finite");
  });

  test("rejects Infinity zIndex with schema_mismatch", async () => {
    const result = await bus.dispatch(
      "overlays:reorder",
      { id: "any-id", zIndex: Number.POSITIVE_INFINITY },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("schema_mismatch");
  });

  test("rejects -Infinity zIndex with schema_mismatch", async () => {
    const result = await bus.dispatch(
      "overlays:reorder",
      { id: "any-id", zIndex: Number.NEGATIVE_INFINITY },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("schema_mismatch");
  });

  test("accepts finite zIndex (passes validator → reaches DB lookup → returns ok with no-op for unknown id)", async () => {
    // Finite zIndex passes the validator. The id doesn't exist in
    // our empty DB so `setOverlayZIndex` returns null and the
    // handler returns ok(undefined) without broadcasting. This is
    // the same semantic as a layer that was deleted between the
    // renderer's read and the IPC dispatch — silent no-op, not an
    // error.
    const result = await bus.dispatch(
      "overlays:reorder",
      { id: "unknown-id", zIndex: 1500 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
  });

  test("accepts zero zIndex (finite, in-range integer)", async () => {
    const result = await bus.dispatch(
      "overlays:reorder",
      { id: "unknown-id", zIndex: 0 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
  });

  test("accepts negative finite zIndex (gap-based zorder lets values go below 0)", async () => {
    const result = await bus.dispatch(
      "overlays:reorder",
      { id: "unknown-id", zIndex: -2500 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
  });
});
