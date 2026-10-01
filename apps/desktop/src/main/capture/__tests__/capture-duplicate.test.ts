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
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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

// `deniedRoot`, when set, plays a Documents root macOS refuses: the first
// attempt runs there and a permission error retries in `capturesRoot`,
// the way the real wrapper falls back to ~/PwrSnap.
let deniedRoot: string | null = null;

vi.mock("../capture-storage-gate", () => ({
  runWithCapturesDirFallback: async <T>(operation: (root: string) => Promise<T>): Promise<T> => {
    if (deniedRoot === null) return operation(capturesRoot);
    try {
      return await operation(deniedRoot);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw cause;
      return operation(capturesRoot);
    }
  },
  runExclusiveCapturesRootOperation: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation()
}));

// The copy primitives have their own tests (file-copy.test.ts). Here the
// volume is whatever the test says: `cloneMode` decides whether a clone
// "works", and the byte copy is the real one in small chunks, optionally
// held at a gate or failed partway so a test can act mid-copy.
const copyControl: {
  cloneMode: "clone" | "no-clone";
  gate: Promise<void> | null;
  failAfterBytes: number | null;
  streamCalls: number;
} = { cloneMode: "clone", gate: null, failAfterBytes: null, streamCalls: 0 };

vi.mock("../file-copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../file-copy")>();
  const { copyFile, rm: rmFile } = await import("node:fs/promises");
  return {
    ...actual,
    cloneFileFast: async (src: string, dest: string): Promise<boolean> => {
      if (copyControl.cloneMode === "no-clone") return false;
      try {
        await copyFile(src, dest);
        return true;
      } catch {
        await rmFile(dest, { force: true });
        return false;
      }
    },
    streamCopyFile: async (
      src: string,
      dest: string,
      options: import("../file-copy").StreamCopyOptions = {}
    ): Promise<number> => {
      copyControl.streamCalls += 1;
      if (copyControl.gate !== null) await copyControl.gate;
      const failAfter = copyControl.failAfterBytes;
      return actual.streamCopyFile(src, dest, {
        ...options,
        chunkBytes: 64,
        onProgress: (copied, total) => {
          options.onProgress?.(copied, total);
          if (failAfter !== null && copied >= failAfter) {
            throw Object.assign(new Error("disk unplugged"), { code: "EIO" });
          }
        }
      });
    }
  };
});

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
const {
  duplicateCapture,
  captureEditSummary,
  recoverInterruptedVideoDuplicates,
  startCaptureDuplicate
} = await import("../capture-duplicate");
const {
  cancelDuplicateJob,
  listDuplicateJobs,
  setDuplicateJobListener,
  setDuplicateProgressIntervalForTests,
  waitForDuplicateJob
} = await import("../duplicate-jobs");
const { insertCaptureDuplicateIntent, listCaptureDuplicateIntents } = await import(
  "../../persistence/capture-duplicate-intents-repo"
);

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

