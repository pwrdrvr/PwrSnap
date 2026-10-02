/**
 * E2E-only capture seeding behind `__PWRSNAP_TEST__.seedCapture` /
 * `seedCaptures` (installed in index.ts under PWRSNAP_E2E=1).
 *
 * v2 is the only bundle format, and the render coordinator throws for a
 * row with no `.pwrsnap` behind it. Seeding bare rows therefore left
 * every Library thumbnail a broken-image icon for the whole suite, which
 * nothing asserted on. So an image row seeded here gets a real v2 bundle
 * of the same shape `persistCaptureFromTempV2` writes (via
 * `buildInitialV2Tree`), plus its layer tree and the per-capture
 * source.png cache, and only then its row.
 *
 * What a spec passes is honoured: id, captured_at, source app, DPR,
 * deleted_at, and the declared width_px × height_px — the bundle's
 * canvas is drawn at those dims, because grid layout and editor
 * geometry are built on them. The spec's fixture image (usually a 1×1
 * PNG, sometimes an SVG) is stretched to fill that canvas, or a flat
 * synthetic fill is used when there is none. The columns that describe
 * the pixels — sha256, byte_size, has_alpha — are computed, not taken
 * from the spec, because the compositor finds the base raster by
 * sha256.
 *
 * Kept fast for specs that seed 100+ rows in one evaluate: the decode,
 * hash, alpha probe and thumbnail run once per distinct (fixture, dims)
 * and are cached for the process; each row only packs and writes its
 * own small zip, without fsync (a scratch userData has no power loss to
 * survive). All rows of one call land in a single SQLite transaction,
 * after every bundle is on disk, so no row is ever visible without its
 * bundle.
 *
 * Video rows, and any row a spec deliberately pins to another bundle
 * format or bundle_path, are inserted as given — videos render through
 * pwrsnap-capture://, not the coordinator.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";

import { BundleManifestV2, type BundleLayerNode, type CaptureRecord } from "@pwrsnap/shared";

import { getMainLogger } from "../log";
import {
  atomicWriteBundle,
  buildCompositeThumbnail,
  buildInitialV2Tree,
  packBundleV2
} from "./bundle-store";
import { insertCapturesBatch, type InsertCapture } from "./captures-repo";
import { getDb } from "./db";
import { insertLayerTreeForCapture } from "./layers-repo";
import { getCacheSourcePath, getCapturesRoot } from "./paths";
import { sourceBufferHasAlpha } from "./source-alpha";

const log = getMainLogger("pwrsnap:e2e-capture-seed");

/** `src_path` is the pre-0005 name of `legacy_src_path`; older specs still use it. */
export type E2ESeedCaptureInput = InsertCapture & { src_path?: string };

type PreparedSource = {
  bytes: Buffer;
  sha256: string;
  hasAlpha: boolean;
  thumbnailJpg: Buffer;
};

/** Synthetic flat fill for a row with no readable fixture. */
const FALLBACK_FILL = { r: 0x3a, g: 0x5f, b: 0x8c } as const;

/** Bundles packed + written at once. Enough to overlap I/O, small enough
 *  to keep a 150-row seed from holding 150 zips in memory together. */
const WRITE_CONCURRENCY = 8;

const preparedSources = new Map<string, Promise<PreparedSource>>();

function normalizeInput(input: E2ESeedCaptureInput): InsertCapture {
  const { src_path: legacyAlias, ...rest } = input;
  const withAlias =
    legacyAlias !== undefined && rest.legacy_src_path === undefined
      ? { ...rest, legacy_src_path: legacyAlias }
      : rest;
  // v2 is the only bundle format; an explicit version still wins.
  return { bundle_format_version: 2, ...withAlias };
}

function shouldBuildBundle(row: InsertCapture): boolean {
  return (
    row.kind === "image" &&
    row.bundle_format_version === 2 &&
    (row.bundle_path === undefined || row.bundle_path === null)
  );
}

