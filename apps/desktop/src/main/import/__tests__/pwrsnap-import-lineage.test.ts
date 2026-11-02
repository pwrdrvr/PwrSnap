// `.pwrsnap` import restores duplicate lineage from the bundle manifest.
//
// Pins, against a real database and real bundle files:
//   - a copy whose family root is NOT in this library keeps the foreign
//     family_id, and regroups with its root when the root arrives later;
//   - a copy whose root IS here joins that family, rooting the root (and
//     scheduling the root's manifest repack) when it had no family yet;
//   - re-importing the same bundle is a no-op ("duplicate"), lineage and
//     all;
//   - a root bundle remapped onto a new id (its id is taken here by other
//     content) becomes a copy of the capture that holds the id, and the
//     manifest written for it says so under the NEW id;
//   - an edge that would close a duplicated_from cycle is refused, on the
//     row and in the written manifest.
//
// Fixture content is invented.

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import * as fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { BundleDocumentV2, BundleManifestV2 } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  dataRoot: "",
  capturesRoot: "",
  scheduledRepacks: [] as string[]
}));

vi.mock("../../persistence/db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) throw new Error("test db not initialized");
    return mocks.db;
  }
}));

vi.mock("../../persistence/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../persistence/paths")>()),
  getDataRoot: () => mocks.dataRoot,
  getDurableCapturesRoots: () => [{ kind: "override" as const, path: mocks.capturesRoot }]
}));

vi.mock("../../capture/capture-storage-gate", () => ({
  runWithCapturesDirFallback: async <T>(operation: (root: string) => Promise<T>): Promise<T> =>
    operation(mocks.capturesRoot)
}));

// Record repack requests instead of arming the real debounce timer: the
// assertion is that a rooted root's manifest is OWED a repack.
vi.mock("../../persistence/bundle-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../persistence/bundle-store")>();
  return {
    ...actual,
    scheduleRepack: (captureId: string): void => {
      mocks.scheduledRepacks.push(captureId);
    }
  };
});

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const { importPwrsnapBundle } = await import("../pwrsnap-import-service");
const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
const { packBundleV2 } = await import("../../persistence/bundle-store");
const { listCaptureFamilies, listFamilyMembers } = await import(
  "../../persistence/capture-families-repo"
);

const MIGRATIONS_DIR = join(__dirname, "..", "..", "persistence", "migrations");
let workDir: string;

