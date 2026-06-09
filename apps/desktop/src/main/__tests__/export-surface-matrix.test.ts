// Integration test matrix: every export surface × every capture-format
// variant, asserting end-to-end that user annotations land in the
// bytes the surface produces.
//
// THIS TEST EXISTS BECAUSE OF PR #116. That PR fixed a v1/v2 dispatch
// bug in `renderViaCoordinator` that silently caused Copy MED on any
// annotated v2 capture to return the bare source PNG (zero overlays
// composited). The bug shipped to users — every unit test in the
// codebase passed throughout. The gap was the integration layer:
// nobody tested "given a v2 capture with overlays, calling the
// `clipboard:copy-image` bus verb produces a PNG that contains those
// overlays' pixels." This file is that test.
//
// Coverage matrix (parameterized — adding a new surface or variant
// extends the matrix by N tests automatically):
//
//   SURFACES = clipboard:copy-image, clipboard:copy-path,
//              capture:prepareDrag
//   VARIANTS = v1-unedited, v1-annotated, v2-unedited, v2-annotated
//
// For each cell:
//   1. Seed the capture (real bundle on disk, real captures row in
//      SQLite, real layers tree for v2).
//   2. Call the bus verb (real handler, real renderer, real sharp).
//   3. Locate the produced PNG bytes (clipboard buffer for
//      copy-image; cache file at path for copy-path + prepareDrag).
//   4. Assert pixel signature: annotated variants must have RED
//      pixels in the overlay region; unedited variants must not.
//
// Why pixel signature (not byte-for-byte): JPEG re-encode + libvips
// version drift cause sub-pixel jitter even for identical inputs.
// A fuzzy "this region contains some red" check is robust to that
// AND directly answers the user-visible question (did my annotation
// make it through?).
//
// Source: GitHub issue #117. PR #116 unblocked the urgent regression;
// THIS file makes sure the regression class can't come back invisibly.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

// These integration tests do real sharp rasterization (compose → PNG →
// pixel assertions), which can exceed the 5s default on constrained CI
// runners (the 2-core windows-latest in particular). Give them generous
// headroom; the global 5s default stays in place for fast unit suites.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ---------------------------------------------------------------------
// Mock the parts of electron we touch. We don't need a real BrowserWindow
// or real clipboard — just enough surface for the handlers + renderer to
// run without ReferenceErrors.
// ---------------------------------------------------------------------

// Captures what each handler wrote so the test can inspect.
type ClipboardCapture =
  | { kind: "writeImage"; bytes: Buffer }
  | { kind: "writeText"; text: string }
  | { kind: "writeBuffer"; uti: string; bytes: Buffer };

const clipboardCaptured: ClipboardCapture[] = [];

// We'll set this from the test setup once the temp dir exists.
let testDataRoot: string;
let testDocumentsRoot: string;

vi.mock("electron", () => {
  return {
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
      write: vi.fn((args: { image?: unknown; text?: string }) => {
        if (args.image !== undefined) {
          // `image` is the mocked nativeImage object below — it
          // carries `__bytes` so we can recover what got written.
          const bytes = (args.image as { __bytes?: Buffer }).__bytes;
          if (bytes !== undefined) {
            clipboardCaptured.push({ kind: "writeImage", bytes });
          }
        }
      }),
      writeText: vi.fn((text: string) => {
        clipboardCaptured.push({ kind: "writeText", text });
      }),
      writeImage: vi.fn((image: unknown) => {
        const bytes = (image as { __bytes?: Buffer }).__bytes;
        if (bytes !== undefined) {
          clipboardCaptured.push({ kind: "writeImage", bytes });
        }
      }),
      writeBuffer: vi.fn((uti: string, bytes: Buffer) => {
        clipboardCaptured.push({ kind: "writeBuffer", uti, bytes });
      })
    },
    nativeImage: {
      // Return a stand-in that carries the bytes so the clipboard
      // mock can recover them. nativeImage.isEmpty() needs to return
      // false (the handler bails on empty images).
      createFromBuffer: (bytes: Buffer) => ({
        isEmpty: () => bytes.length === 0,
        __bytes: bytes
      })
    },
    BrowserWindow: {
      getAllWindows: () => []
    }
  };
});

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

// ---------------------------------------------------------------------
// Test fixture setup.
// ---------------------------------------------------------------------

// Imported AFTER the electron mock so the renderer/handler modules
// pick up the mocked clipboard.
const { bus } = await import("../command-bus");
const { registerClipboardHandlers } = await import("../handlers/clipboard-handlers");
const { registerCaptureHandlers } = await import("../handlers/capture-handlers");
const { registerLibraryHandlers } = await import("../handlers/library-handlers");
const { renderViaCoordinator } = await import("../render/coordinator");
const { openDatabase, closeDatabase, getDb } = await import("../persistence/db");
const { packBundleV2, buildCompositeThumbnail } = await import(
  "../persistence/bundle-store"
);
const { insertLayerTreeForCapture } = await import("../persistence/layers-repo");

const SOURCE_WIDTH = 400;
const SOURCE_HEIGHT = 300;
// Overlay rect covers x=[50, 250], y=[50, 150] — well inside the
// SOURCE bounds so we can assert pixels at the center and corners.
const OVERLAY_RECT = { x: 0.125, y: 0.166666, w: 0.5, h: 0.333333 };
// Red, used for the rectangle overlay so we can detect it by hue.
const OVERLAY_COLOR_HEX = "#ff5f57";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-matrix-"));
  testDataRoot = workDir;
  testDocumentsRoot = join(workDir, "documents");
  await mkdir(testDocumentsRoot, { recursive: true });
  await mkdir(join(workDir, "captures"), { recursive: true });
  await mkdir(join(workDir, "render-cache"), { recursive: true });
  process.env.PWRSNAP_DATA_ROOT = workDir;

  // openDatabase opens the file at <PWRSNAP_DATA_ROOT>/pwrsnap.db
  // and runs every migration in apps/desktop/src/main/persistence/
  // migrations/ up to the latest. We don't need to re-apply them
  // manually; that would conflict with the migration that creates
  // `captures`.
  await openDatabase();

  // Register the handlers under test. They read from the same bus
  // instance the test dispatches through.
  registerLibraryHandlers();
  registerClipboardHandlers();
  registerCaptureHandlers();
});

afterAll(async () => {
  closeDatabase();
  delete process.env.PWRSNAP_DATA_ROOT;
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  clipboardCaptured.length = 0;
});

afterEach(() => {
  // Wipe captures + layers between tests so each test's seed runs
  // against a clean slate. The DB file persists; just the rows go.
  const db = getDb();
  db.exec(`DELETE FROM layers`);
  db.exec(`DELETE FROM captures`);
});

