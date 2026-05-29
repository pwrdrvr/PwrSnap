// Boot-time `reconcileV1ToV2OnBoot` sweep: heals partial mid-crash
// states from a prior doctor run. Each test injects one of the
// concrete crash scenarios from the plan §"Phase 3 — v1→v2 lazy
// doctor" and asserts the sweep heals correctly.
//
// Crash scenarios covered (one per test):
//
//   1. Orphan .pwrsnap.tmp file (crashed between step 6
//      atomicWriteBundle and step 7 BEGIN IMMEDIATE) — file unlinked.
//   2. DB says v2 but bundle file missing (crashed between step 8
//      rename and the captures.bundle_path UPDATE; the temp file may
//      have been swept and the row points at a final path that
//      doesn't exist) — DB reverted to v1.
//   3. DB says v1 but bundle on disk is v2 (crashed between step 7
//      commit + step 8 final UPDATE so the projection lags reality)
//      — DB reconciled to v2.
//   4. Orphan overlays rows for v2 capture (crashed between step 8
//      and step 9 DELETE) — rows deleted.
//   5. No-op when no rows match — changes nothing and stays silent.
//
// The sweep is a read-mostly crash-recovery pass: it NEVER drives the
// library migration toast (the eager `migrateAllV1OnBoot` owns that
// surface), so its repairs are silent — no aggregate progress event
// is emitted. Tests assert `getLastDoctorProgressSnapshot()` stays
// null across a reconcile run.

import Database from "better-sqlite3";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import yazl from "yazl";

import type {
  BundleManifestV1,
  BundleManifestV2,
  BundleDocumentV2
} from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null
}));

vi.mock("../db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) {
      throw new Error("test db not initialized");
    }
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

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

// We use REAL bundle-store reads against on-disk fixtures so the
// reconcile sweep exercises the same code path it does in production.
// The fixture builder below produces minimal valid v1 and v2 bundles.

import { readFileSync, readdirSync } from "node:fs";

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
    db.exec(sql);
  }
}

function insertCaptureRow(
  db: Database.Database,
  args: {
    id: string;
    bundleFormatVersion: number;
    bundlePath: string | null;
    width?: number;
    height?: number;
  }
): void {
  db.prepare(
    `INSERT INTO captures (
       id, kind, captured_at, source_app_bundle_id, source_app_name,
       legacy_src_path, bundle_path, flat_png_path, bundle_modified_at,
       bundle_format_version, bundle_edits_version,
       width_px, height_px, device_pixel_ratio, byte_size,
       sha256, edits_version, deleted_at
     ) VALUES (
       @id, 'image', '2026-05-23T12:00:00.000Z', NULL, NULL,
       NULL, @bundle_path, NULL, '2026-05-23T12:00:00.000Z',
       @bundle_format_version, 0,
       @width_px, @height_px, 2.0, 1024,
       @sha256, 0, NULL
     )`
  ).run({
    id: args.id,
    bundle_path: args.bundlePath,
    bundle_format_version: args.bundleFormatVersion,
    width_px: args.width ?? 100,
    height_px: args.height ?? 100,
    sha256: `sha-${args.id}`
  });
}

// Build a minimal valid v1 bundle ZIP at the given path. Just enough
// to pass validateBundleZipEntryNames + zod parse.
async function writeV1BundleFixture(
  bundlePath: string,
  args: {
    captureId: string;
    width: number;
    height: number;
  }
): Promise<void> {
  const manifest: BundleManifestV1 = {
    bundle_format_version: 1,
    capture_id: args.captureId,
    source_sha256: "deadbeef".repeat(8),
    source_dimensions: { width_px: args.width, height_px: args.height },
    paired_png_filename: `${args.captureId}.png`,
    created_at: "2026-05-23T12:00:00.000Z",
    bundle_modified_at: "2026-05-23T12:00:00.000Z"
  };
  const overlays = {
    overlays_format_version: 1,
    overlays_version: 0,
    overlays: [],
    tags: [],
    description: null,
    ai_runs: []
  };
  // Minimal PNG bytes — single 1x1 transparent pixel encoded as PNG.
  // (Skips sharp dependency for speed in the reconcile tests.)
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100" +
      "0d0a2db40000000049454e44ae426082",
    "hex"
  );

  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
    zip.addBuffer(Buffer.from(JSON.stringify(overlays)), "overlays.json");
    zip.addBuffer(pngBytes, "source.png", { compress: false });
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => {
      writeFile(bundlePath, Buffer.concat(chunks)).then(resolve, reject);
    });
    zip.outputStream.on("error", reject);
    zip.end();
  });
}

