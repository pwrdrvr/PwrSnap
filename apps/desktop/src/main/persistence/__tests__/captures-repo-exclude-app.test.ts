// `excludeAppBundleIds` — the negative source-app facet behind the
// Library sidebar's ⌥-click "exclude this app" gesture.
//
// Two layers are covered here because they fail differently:
//
//   • `buildExcludeAppBundleClause` — the SQL shape. The NULL arm is
//     the whole reason this isn't a one-liner: `NULL NOT IN (…)`
//     evaluates to NULL, which WHERE treats as false, so a bare
//     `NOT IN` would silently drop every capture that has no source
//     app along with the excluded one.
//
//   • `listCaptures` against a real in-memory database — proves the
//     clause composes with `deleted_at IS NULL`, the keyset cursor,
//     and the positive `appBundleId(s)` filter.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null
}));

vi.mock("../db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) throw new Error("test db not initialized");
    return mocks.db;
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const needsFkOff = sql.startsWith("-- @no-foreign-keys");
    if (needsFkOff) db.pragma("foreign_keys = OFF");
    try {
      db.exec(sql);
    } finally {
      if (needsFkOff) db.pragma("foreign_keys = ON");
    }
  }
}

beforeEach(() => {
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(() => {
  mocks.db?.close();
  mocks.db = null;
});

type SeedRow = {
  id: string;
  bundleId: string | null;
  capturedAt: string;
};

async function seed(rows: SeedRow[]): Promise<void> {
  const { insertCapture } = await import("../captures-repo");
  for (const [index, row] of rows.entries()) {
    insertCapture({
      id: row.id,
      kind: "image",
      captured_at: row.capturedAt,
      source_app_bundle_id: row.bundleId,
      source_app_name: row.bundleId,
      legacy_src_path: null,
      bundle_path: `/tmp/${row.id}.pwrsnap`,
      bundle_modified_at: row.capturedAt,
      bundle_format_version: 2,
      bundle_edits_version: 0,
      width_px: 100,
      height_px: 100,
      device_pixel_ratio: 2,
      byte_size: 10,
      sha256: String(index).padStart(64, "0")
    });
  }
}

const ELECTRON = "com.github.Electron";
const SAFARI = "com.apple.Safari";

describe("buildExcludeAppBundleClause — SQL shape", () => {
  test("an empty list is a no-op, NOT 'exclude everything'", async () => {
    const { buildExcludeAppBundleClause } = await import("../captures-repo");
    const params: Record<string, unknown> = {};
    expect(buildExcludeAppBundleClause([], params)).toBeNull();
    expect(params).toEqual({});
  });

  test("emits a NOT IN with an explicit IS NULL arm so no-source-app rows survive", async () => {
    const { buildExcludeAppBundleClause } = await import("../captures-repo");
    const params: Record<string, unknown> = {};
    const clause = buildExcludeAppBundleClause([ELECTRON, SAFARI], params);
    expect(clause).toBe(
      "(source_app_bundle_id IS NULL OR source_app_bundle_id NOT IN (@excludeAppBundleId0, @excludeAppBundleId1))"
    );
    expect(params).toEqual({
      excludeAppBundleId0: ELECTRON,
      excludeAppBundleId1: SAFARI
    });
  });

  test("a null entry flips the arm to IS NOT NULL — the caller wants that bucket gone too", async () => {
    const { buildExcludeAppBundleClause } = await import("../captures-repo");
    const params: Record<string, unknown> = {};
    const clause = buildExcludeAppBundleClause([ELECTRON, null], params);
    expect(clause).toBe(
      "(source_app_bundle_id IS NOT NULL AND source_app_bundle_id NOT IN (@excludeAppBundleId0))"
    );
    expect(params).toEqual({ excludeAppBundleId0: ELECTRON });
  });

  test("a null-only list excludes just the no-source-app bucket", async () => {
    const { buildExcludeAppBundleClause } = await import("../captures-repo");
    const params: Record<string, unknown> = {};
    expect(buildExcludeAppBundleClause([null], params)).toBe(
      "source_app_bundle_id IS NOT NULL"
    );
    expect(params).toEqual({});
  });
});

describe("listCaptures with excludeAppBundleIds", () => {
  test("drops the excluded app and KEEPS rows with no source app", async () => {
    await seed([
      { id: "electron-1", bundleId: ELECTRON, capturedAt: "2026-08-01T10:00:00.000Z" },
      { id: "safari-1", bundleId: SAFARI, capturedAt: "2026-08-01T11:00:00.000Z" },
      { id: "orphan-1", bundleId: null, capturedAt: "2026-08-01T12:00:00.000Z" }
    ]);
    const { listCaptures } = await import("../captures-repo");
    const { rows } = listCaptures({ excludeAppBundleIds: [ELECTRON] });
    // The NULL-safety guard is the point: a bare `NOT IN` would have
    // taken `orphan-1` out too.
    expect(rows.map((r) => r.id).sort()).toEqual(["orphan-1", "safari-1"]);
  });

  test("a null entry also drops the no-source-app bucket", async () => {
    await seed([
      { id: "electron-1", bundleId: ELECTRON, capturedAt: "2026-08-01T10:00:00.000Z" },
      { id: "safari-1", bundleId: SAFARI, capturedAt: "2026-08-01T11:00:00.000Z" },
      { id: "orphan-1", bundleId: null, capturedAt: "2026-08-01T12:00:00.000Z" }
    ]);
    const { listCaptures } = await import("../captures-repo");
    const { rows } = listCaptures({ excludeAppBundleIds: [ELECTRON, null] });
    expect(rows.map((r) => r.id)).toEqual(["safari-1"]);
  });

  test("multi-bundle exclude removes every bundle id mapped to the app", async () => {
    // macOS hands back inconsistent casing across launches, so one
    // logical app can occupy several `app_stats` bundle rows. The
    // sidebar expands the app to all of them before excluding.
    await seed([
      { id: "electron-upper", bundleId: ELECTRON, capturedAt: "2026-08-01T10:00:00.000Z" },
      {
        id: "electron-lower",
        bundleId: ELECTRON.toLowerCase(),
        capturedAt: "2026-08-01T10:30:00.000Z"
      },
      { id: "safari-1", bundleId: SAFARI, capturedAt: "2026-08-01T11:00:00.000Z" }
    ]);
    const { listCaptures } = await import("../captures-repo");
    const { rows } = listCaptures({
      excludeAppBundleIds: [ELECTRON, ELECTRON.toLowerCase()]
    });
    expect(rows.map((r) => r.id)).toEqual(["safari-1"]);
  });

  test("an empty exclude list returns everything", async () => {
    await seed([
      { id: "electron-1", bundleId: ELECTRON, capturedAt: "2026-08-01T10:00:00.000Z" },
      { id: "safari-1", bundleId: SAFARI, capturedAt: "2026-08-01T11:00:00.000Z" }
    ]);
    const { listCaptures } = await import("../captures-repo");
    expect(listCaptures({ excludeAppBundleIds: [] }).rows).toHaveLength(2);
  });

  test("composes conjunctively with a positive appBundleIds filter", async () => {
    await seed([
      { id: "electron-1", bundleId: ELECTRON, capturedAt: "2026-08-01T10:00:00.000Z" },
      { id: "safari-1", bundleId: SAFARI, capturedAt: "2026-08-01T11:00:00.000Z" }
    ]);
    const { listCaptures } = await import("../captures-repo");
    const { rows } = listCaptures({
      appBundleIds: [ELECTRON, SAFARI],
      excludeAppBundleIds: [ELECTRON]
    });
    expect(rows.map((r) => r.id)).toEqual(["safari-1"]);
  });

  test("still excludes soft-deleted rows by default", async () => {
    await seed([
      { id: "electron-1", bundleId: ELECTRON, capturedAt: "2026-08-01T10:00:00.000Z" },
      { id: "safari-1", bundleId: SAFARI, capturedAt: "2026-08-01T11:00:00.000Z" },
      { id: "safari-2", bundleId: SAFARI, capturedAt: "2026-08-01T12:00:00.000Z" }
    ]);
    mocks.db!
      .prepare("UPDATE captures SET deleted_at = ? WHERE id = ?")
      .run("2026-08-02T00:00:00.000Z", "safari-2");
    const { listCaptures } = await import("../captures-repo");
    const { rows } = listCaptures({ excludeAppBundleIds: [ELECTRON] });
    expect(rows.map((r) => r.id)).toEqual(["safari-1"]);
  });

  test("app_stats and totalLive stay global — the exclude facet must not move them", async () => {
    await seed([
      { id: "electron-1", bundleId: ELECTRON, capturedAt: "2026-08-01T10:00:00.000Z" },
      { id: "safari-1", bundleId: SAFARI, capturedAt: "2026-08-01T11:00:00.000Z" }
    ]);
    const { getAppStats, getTotalLive, listCaptures } = await import("../captures-repo");
    const statsBefore = getAppStats();
    const totalBefore = getTotalLive();
    listCaptures({ excludeAppBundleIds: [ELECTRON] });
    expect(getAppStats()).toEqual(statsBefore);
    expect(getTotalLive()).toBe(totalBefore);
    // The excluded app keeps its own count — that number is what the
    // sidebar shows next to a struck-through row.
    expect(statsBefore.find((s) => s.bundleId === ELECTRON)?.count).toBe(1);
    expect(totalBefore).toBe(2);
  });

  test("composes with the keyset cursor", async () => {
    await seed([
      { id: "safari-1", bundleId: SAFARI, capturedAt: "2026-08-01T10:00:00.000Z" },
      { id: "electron-1", bundleId: ELECTRON, capturedAt: "2026-08-01T11:00:00.000Z" },
      { id: "safari-2", bundleId: SAFARI, capturedAt: "2026-08-01T12:00:00.000Z" }
    ]);
    const { listCaptures } = await import("../captures-repo");
    const page = listCaptures({ excludeAppBundleIds: [ELECTRON], limit: 1 });
    expect(page.rows.map((r) => r.id)).toEqual(["safari-2"]);
    expect(page.nextCursor).not.toBeNull();
    const next = listCaptures({
      excludeAppBundleIds: [ELECTRON],
      limit: 1,
      ...(page.nextCursor === null ? {} : { cursor: page.nextCursor })
    });
    expect(next.rows.map((r) => r.id)).toEqual(["safari-1"]);
  });
});