beforeEach(async () => {
  workDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pwrsnap-import-lineage-")));
  mocks.dataRoot = join(workDir, "data");
  mocks.capturesRoot = join(workDir, "captures");
  mocks.scheduledRepacks = [];
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(async () => {
  mocks.db?.close();
  mocks.db = null;
  await fs.rm(workDir, { recursive: true, force: true });
});

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

/** A minimal, valid bundle: a root group over one base raster. */
async function bundleFile(input: {
  captureId: string;
  color: string;
  familyId?: string;
  duplicatedFrom?: string;
}): Promise<string> {
  const base = await sharp({
    create: { width: 40, height: 30, channels: 4, background: input.color }
  })
    .png()
    .toBuffer();
  const baseSha = createHash("sha256").update(base).digest("hex");
  const createdAt = "2026-09-12T09:30:00.000Z";
  const layerId = (name: string): string =>
    `${name}${input.captureId}${input.color.slice(1)}`.slice(0, 16).padEnd(16, "0");
  const rootId = layerId("g");
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 1,
    layers: [
      {
        id: rootId,
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
        applied_at: createdAt,
        rejected_at: null,
        superseded_by: null,
        created_at: createdAt
      },
      {
        id: layerId("r"),
        parent_id: rootId,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: baseSha },
        natural_width_px: 40,
        natural_height_px: 30,
        name: "Source",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 0,
        source: "user",
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: null,
        superseded_by: null,
        created_at: createdAt
      }
    ],
    tags: ["Breakfast"],
    description: "A bowl of crunchy oat rings",
    ai_runs: []
  };
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: input.captureId,
    canvas_dimensions: { width_px: 40, height_px: 30 },
    paired_png_filename: `${input.captureId}.png`,
    created_at: createdAt,
    bundle_modified_at: createdAt,
    ...(input.familyId !== undefined ? { family_id: input.familyId } : {}),
    ...(input.duplicatedFrom !== undefined ? { duplicated_from: input.duplicatedFrom } : {})
  };
  const bytes = await packBundleV2({
    manifest,
    document,
    portableMetadata: { version: 1, manifest: {}, document: {}, layers: {}, aiRuns: {} },
    sources: new Map([[baseSha, base]]),
    layerBytes: new Map()
  });
  const dir = join(workDir, "external");
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${input.captureId}-${input.color.slice(1)}.pwrsnap`);
  await fs.writeFile(path, bytes);
  return path;
}

function lineageOf(id: string): { family_id: string | null; duplicated_from: string | null } {
  return mocks.db!
    .prepare("SELECT family_id, duplicated_from FROM captures WHERE id = ?")
    .get(id) as { family_id: string | null; duplicated_from: string | null };
}

async function importedManifest(id: string): Promise<BundleManifestV2> {
  const row = mocks.db!.prepare("SELECT bundle_path FROM captures WHERE id = ?").get(id) as {
    bundle_path: string;
  };
  return (await validatePwrsnapBundleBytes(await fs.readFile(row.bundle_path))).manifest;
}

const ROOT = "cerealroot000001";
const COPY = "cerealcopy000001";
const COPY_OF_COPY = "cerealcopy000002";

describe("import restores duplicate lineage", () => {
  test("a foreign copy keeps its family and regroups when its root arrives", async () => {
    const copyResult = await importPwrsnapBundle(
      await bundleFile({
        captureId: COPY,
        color: "#aa3311ff",
        familyId: ROOT,
        duplicatedFrom: ROOT
      })
    );
    expect(copyResult.status).toBe("imported");
    expect(lineageOf(COPY)).toEqual({ family_id: ROOT, duplicated_from: ROOT });
    // A family of one is not a family yet.
    expect(listCaptureFamilies()).toEqual([]);
    // The manifest was left as it came: its lineage needed no change.
    expect(await importedManifest(COPY)).toMatchObject({ family_id: ROOT, duplicated_from: ROOT });

    const grandchild = await importPwrsnapBundle(
      await bundleFile({
        captureId: COPY_OF_COPY,
        color: "#bb4422ff",
        familyId: ROOT,
        duplicatedFrom: COPY
      })
    );
    expect(grandchild.status).toBe("imported");
    expect(lineageOf(COPY_OF_COPY)).toEqual({ family_id: ROOT, duplicated_from: COPY });
    expect(listCaptureFamilies()).toMatchObject([
      { familyId: ROOT, rootId: null, liveCount: 2 }
    ]);

    await importPwrsnapBundle(
      await bundleFile({ captureId: ROOT, color: "#cc5533ff", familyId: ROOT })
    );
    expect(lineageOf(ROOT)).toEqual({ family_id: ROOT, duplicated_from: null });
    expect(listCaptureFamilies()).toMatchObject([
      { familyId: ROOT, rootId: ROOT, coverId: ROOT, liveCount: 3 }
    ]);
    expect(listFamilyMembers(ROOT).map((member) => member.id).sort()).toEqual(
      [COPY, COPY_OF_COPY, ROOT].sort()
    );
    expect(mocks.scheduledRepacks).toEqual([]);
  });

  test("a copy joins a root already here and roots it, owing the root a repack", async () => {
    // The root arrived without lineage (it was never duplicated where it was made).
    await importPwrsnapBundle(await bundleFile({ captureId: ROOT, color: "#2266aaff" }));
    expect(lineageOf(ROOT)).toEqual({ family_id: null, duplicated_from: null });

    await importPwrsnapBundle(
      await bundleFile({
        captureId: COPY,
        color: "#3377bbff",
        familyId: ROOT,
        duplicatedFrom: ROOT
      })
    );

    expect(lineageOf(ROOT)).toEqual({ family_id: ROOT, duplicated_from: null });
    expect(lineageOf(COPY)).toEqual({ family_id: ROOT, duplicated_from: ROOT });
    expect(listCaptureFamilies()).toMatchObject([{ familyId: ROOT, rootId: ROOT, liveCount: 2 }]);
    expect(mocks.scheduledRepacks).toEqual([ROOT]);
  });

  test("re-importing the same bundle is idempotent", async () => {
    await importPwrsnapBundle(await bundleFile({ captureId: ROOT, color: "#2266aaff" }));
    const copyPath = await bundleFile({
      captureId: COPY,
      color: "#3377bbff",
      familyId: ROOT,
      duplicatedFrom: ROOT
    });
    const first = await importPwrsnapBundle(copyPath);
    const lineageBefore = mocks.db!
      .prepare("SELECT id, family_id, duplicated_from FROM captures ORDER BY id")
      .all();
    const repacksBefore = [...mocks.scheduledRepacks];

    const again = await importPwrsnapBundle(copyPath);

    expect(again.status).toBe("duplicate");
    expect(again.record.id).toBe(first.record.id);
    expect(
      mocks.db!.prepare("SELECT id, family_id, duplicated_from FROM captures ORDER BY id").all()
    ).toEqual(lineageBefore);
    expect(mocks.scheduledRepacks).toEqual(repacksBefore);
  });

  test("a remapped root becomes a copy of the capture that holds its id", async () => {
    // This library already holds ROOT, with different pixels.
    await importPwrsnapBundle(await bundleFile({ captureId: ROOT, color: "#118844ff" }));
    const incomingPath = await bundleFile({
      captureId: ROOT,
      color: "#994411ff",
      familyId: ROOT
    });

    const incoming = await importPwrsnapBundle(incomingPath);

    if (incoming.status !== "imported") throw new Error("expected a remapped import");
    const newId = incoming.record.id;
    expect(newId).not.toBe(ROOT);
    expect(incoming.captureIdChanged).toBe(true);
    expect(lineageOf(newId)).toEqual({ family_id: ROOT, duplicated_from: ROOT });
    expect(lineageOf(ROOT)).toEqual({ family_id: ROOT, duplicated_from: null });
    expect(await importedManifest(newId)).toMatchObject({
      capture_id: newId,
      family_id: ROOT,
      duplicated_from: ROOT
    });
    expect(mocks.scheduledRepacks).toEqual([ROOT]);

    // And again: the same remapped id, no new row, nothing moved.
    const again = await importPwrsnapBundle(incomingPath);
    expect(again).toMatchObject({ status: "duplicate", record: { id: newId } });
    expect(lineageOf(newId)).toEqual({ family_id: ROOT, duplicated_from: ROOT });
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number })
        .count
    ).toBe(2);
  });

  test("an edge that would close a duplicated_from cycle is refused", async () => {
    // COPY says it was copied from COPY_OF_COPY …
    await importPwrsnapBundle(
      await bundleFile({
        captureId: COPY,
        color: "#556677ff",
        familyId: ROOT,
        duplicatedFrom: COPY_OF_COPY
      })
    );
    // … and COPY_OF_COPY claims to have been copied from COPY.
    const second = await importPwrsnapBundle(
      await bundleFile({
        captureId: COPY_OF_COPY,
        color: "#667788ff",
        familyId: ROOT,
        duplicatedFrom: COPY
      })
    );

    expect(second.status).toBe("imported");
    expect(lineageOf(COPY_OF_COPY)).toEqual({ family_id: ROOT, duplicated_from: null });
    // The written manifest agrees with the row: the refused edge is gone.
    const manifest = await importedManifest(COPY_OF_COPY);
    expect(manifest.family_id).toBe(ROOT);
    expect(manifest.duplicated_from).toBeUndefined();
  });
});
