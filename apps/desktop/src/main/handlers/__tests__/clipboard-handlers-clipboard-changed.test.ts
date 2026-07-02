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
import { nanoid } from "nanoid";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test, vi } from "vitest";

import { CLIPBOARD_LAYER_FRAGMENT_UTI, EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  BundleDocumentV2,
  BundleLayerNode,
  BundleManifestV2,
  Overlay
} from "@pwrsnap/shared";

let testDataRoot: string;
let testDocumentsRoot: string;

// Stateful pasteboard simulation shared with the hoisted electron mock.
// Models the macOS dev-build behavior the paste fix targets: an UNDECLARED
// custom UTI is stored under a `dyn.…` alias, so availableFormats() never
// reports the literal fragment UTI — but readBuffer(literalUTI) still
// resolves the bytes. (Packaged builds register the UTI via
// electron-builder.yml's UTExportedTypeDeclarations and keep the literal.)
const fakeClipboard = vi.hoisted(() => ({
  pasteboard: new Map<string, Buffer>(),
  // Keep in sync with CLIPBOARD_LAYER_FRAGMENT_UTI (can't import into a
  // hoisted factory).
  FRAGMENT_UTI: "com.pwrdrvr.pwrsnap.layer-fragment"
}));

// A single fake BrowserWindow that records every webContents.send so we
// can assert paste broadcasts the layers-changed events that drive the
// editor canvas refetch.
const fakeWindows = vi.hoisted(() => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    list: [
      {
        isDestroyed: (): boolean => false,
        webContents: {
          send: (channel: string, payload: unknown): void => {
            sent.push({ channel, payload });
          }
        }
      }
    ]
  };
});

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
    // Each write clears first (macOS ScopedClipboardWriter calls
    // clearContents on construction), then stores the bytes.
    writeBuffer: vi.fn((format: string, value: Buffer) => {
      fakeClipboard.pasteboard.clear();
      fakeClipboard.pasteboard.set(format, Buffer.from(value));
    }),
    readBuffer: vi.fn(
      (format: string) => fakeClipboard.pasteboard.get(format) ?? Buffer.alloc(0)
    ),
    availableFormats: vi.fn(() =>
      [...fakeClipboard.pasteboard.keys()].map((k) =>
        k === fakeClipboard.FRAGMENT_UTI ? "dyn.ah62d4rv4ge8085553a" : k
      )
    )
  },
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => ({
      isEmpty: () => bytes.length === 0,
      __bytes: bytes
    })
  },
  BrowserWindow: {
    getAllWindows: () => fakeWindows.list
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
const { materializePendingSourceForCapture } = await import(
  "../../persistence/pending-source-store"
);
const { insertLayerTreeForCapture, listLayerTree } = await import(
  "../../persistence/layers-repo"
);
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
  fakeClipboard.pasteboard.clear();
  fakeWindows.sent.length = 0;
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
      name: "Source",
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

  test("copyLayerFragment with EXPLICIT [sourceRasterId] (whole-image Cmd+A) succeeds and writes a fragment", async () => {
    // Mirrors the editor's Cmd+A → Cmd+C on a plain screenshot: explicit
    // layerIds that include the base Source raster but NOT the root group,
    // so the raster gets reparented to null. This is the path the user hit
    // returning "doesn't contain an image" on paste.
    const captureId = await seedSimpleV2Capture();
    const result = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId, layerIds: ["ras_clipchg_xxxx"] },
      { principal: "ipc" }
    );
    if (!result.ok) {
      throw new Error(`copyLayerFragment([source]) failed: ${result.error.code} — ${result.error.message}`);
    }
    expect(result.value.layerCount).toBe(1);
    expect(result.value.sourceCount).toBe(1);
    expect(clipboard.writeBuffer).toHaveBeenCalledTimes(1);
  });

  test("paste finds the fragment when availableFormats only reports the dynamic UTI alias (dev build)", async () => {
    // Regression pin for the macOS dev-build bug: copy succeeds and the
    // bytes ARE on the pasteboard, but because the custom UTI isn't
    // system-registered, availableFormats() reports only a `dyn.…` alias.
    // The old paste gated on `availableFormats().some(=== UTI)`, missed the
    // alias, and fell through to "clipboard doesn't contain an image".
    // pasteLayerFragment now readBuffer()s directly, which resolves the
    // alias on read.
    const captureId = await seedSimpleV2Capture();
    const copyRes = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId, layerIds: ["ras_clipchg_xxxx"] },
      { principal: "ipc" }
    );
    expect(copyRes.ok).toBe(true);

    // The asymmetry the fix relies on: literal UTI absent from
    // availableFormats(), yet readBuffer(literal UTI) returns the bytes.
    expect(clipboard.availableFormats()).not.toContain(CLIPBOARD_LAYER_FRAGMENT_UTI);
    expect(clipboard.readBuffer(CLIPBOARD_LAYER_FRAGMENT_UTI).byteLength).toBeGreaterThan(0);

    const pasteRes = await bus.dispatch(
      "clipboard:pasteLayerFragment",
      { captureId },
      { principal: "ipc" }
    );
    if (!pasteRes.ok) {
      throw new Error(`paste failed: ${pasteRes.error.code} — ${pasteRes.error.message}`);
    }
    // Found via readBuffer (not the alias-missing availableFormats), so a
    // real layer landed and we did NOT fall back to the flattened PNG.
    expect(pasteRes.value.insertedLayerIds.length).toBeGreaterThan(0);
    expect(pasteRes.value.fallbackUsedPng).toBe(false);
  });

  test("paste stacks the pasted block above the target's layers and de-names a carried 'Source' raster", async () => {
    const captureId = await seedSimpleV2Capture({ edited: true });
    const beforeIds = new Set(listLayerTree(captureId).map((l) => l.id));

    // Copy a FLAT selection (base raster + the vector annotation). Both
    // reparent to null (their group isn't in the selection), so both are
    // fragment roots that must restack above the target on paste.
    const copyRes = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId, layerIds: ["ras_clipchg_xxxx", "vec_clipchg_xxxx"] },
      { principal: "ipc" }
    );
    expect(copyRes.ok).toBe(true);

    const pasteRes = await bus.dispatch(
      "clipboard:pasteLayerFragment",
      { captureId },
      { principal: "ipc" }
    );
    expect(pasteRes.ok).toBe(true);

    const pasted = listLayerTree(captureId).filter((l) => !beforeIds.has(l.id));
    expect(pasted).toHaveLength(2);
    // The target's pre-paste root-level max z was 0 (the root group);
    // every pasted root must land strictly above it, contiguous, so it
    // can't interleave between the target's existing layers.
    for (const p of pasted) expect(p.z_index).toBeGreaterThan(0);
    // The carried base-raster name "Source" is cleared so the panel shows
    // it as "Image" and it doesn't masquerade as this capture's base.
    const pastedRaster = pasted.find((l) => l.kind === "raster");
    expect(pastedRaster?.name).toBe("");
  });

  test("paste broadcasts layers-changed so the editor canvas refetches (no visibility-toggle needed)", async () => {
    const captureId = await seedSimpleV2Capture();
    const copyRes = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId, layerIds: ["ras_clipchg_xxxx"] },
      { principal: "ipc" }
    );
    expect(copyRes.ok).toBe(true);

    fakeWindows.sent.length = 0;
    const pasteRes = await bus.dispatch(
      "clipboard:pasteLayerFragment",
      { captureId },
      { principal: "ipc" }
    );
    expect(pasteRes.ok).toBe(true);

    // Editor windows refetch on overlaysChanged; Library / float-over on
    // capturesChanged. Both must fire for this capture, or the pasted
    // raster stays invisible until an unrelated edit broadcasts.
    const overlays = fakeWindows.sent.filter(
      (e) => e.channel === EVENT_CHANNELS.overlaysChanged
    );
    const captures = fakeWindows.sent.filter(
      (e) => e.channel === EVENT_CHANNELS.capturesChanged
    );
    expect(overlays).toContainEqual({
      channel: EVENT_CHANNELS.overlaysChanged,
      payload: { captureId }
    });
    expect(captures).toContainEqual({
      channel: EVENT_CHANNELS.capturesChanged,
      payload: { changedIds: [captureId] }
    });
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

  test("renders a pending pasted raster source after render-cache is cleared", async () => {
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
    await materializePendingSourceForCapture(captureId, pastedSha, pastedPng);
    await rm(join(workDir, "render-cache"), { recursive: true, force: true });
    await mkdir(join(workDir, "render-cache"), { recursive: true });

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

// ── Flexible seed for the placement tests ────────────────────────────
// Seeds a v2 capture with arbitrary canvas / natural-raster dims, an
// optional off-origin raster transform (to model a crop), and optional
// vector annotations. Layer ids are nanoid(16) — the layers table keys on
// a GLOBAL id PK, so they must be unique across the multiple captures a
// placement test seeds.
let placeSeedCounter = 0;

async function seedPlacementCapture(opts: {
  canvasW: number;
  canvasH: number;
  naturalW?: number;
  naturalH?: number;
  rasterTransform?: [number, number, number, number, number, number];
  annotations?: Overlay[];
  /** Optional crop VectorLayer (`shape.kind === "crop"`). `visible:false`
   *  models a crop toggled OFF (editor shows the full uncropped image). */
  cropMarker?: { rect: { x: number; y: number; w: number; h: number }; visible: boolean };
}): Promise<{ captureId: string; rasterId: string; sourceSha: string }> {
  placeSeedCounter += 1;
  const captureId = `t_place_${String(placeSeedCounter).padStart(6, "0")}`;
  const naturalW = opts.naturalW ?? opts.canvasW;
  const naturalH = opts.naturalH ?? opts.canvasH;
  const sourcePng = await sharp({
    create: {
      width: naturalW,
      height: naturalH,
      channels: 3,
      background: { r: 180, g: 120, b: 60 }
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
    canvas_dimensions: { width_px: opts.canvasW, height_px: opts.canvasH },
    paired_png_filename: `${captureId}.png`,
    created_at: now,
    bundle_modified_at: now
  };
  const rootGroupId = nanoid(16);
  const rasterId = nanoid(16);
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
    { ...common, id: rootGroupId, kind: "group", parent_id: null, z_index: 0, collapsed: false },
    {
      ...common,
      id: rasterId,
      kind: "raster",
      name: "Source",
      parent_id: rootGroupId,
      z_index: 0,
      source_ref: { kind: "embedded", sha256: sourceSha },
      natural_width_px: naturalW,
      natural_height_px: naturalH,
      transform: opts.rasterTransform ?? [1, 0, 0, 1, 0, 0]
    },
    ...(opts.annotations ?? []).map(
      (shape, i): BundleLayerNode => ({
        ...common,
        id: nanoid(16),
        kind: "vector",
        parent_id: rootGroupId,
        z_index: 1 + i,
        shape
      })
    ),
    ...(opts.cropMarker !== undefined
      ? [
          {
            ...common,
            id: nanoid(16),
            kind: "vector" as const,
            parent_id: rootGroupId,
            z_index: 900,
            visible: opts.cropMarker.visible,
            shape: { kind: "crop" as const, rect: opts.cropMarker.rect }
          }
        ]
      : [])
  ];
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 0,
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
      w: opts.canvasW,
      h: opts.canvasH,
      bs: bundleBuf.length,
      sha: sourceSha
    });
  insertLayerTreeForCapture(captureId, layers);
  return { captureId, rasterId, sourceSha };
}

describe("cross-capture layer paste — placement (bake on copy, scale-to-fit on paste)", () => {
  test("cropped off-origin source pastes into a LARGER target ON-canvas with annotations aligned", async () => {
    // Source A: a 120×120 screenshot CROPPED to a 60×40 off-origin
    // viewport — raster translate (-30,-40) means the canvas shows source
    // region [30,40]-[90,80], and the raster's natural image extends BEYOND
    // the canvas on every side. Two annotations sit over the visible region.
    const rectShape: Overlay = {
      kind: "shape",
      rect: { x: 0.2, y: 0.25, w: 0.5, h: 0.4 },
      color: "#ff0000",
      filled: false
    };
    const textShape: Overlay = {
      kind: "text",
      point: { x: 0.3, y: 0.3 },
      body: "hi",
      size: "medium",
      color: "#00ff00"
    };
    const src = await seedPlacementCapture({
      canvasW: 60,
      canvasH: 40,
      naturalW: 120,
      naturalH: 120,
      rasterTransform: [1, 0, 0, 1, -30, -40],
      annotations: [rectShape, textShape]
    });

    // ── COPY ── the base raster bakes to a canvas-sized (60×40) PNG with
    // the cropped-away overhang dropped, and source_frame records A's
    // canvas so paste can place the block.
    const copyRes = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId: src.captureId },
      { principal: "ipc" }
    );
    if (!copyRes.ok) {
      throw new Error(`copy failed: ${copyRes.error.code} — ${copyRes.error.message}`);
    }

    const fragment = JSON.parse(
      clipboard.readBuffer(CLIPBOARD_LAYER_FRAGMENT_UTI).toString("utf-8")
    ) as {
      source_frame?: { width_px: number; height_px: number };
      layers: BundleLayerNode[];
      source_refs: Array<{ sha256: string; png_base64: string }>;
    };
    expect(fragment.source_frame).toEqual({ width_px: 60, height_px: 40 });
    const fragRaster = fragment.layers.find((l) => l.kind === "raster");
    if (fragRaster === undefined || fragRaster.kind !== "raster") {
      throw new Error("fragment has no raster");
    }
    // Overhang removed: the baked raster's natural dims equal A's canvas
    // and its transform is reset to identity (no off-canvas spill).
    expect(fragRaster.natural_width_px).toBe(60);
    expect(fragRaster.natural_height_px).toBe(40);
    expect([...fragRaster.transform]).toEqual([1, 0, 0, 1, 0, 0]);
    // The baked source PNG is canvas-sized — proves COPY baked the
    // VISIBLE region, not the full 120×120 source.
    const bakedRef = fragment.source_refs.find(
      (r) => r.sha256 === fragRaster.source_ref.sha256
    );
    if (bakedRef === undefined) throw new Error("baked source_ref missing");
    const bakedMeta = await sharp(Buffer.from(bakedRef.png_base64, "base64")).metadata();
    expect(bakedMeta.width).toBe(60);
    expect(bakedMeta.height).toBe(40);

    // ── PASTE into a plain 200×160 target ──
    const tgt = await seedPlacementCapture({ canvasW: 200, canvasH: 160 });
    const beforeIds = new Set(listLayerTree(tgt.captureId).map((l) => l.id));
    const pasteRes = await bus.dispatch(
      "clipboard:pasteLayerFragment",
      { captureId: tgt.captureId },
      { principal: "ipc" }
    );
    if (!pasteRes.ok) {
      throw new Error(`paste failed: ${pasteRes.error.code} — ${pasteRes.error.message}`);
    }

    const pasted = listLayerTree(tgt.captureId).filter((l) => !beforeIds.has(l.id));
    const pastedRaster = pasted.find((l) => l.kind === "raster");
    if (pastedRaster === undefined || pastedRaster.kind !== "raster") {
      throw new Error("no pasted raster");
    }

    // A (60×40) fits inside B (200×160), so placement caps at NATIVE size
    // (scale 1), centered at ((200-60)/2, (160-40)/2) = (70, 60).
    expect(pastedRaster.natural_width_px).toBe(60);
    expect(pastedRaster.natural_height_px).toBe(40);
    const a = pastedRaster.transform[0];
    const d = pastedRaster.transform[3];
    const tx = pastedRaster.transform[4];
    const ty = pastedRaster.transform[5];
    expect(a).toBeCloseTo(1, 6);
    expect(d).toBeCloseTo(1, 6);
    expect(tx).toBeCloseTo(70, 6);
    expect(ty).toBeCloseTo(60, 6);
    // THE REGRESSION GUARD: the raster lands fully ON-canvas — not off the
    // top-left with overhang. Pre-fix it pasted at natural 120×120 with
    // transform (-30,-40): negative translate + dims exceeding the canvas.
    expect(tx).toBeGreaterThanOrEqual(0);
    expect(ty).toBeGreaterThanOrEqual(0);
    expect(tx + pastedRaster.natural_width_px * a).toBeLessThanOrEqual(200);
    expect(ty + pastedRaster.natural_height_px * d).toBeLessThanOrEqual(160);

    // Annotations remap into the placement rect (origin 70,60 / size
    // 60,40 in B → normalized [0.35,0.375,0.3,0.25]). The rect's stored
    // [0.2,0.25,0.5,0.4] maps to [0.41,0.4375,0.15,0.1].
    const pastedRect = pasted.find(
      (l) => l.kind === "vector" && l.shape.kind === "shape"
    );
    const pastedText = pasted.find(
      (l) => l.kind === "vector" && l.shape.kind === "text"
    );
    if (
      pastedRect === undefined ||
      pastedRect.kind !== "vector" ||
      pastedRect.shape.kind !== "shape"
    ) {
      throw new Error("no pasted rect");
    }
    if (
      pastedText === undefined ||
      pastedText.kind !== "vector" ||
      pastedText.shape.kind !== "text"
    ) {
      throw new Error("no pasted text");
    }
    expect(pastedRect.shape.rect.x).toBeCloseTo(0.41, 4);
    expect(pastedRect.shape.rect.y).toBeCloseTo(0.4375, 4);
    expect(pastedRect.shape.rect.w).toBeCloseTo(0.15, 4);
    expect(pastedRect.shape.rect.h).toBeCloseTo(0.1, 4);
    expect(pastedText.shape.point.x).toBeCloseTo(0.44, 4);
    expect(pastedText.shape.point.y).toBeCloseTo(0.45, 4);
    // …and they sit WITHIN the raster's placed rect (aligned to the
    // image), not scattered across the larger canvas.
    expect(pastedText.shape.point.x).toBeGreaterThanOrEqual(0.35);
    expect(pastedText.shape.point.x).toBeLessThanOrEqual(0.65);
    expect(pastedText.shape.point.y).toBeGreaterThanOrEqual(0.375);
    expect(pastedText.shape.point.y).toBeLessThanOrEqual(0.625);
  });

  test("source LARGER than target scales the block down to fit, preserving aspect + alignment", async () => {
    // Source A: 500×400 natural, cropped to a 400×300 off-origin canvas.
    // Target B: 100×80. A (400×300) is bigger than B in both dims, so
    // placement scales by min(100/400, 80/300) = 0.25 → 100×75 centered
    // vertically at oy = (80-75)/2 = 2.5; ox = 0.
    const rectShape: Overlay = {
      kind: "shape",
      rect: { x: 0.2, y: 0.25, w: 0.5, h: 0.4 },
      color: "#ff0000",
      filled: false
    };
    const src = await seedPlacementCapture({
      canvasW: 400,
      canvasH: 300,
      naturalW: 500,
      naturalH: 400,
      rasterTransform: [1, 0, 0, 1, -50, -60],
      annotations: [rectShape]
    });
    const copyRes = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId: src.captureId },
      { principal: "ipc" }
    );
    expect(copyRes.ok).toBe(true);

    const tgt = await seedPlacementCapture({ canvasW: 100, canvasH: 80 });
    const beforeIds = new Set(listLayerTree(tgt.captureId).map((l) => l.id));
    const pasteRes = await bus.dispatch(
      "clipboard:pasteLayerFragment",
      { captureId: tgt.captureId },
      { principal: "ipc" }
    );
    if (!pasteRes.ok) {
      throw new Error(`paste failed: ${pasteRes.error.code} — ${pasteRes.error.message}`);
    }

    const pasted = listLayerTree(tgt.captureId).filter((l) => !beforeIds.has(l.id));
    const pastedRaster = pasted.find((l) => l.kind === "raster");
    if (pastedRaster === undefined || pastedRaster.kind !== "raster") {
      throw new Error("no pasted raster");
    }
    // natural stays at the baked canvas dims (400×300); the scale is in
    // the matrix.
    expect(pastedRaster.natural_width_px).toBe(400);
    expect(pastedRaster.natural_height_px).toBe(300);
    expect(pastedRaster.transform[0]).toBeCloseTo(0.25, 6);
    expect(pastedRaster.transform[3]).toBeCloseTo(0.25, 6);
    expect(pastedRaster.transform[4]).toBeCloseTo(0, 6);
    expect(pastedRaster.transform[5]).toBeCloseTo(2.5, 6);
    // Rendered rect fills B horizontally (100), 75 tall, fully on-canvas.
    const renderedW = pastedRaster.natural_width_px * pastedRaster.transform[0];
    const renderedH = pastedRaster.natural_height_px * pastedRaster.transform[3];
    expect(renderedW).toBeCloseTo(100, 4);
    expect(renderedH).toBeCloseTo(75, 4);
    expect(pastedRaster.transform[5] + renderedH).toBeLessThanOrEqual(80 + 1e-6);

    // Annotation remap into placedRectNorm {x:0, y:2.5/80=0.03125, w:1,
    // h:75/80=0.9375}: rect [0.2,0.25,0.5,0.4] → [0.2, 0.265625, 0.5, 0.375].
    const pastedRect = pasted.find(
      (l) => l.kind === "vector" && l.shape.kind === "shape"
    );
    if (
      pastedRect === undefined ||
      pastedRect.kind !== "vector" ||
      pastedRect.shape.kind !== "shape"
    ) {
      throw new Error("no pasted rect");
    }
    expect(pastedRect.shape.rect.x).toBeCloseTo(0.2, 4);
    expect(pastedRect.shape.rect.y).toBeCloseTo(0.265625, 4);
    expect(pastedRect.shape.rect.w).toBeCloseTo(0.5, 4);
    expect(pastedRect.shape.rect.h).toBeCloseTo(0.375, 4);
  });

  test("same-size paste with a baked base raster still lands 1:1 (no placement drift)", async () => {
    // A and B identical dims (uncropped). The base raster still bakes on
    // copy, but placement resolves to the identity (scale 1, origin 0): the
    // pasted raster lands at transform [1,0,0,1,0,0] over the original and
    // the annotation keeps its exact normalized coords.
    const rectShape: Overlay = {
      kind: "shape",
      rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
      color: "#ff0000",
      filled: true
    };
    const src = await seedPlacementCapture({
      canvasW: 100,
      canvasH: 80,
      annotations: [rectShape]
    });
    const copyRes = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId: src.captureId },
      { principal: "ipc" }
    );
    expect(copyRes.ok).toBe(true);

    const tgt = await seedPlacementCapture({ canvasW: 100, canvasH: 80 });
    const beforeIds = new Set(listLayerTree(tgt.captureId).map((l) => l.id));
    const pasteRes = await bus.dispatch(
      "clipboard:pasteLayerFragment",
      { captureId: tgt.captureId },
      { principal: "ipc" }
    );
    expect(pasteRes.ok).toBe(true);

    const pasted = listLayerTree(tgt.captureId).filter((l) => !beforeIds.has(l.id));
    const pastedRaster = pasted.find((l) => l.kind === "raster");
    if (pastedRaster === undefined || pastedRaster.kind !== "raster") {
      throw new Error("no pasted raster");
    }
    expect(pastedRaster.natural_width_px).toBe(100);
    expect(pastedRaster.natural_height_px).toBe(80);
    expect([...pastedRaster.transform]).toEqual([1, 0, 0, 1, 0, 0]);

    const pastedRect = pasted.find(
      (l) => l.kind === "vector" && l.shape.kind === "shape"
    );
    if (
      pastedRect === undefined ||
      pastedRect.kind !== "vector" ||
      pastedRect.shape.kind !== "shape"
    ) {
      throw new Error("no pasted rect");
    }
    // Exact 1:1 — same normalized coords as stored, no drift.
    expect(pastedRect.shape.rect.x).toBeCloseTo(0.1, 6);
    expect(pastedRect.shape.rect.y).toBeCloseTo(0.1, 6);
    expect(pastedRect.shape.rect.w).toBeCloseTo(0.4, 6);
    expect(pastedRect.shape.rect.h).toBeCloseTo(0.3, 6);
  });

  test("crop toggled OFF (uncropped view): copy bakes the FULL image the editor shows, not the cropped sub-region", async () => {
    // A 120x120 screenshot cropped to a 60x40 off-origin viewport, but the
    // crop marker is HIDDEN — so the editor + export render the whole
    // 120x120 image (resolveCropViewport). Copy must match: it should
    // capture the full 120x120, NOT the stored 60x40 cropped window.
    const src = await seedPlacementCapture({
      canvasW: 60,
      canvasH: 40,
      naturalW: 120,
      naturalH: 120,
      rasterTransform: [1, 0, 0, 1, -30, -40],
      cropMarker: { rect: { x: 0.25, y: 0.333, w: 0.5, h: 0.333 }, visible: false }
    });

    const copyRes = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId: src.captureId },
      { principal: "ipc" }
    );
    if (!copyRes.ok) {
      throw new Error(`copy failed: ${copyRes.error.code} — ${copyRes.error.message}`);
    }

    const fragment = JSON.parse(
      clipboard.readBuffer(CLIPBOARD_LAYER_FRAGMENT_UTI).toString("utf-8")
    ) as { source_frame?: { width_px: number; height_px: number }; layers: BundleLayerNode[] };

    // source_frame is the FULL image (120x120), not the 60x40 crop.
    expect(fragment.source_frame).toEqual({ width_px: 120, height_px: 120 });
    const fragRaster = fragment.layers.find((l) => l.kind === "raster");
    if (fragRaster === undefined || fragRaster.kind !== "raster") {
      throw new Error("fragment has no raster");
    }
    expect(fragRaster.natural_width_px).toBe(120);
    expect(fragRaster.natural_height_px).toBe(120);
    // Full image fills the frame 1:1, so the base raster is reused as-is
    // (identity transform) — no cropped-window bake.
    expect([...fragRaster.transform]).toEqual([1, 0, 0, 1, 0, 0]);
    // The crop marker was baked-in / uncropped, so it must NOT ride along.
    expect(
      fragment.layers.some((l) => l.kind === "vector" && l.shape.kind === "crop"),
      "carried crop marker would hijack the target's resolveCropViewport"
    ).toBe(false);
  });

  test("applied (visible) crop: copy bakes the cropped region AND drops the crop marker", async () => {
    // Same geometry, but the crop is APPLIED (visible) — the editor shows
    // the 60x40 cropped viewport. Copy bakes that 60x40 region and must
    // still strip the crop marker (the crop is now baked into the raster).
    const src = await seedPlacementCapture({
      canvasW: 60,
      canvasH: 40,
      naturalW: 120,
      naturalH: 120,
      rasterTransform: [1, 0, 0, 1, -30, -40],
      cropMarker: { rect: { x: 0.25, y: 0.333, w: 0.5, h: 0.333 }, visible: true }
    });

    const copyRes = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId: src.captureId },
      { principal: "ipc" }
    );
    if (!copyRes.ok) {
      throw new Error(`copy failed: ${copyRes.error.code} — ${copyRes.error.message}`);
    }

    const fragment = JSON.parse(
      clipboard.readBuffer(CLIPBOARD_LAYER_FRAGMENT_UTI).toString("utf-8")
    ) as { source_frame?: { width_px: number; height_px: number }; layers: BundleLayerNode[] };

    expect(fragment.source_frame).toEqual({ width_px: 60, height_px: 40 });
    const fragRaster = fragment.layers.find((l) => l.kind === "raster");
    if (fragRaster === undefined || fragRaster.kind !== "raster") {
      throw new Error("fragment has no raster");
    }
    // Cropped region baked into a 60x40 canvas-sized raster (overhang gone).
    expect(fragRaster.natural_width_px).toBe(60);
    expect(fragRaster.natural_height_px).toBe(40);
    expect([...fragRaster.transform]).toEqual([1, 0, 0, 1, 0, 0]);
    expect(
      fragment.layers.some((l) => l.kind === "vector" && l.shape.kind === "crop")
    ).toBe(false);
  });
});

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}