// Build a 400×300 all-white source PNG.
async function makeSourcePng(): Promise<Buffer> {
  return await sharp({
    create: {
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .png()
    .toBuffer();
}

function annotatedOverlay(): Overlay {
  return {
    kind: "shape",
    rect: OVERLAY_RECT,
    color: OVERLAY_COLOR_HEX,
    filled: true
  };
}

// ---------------------------------------------------------------------
// Seed helpers — one for v1, one for v2. Each writes a REAL bundle to
// disk + inserts the captures + layers/overlays rows. The handlers
// under test then exercise the actual code paths a user hits.
// ---------------------------------------------------------------------

interface SeedArgs {
  id: string;
  annotated: boolean;
}

async function seedV2Capture(args: SeedArgs): Promise<void> {
  const sourcePng = await makeSourcePng();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(workDir, "captures", `${args.id}.pwrsnap`);
  // See `seedV1Capture` for why flat_png_path is populated even
  // though the surfaces currently under test don't read it.
  const flatPngPath = join(workDir, "captures", `${args.id}.png`);
  await writeFile(flatPngPath, sourcePng);
  const now = new Date().toISOString();

  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: args.id,
    canvas_dimensions: { width_px: SOURCE_WIDTH, height_px: SOURCE_HEIGHT },
    paired_png_filename: `${args.id}.png`,
    created_at: now,
    bundle_modified_at: now
  };

  // v2 layer tree: root group → raster (source). Annotated variant
  // adds a vector rect on top. The compose-tree compositor walks
  // this in z-order and bakes overlays into the rendered output.
  //
  // Layer ids are 16-char nanoid-style (NanoId16 schema). Transform
  // is the affine matrix tuple [a, b, c, d, tx, ty] — identity here.
  const rootGroupId = "grp_root_test_x0";
  const rasterId = "ras_source_test0";
  const overlayId = "vec_rect_test_x0";
  const common = {
    name: "",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal" as const,
    // Identity affine: 1 0 0 1 0 0
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
      natural_width_px: SOURCE_WIDTH,
      natural_height_px: SOURCE_HEIGHT
    }
  ];
  if (args.annotated) {
    layers.push({
      ...common,
      id: overlayId,
      kind: "vector",
      parent_id: rootGroupId,
      z_index: 1,
      shape: annotatedOverlay()
    });
  }
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: args.annotated ? 1 : 0,
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
        2, @ev,
        @w, @h, 2.0, @bs,
        @sha, @ev, NULL
      )`
    )
    .run({
      id: args.id,
      captured_at: now,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      ev: args.annotated ? 1 : 0,
      w: SOURCE_WIDTH,
      h: SOURCE_HEIGHT,
      bs: bundleBuf.length,
      sha: sourceSha
    });

  // Persist the layer tree so renderViaCoordinator → composeV2 sees
  // it (v2 reads from the layers table, not from the bundle on
  // each render — bundle is the durable backing store, layers are
  // the hot read path).
  insertLayerTreeForCapture(args.id, layers);
}

// ---------------------------------------------------------------------
// Pixel-signature helper. Decode a PNG and check whether the overlay
// region contains red-ish pixels (composite worked) or stays white
// (no overlay applied).
// ---------------------------------------------------------------------

async function pngHasRedInOverlayRegion(pngBytes: Buffer): Promise<boolean> {
  // Sample the center pixel of the overlay rect. For our 400×300
  // source + OVERLAY_RECT, the center is roughly (150, 100). Sharp's
  // .raw() returns interleaved RGBA bytes; we read one pixel.
  const meta = await sharp(pngBytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) return false;

  // The handler may resize the render (preset MED = 1440 wide).
  // Scale the overlay-center coordinate to the rendered dims.
  const cx = Math.round((OVERLAY_RECT.x + OVERLAY_RECT.w / 2) * width);
  const cy = Math.round((OVERLAY_RECT.y + OVERLAY_RECT.h / 2) * height);

  const { data, info } = await sharp(pngBytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const idx = (cy * width + cx) * channels;
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  // Red-ish: R dominant, G+B low. The overlay color #ff5f57 → (255,
  // 95, 87). Allow generous tolerance for any compositing / resize
  // blur.
  return r > 180 && g < 160 && b < 160;
}

// ---------------------------------------------------------------------
// Surface adapters — wrap each bus verb in a uniform shape so the
// matrix loop below can drive any of them. Each adapter returns the
// PNG bytes the surface produced.
// ---------------------------------------------------------------------

interface Surface {
  name: string;
  /** Optional applicability filter. Returning false for a variant
   *  skips the cell entirely — used by v2-only surfaces (e.g.,
   *  `clipboard:copyLayerFragment`) so v1 variants don't run against
   *  a handler that's documented to refuse them. Default = always
   *  applies. */
  appliesTo?(variantName: string): boolean;
  /** Drive the surface; return the PNG bytes it produced. */
  run(captureId: string): Promise<Buffer>;
}

const SURFACES: readonly Surface[] = [
  {
    name: "clipboard:copy-image",
    run: async (captureId) => {
      const result = await bus.dispatch(
        "clipboard:copy",
        { captureId, preset: "med" },
        { principal: "ipc" }
      );
      if (!result.ok) throw new Error(`copy failed: ${result.error.code}`);
      const last = clipboardCaptured.at(-1);
      if (last === undefined || last.kind !== "writeImage") {
        throw new Error(
          `expected writeImage on clipboard, got ${JSON.stringify(last)}`
        );
      }
      return last.bytes;
    }
  },
  {
    name: "clipboard:copy-path",
    run: async (captureId) => {
      const result = await bus.dispatch(
        "clipboard:copy-path",
        { captureId, preset: "med" },
        { principal: "ipc" }
      );
      if (!result.ok) throw new Error(`copy-path failed: ${result.error.code}`);
      const last = clipboardCaptured.at(-1);
      if (last === undefined || last.kind !== "writeText") {
        throw new Error(
          `expected writeText on clipboard, got ${JSON.stringify(last)}`
        );
      }
      return readFileSync(last.text);
    }
  },
  {
    name: "capture:prepareDrag",
    run: async (captureId) => {
      const result = await bus.dispatch(
        "capture:prepareDrag",
        { captureId, preset: "med" },
        { principal: "ipc" }
      );
      if (!result.ok) throw new Error(`prepareDrag failed: ${result.error.code}`);
      // prepareDrag returns both `path` (the high-res draggable) and
      // `iconPath` (the smaller drag preview). The high-res path is
      // the user-facing payload; verify pixels there.
      return readFileSync(result.value.path);
    }
  },
  {
    name: "clipboard:copyLayerFragment",
    // v2-only by design: the handler returns `v1_capture` for v1
    // rows. Skipping v1 variants is cleaner than asserting the
    // error (which would be testing the validation gate, not the
    // composite-bytes-on-clipboard behavior the matrix exists for).
    appliesTo: (variantName) => variantName.startsWith("v2"),
    run: async (captureId) => {
      // Drive the verb with no `layerIds` so the whole tree gets
      // serialized — matches the most common "copy this PwrSnap"
      // user flow.
      const result = await bus.dispatch(
        "clipboard:copyLayerFragment",
        { captureId },
        { principal: "ipc" }
      );
      if (!result.ok) {
        throw new Error(`copyLayerFragment failed: ${result.error.code}`);
      }
      // copyLayerFragment writes BOTH a private-UTI buffer (the
      // PwrSnap-to-PwrSnap fragment) AND a fallback PNG image (so
      // non-PwrSnap consumers get usable bytes). The PNG is what
      // a generic paste-target would see; the matrix asserts the
      // PNG contains the user's annotations. The writeBuffer call
      // is a separate, independent check — see the dedicated test
      // below the matrix.
      const writeImage = [...clipboardCaptured]
        .reverse()
        .find((c) => c.kind === "writeImage");
      if (writeImage === undefined || writeImage.kind !== "writeImage") {
        throw new Error(
          `expected writeImage in clipboard captures, got ${JSON.stringify(
            clipboardCaptured
          )}`
        );
      }
      return writeImage.bytes;
    }
  }
];

interface Variant {
  name: string;
  expectsRed: boolean;
  seed(id: string): Promise<void>;
}

// v2 is the only bundle format. The v1 variants (and the v1 seed
// helper) were removed when the v1 read/render path was deleted —
// `renderViaCoordinator` now throws for a non-v2 record, so a v1
// variant could never produce a render to assert on.
const VARIANTS: readonly Variant[] = [
  {
    name: "v2-unedited",
    expectsRed: false,
    seed: (id) => seedV2Capture({ id, annotated: false })
  },
  {
    name: "v2-annotated",
    expectsRed: true,
    seed: (id) => seedV2Capture({ id, annotated: true })
  }
];

// ---------------------------------------------------------------------
// The matrix. Each (surface × variant) becomes one test.
// ---------------------------------------------------------------------

describe("export-surface-matrix: every surface composites the v2 layer set", () => {
  for (const surface of SURFACES) {
    for (const variant of VARIANTS) {
      if (surface.appliesTo !== undefined && !surface.appliesTo(variant.name)) {
        continue;
      }
      const expectation = variant.expectsRed
        ? "INCLUDES overlay (red pixels in overlay region)"
        : "OMITS overlay (no red pixels — source is white)";
      test(`${surface.name} on ${variant.name} ${expectation}`, async () => {
        const captureId = idForCell(surface.name, variant.name);
        await variant.seed(captureId);
        const pngBytes = await surface.run(captureId);
        const hasRed = await pngHasRedInOverlayRegion(pngBytes);
        if (variant.expectsRed) {
          // The #116 regression class manifested here for v2-annotated:
          // pre-fix this assertion failed because the surface returned
          // bare source bytes with no overlay composited.
          //
          // TO VERIFY the matrix is honest about catching that class:
          // temporarily wrap the v2 branch in
          // `apps/desktop/src/main/render/coordinator.ts` behind
          // `false &&` and re-run this file. Exactly the v2-annotated
          // cells (across every surface that respects the dispatch)
          // must fail; the unedited cells stay green. That's the
          // signature. Revert when done.
          expect(hasRed).toBe(true);
        } else {
          // Sanity: unedited variants must NOT have red pixels — proves
          // the matrix actually distinguishes "composite ran" from
          // "didn't run."
          expect(hasRed).toBe(false);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------
// Additional pin for `clipboard:copyLayerFragment`'s WriteBuffer side
// (the private-UTI fragment payload). The matrix above asserts the
// PNG fallback that non-PwrSnap consumers see; this confirms the
// PwrSnap-to-PwrSnap fragment ALSO lands on the clipboard correctly.
// Without this, the writeBuffer interceptor in the electron mock
// would be untested — a regression where writeBuffer stopped being
// called for some reason would slip through silently.
// ---------------------------------------------------------------------

describe("clipboard:copyLayerFragment — private UTI fragment payload", () => {
  test("writes a UTI buffer containing a valid layer-fragment JSON for v2 annotated", async () => {
    const captureId = "t_uti_buffer_check_xx";
    await seedV2Capture({ id: captureId, annotated: true });

    const result = await bus.dispatch(
      "clipboard:copyLayerFragment",
      { captureId },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);

    const writeBuf = clipboardCaptured.find((c) => c.kind === "writeBuffer");
    expect(writeBuf).toBeDefined();
    if (writeBuf === undefined || writeBuf.kind !== "writeBuffer") return;

    // UTI matches the canonical PwrSnap one — the same constant
    // every PwrSnap-to-PwrSnap paste path looks for.
    expect(writeBuf.uti).toBe("com.pwrdrvr.pwrsnap.layer-fragment");

    // Payload parses as JSON and carries the expected top-level
    // schema fields. We don't re-validate the whole zod schema here
    // (that's the handler's job); a presence check confirms the
    // wire path is intact.
    const parsed = JSON.parse(writeBuf.bytes.toString("utf-8"));
    expect(parsed.format_version).toBe(1);
    expect(parsed.source_capture_id).toBe(captureId);
    expect(Array.isArray(parsed.layers)).toBe(true);
    expect(parsed.layers.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.source_refs)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Text-overlay sizing across crops (pwrdrvr/PwrSnap#110 follow-up).
//
// The matrix above pins overlay COMPOSITING (red region present in
// the export). This block pins overlay SIZING — specifically, that
// text in a v2 cropped capture renders at the SOURCE raster's
// shortSide-derived size, not the (shrunk) canvas's. Editor was
// fixed in commit `881cff0`; the bake's `textSvg` (compose.ts) had
// the same bug. User-visible symptom: clipboard:copy MED produced a
// PNG with text noticeably smaller than what the editor displayed.
//
// Pixel signature: a "large" text bucket on a 400×300 canvas backed
// by an 800×600 source raster renders text 33 source-px tall (correct
// behavior, sourceShortSide=600 / 18) vs 17 source-px tall (bug
// behavior, canvasShortSide=300 / 18). After MED resizes to 1440-wide,
// the canvas is 1440×1080, scale 3.6×. Text vertical extent:
//   • Correct: rows 480..600
//   • Bug:     rows 510..570
// At Y=495 (between the two regimes), the column at the text's X
// anchor (720) has dark pixels under the CORRECT rendering and white
// under the BUG.
// ---------------------------------------------------------------------

const CROPPED_TEXT_RASTER_W = 800;
const CROPPED_TEXT_RASTER_H = 600;
const CROPPED_TEXT_CANVAS_W = 400;
const CROPPED_TEXT_CANVAS_H = 300;

async function seedV2CroppedCaptureWithLargeText(id: string): Promise<void> {
  // Source raster is 800×600 (the user's pre-crop natural). The
  // captures.{width,height}_px and the manifest canvas_dimensions are
  // 400×300 — simulating the post-crop state. The raster's transform
  // stays identity here; this fixture is about the SIZE math, not the
  // off-origin translate (PR #110 covers the latter separately).
  const sourcePng = await sharp({
    create: {
      width: CROPPED_TEXT_RASTER_W,
      height: CROPPED_TEXT_RASTER_H,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .png()
    .toBuffer();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(workDir, "captures", `${id}.pwrsnap`);
  const flatPngPath = join(workDir, "captures", `${id}.png`);
  await writeFile(flatPngPath, sourcePng);
  const now = new Date().toISOString();

  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: id,
    canvas_dimensions: {
      width_px: CROPPED_TEXT_CANVAS_W,
      height_px: CROPPED_TEXT_CANVAS_H
    },
    paired_png_filename: `${id}.png`,
    created_at: now,
    bundle_modified_at: now
  };

  // NanoId16 = exactly 16 chars of [A-Za-z0-9_-]. Match existing
  // matrix fixtures' style.
  const rootGroupId = "grp_text_size_x0";
  const rasterId = "ras_text_size_x0";
  const textId = "vec_text_size_x0";
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
      // NATURAL dims are the source raster's 800×600 — invariant
      // across crops. Canvas dims (manifest + captures row) are the
      // smaller cropped extent. This mismatch is the load-bearing
      // setup that exposes the bake's size bug.
      natural_width_px: CROPPED_TEXT_RASTER_W,
      natural_height_px: CROPPED_TEXT_RASTER_H
    },
    {
      ...common,
      id: textId,
      kind: "vector",
      parent_id: rootGroupId,
      z_index: 1,
      shape: {
        kind: "text",
        point: { x: 0.5, y: 0.5 },
        // Single dense glyph so the vertical pixel column at the
        // anchor X reliably hits text body for ANY non-trivial
        // fontSize. "M" is the densest ASCII char vertically.
        body: "M",
        size: "large",
        // Explicit dark color: black so the test's "is this pixel
        // dark?" check is unambiguous against the white raster.
        color: "#000000"
      }
    }
  ];
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 1,
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
        2, @ev,
        @w, @h, 2.0, @bs,
        @sha, @ev, NULL
      )`
    )
    .run({
      id,
      captured_at: now,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      ev: 1,
      w: CROPPED_TEXT_CANVAS_W,
      h: CROPPED_TEXT_CANVAS_H,
      bs: bundleBuf.length,
      sha: sourceSha
    });

  insertLayerTreeForCapture(id, layers);
}

