// Issue #139 regression pin — clipboard:copy fires the
// `clipboardEvents` "changed" event so the File > New > Paste from
// Clipboard menu item enables synchronously after an in-app copy.
//
// Pre-fix the menu refresh relied on Electron's `menu-will-show`,
// which lagged on macOS after a copy completed. Users saw the
// menu item stay disabled until they dismissed the menu and
// reopened it. The event-driven refresh ensures the next menu
// open already shows the enabled state.
//
// We don't try to validate the actual macOS NSMenu state in a
// vitest — that requires a live Electron menu. Instead we pin the
// SIGNAL: clipboard:copy must emit "changed". Main-process
// subscribers (the menu refresh, the renderer broadcast) are
// wired separately in index.ts and tested through their own
// integration paths.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test, vi } from "vitest";

import type {
  BundleDocumentV2,
  BundleLayerNode,
  BundleManifestV2,
  Overlay
} from "@pwrsnap/shared";

let testDataRoot: string;
let testDocumentsRoot: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return testDataRoot;
      if (name === "documents") return testDocumentsRoot;
      if (name === "temp") return testDataRoot;
      return testDataRoot;
    },
    isPackaged: false,
    on: () => undefined
  },
  clipboard: {
    write: vi.fn(),
    writeText: vi.fn(),
    writeImage: vi.fn(),
    writeBuffer: vi.fn()
  },
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => ({
      isEmpty: () => bytes.length === 0,
      __bytes: bytes
    })
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

const { bus } = await import("../../command-bus");
const { registerClipboardHandlers } = await import("../clipboard-handlers");
const { registerLibraryHandlers } = await import("../library-handlers");
const { openDatabase, closeDatabase, getDb } = await import("../../persistence/db");
const { packBundleV2, buildCompositeThumbnail } = await import(
  "../../persistence/bundle-store"
);
const { insertLayerTreeForCapture } = await import("../../persistence/layers-repo");
const { clipboardEvents } = await import("../../clipboard-events");
const { clipboard } = await import("electron");

const CANVAS_W = 100;
const CANVAS_H = 80;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-clipboard-changed-"));
  testDataRoot = workDir;
  testDocumentsRoot = join(workDir, "documents");
  await mkdir(testDocumentsRoot, { recursive: true });
  await mkdir(join(workDir, "captures"), { recursive: true });
  await mkdir(join(workDir, "render-cache"), { recursive: true });
  process.env.PWRSNAP_DATA_ROOT = workDir;
  await openDatabase();
  registerLibraryHandlers();
  registerClipboardHandlers();
});

