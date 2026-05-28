// Tests for `layers:reorder` — covers the bus-boundary validation
// for the v2 z-order verb. Mirrors `overlays-handlers.test.ts` for
// the v1 sibling.
//
// Why this exists: v2 is the DEFAULT bundle format (per CLAUDE.md
// "Bundle format v2 — default"), so this verb is the higher-traffic
// reorder path. A compromised renderer (or buggy caller) passing
// NaN / ±Infinity lands a poison value into `layers.z_index`, which
// then breaks `ORDER BY z_index` silently for the entire capture's
// layer tree. The validator stops the bad payload before it touches
// the DB.
//
// Strategy mirrors the v1 file at __tests__/overlays-handlers.test.ts
// — in-memory better-sqlite3 with migrations applied + mocked
// electron/bundle-store. The DB doesn't need rows for these tests
// because the validator runs BEFORE `setLayerZIndex` and returns the
// error immediately.

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
const { registerLayersHandlers } = await import("../layers-handlers");

registerLayersHandlers();

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

describe("layers:reorder zIndex validation", () => {
  test("rejects NaN zIndex with schema_mismatch", async () => {
    const result = await bus.dispatch(
      "layers:reorder",
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
      "layers:reorder",
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
      "layers:reorder",
      { id: "any-id", zIndex: Number.NEGATIVE_INFINITY },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("schema_mismatch");
  });

  test("accepts finite zIndex (validator passes → reaches DB lookup → returns ok for unknown id)", async () => {
    // Finite zIndex passes the validator. The id doesn't exist in
    // our empty DB so `setLayerZIndex` is a no-op + lookup of the
    // capture id returns null → handler returns ok(undefined)
    // without broadcasting. Mirrors the layer-was-deleted-mid-flight
    // semantic.
    const result = await bus.dispatch(
      "layers:reorder",
      { id: "unknown-id", zIndex: 1500 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
  });

  test("accepts zero zIndex", async () => {
    const result = await bus.dispatch(
      "layers:reorder",
      { id: "unknown-id", zIndex: 0 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
  });

  test("accepts negative finite zIndex (gap-based zorder lets values go below 0)", async () => {
    const result = await bus.dispatch(
      "layers:reorder",
      { id: "unknown-id", zIndex: -2500 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
  });
});