/** Count how many "dark" pixels fall in a vertical column at the
 *  given X coord, within Y range [yStart, yEnd). Used to estimate text
 *  height in the rendered PNG without depending on exact glyph metrics
 *  — a taller text glyph fills more rows of the column. */
async function darkPixelCountInColumn(
  pngBytes: Buffer,
  x: number,
  yStart: number,
  yEnd: number
): Promise<number> {
  const { data, info } = await sharp(pngBytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const width = info.width;
  let count = 0;
  for (let y = yStart; y < yEnd; y += 1) {
    const idx = (y * width + x) * channels;
    const r = data[idx] ?? 255;
    const g = data[idx + 1] ?? 255;
    const b = data[idx + 2] ?? 255;
    // "Dark" = significantly darker than white. The text has a
    // black fill + dark stroke; an anti-aliased edge pixel will
    // land somewhere below 200 in all channels. 200 is generous —
    // pure background (255,255,255) doesn't hit; even faint anti-
    // alias halos do.
    if (r < 200 && g < 200 && b < 200) count += 1;
  }
  return count;
}

describe("text overlay sizing — bake honors source shortSide across crops (pwrdrvr/PwrSnap#110)", () => {
  test("clipboard:copy MED on v2 cropped capture renders text at SOURCE-shortSide-derived size", async () => {
    // The user-visible bug: the editor showed text at the correct size
    // (post-`881cff0` renderer fix), but Copy MED produced an export
    // where the text was visibly smaller. Root cause: `textSvg` in
    // `compose.ts` was deriving fontSize from canvas shortSide, which
    // shrinks every crop. Fix threads source dims through compose-tree
    // so textSvg can use the raster's natural shortSide.
    const captureId = "t_text_size_cropped_x0";
    await seedV2CroppedCaptureWithLargeText(captureId);

    const result = await bus.dispatch(
      "clipboard:copy",
      { captureId, preset: "med" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);

    const last = clipboardCaptured.at(-1);
    if (last === undefined || last.kind !== "writeImage") {
      throw new Error(`expected writeImage on clipboard, got ${JSON.stringify(last)}`);
    }
    const pngBytes = last.bytes;

    // Copy presets now clamp to source width for captures smaller
    // than LOW/MED, so this user-facing path should remain source-
    // sized. The text-size assertion below still catches the original
    // bug because the correct fontSize derives from the source
    // shortSide (600), not the cropped canvas shortSide (300), at any
    // render scale.
    const meta = await sharp(pngBytes).metadata();
    expect(meta.width).toBe(CROPPED_TEXT_CANVAS_W);
    expect(meta.height).toBe(CROPPED_TEXT_CANVAS_H);
    const outputWidth = meta.width;
    const outputHeight = meta.height;
    if (outputWidth === undefined || outputHeight === undefined) {
      throw new Error("sharp.metadata() returned undefined dims");
    }
    const renderScale = outputWidth / CROPPED_TEXT_CANVAS_W;

    // Text anchor at canvas (200, 150). SVG `text-anchor` defaults
    // to "start" so the M's left edge sits at x=200×scale; with
    // fontSize × scale the glyph extends rightward from there. Scale
    // the scan column + window so the assertion works at ANY render
    // scale.
    //
    // fontSize derivation (the load-bearing assertion):
    //   CORRECT (uses sourceShortSide=600): 600/18 = 33.3 source-px
    //   BUG     (uses canvasShortSide=300): 300/18 = 16.7 source-px
    // In the rendered output, both get multiplied by renderScale:
    //   CORRECT: 33.3 × scale (≈120 PNG-px at MED 3.6× scale)
    //   BUG:     16.7 × scale (≈60 PNG-px)
    //
    // The "M" vertical stroke fills a contiguous block at its column.
    // We pick the scan x at "anchor + 2 canvas-px" (the left vertical
    // of the M, reliable for any fontSize) and the scan y as
    // ±half-the-expected-text-height around the anchor in scaled
    // coords. Threshold scales with renderScale so the test stays
    // valid at LOW / MED / HIGH alike.
    const anchorXCanvas = 200;
    const anchorYCanvas = 150;
    const scanX = Math.round((anchorXCanvas + 2) * renderScale);
    // Scan a window of ±half-text-height around the anchor in canvas
    // px, scaled to render px. ±30 canvas-px is wider than 16.7 but
    // narrower than 33.3 — keeps the bug regime under threshold while
    // the correct regime saturates.
    const windowHalfCanvasPx = 30;
    const windowStart = Math.round(
      (anchorYCanvas - windowHalfCanvasPx) * renderScale
    );
    const windowEnd = Math.round(
      (anchorYCanvas + windowHalfCanvasPx) * renderScale
    );
    const darkCount = await darkPixelCountInColumn(
      pngBytes,
      scanX,
      windowStart,
      windowEnd
    );
    // Threshold = 22 canvas-px (the original threshold, picked
    // between the bug's 17 max and the correct's 33 min) × renderScale
    // so it stays valid across preset tiers.
    const threshold = 22 * renderScale;
    expect(
      darkCount,
      `Dark-pixel count in vertical column at scaled x=${scanX}, y=[${windowStart}, ${windowEnd}) (renderScale=${renderScale}) should reflect CORRECT (source-shortSide) text height (~${Math.round(33.3 * renderScale)} px) — saw ${darkCount}. Bug rendering would shrink the text to ~${Math.round(16.7 * renderScale)} px tall and miss the ${threshold.toFixed(0)} threshold; the bake's textSvg used canvas shortSide instead of sourceShortSide.`
    ).toBeGreaterThan(threshold);
  });
});

// ---------------------------------------------------------------------
// Out-of-canvas overlay coords (pwrdrvr/PwrSnap#110 schema widening).
//
// `NormalizedScalar` was widened from `.min(0).max(1)` to `.finite()`
// so an overlay whose source-pixel position is outside the cropped
// viewport (e.g. a text typed at point.x=0.95 on a 2880-wide canvas
// that's then cropped to 60% width → new point.x ≈ 1.58) can persist
// as DATA in the layer tree. The renderer (SVG overflow:hidden) and
// the bake (sharp composite) clip at the canvas boundary at paint
// time — but no test currently pins the "schema permits, paint clips"
// contract end-to-end. This block does.
//
// Without this test, a future tightening of the schema OR a regression
// in the bake's clip math could let an out-of-canvas rect paint
// arbitrary pixels past the canvas right edge and ship unnoticed.
// ---------------------------------------------------------------------

async function seedV2CaptureWithOutOfCanvasRect(id: string): Promise<void> {
  // 400×300 canvas + raster, with a vector rect whose x=1.05 (i.e.,
  // its LEFT edge is already past the right edge of the canvas).
  // CORRECT behavior: the export PNG shows no red pixels at all —
  // the rect is wholly outside the visible canvas.
  // BUG behavior (if the schema clamped or the bake mis-clipped):
  // some red bleeds onto the canvas's right edge or wraps around.
  const sourcePng = await makeSourcePng();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(workDir, "captures", `${id}.pwrsnap`);
  const flatPngPath = join(workDir, "captures", `${id}.png`);
  await writeFile(flatPngPath, sourcePng);
  const now = new Date().toISOString();
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: id,
    canvas_dimensions: { width_px: SOURCE_WIDTH, height_px: SOURCE_HEIGHT },
    paired_png_filename: `${id}.png`,
    created_at: now,
    bundle_modified_at: now
  };
  const rootGroupId = "grp_oob_test_xx0";
  const rasterId = "ras_oob_test_xx0";
  const overlayId = "vec_oob_test_xx0";
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
      natural_width_px: SOURCE_WIDTH,
      natural_height_px: SOURCE_HEIGHT
    },
    {
      ...common,
      id: overlayId,
      kind: "vector",
      parent_id: rootGroupId,
      z_index: 1,
      shape: {
        kind: "shape",
        // Entirely past the right edge: x = 1.05 means the rect's
        // left edge starts at source pixel 1.05 × 400 = 420 — 20 px
        // past the canvas's right edge (at 400). w = 0.2 = 80 px.
        // Schema accepts (.finite() — out-of-canvas coords are
        // legitimate post-#110); the BAKE must clip and emit no red.
        rect: { x: 1.05, y: 0.166666, w: 0.2, h: 0.333333 },
        color: OVERLAY_COLOR_HEX,
        filled: true
      }
    }
  ];
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 1,
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
        2, @ev,
        @w, @h, 2.0, @bs,
        @sha, @ev, NULL
      )`
    )
    .run({
      id,
      captured_at: now,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      ev: 1,
      w: SOURCE_WIDTH,
      h: SOURCE_HEIGHT,
      bs: bundleBuf.length,
      sha: sourceSha
    });
  insertLayerTreeForCapture(id, layers);
}

/** Scan every pixel of the PNG and return the count that match the
 *  overlay's red hue. Lets the test prove the entire canvas is free
 *  of the overlay color when it should be clipped, not just one
 *  sampled point. */
async function totalRedPixelCount(pngBytes: Buffer): Promise<number> {
  const { data, info } = await sharp(pngBytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let count = 0;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    // Same "red-ish" tolerance as `pngHasRedInOverlayRegion` —
    // overlay color #ff5f57 ± resize-blur slack.
    if (r > 180 && g < 160 && b < 160) count += 1;
  }
  return count;
}

describe("schema-permits + paint-clips: out-of-canvas overlay coords don't bleed past canvas edge", () => {
  test("v2 capture with rect at x=1.05 (entirely past right edge): bake produces ZERO red pixels", async () => {
    // The contract pwrdrvr/PwrSnap#110's schema widening relies on:
    // overlays can persist out-of-canvas coords, and the renderer
    // + bake clip them at the canvas boundary. Without this test,
    // a future bake-pipeline refactor that forgot to clip — or a
    // sharp.composite call that wraps coords modulo canvas dim
    // (Sharp doesn't do this, but a future migration to a
    // different rasterizer might) — would silently ship a buggy
    // export where a "hidden" annotation paints arbitrary canvas
    // pixels.
    //
    // The seeded rect is entirely past the canvas's right edge
    // (left edge at canvas x=420; canvas right edge is x=400).
    // No red pixels should appear anywhere in the exported PNG.
    const captureId = "t_oob_rect_clip_x00";
    await seedV2CaptureWithOutOfCanvasRect(captureId);

    const result = await bus.dispatch(
      "clipboard:copy",
      { captureId, preset: "med" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);

    const last = clipboardCaptured.at(-1);
    if (last === undefined || last.kind !== "writeImage") {
      throw new Error(`expected writeImage on clipboard, got ${JSON.stringify(last)}`);
    }
    const redCount = await totalRedPixelCount(last.bytes);
    expect(
      redCount,
      "An overlay rect entirely outside the canvas must NOT paint a single pixel of overlay color. If red pixels appear, the bake's composite is either wrapping the rect coords modulo canvas dim or failing to clip — either way the schema's widening to .finite() would be exposing a real bug."
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Scale-aware accumulator WYSIWYG (PR #129 bake-WYSIWYG follow-up).
//
// The bake-WYSIWYG PR introduced a scale-aware accumulator: when the
// requested output width exceeds canvas width (MED on a small capture,
// LOW on an even smaller one), the accumulator is built at render dims
// instead of canvas dims so every layer rasterizes at output resolution
// (crisp text, visible halos).
//
// The first ship of that change had a CRITICAL bug: the raster layer
// compositor (`compositeRasterOntoAccumulator`) still placed the source
// PNG at its NATURAL dims (e.g. 400×300) onto the render-dim accumulator
// (e.g. 1440×1080). Result: the image landed in the upper-left quadrant
// while VECTOR overlays (whose fractional point coords are scaled
// against the accumulator's full dims) spread across the entire render
// canvas. WYSIWYG completely broken — text overlays floated outside
// the visible image.
//
// The effect layer compositor (`applyEffectOntoAccumulator`) had the
// same class of bug — `clip_rect` is in CANVAS coords but extract+
// composite ran against the render-dim accumulator, mis-positioning
// blur and highlight rects.
//
// These tests pin the fix end-to-end. They use a NON-WHITE source
// (cyan) so transparent-vs-raster pixels are unambiguously
// distinguishable — the existing matrix tests use white sources and
// can't catch this class (transparent reads like white to a naive
// "is this red?" check).
//
// If either test fails, the symptom on the user's screen is:
// "raster in upper-left corner, annotations scattered across an
//  otherwise transparent canvas."
// ---------------------------------------------------------------------

const SCALE_TEST_CANVAS_W = 400;
const SCALE_TEST_CANVAS_H = 300;
// Distinct enough from white and from the overlay red that all three
// states (transparent, raster, overlay) are unambiguous in the assertion.
const SCALE_TEST_RASTER_R = 0;
const SCALE_TEST_RASTER_G = 200;
const SCALE_TEST_RASTER_B = 220;

async function seedV2CaptureCyanRaster(id: string): Promise<void> {
  // 400×300 source PNG, ALL CYAN. Canvas matches source dims (no crop).
  // The interesting axis is render dims = canvas × renderScale (MED on
  // 400-wide canvas → 1440-wide render → 3.6× upscale).
  const sourcePng = await sharp({
    create: {
      width: SCALE_TEST_CANVAS_W,
      height: SCALE_TEST_CANVAS_H,
      channels: 3,
      background: {
        r: SCALE_TEST_RASTER_R,
        g: SCALE_TEST_RASTER_G,
        b: SCALE_TEST_RASTER_B
      }
    }
  })
    .png()
    .toBuffer();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(workDir, "captures", `${id}.pwrsnap`);
  const flatPngPath = join(workDir, "captures", `${id}.png`);
  await writeFile(flatPngPath, sourcePng);
  const now = new Date().toISOString();
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: id,
    canvas_dimensions: {
      width_px: SCALE_TEST_CANVAS_W,
      height_px: SCALE_TEST_CANVAS_H
    },
    paired_png_filename: `${id}.png`,
    created_at: now,
    bundle_modified_at: now
  };
  const rootGroupId = "grp_scale_test_0";
  const rasterId = "ras_scale_test_0";
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
      natural_width_px: SCALE_TEST_CANVAS_W,
      natural_height_px: SCALE_TEST_CANVAS_H
    }
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
      id,
      captured_at: now,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      w: SCALE_TEST_CANVAS_W,
      h: SCALE_TEST_CANVAS_H,
      bs: bundleBuf.length,
      sha: sourceSha
    });
  insertLayerTreeForCapture(id, layers);
}

async function seedV2CaptureCyanRasterWithHighlight(id: string): Promise<void> {
  // Same cyan raster as above + a highlight EFFECT layer covering the
  // CENTER of the canvas. The effect compositor extracts from the
  // accumulator at clip_rect bounds, applies the tint, composites back.
  // If clip_rect isn't scaled by renderScale, the effect lands in the
  // upper-left of the render canvas instead of the canvas center.
  const sourcePng = await sharp({
    create: {
      width: SCALE_TEST_CANVAS_W,
      height: SCALE_TEST_CANVAS_H,
      channels: 3,
      background: {
        r: SCALE_TEST_RASTER_R,
        g: SCALE_TEST_RASTER_G,
        b: SCALE_TEST_RASTER_B
      }
    }
  })
    .png()
    .toBuffer();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(workDir, "captures", `${id}.pwrsnap`);
  const flatPngPath = join(workDir, "captures", `${id}.png`);
  await writeFile(flatPngPath, sourcePng);
  const now = new Date().toISOString();
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: id,
    canvas_dimensions: {
      width_px: SCALE_TEST_CANVAS_W,
      height_px: SCALE_TEST_CANVAS_H
    },
    paired_png_filename: `${id}.png`,
    created_at: now,
    bundle_modified_at: now
  };
  const rootGroupId = "grp_highlight_x0";
  const rasterId = "ras_highlight_x0";
  const effectId = "eff_highlight_x0";
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
      natural_width_px: SCALE_TEST_CANVAS_W,
      natural_height_px: SCALE_TEST_CANVAS_H
    },
    {
      ...common,
      id: effectId,
      kind: "effect",
      parent_id: rootGroupId,
      z_index: 1,
      // Pure red tint at full opacity so the post-effect pixels are
      // unambiguously red (not pink-cyan blend).
      effect: { type: "highlight", tint_hex: "#ff0000", opacity: 1 },
      // clip_rect in CANVAS coords: a 100×100 box at canvas position
      // (250, 100). At MED scale=3.6 it must land at render position
      // (900, 360) covering 360×360 px. Pre-fix, the effect used the
      // raw clip_rect against the render-dim accumulator — so the
      // effect would land at the SAME pixel coords (250..350, 100..200)
      // which is the UPPER-LEFT quadrant of the render canvas, NOT
      // the canvas center.
      clip_rect: { x: 250, y: 100, w: 100, h: 100 }
    }
  ];
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 1,
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
        2, 1,
        @w, @h, 2.0, @bs,
        @sha, 1, NULL
      )`
    )
    .run({
      id,
      captured_at: now,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      w: SCALE_TEST_CANVAS_W,
      h: SCALE_TEST_CANVAS_H,
      bs: bundleBuf.length,
      sha: sourceSha
    });
  insertLayerTreeForCapture(id, layers);
}