afterAll(async () => {
  closeDatabase();
  delete process.env.PWRSNAP_DATA_ROOT;
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

let changedSpy: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

beforeEach(() => {
  changedSpy = vi.fn<(...args: unknown[]) => void>();
  clipboardEvents.on("changed", changedSpy);
  vi.mocked(clipboard.write).mockClear();
  vi.mocked(clipboard.writeText).mockClear();
  vi.mocked(clipboard.writeImage).mockClear();
  vi.mocked(clipboard.writeBuffer).mockClear();
});

afterEach(() => {
  clipboardEvents.off("changed", changedSpy);
  const db = getDb();
  db.exec(`DELETE FROM layers`);
  db.exec(`DELETE FROM captures`);
});

async function seedSimpleV2Capture(options: { edited?: boolean } = {}): Promise<string> {
  const captureId = `t_clipchg_${Date.now()}`.slice(0, 32);
  const sourcePng = await sharp({
    create: {
      width: CANVAS_W,
      height: CANVAS_H,
      channels: 3,
      background: { r: 200, g: 200, b: 200 }
    }
  })
    .png()
    .toBuffer();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(workDir, "captures", `${captureId}.pwrsnap`);
  const flatPngPath = join(workDir, "captures", `${captureId}.png`);
  await writeFile(flatPngPath, sourcePng);
  const now = new Date().toISOString();
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: captureId,
    canvas_dimensions: { width_px: CANVAS_W, height_px: CANVAS_H },
    paired_png_filename: `${captureId}.png`,
    created_at: now,
    bundle_modified_at: now
  };
  const rootGroupId = "grp_clipchg_xxxx";
  const rasterId = "ras_clipchg_xxxx";
  const common = {
    name: "",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal" as const,
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    source: "user" as const,
    ai_run_id: null,
    applied_at: now,
    rejected_at: null,
    superseded_by: null,
    created_at: now
  };
  const layers: BundleLayerNode[] = [
    {
      ...common,
      id: rootGroupId,
      kind: "group",
      parent_id: null,
      z_index: 0,
      collapsed: false
    },
    {
      ...common,
      id: rasterId,
      kind: "raster",
      parent_id: rootGroupId,
      z_index: 0,
      source_ref: { kind: "embedded", sha256: sourceSha },
      natural_width_px: CANVAS_W,
      natural_height_px: CANVAS_H
    }
  ];
  if (options.edited === true) {
    layers.push({
      ...common,
      id: "vec_clipchg_xxxx",
      kind: "vector",
      parent_id: rootGroupId,
      z_index: 1,
      shape: editedShape()
    });
  }
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: options.edited === true ? 1 : 0,
    layers,
    tags: [],
    description: null,
    ai_runs: []
  };
  const thumbnailJpg = await buildCompositeThumbnail(sourcePng);
  const bundleBuf = await packBundleV2({
    manifest,
    document,
    sources: new Map([[sourceSha, sourcePng]]),
    layerBytes: new Map(),
    thumbnailJpg
  });
  await writeFile(bundlePath, bundleBuf);
  getDb()
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at, source_app_bundle_id, source_app_name,
        legacy_src_path, bundle_path, flat_png_path, bundle_modified_at,
        bundle_format_version, bundle_edits_version,
        width_px, height_px, device_pixel_ratio, byte_size,
        sha256, edits_version, deleted_at
      ) VALUES (
        @id, 'image', @captured_at, NULL, NULL,
        NULL, @bundle_path, @flat_png_path, @captured_at,
        2, 0,
        @w, @h, 2.0, @bs,
        @sha, 0, NULL
      )`
    )
    .run({
      id: captureId,
      captured_at: now,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      w: CANVAS_W,
      h: CANVAS_H,
      bs: bundleBuf.length,
      sha: sourceSha
    });
  insertLayerTreeForCapture(captureId, layers);
  return captureId;
}

function editedShape(): Overlay {
  return {
    kind: "shape",
    rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
    color: "#ff0000",
    filled: true
  };
}

describe("issue #139 — clipboard:copy fires clipboardEvents 'changed'", () => {
  test("a successful clipboard:copy emits exactly one 'changed' event", async () => {
    const captureId = await seedSimpleV2Capture();
    const result = await bus.dispatch(
      "clipboard:copy",
      { captureId, preset: "med" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    // Pre-fix the event channel didn't exist at all; this assertion
    // was guaranteed to fail. Post-fix exactly one emit lands per
    // copy — duplicates would indicate a double-fire bug (e.g. both
    // the success path AND a finally-block emitting).
    expect(changedSpy, "expected clipboardEvents 'changed' to fire").toHaveBeenCalledTimes(1);
  });

  test("clipboard:copy that ERRORS does NOT fire 'changed' (the clipboard wasn't written)", async () => {
    // Dispatch against a non-existent capture — handler returns err
    // before any clipboard.write. No event should fire.
    const result = await bus.dispatch(
      "clipboard:copy",
      { captureId: "no_such_capture_xxxx", preset: "med" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    expect(
      changedSpy,
      "clipboardEvents 'changed' must NOT fire when nothing was written to the clipboard"
    ).not.toHaveBeenCalled();
  });

  test("two sequential clipboard:copy calls fire 'changed' twice (each write is a discrete signal)", async () => {
    const captureId = await seedSimpleV2Capture();
    await bus.dispatch("clipboard:copy", { captureId, preset: "med" }, { principal: "ipc" });
    await bus.dispatch("clipboard:copy", { captureId, preset: "high" }, { principal: "ipc" });
    expect(changedSpy).toHaveBeenCalledTimes(2);
  });

  test("clipboard:copyLayerFragment writes the private fragment without overwriting it with image fallback", async () => {
    const captureId = await seedSimpleV2Capture();
    const result = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    expect(
      changedSpy,
      "expected clipboardEvents 'changed' to fire exactly once per copyLayerFragment dispatch"
    ).toHaveBeenCalledTimes(1);
    expect(clipboard.writeBuffer).toHaveBeenCalledTimes(1);
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });
});

describe("image preset exports clamp to source width", () => {
  test("small unedited captures reuse the source file for LOW, MED, and HIGH", async () => {
    const captureId = await seedSimpleV2Capture();

    const [low, med, high] = await Promise.all([
      bus.dispatch("clipboard:copy-path", { captureId, preset: "low" }, { principal: "ipc" }),
      bus.dispatch("clipboard:copy-path", { captureId, preset: "med" }, { principal: "ipc" }),
      bus.dispatch("clipboard:copy-path", { captureId, preset: "high" }, { principal: "ipc" })
    ]);

    expect(low.ok).toBe(true);
    expect(med.ok).toBe(true);
    expect(high.ok).toBe(true);
    if (!low.ok || !med.ok || !high.ok) throw new Error("expected all copy-path calls to succeed");

    expect(low.value.path).toBe(high.value.path);
    expect(med.value.path).toBe(high.value.path);
    expect(toPosixPath(high.value.path).endsWith("/source.png")).toBe(true);

    const metadata = await sharp(high.value.path).metadata();
    expect(metadata.width).toBe(CANVAS_W);
    expect(metadata.height).toBe(CANVAS_H);
  });

  test("small edited captures reuse one source-sized composite, not the source file", async () => {
    const captureId = await seedSimpleV2Capture({ edited: true });

    const [low, med, high] = await Promise.all([
      bus.dispatch("clipboard:copy-path", { captureId, preset: "low" }, { principal: "ipc" }),
      bus.dispatch("clipboard:copy-path", { captureId, preset: "med" }, { principal: "ipc" }),
      bus.dispatch("clipboard:copy-path", { captureId, preset: "high" }, { principal: "ipc" })
    ]);

    expect(low.ok).toBe(true);
    expect(med.ok).toBe(true);
    expect(high.ok).toBe(true);
    if (!low.ok || !med.ok || !high.ok) throw new Error("expected all copy-path calls to succeed");

    expect(low.value.path).toBe(high.value.path);
    expect(med.value.path).toBe(high.value.path);
    expect(toPosixPath(high.value.path).endsWith("/source.png")).toBe(false);

    const metadata = await sharp(high.value.path).metadata();
    expect(metadata.width).toBe(CANVAS_W);
    expect(metadata.height).toBe(CANVAS_H);
  });

  test("renders a cache-only pasted raster source before bundle repack folds it in", async () => {
    const captureId = await seedSimpleV2Capture();
    const pastedPng = await sharp({
      create: {
        width: 24,
        height: 18,
        channels: 4,
        background: { r: 0, g: 128, b: 255, alpha: 1 }
      }
    })
      .png()
      .toBuffer();
    const pastedSha = createHash("sha256").update(pastedPng).digest("hex");
    const pastedPath = join(workDir, "render-cache", captureId, `${pastedSha}.png`);
    await mkdir(join(workDir, "render-cache", captureId), { recursive: true });
    await writeFile(pastedPath, pastedPng);

    const root = getDb()
      .prepare<[string], { id: string }>(
        `SELECT id FROM layers WHERE capture_id = ? AND kind = 'group' AND parent_id IS NULL`
      )
      .get(captureId);
    if (root === undefined) throw new Error("expected root group");
    const now = new Date().toISOString();
    insertLayerTreeForCapture(captureId, [
      {
        id: "ras_cacheonly_xx",
        parent_id: root.id,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: pastedSha },
        natural_width_px: 24,
        natural_height_px: 18,
        name: "Pasted Image",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 10, 10],
        z_index: 1000,
        source: "user",
        ai_run_id: null,
        applied_at: now,
        rejected_at: null,
        superseded_by: null,
        created_at: now
      }
    ]);

    const result = await bus.dispatch(
      "clipboard:copy-path",
      { captureId, preset: "high" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const metadata = await sharp(result.value.path).metadata();
    expect(metadata.width).toBe(CANVAS_W);
    expect(metadata.height).toBe(CANVAS_H);
  });
});

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}
