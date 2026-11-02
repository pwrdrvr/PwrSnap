// Duplicate lineage restored from a bundle manifest — the repair half.
//
// `repairCaptureLineageFromManifest` only FILLS what a row lost (a DB
// restored from an older backup, or rebuilt). It never overwrites a value
// the row holds, never closes a duplicated_from cycle, and roots a root
// that lost its own marker. Real migrations, in-memory database; the
// production wiring (the boot filename pass) is pinned in
// bundle-filename-maintenance.test.ts.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { BundleManifestV2 } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  warnings: [] as Array<{ message: string; meta: unknown }>,
  familiesChanged: [] as string[][]
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
    warn: (message: string, meta: unknown) => {
      mocks.warnings.push({ message, meta });
    },
    error: () => undefined
  })
}));

const { repairCaptureLineageFromManifest, lineageClaimFromManifest, resolveLineageClaim } =
  await import("../capture-lineage");
const { setFamiliesChangedListener } = await import("../family-change-signal");
const { listCaptureFamilies } = await import("../capture-families-repo");

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

beforeEach(() => {
  mocks.warnings = [];
  mocks.familiesChanged = [];
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  mocks.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (sql.startsWith("-- @no-foreign-keys")) mocks.db.pragma("foreign_keys = OFF");
    try {
      mocks.db.exec(sql);
    } finally {
      if (sql.startsWith("-- @no-foreign-keys")) mocks.db.pragma("foreign_keys = ON");
    }
  }
  setFamiliesChangedListener((ids) => {
    mocks.familiesChanged.push(ids);
  });
});

afterEach(() => {
  setFamiliesChangedListener(null);
  mocks.db?.close();
  mocks.db = null;
});