/** Read a single pixel's RGBA at output coords. Returns {r,g,b,a} so
 *  callers can distinguish transparent (alpha=0) from raster-colored. */
async function readPixel(
  pngBytes: Buffer,
  x: number,
  y: number
): Promise<{ r: number; g: number; b: number; a: number }> {
  const { data, info } = await sharp(pngBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return {
    r: data[idx] ?? 0,
    g: data[idx + 1] ?? 0,
    b: data[idx + 2] ?? 0,
    a: data[idx + 3] ?? 0
  };
}

describe("scale-aware accumulator: raster + effect layers respect renderScale", () => {
  test("raster layer fills the FULL output dims when the coordinator is explicitly asked to upscale", async () => {
    // Pre-fix this test fails: the raster lands at source dims
    // (400×300) in the upper-left of the render-dim accumulator
    // (1440×1080), so the bottom-right is transparent.
    const captureId = "t_scale_raster_fill_x";
    await seedV2CaptureCyanRaster(captureId);

    const result = await renderViaCoordinator({
      captureId,
      srcPath: "/ignored/for/v2.png",
      imageWidthPx: SCALE_TEST_CANVAS_W,
      imageHeightPx: SCALE_TEST_CANVAS_H,
      width: 1440,
      format: "png"
    });
    const pngBytes = readFileSync(result.cachePath);

    // Confirm the output dims actually upscaled (sanity — if this
    // fails, the scale-aware accumulator change reverted).
    const meta = await sharp(pngBytes).metadata();
    expect(meta.width).toBe(1440);
    expect(meta.height).toBe(1080);

    // Sample a pixel well past the source-dims (400×300) upper-left
    // region but well inside the canvas. This is the load-bearing
    // assertion — pre-fix it would be transparent (alpha=0); post-fix
    // it must be the raster's cyan color.
    const samples: Array<{ name: string; x: number; y: number }> = [
      { name: "center of render", x: 720, y: 540 },
      { name: "render right-half", x: 1000, y: 540 },
      { name: "render bottom-half", x: 720, y: 800 },
      { name: "render bottom-right", x: 1300, y: 1000 }
    ];
    for (const s of samples) {
      const px = await readPixel(pngBytes, s.x, s.y);
      expect(
        px.a,
        `Pixel at ${s.name} (${s.x}, ${s.y}) should be OPAQUE (raster present). ` +
          `If alpha=0, the raster layer was placed at its natural dims ` +
          `(400×300) in the upper-left of the render-dim accumulator ` +
          `(${meta.width}×${meta.height}) instead of being upscaled to ` +
          `fill it. Got rgba(${px.r}, ${px.g}, ${px.b}, ${px.a}).`
      ).toBeGreaterThan(200);
      // And the color should be approximately the source cyan
      // (lanczos upscale doesn't change a flat fill, so this is exact
      // modulo rounding).
      expect(
        Math.abs(px.r - SCALE_TEST_RASTER_R) +
          Math.abs(px.g - SCALE_TEST_RASTER_G) +
          Math.abs(px.b - SCALE_TEST_RASTER_B),
        `Pixel at ${s.name} (${s.x}, ${s.y}) should be the raster's ` +
          `cyan (${SCALE_TEST_RASTER_R}, ${SCALE_TEST_RASTER_G}, ` +
          `${SCALE_TEST_RASTER_B}). Got rgba(${px.r}, ${px.g}, ${px.b}, ${px.a}).`
      ).toBeLessThan(30);
    }
  });

  test("highlight effect clip_rect lands at the SCALED canvas position when upscaled", async () => {
    // Pre-fix: clip_rect is in canvas coords but applied directly to
    // the render-dim accumulator, so a clip_rect at canvas (250..350,
    // 100..200) extracts the upper-left rect (250..350, 100..200) of
    // the render canvas — the wrong region. Post-fix: scaled to render
    // coords (900..1260, 360..720).
    const captureId = "t_scale_effect_pos_xx";
    await seedV2CaptureCyanRasterWithHighlight(captureId);

    const result = await renderViaCoordinator({
      captureId,
      srcPath: "/ignored/for/v2.png",
      imageWidthPx: SCALE_TEST_CANVAS_W,
      imageHeightPx: SCALE_TEST_CANVAS_H,
      width: 1440,
      format: "png"
    });
    const pngBytes = readFileSync(result.cachePath);
    const meta = await sharp(pngBytes).metadata();
    expect(meta.width).toBe(1440);
    expect(meta.height).toBe(1080);

    // EXPECTED region (post-fix): canvas (250..350, 100..200) ×
    // renderScale 3.6 → render (900..1260, 360..720). Sample the
    // center: (1080, 540).
    const insideExpected = await readPixel(pngBytes, 1080, 540);
    expect(
      insideExpected.r,
      `Pixel at scaled effect center (1080, 540) should be red ` +
        `(highlight tint). If R is low, the effect's clip_rect wasn't ` +
        `scaled by renderScale. Got rgba(${insideExpected.r}, ` +
        `${insideExpected.g}, ${insideExpected.b}, ${insideExpected.a}).`
    ).toBeGreaterThan(180);
    expect(insideExpected.g).toBeLessThan(80);

    // INSIDE THE BUG REGION (canvas-px coords applied without scale):
    // (250..350, 100..200), center (300, 150). Post-fix this is just
    // the raster cyan; pre-fix it would be red.
    const insideBugRegion = await readPixel(pngBytes, 300, 150);
    expect(
      insideBugRegion.r,
      `Pixel at (300, 150) — where pre-fix the effect would have been ` +
        `applied (clip_rect not scaled) — should NOT be red. Got ` +
        `rgba(${insideBugRegion.r}, ${insideBugRegion.g}, ` +
        `${insideBugRegion.b}, ${insideBugRegion.a}).`
    ).toBeLessThan(80);
    expect(insideBugRegion.g).toBeGreaterThan(150);
  });
});

// ---------------------------------------------------------------------
// Highlight color WYSIWYG — bake matches editor's CSS mix-blend-mode
// multiply behavior, not sharp/libvips's premultiplied multiply.
//
// User report on PR #129: the v2 bake of a vector highlight (kind:
// "highlight", default blend "multiply") produces a DARK gray box
// where the editor shows a LIGHT tint of the highlight color. Root
// cause: sharp's `blend: "multiply"` premultiplies the overlay's
// alpha into RGB before computing the multiply, so a 32%-opaque blue
// over white becomes (74×0.32, 158×0.32, 255×0.32) ≈ (24, 51, 82)
// instead of the CSS-spec
//   result = αs × (Cb × Cs / 255) + (1 - αs) × Cb
// which over white (Cb=255) gives (165, 207, 255) — recognizably blue.
//
// The editor uses CSS mix-blend-mode multiply (Chromium implements the
// CSS spec verbatim). The bake's path through `compositeVectorOnto-
// Accumulator` → `compose-tree-vector.ts` → `sharp.composite({ blend:
// "multiply" })` diverges by enough to be user-visible — and the
// existing matrix tests miss it because they only check "is there
// red?" not "is the actual color right?"
// ---------------------------------------------------------------------

async function seedV2CaptureWithHighlightOverlay(id: string): Promise<void> {
  // 400×300 WHITE raster + a vector highlight rect covering the center
  // half. White background means CSS multiply gives a clean light tint
  // of the highlight color; the bug regime gives darker.
  const sourcePng = await makeSourcePng();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(workDir, "captures", `${id}.pwrsnap`);
  const flatPngPath = join(workDir, "captures", `${id}.png`);
  await writeFile(flatPngPath, sourcePng);
  const now = new Date().toISOString();
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: id,
    canvas_dimensions: { width_px: SOURCE_WIDTH, height_px: SOURCE_HEIGHT },
    paired_png_filename: `${id}.png`,
    created_at: now,
    bundle_modified_at: now
  };
  const rootGroupId = "grp_hl_color_xx0";
  const rasterId = "ras_hl_color_xx0";
  const overlayId = "vec_hl_color_xx0";
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
      natural_width_px: SOURCE_WIDTH,
      natural_height_px: SOURCE_HEIGHT
    },
    {
      ...common,
      id: overlayId,
      kind: "vector",
      parent_id: rootGroupId,
      z_index: 1,
      shape: {
        kind: "highlight",
        // Center half: covers (100, 75) to (300, 225) in canvas coords.
        rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        color: "#4a9eff", // bright blue — easy to detect a "light blue" result
        opacity: 0.5
        // blend omitted — falls back to "multiply" (default)
      }
    }
  ];
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 1,
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
        2, 1,
        @w, @h, 2.0, @bs,
        @sha, 1, NULL
      )`
    )
    .run({
      id,
      captured_at: now,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      w: SOURCE_WIDTH,
      h: SOURCE_HEIGHT,
      bs: bundleBuf.length,
      sha: sourceSha
    });
  insertLayerTreeForCapture(id, layers);
}

describe("highlight color WYSIWYG: bake matches editor's CSS multiply behavior", () => {
  test("vector highlight over white raster bakes to a LIGHT tint (not dark/gray)", async () => {
    // CSS mix-blend-mode multiply formula:
    //   blend = (overlay_rgb × backdrop_rgb) / 255
    //   result = blend × overlay_alpha + backdrop × (1 - overlay_alpha)
    // For blue (74, 158, 255) at α=0.5 over white (255, 255, 255):
    //   blend = (74, 158, 255)
    //   result = (74×0.5 + 255×0.5, 158×0.5 + 255×0.5, 255×0.5 + 255×0.5)
    //          = (164.5, 206.5, 255)  → recognizably LIGHT BLUE
    //
    // Pre-fix bake (sharp.composite blend:"multiply" — premultiplies):
    //   result ≈ (74×0.5, 158×0.5, 255×0.5) = (37, 79, 127.5)
    //   → DARK BLUE/GRAY. Gray-blue is the symptom in the user's
    //     screenshot from PR #129 review.
    const captureId = "t_highlight_color_x0";
    await seedV2CaptureWithHighlightOverlay(captureId);

    const result = await bus.dispatch(
      "clipboard:copy",
      { captureId, preset: "high" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    const last = clipboardCaptured.at(-1);
    if (last === undefined || last.kind !== "writeImage") {
      throw new Error(`expected writeImage on clipboard, got ${JSON.stringify(last)}`);
    }
    const pngBytes = last.bytes;

    // Sanity: HIGH preset on 400-wide canvas → no upscale, output 400×300.
    const meta = await sharp(pngBytes).metadata();
    expect(meta.width).toBe(SOURCE_WIDTH);
    expect(meta.height).toBe(SOURCE_HEIGHT);

    // Center of highlight = canvas (200, 150). The highlight rect covers
    // (100, 75) → (300, 225) so the center is well inside, away from
    // edges where antialiasing might confuse the read.
    const center = await readPixel(pngBytes, 200, 150);

    // CORRECT (CSS multiply on white): channels ≈ (165, 207, 255).
    // BUG (libvips premultiplied multiply on white): channels ≈ (37, 79, 128).
    //
    // The R channel is the clearest signal: CSS gives ~165, bug gives
    // ~37. A threshold of R > 130 cleanly distinguishes them with
    // plenty of room for libvips/sharp-version jitter.
    expect(
      center.r,
      `Highlight center should be a LIGHT tint of blue (R ≈ 165 — ` +
        `CSS mix-blend-mode multiply over white). If R is low (~37), ` +
        `the bake is using sharp's premultiplied multiply blend and ` +
        `diverging from the editor — the symptom is a dark/gray box ` +
        `where the editor shows light blue. Got rgba(${center.r}, ` +
        `${center.g}, ${center.b}, ${center.a}).`
    ).toBeGreaterThan(130);
    // Sanity on the other channels — light blue means G is medium-high
    // and B is very high. Reject any reading that's purely gray/black.
    expect(center.g, `Highlight G channel`).toBeGreaterThan(180);
    expect(center.b, `Highlight B channel`).toBeGreaterThan(240);
  });
});

function idForCell(surfaceName: string, variantName: string): string {
  // Captures table + BundleManifestV1/V2 cap capture_id at 32 chars.
  // Derive a short, stable id from a sha256 of the cell coordinates
  // so a test failure still points at the exact combination via the
  // surface+variant in the test name, but the on-disk capture id
  // stays under the schema cap.
  const sha = createHash("sha256")
    .update(`${surfaceName}::${variantName}`)
    .digest("hex");
  return `t_${sha.slice(0, 20)}`;
}