async function writeV2BundleFixture(
  bundlePath: string,
  args: {
    captureId: string;
    width: number;
    height: number;
  }
): Promise<void> {
  const SHA = "0".repeat(64);
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: args.captureId,
    canvas_dimensions: { width_px: args.width, height_px: args.height },
    paired_png_filename: `${args.captureId}.png`,
    created_at: "2026-05-23T12:00:00.000Z",
    bundle_modified_at: "2026-05-23T12:00:00.000Z"
  };
  const rootGroupId = "abcdefghij012345";
  const rasterId = "klmnopqrstu67890";
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 0,
    layers: [
      {
        id: rootGroupId,
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
        applied_at: "2026-05-23T12:00:00.000Z",
        rejected_at: null,
        superseded_by: null,
        created_at: "2026-05-23T12:00:00.000Z"
      },
      {
        id: rasterId,
        parent_id: rootGroupId,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: SHA },
        natural_width_px: args.width,
        natural_height_px: args.height,
        name: "Source",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 0,
        source: "user",
        ai_run_id: null,
        applied_at: "2026-05-23T12:00:00.000Z",
        rejected_at: null,
        superseded_by: null,
        created_at: "2026-05-23T12:00:00.000Z"
      }
    ],
    tags: [],
    description: null,
    ai_runs: []
  };
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100" +
      "0d0a2db40000000049454e44ae426082",
    "hex"
  );

  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
    zip.addBuffer(Buffer.from(JSON.stringify(document)), "document.json");
    zip.addBuffer(pngBytes, `sources/${SHA}.png`, { compress: false });
    // composite.png is REQUIRED by validateBundleZipEntryNamesV2's
    // missingEntries check. Use the same 1×1 PNG as a placeholder.
    zip.addBuffer(pngBytes, "composite.png", { compress: false });
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => {
      writeFile(bundlePath, Buffer.concat(chunks)).then(resolve, reject);
    });
    zip.outputStream.on("error", reject);
    zip.end();
  });
}

let tempRoot: string;

beforeEach(async () => {
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
  tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-v1-to-v2-reconcile-"));
  await mkdir(tempRoot, { recursive: true });
});

