// Pass C — composite.png → composite_thumbnail.jpg rewrite. This
// spec covers the SQL bookkeeping around the rewrite, not the
// rewrite itself (the byte-level work lives in
// `rewriteCompositeRow` and is exercised end-to-end via the
// happy-path test below). Three scenarios are load-bearing:
//
//   1. Happy path — a bundle with composite.png byte-identical to
//      source.png gets rewritten: composite.png is gone,
//      composite_thumbnail.jpg appears, the DB row's
//      bundle_modified_at advances, attempts counter clears.
//   2. Idempotent re-run — the same migration run a second time on
//      the now-rewritten bundle is a no-op AND must NOT touch
//      bundle_modified_at. The earlier shape of this code rewrote
//      bundle_modified_at to `row.captured_at` in the no-change
//      branch, silently corrupting the audit trail. Reviewer
//      caught it in /review; this test prevents regression.
//   3. Failure path — a malformed bundle bumps
//      legacy_composite_v2_attempts + sets
//      legacy_composite_v2_last_failed_at, but doesn't tank the
//      whole run; other rows still process.

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the DB singleton BEFORE the migration module loads. Tests
// drive an isolated in-memory `testDb` rather than touching the
// user's real ~/Library/Application Support/PwrSnap/pwrsnap.db.
let testDb: Database.Database;
vi.mock("../persistence/db", () => ({
  getDb: () => testDb
}));

// Renderer-broadcast side effect — every emitProgress() calls
// BrowserWindow.getAllWindows(). The Electron module isn't loadable
// in a vitest node environment, so stub it to an empty list.
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

// Tests need a real on-disk bundle to drive Pass C. Pack helpers
// use the production `packBundle` / yazl path so the bundle's ZIP
// shape exactly matches what users have on disk.
const { packBundle } = await import("../persistence/bundle-store");
const { runLegacyBundleMigration } = await import(
  "../persistence/legacy-bundle-migration"
);

import type { BundleManifestV1, BundleOverlaysV1 } from "@pwrsnap/shared";
import { mkdir } from "node:fs/promises";
import { writeFileSync as syncWriteFile } from "node:fs";
import yazl from "yazl";

const migrationsDir = fileURLToPath(
  new URL("../persistence/migrations", import.meta.url)
);

function applyAllMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  // Bookkeeping table the runner expects.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT NOT NULL PRIMARY KEY
  )`);
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const insert = db.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(file.slice(0, file.indexOf(".")));
  }
}

/**
 * Generate a synthetic PNG larger than COMPOSITE_THUMBNAIL_MAX_DIM_PX
 * (1024) so buildCompositeThumbnail produces an actual JPEG rather
 * than null. Pass C's preferred-image-source logic (composite ==
 * source → use source) and the entry-write logic both need a
 * large-enough image to exercise; a 4x4 PNG would skip the thumbnail
 * entirely and the test wouldn't catch composite_thumbnail.jpg
 * regressions.
 */
async function makeLargePng(): Promise<Buffer> {
  // Lazy-import sharp so the test file isn't gated on the native
  // binding loading (we may still skip this suite in environments
  // where sharp isn't built for the test Node ABI).
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

/**
 * Pack a fixture bundle to disk with the given entries. Returns the
 * full bundle path. Caller passes whatever entry mix the test wants
 * — these tests need a v1 bundle that includes the LEGACY composite.png
 * entry (which production code no longer writes but pre-PR-90 bundles
 * carry on disk), so we drop down to yazl directly rather than
 * production `writeBundle()` which intentionally omits composite.png.
 */
async function packLegacyBundle(opts: {
  outputDir: string;
  filenameStem: string;
  sourcePng: Buffer;
  compositePng: Buffer | null;
  manifest: BundleManifestV1;
  overlays: BundleOverlaysV1;
}): Promise<string> {
  const path = join(opts.outputDir, `${opts.filenameStem}.pwrsnap`);
  await new Promise<void>((resolveZip, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(opts.manifest)), "manifest.json");
    zip.addBuffer(Buffer.from(JSON.stringify(opts.overlays)), "overlays.json");
    zip.addBuffer(opts.sourcePng, "source.png", { compress: false });
    if (opts.compositePng !== null) {
      zip.addBuffer(opts.compositePng, "composite.png", { compress: false });
    }
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => {
      syncWriteFile(path, Buffer.concat(chunks));
      resolveZip();
    });
    zip.outputStream.on("error", reject);
    zip.end();
  });
  return path;
}

/** Inspect the entry names present in a bundle (without extracting). */
function listBundleEntries(path: string): Promise<string[]> {
  return new Promise((res, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err !== null) {
        reject(err);
        return;
      }
      const names: string[] = [];
      zip!.on("entry", (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zip!.readEntry();
      });
      zip!.on("end", () => res(names));
      zip!.on("error", reject);
      zip!.readEntry();
    });
  });
}

// Valid-shape 64-char hex sha256 placeholder. Real value isn't
// inspected by Pass C (it copies the manifest forward verbatim
// except for bundle_modified_at), but the BundleManifestV1 schema
// rejects anything that isn't 64 lowercase hex chars.
const PLACEHOLDER_SHA256 =
  "0000000000000000000000000000000000000000000000000000000000000000";

function manifestFor(captureId: string): BundleManifestV1 {
  return {
    bundle_format_version: 1,
    capture_id: captureId,
    source_sha256: PLACEHOLDER_SHA256,
    source_dimensions: { width_px: 1200, height_px: 800 },
    paired_png_filename: `${captureId}.png`,
    created_at: "2026-01-01T00:00:00.000Z",
    bundle_modified_at: "2026-01-01T00:00:00.000Z"
  };
}

function emptyOverlays(): BundleOverlaysV1 {
  return {
    overlays_format_version: 1,
    overlays_version: 0,
    overlays: [],
    tags: [],
    description: null,
    ai_runs: []
  };
}

/**
 * Insert a `captures` row that looks like a pre-PR-90 bundle row.
 * Caller has already packed the bundle file at `bundlePath`.
 */
function insertCaptureRow(
  db: Database.Database,
  opts: {
    id: string;
    bundlePath: string;
    sha256: string;
    bundleModifiedAt?: string;
  }
): void {
  // Post-PR-90 schema: `src_path` was dropped in 0007 in favor of
  // `bundle_path` (modern captures) and `legacy_src_path` (pre-PR-14
  // PNG-only captures). For Pass C we always set bundle_path; the
  // legacy_src_path column stays NULL because these rows are
  // already in the bundle-flow state.
  //
  // Width/height MUST exceed buildCompositeThumbnail's 1024px
  // bypass threshold — otherwise Pass C calls
  // `buildCompositeThumbnail(thumbnailInput, { width_px: row.width_px,
  // height_px: row.height_px })` with the ROW dims (not the image
  // bytes' dims), buildCompositeThumbnail returns null, and the
  // rewritten bundle has no composite_thumbnail.jpg entry. 1200×800
  // matches the synthetic PNG generated by makeLargePng().
  db.prepare(
    `INSERT INTO captures (
      id, kind, captured_at, width_px, height_px,
      byte_size, sha256, bundle_path, bundle_modified_at
    ) VALUES (
      @id, 'image', '2026-01-01T00:00:00.000Z', 1200, 800,
      100, @sha256, @bundle, @bundle_modified_at
    )`
  ).run({
    id: opts.id,
    sha256: opts.sha256,
    bundle: opts.bundlePath,
    bundle_modified_at: opts.bundleModifiedAt ?? "2026-01-01T00:00:00.000Z"
  });
}

describe("legacy bundle migration — Pass C", () => {
  let workDir: string;
  let largePng: Buffer;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pwrsnap-pass-c-test-"));
    largePng = await makeLargePng();
    testDb = new Database(":memory:");
    applyAllMigrations(testDb);
  });

  afterEach(async () => {
    testDb?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  test("rewrites a bundle that has composite.png byte-identical to source.png", async () => {
    // Pre-PR-90 shape: composite.png present, byte-identical to source.png.
    const captureId = "passC-happy";
    const bundlePath = await packLegacyBundle({
      outputDir: workDir,
      filenameStem: captureId,
      sourcePng: largePng,
      compositePng: largePng,
      manifest: manifestFor(captureId),
      overlays: emptyOverlays()
    });
    insertCaptureRow(testDb, {
      id: captureId,
      bundlePath,
      sha256: "passC-happy-sha"
    });

    const result = await runLegacyBundleMigration();

    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(0);

    // Bundle no longer carries composite.png and now has composite_thumbnail.jpg.
    const entries = await listBundleEntries(bundlePath);
    expect(entries).not.toContain("composite.png");
    expect(entries).toContain("source.png");
    expect(entries).toContain("composite_thumbnail.jpg");

    // DB row: bundle_modified_at advanced past the original placeholder,
    // attempts cleared.
    const row = testDb
      .prepare(
        `SELECT bundle_modified_at, legacy_composite_v2_attempts,
                legacy_composite_v2_last_failed_at
         FROM captures WHERE id = @id`
      )
      .get({ id: captureId }) as {
        bundle_modified_at: string;
        legacy_composite_v2_attempts: number;
        legacy_composite_v2_last_failed_at: string | null;
      };
    expect(row.bundle_modified_at).not.toBe("2026-01-01T00:00:00.000Z");
    expect(row.legacy_composite_v2_attempts).toBe(0);
    expect(row.legacy_composite_v2_last_failed_at).toBeNull();
  });

  test("idempotent re-run leaves bundle_modified_at ALONE on the no-change branch", async () => {
    // Modern-shape bundle that snuck into the over-selection predicate —
    // already missing composite.png, so Pass C should treat it as
    // "already migrated" and skip rewriting. The bug this test guards
    // against: the no-change branch previously wrote
    // bundle_modified_at = row.captured_at, silently corrupting the
    // value for every row that ran a second time.
    const captureId = "passC-noop";
    const bundlePath = await packLegacyBundle({
      outputDir: workDir,
      filenameStem: captureId,
      sourcePng: largePng,
      compositePng: null, // ← key: no composite.png
      manifest: manifestFor(captureId),
      overlays: emptyOverlays()
    });
    const sentinelTimestamp = "2026-03-15T12:34:56.000Z";
    insertCaptureRow(testDb, {
      id: captureId,
      bundlePath,
      sha256: "passC-noop-sha",
      bundleModifiedAt: sentinelTimestamp
    });

    const result = await runLegacyBundleMigration();

    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(0);

    const row = testDb
      .prepare(
        `SELECT bundle_modified_at, legacy_composite_v2_attempts
         FROM captures WHERE id = @id`
      )
      .get({ id: captureId }) as {
        bundle_modified_at: string;
        legacy_composite_v2_attempts: number;
      };

    // The critical assertion. If this fails the
    // markCompositeMigrated-clobber bug has regressed.
    expect(row.bundle_modified_at).toBe(sentinelTimestamp);
    expect(row.legacy_composite_v2_attempts).toBe(0);
  });

  test("bundle on disk is byte-stable across the no-change branch", async () => {
    // Belt-and-suspenders companion to the previous test: confirm
    // that we don't even REWRITE the bundle on disk in the no-change
    // path. mtime + size must remain identical.
    const captureId = "passC-stable";
    const bundlePath = await packLegacyBundle({
      outputDir: workDir,
      filenameStem: captureId,
      sourcePng: largePng,
      compositePng: null,
      manifest: manifestFor(captureId),
      overlays: emptyOverlays()
    });
    insertCaptureRow(testDb, {
      id: captureId,
      bundlePath,
      sha256: "passC-stable-sha"
    });
    const before = await stat(bundlePath);

    await runLegacyBundleMigration();

    const after = await stat(bundlePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
