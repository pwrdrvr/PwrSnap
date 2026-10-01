// capture:duplicate — the copy is a whole, independent capture.
//
// Pins, against a real database and real bundles:
//   - a with-edits image copy carries the live layer tree under NEW layer
//     ids (layers.id is a global primary key) and its own bundle file;
//   - a base-only copy is just the base raster, even when the source has
//     a capture-time cursor and annotations;
//   - both join the source's family (family_id = root, duplicated_from =
//     direct parent), on the row AND in the bundle manifest;
//   - enrichment is copied, with " copy" / " copy 2" numbering against the
//     family, and accepted tags come along;
//   - a video copy is its own file, keeping or dropping the trim + cuts.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import type { BundleLayerNode } from "@pwrsnap/shared";

let testDataRoot: string;
let testDocumentsRoot: string;
let capturesRoot: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "documents") return testDocumentsRoot;
      return testDataRoot;
    },
    isPackaged: false,
    on: () => undefined
  },
  BrowserWindow: {
    getAllWindows: () => []
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

vi.mock("../capture-storage-gate", () => ({
  runWithCapturesDirFallback: async <T>(operation: (root: string) => Promise<T>): Promise<T> =>
    operation(capturesRoot)
}));

const { openDatabase, closeDatabase, getDb } = await import("../../persistence/db");
const { persistCaptureFromTempV2, readBundleManifest, cancelScheduledRepacks } = await import(
  "../../persistence/bundle-store"
);
const { insertLayer, listLayerTree } = await import("../../persistence/layers-repo");
const { getCaptureById, insertCapture, softDeleteCapture, restoreCapture, hardDeleteCapture } =
  await import("../../persistence/captures-repo");
const { setFamiliesChangedListener } = await import("../../persistence/family-change-signal");
const { insertVideoMetadata, setVideoSegments, getVideoMetadata } = await import(
  "../../persistence/video-repo"
);
const { addUserTag, getCaptureEnrichment } = await import("../../persistence/enrichment-repo");
const { listCaptureFamilies, listFamilyMembers } = await import(
  "../../persistence/capture-families-repo"
);
const { duplicateCapture, captureEditSummary } = await import("../capture-duplicate");

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-duplicate-"));
  testDataRoot = workDir;
  testDocumentsRoot = join(workDir, "documents");
  capturesRoot = join(testDocumentsRoot, "PwrSnap");
  await mkdir(capturesRoot, { recursive: true });
  process.env.PWRSNAP_DATA_ROOT = workDir;
  await openDatabase();
});