async function recordVideo(size = 0): Promise<string> {
  const bytes =
    size > 0
      ? Buffer.alloc(size, 7)
      : Buffer.from(`not really an mp4 ${Math.random()}`);
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

describe("duplicateCapture — videos", () => {
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

describe("video copies that cannot be cloned", () => {
  // The recording is byte-copied in the background: the command answers
  // with a job, the row appears only once the file is whole, and every way
  // the copy can end without one — cancel, failure, crash — leaves no row,
  // no file and no intent behind.
  const events: Array<{ jobId: string; state: string; bytesCopied: number }> = [];

  beforeEach(() => {
    events.length = 0;
    copyControl.cloneMode = "no-clone";
    copyControl.gate = null;
    copyControl.failAfterBytes = null;
    copyControl.streamCalls = 0;
    setDuplicateProgressIntervalForTests(0);
    setDuplicateJobListener((job) =>
      events.push({ jobId: job.jobId, state: job.state, bytesCopied: job.bytesCopied })
    );
  });

  afterEach(() => {
    setDuplicateJobListener(null);
    copyControl.cloneMode = "clone";
  });

  /** Hold the byte copy until `open()` is called. */
  function holdCopy(): { open: () => void } {
    let open: () => void = () => undefined;
    copyControl.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open };
  }

  async function capturesRootEntries(): Promise<string[]> {
    return (await readdir(capturesRoot)).sort();
  }

  test("a clone answers with the record and sends no job events", async () => {
    copyControl.cloneMode = "clone";
    const sourceId = await recordVideo(4096);
    const committed: string[] = [];

    const outcome = await startCaptureDuplicate(sourceId, {
      withEdits: true,
      onCommitted: (record) => committed.push(record.id)
    });

    expect(outcome.job).toBeNull();
    expect(outcome.record?.kind).toBe("video");
    expect(committed).toEqual([outcome.record?.id]);
    expect(events).toEqual([]);
    expect(copyControl.streamCalls).toBe(0);
    expect(listCaptureDuplicateIntents()).toEqual([]);
  });

  test("a byte copy answers with a job at once; the row exists only when the job is done", async () => {
    const sourceId = await recordVideo(4096);
    const before = await capturesRootEntries();
    const hold = holdCopy();
    const committed: string[] = [];

    const outcome = await startCaptureDuplicate(sourceId, {
      withEdits: false,
      onCommitted: (record) => committed.push(record.id)
    });
    expect(outcome.record).toBeNull();
    const job = outcome.job!;
    expect(job).toMatchObject({ sourceId, state: "copying", bytesCopied: 0, totalBytes: 4096 });

    // Mid-copy: no row, nothing at the final name, and the job is listed.
    expect(getCaptureById(job.captureId)).toBeNull();
    expect(listDuplicateJobs().map((j) => j.jobId)).toEqual([job.jobId]);
    expect(listCaptureDuplicateIntents().map((i) => i.captureId)).toEqual([job.captureId]);
    expect(committed).toEqual([]);

    hold.open();
    const end = await waitForDuplicateJob(job.jobId);
    expect(end).toMatchObject({ state: "done", bytesCopied: 4096 });

    const copy = getCaptureById(job.captureId)!;
    expect(copy.family_id).toBe(sourceId);
    expect(getVideoMetadata(copy.id)?.segments).toEqual([{ start: 0, end: 30 }]);
    expect(await readFile(copy.legacy_src_path!)).toEqual(
      await readFile(getCaptureById(sourceId)!.legacy_src_path!)
    );
    expect(committed).toEqual([copy.id]);
    expect(listDuplicateJobs()).toEqual([]);
    expect(listCaptureDuplicateIntents()).toEqual([]);

    // Progress went out between the start and the end, only ever forward.
    const states = events.filter((e) => e.jobId === job.jobId).map((e) => e.state);
    expect(states[0]).toBe("copying");
    expect(states.at(-1)).toBe("done");
    const progress = events.filter((e) => e.state === "copying").map((e) => e.bytesCopied);
    expect(progress.some((bytes) => bytes > 0 && bytes < 4096)).toBe(true);
    expect([...progress].sort((x, y) => x - y)).toEqual(progress);

    // Only the copy's own file was added to the captures root.
    const added = (await capturesRootEntries()).filter((name) => !before.includes(name));
    expect(added).toHaveLength(1);
    expect(added[0]).not.toMatch(/\.partial$/);
  });

  test("cancel stops the copy and removes the staging file", async () => {
    const sourceId = await recordVideo(64 * 1024);
    const before = await capturesRootEntries();
    // Cancel from inside the copy, once real bytes have landed.
    let cancelledAt = -1;
    setDuplicateJobListener((job) => {
      events.push({ jobId: job.jobId, state: job.state, bytesCopied: job.bytesCopied });
      if (job.state === "copying" && job.bytesCopied >= 1024 && cancelledAt < 0) {
        cancelledAt = job.bytesCopied;
        expect(cancelDuplicateJob(job.jobId)).toBe(true);
      }
    });

    const { job } = await startCaptureDuplicate(sourceId, { withEdits: true });
    const end = await waitForDuplicateJob(job!.jobId);

    expect(end?.state).toBe("cancelled");
    expect(cancelledAt).toBeGreaterThan(0);
    expect(end!.bytesCopied).toBeLessThan(64 * 1024);
    expect(getCaptureById(job!.captureId)).toBeNull();
    expect(await capturesRootEntries()).toEqual(before);
    expect(listCaptureDuplicateIntents()).toEqual([]);
    // A finished job cannot be cancelled again.
    expect(cancelDuplicateJob(job!.jobId)).toBe(false);
    // Nothing joined a family for a copy that never happened.
    expect(getCaptureById(sourceId)!.family_id).toBeNull();
  });

  test("a copy that fails partway leaves no row, no file and no intent", async () => {
    const sourceId = await recordVideo(8192);
    const before = await capturesRootEntries();
    copyControl.failAfterBytes = 2048;

    const { job } = await startCaptureDuplicate(sourceId, { withEdits: true });
    const end = await waitForDuplicateJob(job!.jobId);

    expect(end?.state).toBe("failed");
    expect(end?.error).toBe("PwrSnap could not copy the recording.");
    expect(getCaptureById(job!.captureId)).toBeNull();
    expect(await capturesRootEntries()).toEqual(before);
    expect(listCaptureDuplicateIntents()).toEqual([]);
    expect(getCaptureById(sourceId)!.family_id).toBeNull();
  });

  test("a second duplicate of a source still copying is refused; the source frees up after", async () => {
    const sourceId = await recordVideo(4096);
    const hold = holdCopy();
    const first = await startCaptureDuplicate(sourceId, { withEdits: true });

    await expect(startCaptureDuplicate(sourceId, { withEdits: false })).rejects.toMatchObject({
      name: "CaptureDuplicateError",
      code: "in_progress"
    });
    expect(listDuplicateJobs()).toHaveLength(1);

    hold.open();
    expect((await waitForDuplicateJob(first.job!.jobId))?.state).toBe("done");
    // The job settles before its source is released; let that land.
    await new Promise((resolve) => setImmediate(resolve));

    copyControl.cloneMode = "clone";
    const again = await startCaptureDuplicate(sourceId, { withEdits: true });
    expect(again.record?.family_id).toBe(sourceId);
  });

  test("a different source copies alongside", async () => {
    const a = await recordVideo(4096);
    const b = await recordVideo(4096);
    const hold = holdCopy();
    const first = await startCaptureDuplicate(a, { withEdits: true });
    const second = await startCaptureDuplicate(b, { withEdits: true });
    expect(listDuplicateJobs()).toHaveLength(2);
    const ends = [waitForDuplicateJob(first.job!.jobId), waitForDuplicateJob(second.job!.jobId)];
    hold.open();
    expect((await Promise.all(ends)).map((end) => end?.state)).toEqual(["done", "done"]);
  });
});

describe("video copies when the captures root refuses writes", () => {
  // A denial has to surface while the fallback wrapper can still switch
  // roots — i.e. before the copy goes to the background — and the retry
  // must not trip over the intent the denied attempt could not clean up.
  // A mode-000 directory is the denial stand-in, which needs POSIX
  // permissions: root ignores them, and on Windows chmod only toggles the
  // read-only attribute, so the "denied" root would accept the copy.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "falls back to the other root instead of failing the background copy",
    async () => {
      const denied = join(workDir, "denied-documents");
      await mkdir(denied, { recursive: true });
      await chmod(denied, 0o000);
      deniedRoot = denied;
      copyControl.cloneMode = "no-clone";
      try {
        const sourceId = await recordVideo(2048);
        const { job } = await startCaptureDuplicate(sourceId, { withEdits: true });
        expect(job).not.toBeNull();
        const end = await waitForDuplicateJob(job!.jobId);
        expect(end?.state).toBe("done");
        const copy = getCaptureById(job!.captureId)!;
        expect(copy.legacy_src_path!.startsWith(capturesRoot)).toBe(true);
      } finally {
        deniedRoot = null;
        copyControl.cloneMode = "clone";
        await chmod(denied, 0o755);
        // The denied attempt's intent waits for the next start; play it.
        await recoverInterruptedVideoDuplicates();
      }
      expect(listCaptureDuplicateIntents()).toEqual([]);
    }
  );
});

describe("interrupted video duplicates", () => {
  // A crash mid-copy (or between the rename and the insert) leaves an
  // intent row. The next start removes exactly the two paths it names.
  test("removes the staging and destination files of a copy that never committed", async () => {
    const sourceId = await recordVideo(1024);
    const destPath = join(capturesRoot, "crashedcopy00001.mp4");
    insertCaptureDuplicateIntent({
      captureId: "crashedcopy00001",
      sourceId,
      stagingPath: `${destPath}.partial`,
      destPath
    });
    await writeFile(`${destPath}.partial`, "half a recording");
    await writeFile(destPath, "a whole recording with no row");
    const bystander = join(capturesRoot, "bystander.mp4.partial");
    await writeFile(bystander, "not ours");

    expect(await recoverInterruptedVideoDuplicates()).toBe(1);

    await expect(stat(`${destPath}.partial`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(destPath)).rejects.toMatchObject({ code: "ENOENT" });
    // Only named paths are touched — nothing is swept by pattern.
    expect((await stat(bystander)).isFile()).toBe(true);
    expect(listCaptureDuplicateIntents()).toEqual([]);
    await rm(bystander);
  });

  test("leaves a copy still running in this process alone", async () => {
    copyControl.cloneMode = "no-clone";
    let open: () => void = () => undefined;
    copyControl.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    try {
      const sourceId = await recordVideo(1024);
      const { job } = await startCaptureDuplicate(sourceId, { withEdits: true });

      expect(await recoverInterruptedVideoDuplicates()).toBe(0);
      expect(listCaptureDuplicateIntents().map((i) => i.captureId)).toEqual([job!.captureId]);

      open();
      expect((await waitForDuplicateJob(job!.jobId))?.state).toBe("done");
    } finally {
      copyControl.cloneMode = "clone";
      copyControl.gate = null;
    }
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
