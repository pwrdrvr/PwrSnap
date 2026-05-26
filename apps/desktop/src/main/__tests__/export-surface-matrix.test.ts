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
  BundleManifestV1,
  BundleManifestV2,
  BundleOverlaysV1,
  Overlay
} from "@pwrsnap/shared";

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
const { openDatabase, closeDatabase, getDb } = await import("../persistence/db");
const { packBundle, packBundleV2, buildCompositeThumbnail } = await import(
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
  db.exec(`DELETE FROM overlays`);
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
    kind: "rect",
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

async function seedV1Capture(args: SeedArgs): Promise<void> {
  const sourcePng = await makeSourcePng();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(workDir, "captures", `${args.id}.pwrsnap`);
  // `flat_png_path` is the user-visible flat composite PNG that lives
  // as a sibling next to the bundle. Real captures populate this from
  // the capture flow; we populate it here with the canonical sibling
  // path AND write the file on disk so any future surface added to
  // the matrix that reads this column (e.g., a hypothetical
  // "open in default viewer" or "reveal in Finder") gets a valid path
  // instead of a NULL footgun. The flat PNG mirrors the source bytes
  // for unedited variants; for the matrix's pixel assertions only the
  // re-rendered cache files matter — the flat file is just present.
  const flatPngPath = join(workDir, "captures", `${args.id}.png`);
  await writeFile(flatPngPath, sourcePng);
  const now = new Date().toISOString();
  const manifest: BundleManifestV1 = {
    bundle_format_version: 1,
    capture_id: args.id,
    source_sha256: sourceSha,
    source_dimensions: { width_px: SOURCE_WIDTH, height_px: SOURCE_HEIGHT },
    created_at: now,
    bundle_modified_at: now,
    paired_png_filename: `${args.id}.png`
  };
  const overlaysJson: BundleOverlaysV1 = {
    overlays_format_version: 1,
    overlays_version: args.annotated ? 1 : 0,
    overlays: [],
    tags: [],
    description: null,
    ai_runs: []
  };
  const thumbnailJpg = await buildCompositeThumbnail(sourcePng);

  const bundleBuf = await packBundle({
    manifest,
    overlays: overlaysJson,
    sourcePng,
    thumbnailJpg
  });
  await writeFile(bundlePath, bundleBuf);

  // Insert captures row.
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
        1, 0,
        @w, @h, 2.0, @bs,
        @sha, 0, NULL
      )`
    )
    .run({
      id: args.id,
      captured_at: now,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      w: SOURCE_WIDTH,
      h: SOURCE_HEIGHT,
      bs: bundleBuf.length,
      sha: sourceSha
    });

  // Insert overlay row for annotated variants. The v1 renderer
  // (compose.ts) reads from this table.
  if (args.annotated) {
    getDb()
      .prepare(
        `INSERT INTO overlays (
          id, capture_id, data, schema_version, source,
          ai_run_id, applied_at, rejected_at, superseded_by,
          z_index, created_at
        ) VALUES (
          @id, @capture_id, @data, 1, 'user',
          NULL, @applied_at, NULL, NULL,
          0, @applied_at
        )`
      )
      .run({
        id: `${args.id}-ov-0`,
        capture_id: args.id,
        data: JSON.stringify(annotatedOverlay()),
        applied_at: now
      });
  }
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

const VARIANTS: readonly Variant[] = [
  {
    name: "v1-unedited",
    expectsRed: false,
    seed: (id) => seedV1Capture({ id, annotated: false })
  },
  {
    name: "v1-annotated",
    expectsRed: true,
    seed: (id) => seedV1Capture({ id, annotated: true })
  },
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

describe("export-surface-matrix: every surface honors the v1/v2 dispatch + overlay set", () => {
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