afterAll(async () => {
  cancelScheduledRepacks();
  closeDatabase();
  delete process.env.PWRSNAP_DATA_ROOT;
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

async function captureImage(): Promise<string> {
  const png = await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 40, g: 90, b: 160 } }
  })
    .png()
    .toBuffer();
  const tempPath = join(workDir, `shot-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(tempPath, png);
  const sprite = await sharp({
    create: { width: 16, height: 24, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  })
    .png()
    .toBuffer();
  const { record } = await persistCaptureFromTempV2({
    tempPath,
    sourceApp: { bundleId: "com.example.cereal", appName: "Cereal Shelf" },
    outputDir: capturesRoot,
    cursorLayer: { pngBytes: sprite, xPx: 40, yPx: 30, drawWidthPx: 16, drawHeightPx: 24 }
  });
  return record.id;
}

function addArrow(captureId: string): BundleLayerNode {
  const root = listLayerTree(captureId).find((l) => l.kind === "group");
  if (root === undefined) throw new Error("no root group");
  const now = new Date().toISOString();
  return insertLayer({
    captureId,
    bumpZIndexToMax: true,
    node: {
      id: `arrow${Math.random().toString(36).slice(2)}`.slice(0, 16).padEnd(16, "0"),
      parent_id: root.id,
      kind: "vector",
      name: "Arrow",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now,
      shape: { kind: "arrow", from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 }, color: "auto" }
    }
  });
}

function setTitle(captureId: string, title: string, stem: string): void {
  getDb()
    .prepare(
      `INSERT INTO capture_enrichments (capture_id, ocr_text, accepted_title, accepted_filename_stem)
       VALUES (?, 'granola clusters', ?, ?)`
    )
    .run(captureId, title, stem);
}

describe("captureEditSummary", () => {
  test("counts the cursor and annotations, not the base raster", async () => {
    const id = await captureImage();
    const fresh = captureEditSummary(getCaptureById(id)!);
    expect(fresh).toMatchObject({ hasEdits: true, cursors: 1, arrows: 0, cropped: false });

    addArrow(id);
    const edited = captureEditSummary(getCaptureById(id)!);
    expect(edited).toMatchObject({ hasEdits: true, cursors: 1, arrows: 1 });
  });
});

describe("duplicateCapture — images", () => {
  test("with edits: same live tree under new layer ids, its own bundle, joined to a family", async () => {
    const sourceId = await captureImage();
    addArrow(sourceId);
    const source = getCaptureById(sourceId)!;
    // An edit landed after the capture-time pack — the copy must still see it.
    expect(source.edits_version).toBeGreaterThan(source.bundle_edits_version);

    const copy = await duplicateCapture(sourceId, { withEdits: true });

    expect(copy.id).not.toBe(sourceId);
    expect(copy.bundle_path).not.toBe(getCaptureById(sourceId)!.bundle_path);
    expect(copy.captured_at >= source.captured_at).toBe(true);
    expect(copy.family_id).toBe(sourceId);
    expect(copy.duplicated_from).toBe(sourceId);
    expect(getCaptureById(sourceId)!.family_id).toBe(sourceId);
    expect(copy.width_px).toBe(source.width_px);
    expect(copy.source_app_name).toBe("Cereal Shelf");

    const sourceLayers = listLayerTree(sourceId);
    const copyLayers = listLayerTree(copy.id);
    expect(copyLayers.map((l) => l.kind).sort()).toEqual(sourceLayers.map((l) => l.kind).sort());
    const sourceIds = new Set(sourceLayers.map((l) => l.id));
    expect(copyLayers.some((l) => sourceIds.has(l.id))).toBe(false);
    expect(captureEditSummary(copy)).toMatchObject({ arrows: 1, cursors: 1 });

    const manifest = await readBundleManifest(copy.bundle_path!);
    expect(manifest.capture_id).toBe(copy.id);
    expect(manifest.family_id).toBe(sourceId);
    expect(manifest.duplicated_from).toBe(sourceId);
  });

  test("base only: the base raster alone, even when the source carries a cursor and an arrow", async () => {
    const sourceId = await captureImage();
    addArrow(sourceId);

    const copy = await duplicateCapture(sourceId, { withEdits: false });

    const layers = listLayerTree(copy.id);
    expect(layers.map((l) => l.kind).sort()).toEqual(["group", "raster"]);
    expect(captureEditSummary(copy).hasEdits).toBe(false);
    expect(copy.sha256).toBe(getCaptureById(sourceId)!.sha256);
    expect(copy.family_id).toBe(sourceId);
    const manifest = await readBundleManifest(copy.bundle_path!);
    expect(manifest.family_id).toBe(sourceId);
    expect(manifest.duplicated_from).toBe(sourceId);
  });

  test("copies enrichment with family-wide copy numbering; a copy of a copy stays in the root's family", async () => {
    const rootId = await captureImage();
    setTitle(rootId, "Cereal aisle", "cereal-aisle");
    addUserTag(rootId, "breakfast");

    const first = await duplicateCapture(rootId, { withEdits: false });
    const second = await duplicateCapture(rootId, { withEdits: true });
    const third = await duplicateCapture(first.id, { withEdits: false });

    const title = (id: string): string | null => getCaptureEnrichment(id)?.acceptedTitle ?? null;
    expect(title(first.id)).toBe("Cereal aisle copy");
    expect(title(second.id)).toBe("Cereal aisle copy 2");
    expect(title(third.id)).toBe("Cereal aisle copy 3");
    expect(getCaptureEnrichment(first.id)?.ocrText).toBe("granola clusters");
    expect(getCaptureEnrichment(first.id)?.acceptedTags).toContain(
      "breakfast"
    );

    expect(third.family_id).toBe(rootId);
    expect(third.duplicated_from).toBe(first.id);
    // The filename follows the copy's stem.
    expect(first.bundle_path).toMatch(/_cereal-aisle-copy_[0-9a-f]+\.pwrsnap$/);

    const members = listFamilyMembers(rootId).map((m) => m.id);
    expect(members).toEqual([rootId, first.id, second.id, third.id]);
    const family = listCaptureFamilies().find((f) => f.familyId === rootId);
    expect(family).toMatchObject({ rootId, coverId: rootId, liveCount: 4, trashedCount: 0 });
  });

  test("refuses a trashed source", async () => {
    const id = await captureImage();
    getDb().prepare("UPDATE captures SET deleted_at = datetime('now') WHERE id = ?").run(id);
    await expect(duplicateCapture(id, { withEdits: false })).rejects.toMatchObject({
      code: "trashed"
    });
    expect(getCaptureById(id)!.family_id).toBeNull();
  });
});

describe("duplicateCapture — videos", () => {
  async function recordVideo(): Promise<string> {
    const bytes = Buffer.from(`not really an mp4 ${Math.random()}`);
    const id = `vid${Math.random().toString(36).slice(2)}`.slice(0, 16).padEnd(16, "0");
    const path = join(capturesRoot, `${id}.mp4`);
    await writeFile(path, bytes);
    insertCapture({
      id,
      kind: "video",
      captured_at: "2026-09-01T10:00:00.000Z",
      source_app_bundle_id: null,
      source_app_name: null,
      legacy_src_path: path,
      width_px: 1280,
      height_px: 720,
      device_pixel_ratio: 1,
      byte_size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    insertVideoMetadata({
      captureId: id,
      durationSec: 30,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: true,
      requestedSystemAudio: false,
      requestedMicrophone: true,
      subject: { kind: "display", displayId: 1 }
    });
    setVideoSegments(id, [
      { start: 2, end: 10 },
      { start: 14, end: 25 }
    ]);
    return id;
  }

  test("with edits keeps the trim and cuts; the file is its own", async () => {
    const sourceId = await recordVideo();
    const copy = await duplicateCapture(sourceId, { withEdits: true });

    expect(copy.kind).toBe("video");
    expect(copy.legacy_src_path).not.toBe(getCaptureById(sourceId)!.legacy_src_path);
    expect(await readFile(copy.legacy_src_path!)).toEqual(
      await readFile(getCaptureById(sourceId)!.legacy_src_path!)
    );
    expect(getVideoMetadata(copy.id)?.segments).toEqual([
      { start: 2, end: 10 },
      { start: 14, end: 25 }
    ]);
    expect(getVideoMetadata(copy.id)?.hasMicrophoneAudio).toBe(true);
    expect(captureEditSummary(copy)).toMatchObject({ hasEdits: true, trimmed: true, cuts: 1 });
    expect(copy.family_id).toBe(sourceId);
    // No staging file left behind.
    await expect(stat(`${copy.legacy_src_path}.partial`)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("without edits is the full recording", async () => {
    const sourceId = await recordVideo();
    const copy = await duplicateCapture(sourceId, { withEdits: false });
    const video = getVideoMetadata(copy.id);
    expect(video?.defaultRange).toEqual({ start: 0, end: 30 });
    expect(video?.segments).toEqual([{ start: 0, end: 30 }]);
    expect(captureEditSummary(copy).hasEdits).toBe(false);
  });

  test("a copy that fails roots nothing; the source joins a family only with its first copy", async () => {
    const sourceId = await recordVideo();
    const sourcePath = getCaptureById(sourceId)!.legacy_src_path!;
    const bytes = await readFile(sourcePath);
    await rm(sourcePath);
    await expect(duplicateCapture(sourceId, { withEdits: true })).rejects.toBeDefined();
    expect(getCaptureById(sourceId)!.family_id).toBeNull();

    await writeFile(sourcePath, bytes);
    const copy = await duplicateCapture(sourceId, { withEdits: true });
    expect(getCaptureById(sourceId)!.family_id).toBe(sourceId);
    expect(copy.family_id).toBe(sourceId);
  });
});

describe("families-changed signal", () => {
  // The Library re-reads families only on this signal, so it must fire for
  // every write that changes a family and stay quiet for everything else —
  // above all for annotation edits, which happen many times a minute.
  test("fires for copies, trash, restore and purge of members; not for edits or unrelated snaps", async () => {
    const events: string[][] = [];
    setFamiliesChangedListener((ids) => events.push(ids));
    try {
      const sourceId = await captureImage();
      addArrow(sourceId);
      addArrow(sourceId);
      expect(events).toEqual([]);

      const copy = await duplicateCapture(sourceId, { withEdits: true });
      expect(events.flat()).toContain(sourceId);
      events.length = 0;

      addArrow(copy.id);
      expect(events).toEqual([]);

      softDeleteCapture(copy.id);
      restoreCapture(copy.id);
      softDeleteCapture(copy.id);
      hardDeleteCapture(copy.id);
      expect(events).toEqual([[sourceId], [sourceId], [sourceId], [sourceId]]);
      events.length = 0;

      const loner = await captureImage();
      softDeleteCapture(loner);
      hardDeleteCapture(loner);
      expect(events).toEqual([]);
    } finally {
      setFamiliesChangedListener(null);
    }
  });
});