function insertRow(
  id: string,
  lineage: { family_id?: string | null; duplicated_from?: string | null } = {}
): void {
  mocks.db!
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at, source_app_bundle_id, source_app_name,
        legacy_src_path, bundle_path, flat_png_path, bundle_modified_at,
        bundle_format_version, bundle_edits_version,
        width_px, height_px, device_pixel_ratio, byte_size,
        sha256, edits_version, deleted_at, family_id, duplicated_from
      ) VALUES (
        @id, 'image', '2026-09-12T09:30:00.000Z', NULL, NULL,
        NULL, NULL, NULL, '2026-09-12T09:30:00.000Z',
        2, 0, 40, 30, 1, 1024,
        @sha, 0, NULL, @family_id, @duplicated_from
      )`
    )
    .run({
      id,
      sha: id.padEnd(64, "0"),
      family_id: lineage.family_id ?? null,
      duplicated_from: lineage.duplicated_from ?? null
    });
}

function lineageOf(id: string): { family_id: string | null; duplicated_from: string | null } {
  return mocks.db!
    .prepare("SELECT family_id, duplicated_from FROM captures WHERE id = ?")
    .get(id) as { family_id: string | null; duplicated_from: string | null };
}

function manifest(
  captureId: string,
  lineage: { family_id?: string; duplicated_from?: string }
): Pick<BundleManifestV2, "capture_id" | "family_id" | "duplicated_from"> {
  return { capture_id: captureId, ...lineage };
}

const ROOT = "granolaroot00001";
const COPY = "granolacopy00001";
const COPY_OF_COPY = "granolacopy00002";

describe("repairCaptureLineageFromManifest", () => {
  test("backfills a family the database lost, from every member's own manifest", () => {
    // The DB was rebuilt: three captures, no lineage anywhere.
    insertRow(ROOT);
    insertRow(COPY);
    insertRow(COPY_OF_COPY);

    expect(repairCaptureLineageFromManifest(ROOT, manifest(ROOT, { family_id: ROOT }))).toEqual({
      status: "repaired",
      rootedId: null
    });
    expect(
      repairCaptureLineageFromManifest(
        COPY,
        manifest(COPY, { family_id: ROOT, duplicated_from: ROOT })
      )
    ).toEqual({ status: "repaired", rootedId: null });
    expect(
      repairCaptureLineageFromManifest(
        COPY_OF_COPY,
        manifest(COPY_OF_COPY, { family_id: ROOT, duplicated_from: COPY })
      )
    ).toEqual({ status: "repaired", rootedId: null });

    expect(lineageOf(ROOT)).toEqual({ family_id: ROOT, duplicated_from: null });
    expect(lineageOf(COPY)).toEqual({ family_id: ROOT, duplicated_from: ROOT });
    expect(lineageOf(COPY_OF_COPY)).toEqual({ family_id: ROOT, duplicated_from: COPY });
    expect(listCaptureFamilies()).toMatchObject([{ familyId: ROOT, rootId: ROOT, liveCount: 3 }]);
    expect(mocks.familiesChanged.flat()).toContain(ROOT);

    // A second pass finds nothing to do.
    expect(
      repairCaptureLineageFromManifest(
        COPY,
        manifest(COPY, { family_id: ROOT, duplicated_from: ROOT })
      )
    ).toEqual({ status: "unchanged" });
  });

  test("roots a root whose own marker was lost, even when its manifest never got one", () => {
    // The root's manifest predates its first duplicate (its repack never
    // ran), so only the copy's manifest knows the family.
    insertRow(ROOT);
    insertRow(COPY);

    const outcome = repairCaptureLineageFromManifest(
      COPY,
      manifest(COPY, { family_id: ROOT, duplicated_from: ROOT })
    );

    expect(outcome).toEqual({ status: "repaired", rootedId: ROOT });
    expect(lineageOf(ROOT)).toEqual({ family_id: ROOT, duplicated_from: null });
    expect(listCaptureFamilies()).toMatchObject([{ familyId: ROOT, rootId: ROOT, liveCount: 2 }]);
  });

  test("fills only the missing parent when the family survived", () => {
    insertRow(ROOT, { family_id: ROOT });
    insertRow(COPY, { family_id: ROOT });

    expect(
      repairCaptureLineageFromManifest(
        COPY,
        manifest(COPY, { family_id: ROOT, duplicated_from: ROOT })
      )
    ).toEqual({ status: "repaired", rootedId: null });
    expect(lineageOf(COPY)).toEqual({ family_id: ROOT, duplicated_from: ROOT });
  });

  test("keeps the database when it disagrees with the manifest, and says so", () => {
    const OTHER = "othercereal00001";
    insertRow(ROOT, { family_id: ROOT });
    insertRow(OTHER, { family_id: OTHER });
    insertRow(COPY, { family_id: OTHER, duplicated_from: OTHER });

    const outcome = repairCaptureLineageFromManifest(
      COPY,
      manifest(COPY, { family_id: ROOT, duplicated_from: ROOT })
    );

    expect(outcome).toEqual({ status: "conflict" });
    expect(lineageOf(COPY)).toEqual({ family_id: OTHER, duplicated_from: OTHER });
    expect(mocks.warnings.map((warning) => warning.message)).toContain(
      "capture lineage: database and manifest disagree; keeping the database"
    );

    // A row the DB calls a root is not turned into a copy either.
    expect(
      repairCaptureLineageFromManifest(
        ROOT,
        manifest(ROOT, { family_id: OTHER, duplicated_from: OTHER })
      )
    ).toEqual({ status: "conflict" });
    expect(lineageOf(ROOT)).toEqual({ family_id: ROOT, duplicated_from: null });
  });

  test("refuses a parent edge that would close a cycle, but keeps the family", () => {
    insertRow(ROOT, { family_id: ROOT });
    // COPY survived with its edge to COPY_OF_COPY; COPY_OF_COPY lost its lineage.
    insertRow(COPY, { family_id: ROOT, duplicated_from: COPY_OF_COPY });
    insertRow(COPY_OF_COPY);

    const outcome = repairCaptureLineageFromManifest(
      COPY_OF_COPY,
      manifest(COPY_OF_COPY, { family_id: ROOT, duplicated_from: COPY })
    );

    expect(outcome).toEqual({ status: "repaired", rootedId: null });
    expect(lineageOf(COPY_OF_COPY)).toEqual({ family_id: ROOT, duplicated_from: null });
    expect(mocks.warnings).toContainEqual({
      message: "capture lineage: manifest claim adjusted",
      meta: expect.objectContaining({ context: "repair", issues: ["cycle"] })
    });
  });

  test("ignores a manifest that belongs to a different capture", () => {
    insertRow(COPY);
    expect(
      repairCaptureLineageFromManifest(
        COPY,
        manifest(COPY_OF_COPY, { family_id: ROOT, duplicated_from: ROOT })
      )
    ).toEqual({ status: "unchanged" });
    expect(lineageOf(COPY)).toEqual({ family_id: null, duplicated_from: null });
  });
});

describe("lineage claims", () => {
  test("a remapped root keeps its family and becomes a copy of the id's holder", () => {
    expect(
      lineageClaimFromManifest({ capture_id: ROOT, family_id: ROOT }, "remappedid000001")
    ).toEqual({ familyId: ROOT, duplicatedFrom: ROOT });
    // Unremapped, a root stays a root.
    expect(lineageClaimFromManifest({ capture_id: ROOT, family_id: ROOT }, ROOT)).toEqual({
      familyId: ROOT,
      duplicatedFrom: null
    });
    // A self-parent is malformed and dropped.
    expect(
      lineageClaimFromManifest({ capture_id: COPY, family_id: ROOT, duplicated_from: COPY }, COPY)
    ).toEqual({ familyId: ROOT, duplicatedFrom: null });
  });

  test("a root with a parent keeps the family and loses the edge", () => {
    insertRow(COPY);
    expect(resolveLineageClaim(ROOT, { familyId: ROOT, duplicatedFrom: COPY })).toMatchObject({
      familyId: ROOT,
      duplicatedFrom: null,
      issues: ["root_with_parent"]
    });
  });

  test("the root's own row decides the family", () => {
    const OTHER = "othercereal00001";
    insertRow(OTHER, { family_id: OTHER });
    insertRow(ROOT, { family_id: OTHER, duplicated_from: OTHER });
    expect(resolveLineageClaim(COPY, { familyId: ROOT, duplicatedFrom: ROOT })).toMatchObject({
      familyId: OTHER,
      duplicatedFrom: ROOT,
      rootToMark: null,
      issues: ["root_in_other_family"]
    });
  });
});
