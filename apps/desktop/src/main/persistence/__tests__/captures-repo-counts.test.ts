// Counting surfaces behind the Library sidebar's Types rows and the
// topbar's filtered count.
//
// The thing these guard is a mismatch, not a query. The renderer applies
// scope / types / source-app client-side over a partially loaded keyset
// window, so `countCaptures` is the ONLY thing that knows the real size
// of a match set — and if its predicates ever drift from the ones
// `listCaptures` builds, the app confidently reports a number for a grid
// that shows something else. Hence the cross-checks against
// `listCaptures` below rather than only asserting integers.

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

const ELECTRON = "com.github.Electron";
const SAFARI = "com.apple.Safari";

type SeedRow = {
  id: string;
  kind: "image" | "video";
  bundleId: string | null;
  capturedAt: string;
};

async function seed(rows: SeedRow[]): Promise<void> {
  const { insertCapture } = await import("../captures-repo");
  for (const [index, row] of rows.entries()) {
    insertCapture({
      id: row.id,
      kind: row.kind,
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

/** Seven captures spread across both kinds, both apps, and two days. */
async function seedMixed(): Promise<void> {
  await seed([
    { id: "a", kind: "image", bundleId: ELECTRON, capturedAt: "2026-08-22T18:00:00.000Z" },
    { id: "b", kind: "image", bundleId: ELECTRON, capturedAt: "2026-08-22T12:00:00.000Z" },
    { id: "c", kind: "video", bundleId: ELECTRON, capturedAt: "2026-08-22T09:00:00.000Z" },
    { id: "d", kind: "image", bundleId: SAFARI, capturedAt: "2026-08-21T18:00:00.000Z" },
    { id: "e", kind: "video", bundleId: SAFARI, capturedAt: "2026-08-21T12:00:00.000Z" },
    { id: "f", kind: "image", bundleId: null, capturedAt: "2026-08-21T09:00:00.000Z" },
    { id: "g", kind: "video", bundleId: null, capturedAt: "2026-08-20T09:00:00.000Z" }
  ]);
}

describe("getKindStats", () => {
  test("buckets live captures by kind", async () => {
    await seedMixed();
    const { getKindStats } = await import("../captures-repo");
    expect(getKindStats().sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "image", count: 4 },
      { kind: "video", count: 3 }
    ]);
  });

  test("soft-deleted rows drop out of the bucket", async () => {
    await seedMixed();
    const { getKindStats, softDeleteCapture } = await import("../captures-repo");
    softDeleteCapture("c");
    softDeleteCapture("g");
    expect(getKindStats().find((s) => s.kind === "video")?.count).toBe(1);
    expect(getKindStats().find((s) => s.kind === "image")?.count).toBe(4);
  });

  test("a kind with no live captures is ABSENT, not zero — callers must default", async () => {
    await seed([
      { id: "a", kind: "image", bundleId: ELECTRON, capturedAt: "2026-08-22T18:00:00.000Z" }
    ]);
    const { getKindStats } = await import("../captures-repo");
    expect(getKindStats()).toEqual([{ kind: "image", count: 1 }]);
  });

  test("an empty library returns no buckets at all", async () => {
    const { getKindStats } = await import("../captures-repo");
    expect(getKindStats()).toEqual([]);
  });
});

describe("getTrashTotal", () => {
  test("counts every soft-deleted row, not just a page of them", async () => {
    await seedMixed();
    const { getTrashTotal, softDeleteCapture } = await import("../captures-repo");
    expect(getTrashTotal()).toBe(0);
    softDeleteCapture("a");
    softDeleteCapture("e");
    expect(getTrashTotal()).toBe(2);
  });

  test("restoring pulls a row back out of the total", async () => {
    await seedMixed();
    const { getTrashTotal, restoreCapture, softDeleteCapture } = await import(
      "../captures-repo"
    );
    softDeleteCapture("a");
    restoreCapture("a");
    expect(getTrashTotal()).toBe(0);
  });
});

describe("countCaptures", () => {
  test("an empty request counts every live capture", async () => {
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({})).toBe(7);
  });

  test("excludes soft-deleted rows by default and counts them under scope 'trash'", async () => {
    await seedMixed();
    const { countCaptures, softDeleteCapture } = await import("../captures-repo");
    softDeleteCapture("a");
    softDeleteCapture("b");
    expect(countCaptures({})).toBe(5);
    expect(countCaptures({ scope: "live" })).toBe(5);
    expect(countCaptures({ scope: "trash" })).toBe(2);
  });

  test("a single kind narrows; both kinds is the same as omitting the field", async () => {
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({ kinds: ["image"] })).toBe(4);
    expect(countCaptures({ kinds: ["video"] })).toBe(3);
    expect(countCaptures({ kinds: ["image", "video"] })).toBe(7);
  });

  test("duplicate kinds still narrow — length is not a proxy for 'both'", async () => {
    // `["image", "image"]` is a legal value of the parameter type.
    // Reading its LENGTH as "both kinds selected" would drop the
    // predicate and silently return the whole library.
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({ kinds: ["image", "image"] })).toBe(4);
    expect(countCaptures({ kinds: ["video", "video", "video"] })).toBe(3);
    expect(countCaptures({ kinds: ["image", "video", "image"] })).toBe(7);
  });

  test("an EMPTY kinds array counts zero — 'no types selected', not 'both'", async () => {
    // Load-bearing: a projects-only sidebar filter sends `kinds: []` and
    // must not fall back to the whole library. This is the one place the
    // contract deliberately differs from CaptureSearchRequest.kinds.
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({ kinds: [] })).toBe(0);
  });

  test("capturedAtStart is an INCLUSIVE lower bound", async () => {
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({ capturedAtStart: "2026-08-22T00:00:00.000Z" })).toBe(3);
    expect(countCaptures({ capturedAtStart: "2026-08-21T00:00:00.000Z" })).toBe(6);
    // Inclusive: a capture exactly on the boundary is inside the range.
    expect(countCaptures({ capturedAtStart: "2026-08-22T18:00:00.000Z" })).toBe(1);
  });

  test("capturedAtEnd is an EXCLUSIVE upper bound", async () => {
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    // Exclusive: the 18:00 capture is outside a range ending at 18:00.
    expect(countCaptures({ capturedAtEnd: "2026-08-22T18:00:00.000Z" })).toBe(6);
    expect(countCaptures({ capturedAtEnd: "2026-08-22T18:00:00.001Z" })).toBe(7);
  });

  test("the two bounds compose into a half-open day — how Today is expressed", async () => {
    // A start-only predicate would mean "today or later": a capture
    // dated into the future (clock skew, an imported bundle) would be
    // counted by the Today badge while the grid files it under another
    // day header. The pair is what makes the count a DAY.
    await seed([
      { id: "future", kind: "image", bundleId: ELECTRON, capturedAt: "2026-08-23T09:00:00.000Z" }
    ]);
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({ capturedAtStart: "2026-08-22T00:00:00.000Z" })).toBe(4);
    expect(
      countCaptures({
        capturedAtStart: "2026-08-22T00:00:00.000Z",
        capturedAtEnd: "2026-08-23T00:00:00.000Z"
      })
    ).toBe(3);
  });

  test("the positive source-app facet counts the union of the named bundles", async () => {
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({ appBundleIds: [ELECTRON] })).toBe(3);
    expect(countCaptures({ appBundleIds: [ELECTRON, SAFARI] })).toBe(5);
    // `null` is the real "unknown source app" bucket, not a no-op.
    expect(countCaptures({ appBundleIds: [null] })).toBe(2);
  });

  test("the negative facet keeps no-source-app rows, matching the list query", async () => {
    // The whole reason buildExcludeAppBundleClause exists: a bare NOT IN
    // would evaluate to NULL for those rows and silently drop them.
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({ excludeAppBundleIds: [ELECTRON] })).toBe(4);
    expect(countCaptures({ excludeAppBundleIds: [ELECTRON, SAFARI] })).toBe(2);
  });

  test("facets compose conjunctively", async () => {
    await seedMixed();
    const { countCaptures } = await import("../captures-repo");
    expect(countCaptures({ kinds: ["image"], appBundleIds: [ELECTRON] })).toBe(2);
    expect(
      countCaptures({
        kinds: ["video"],
        capturedAtStart: "2026-08-21T00:00:00.000Z",
        excludeAppBundleIds: [ELECTRON]
      })
    ).toBe(1);
  });

  test("agrees with listCaptures on what a source-app facet means", async () => {
    // The predicates are shared via pushSourceAppFacetClauses; this is
    // the assertion that keeps them shared. A count that disagreed with
    // the grid it labels is the failure mode worth catching.
    await seedMixed();
    const { countCaptures, listCaptures } = await import("../captures-repo");
    const facets: Array<{
      appBundleIds?: Array<string | null>;
      excludeAppBundleIds?: Array<string | null>;
    }> = [
      { appBundleIds: [ELECTRON] },
      { appBundleIds: [ELECTRON, SAFARI] },
      { appBundleIds: [null] },
      { excludeAppBundleIds: [ELECTRON] },
      { excludeAppBundleIds: [null] },
      { excludeAppBundleIds: [ELECTRON, null] }
    ];
    for (const facet of facets) {
      const listed = listCaptures({ ...facet, limit: 500 }).rows.length;
      expect(countCaptures(facet)).toBe(listed);
    }
  });
});