afterEach(async () => {
  mocks.db?.close();
  mocks.db = null;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe("reconcileV1ToV2OnBoot", () => {
  test("orphan .pwrsnap.tmp file is deleted", async () => {
    const { reconcileV1ToV2OnBoot } = await import("../v1-to-v2-doctor");

    // A real bundle for a captures row, plus an orphan .tmp sibling
    // (no DB row claims this temp file).
    const bundlePath = join(tempRoot, "cap1.pwrsnap");
    const tmpPath = join(tempRoot, "cap1.pwrsnap.tmp");
    await writeV1BundleFixture(bundlePath, {
      captureId: "cap1xxxxxxxxxxxx",
      width: 100,
      height: 100
    });
    await writeFile(tmpPath, "orphan-temp-bytes");
    insertCaptureRow(mocks.db!, {
      id: "cap1xxxxxxxxxxxx",
      bundleFormatVersion: 1,
      bundlePath
    });

    expect(existsSync(tmpPath)).toBe(true);

    await reconcileV1ToV2OnBoot();

    expect(existsSync(tmpPath)).toBe(false);
    // Real bundle untouched.
    expect(existsSync(bundlePath)).toBe(true);
  });

  test("DB says v2 but bundle missing → row reverted to v1", async () => {
    const { reconcileV1ToV2OnBoot } = await import("../v1-to-v2-doctor");

    const missingPath = join(tempRoot, "cap2.pwrsnap");
    // No file at missingPath — simulate a crash between step 7's
    // captures UPDATE and step 8's rename.
    insertCaptureRow(mocks.db!, {
      id: "cap2xxxxxxxxxxxx",
      bundleFormatVersion: 2,
      bundlePath: missingPath
    });

    await reconcileV1ToV2OnBoot();

    const row = mocks.db!
      .prepare(`SELECT bundle_format_version AS v FROM captures WHERE id = ?`)
      .get("cap2xxxxxxxxxxxx") as { v: number };
    expect(row.v).toBe(1);
  });

  test("DB says v1 but bundle on disk is v2 → DB reconciled to v2 (silently)", async () => {
    const { reconcileV1ToV2OnBoot, getLastDoctorProgressSnapshot } = await import(
      "../v1-to-v2-doctor"
    );

    const bundlePath = join(tempRoot, "cap3.pwrsnap");
    await writeV2BundleFixture(bundlePath, {
      captureId: "cap3xxxxxxxxxxxx",
      width: 100,
      height: 100
    });
    insertCaptureRow(mocks.db!, {
      id: "cap3xxxxxxxxxxxx",
      bundleFormatVersion: 1, // DB lags reality
      bundlePath
    });

    const before = getLastDoctorProgressSnapshot();
    await reconcileV1ToV2OnBoot();

    const row = mocks.db!
      .prepare(`SELECT bundle_format_version AS v FROM captures WHERE id = ?`)
      .get("cap3xxxxxxxxxxxx") as { v: number };
    expect(row.v).toBe(2);
    // Even a boot that DOES heal a stale flag stays silent — no toast.
    // emitProgress assigns a fresh object each call, so an unchanged
    // reference proves no aggregate event was emitted during the sweep.
    expect(getLastDoctorProgressSnapshot()).toBe(before);
  });

  test("orphan overlay rows for v2 capture → DELETEd", async () => {
    const { reconcileV1ToV2OnBoot } = await import("../v1-to-v2-doctor");

    const bundlePath = join(tempRoot, "cap4.pwrsnap");
    await writeV2BundleFixture(bundlePath, {
      captureId: "cap4xxxxxxxxxxxx",
      width: 100,
      height: 100
    });
    insertCaptureRow(mocks.db!, {
      id: "cap4xxxxxxxxxxxx",
      bundleFormatVersion: 2,
      bundlePath
    });

    // Crashed between step 8 (rename) and step 9 (DELETE overlays):
    // overlays rows remain for a now-v2 capture.
    mocks.db!
      .prepare(
        `INSERT INTO overlays
           (id, capture_id, data, schema_version, source, ai_run_id,
            applied_at, rejected_at, superseded_by, z_index, created_at)
         VALUES (?, ?, '{"kind":"arrow","from":{"x":0,"y":0},"to":{"x":1,"y":1},"color":"auto"}',
                 1, 'user', NULL, '2026-05-23T12:00:00.000Z', NULL, NULL, 0,
                 '2026-05-23T12:00:00.000Z')`
      )
      .run("ovr-orphan1xxxxxx".slice(0, 16), "cap4xxxxxxxxxxxx");

    const before = mocks.db!
      .prepare(`SELECT COUNT(*) AS n FROM overlays WHERE capture_id = ?`)
      .get("cap4xxxxxxxxxxxx") as { n: number };
    expect(before.n).toBe(1);

    await reconcileV1ToV2OnBoot();

    const after = mocks.db!
      .prepare(`SELECT COUNT(*) AS n FROM overlays WHERE capture_id = ?`)
      .get("cap4xxxxxxxxxxxx") as { n: number };
    expect(after.n).toBe(0);
  });

  test("no rows match → changes nothing and stays silent (no toast)", async () => {
    const { reconcileV1ToV2OnBoot, getLastDoctorProgressSnapshot } = await import(
      "../v1-to-v2-doctor"
    );

    await reconcileV1ToV2OnBoot();

    // Reconcile never paints the library toast — the eager sweep owns
    // that surface. With nothing to heal, no aggregate progress event
    // is emitted, so the cached snapshot stays at its module default
    // (null; no other test in this file emits one).
    expect(getLastDoctorProgressSnapshot()).toBeNull();
  });
});