async function readFixture(srcPath: string | null): Promise<Buffer | null> {
  if (srcPath === null) return null;
  try {
    return await readFile(srcPath);
  } catch (cause) {
    log.warn("seed fixture unreadable — using a synthetic fill", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return null;
  }
}

async function renderSource(
  fixture: Buffer | null,
  widthPx: number,
  heightPx: number
): Promise<Buffer> {
  if (fixture !== null) {
    try {
      const meta = await sharp(fixture).metadata();
      if (meta.format === "png" && meta.width === widthPx && meta.height === heightPx) {
        return fixture;
      }
      return await sharp(fixture).resize(widthPx, heightPx, { fit: "fill" }).png().toBuffer();
    } catch (cause) {
      log.warn("seed fixture undecodable — using a synthetic fill", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
  return await sharp({
    create: { width: widthPx, height: heightPx, channels: 3, background: FALLBACK_FILL }
  })
    .png()
    .toBuffer();
}

async function prepareSource(
  fixture: Buffer | null,
  widthPx: number,
  heightPx: number
): Promise<PreparedSource> {
  const fixtureKey =
    fixture === null ? "none" : createHash("sha256").update(fixture).digest("hex");
  const key = `${fixtureKey}:${widthPx}x${heightPx}`;
  const cached = preparedSources.get(key);
  if (cached !== undefined) return cached;

  const promise = (async (): Promise<PreparedSource> => {
    const bytes = await renderSource(fixture, widthPx, heightPx);
    const meta = await sharp(bytes).metadata();
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      hasAlpha: await sourceBufferHasAlpha(bytes, meta),
      thumbnailJpg: await buildCompositeThumbnail(bytes)
    };
  })();
  preparedSources.set(key, promise);
  // A failed preparation must not poison every later seed of the same fixture.
  promise.catch(() => preparedSources.delete(key));
  return promise;
}

function bundleStemFor(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe === id) return `e2e-seed-${id}`;
  // Sanitizing can map two ids to one name; a hash of the raw id keeps
  // their bundles apart.
  const tag = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `e2e-seed-${safe}-${tag}`;
}

type PlannedRow = { row: InsertCapture; layers: BundleLayerNode[] | null };

async function planImageRow(row: InsertCapture, outputDir: string): Promise<PlannedRow> {
  // The bundle manifest bounds capture_id; the captures table does not.
  // Name the limit here rather than surfacing a bare ZodError from the pack.
  if (!BundleManifestV2.shape.capture_id.safeParse(row.id).success) {
    throw new Error(
      `seedCapture: image capture id "${row.id}" (${row.id.length} chars) does not fit ` +
        "the v2 bundle manifest's capture_id (8–32 chars); use a shorter fixture id"
    );
  }
  const widthPx = Math.max(1, Math.round(row.width_px));
  const heightPx = Math.max(1, Math.round(row.height_px));
  const fixture = await readFixture(row.legacy_src_path);
  const source = await prepareSource(fixture, widthPx, heightPx);

  const id = row.id;
  const createdAt = row.captured_at;
  const stem = bundleStemFor(id);
  const { manifest, layers } = buildInitialV2Tree({
    captureId: id,
    createdAt,
    sha256: source.sha256,
    widthPx,
    heightPx,
    pairedPngFilename: `${stem}.png`
  });
  const bundleBuf = await packBundleV2({
    manifest,
    document: {
      document_format_version: 1,
      edits_version: 0,
      layers,
      tags: [],
      description: null,
      ai_runs: []
    },
    sources: new Map([[source.sha256, source.bytes]]),
    layerBytes: new Map(),
    thumbnailJpg: source.thumbnailJpg
  });
  const bundlePath = join(outputDir, `${stem}.pwrsnap`);
  await atomicWriteBundle(bundlePath, bundleBuf, { durable: false });

  const cacheSource = getCacheSourcePath(id);
  await mkdir(dirname(cacheSource), { recursive: true });
  await writeFile(cacheSource, source.bytes);

  return {
    row: {
      ...row,
      id,
      legacy_src_path: null,
      bundle_path: bundlePath,
      flat_png_path: null,
      bundle_modified_at: createdAt,
      bundle_format_version: 2,
      bundle_edits_version: 0,
      width_px: widthPx,
      height_px: heightPx,
      byte_size: source.bytes.length,
      sha256: source.sha256,
      has_alpha: source.hasAlpha
    },
    layers
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Seed capture rows for an E2E spec. Image rows get a real v2 bundle
 * (see the module header). Resolves once every bundle is written and
 * every row is committed, in input order.
 */
export async function seedCapturesForE2E(
  inputs: readonly E2ESeedCaptureInput[]
): Promise<Array<{ record: CaptureRecord }>> {
  const rows = inputs.map(normalizeInput);
  const outputDir = getCapturesRoot();
  const planned = await mapWithConcurrency(rows, WRITE_CONCURRENCY, async (row) =>
    shouldBuildBundle(row) ? await planImageRow(row, outputDir) : { row, layers: null }
  );
  const db = getDb();
  return db.transaction(() => {
    const results = insertCapturesBatch(planned.map((p) => p.row));
    for (const p of planned) {
      if (p.layers !== null) insertLayerTreeForCapture(p.row.id, p.layers);
    }
    return results;
  })();
}
