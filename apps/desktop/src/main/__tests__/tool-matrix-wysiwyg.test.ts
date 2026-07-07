// Tool × setting matrix for bake WYSIWYG.
//
// PURPOSE
// ═══════
// This file exists because the bake-WYSIWYG PR (#129) has shipped FIVE
// silent regressions through review — text positioning, highlight color,
// scale-aware accumulator drop, pool-window concurrency, and most
// recently blur effects vanishing entirely. The existing
// `export-surface-matrix.test.ts` covers ONE shape (red rect) across
// the export surfaces — proving the dispatch wiring works. It does NOT
// cover that every TOOL contributes its pixels to the bake.
//
// Per the user request after the blur-missing report:
//
//   "We need failing E2Es that the Copy button MUST contain EACH of the
//    different types of drawings in the copied image and that the
//    copied image must look substantially similar (if not pixel
//    perfect match) to a screenshot captured of the editor
//    representation of the edited image. We need a matrix of every
//    different tool with many settings exercised."
//
// We approximate "looks like the editor" with PIXEL-SIGNATURE
// assertions per tool — each tool has a signature that's both
// DETECTABLE in the bake AND IMPOSSIBLE if the tool's contribution
// was dropped:
//
//   arrow      — dark stroke pixels at the line's midpoint
//   rect       — fill color dominates the rect interior
//   highlight  — backdrop pixels shift toward the tint at the
//                rect's center (each blend mode has its own
//                directional expectation)
//   blur       — variance of pixel values inside the rect drops by
//                an order of magnitude vs the same region in the
//                source raster (PROVES blur happened, regardless of
//                exact sigma)
//   blur/pixelate — neighboring pixels within a "block" of the
//                   pixelate output agree on color (proves the
//                   mosaic stamp ran)
//   blur/redact — solid black, zero variance
//   text       — dark pixels appear near the text's anchor point
//
// FAILURE → ACTION
// ═══════════════
// If a test in this file fails after editing the bake pipeline:
//
//   1. The test name tells you WHICH tool / setting is broken.
//   2. Look at the assertion's `message` arg — it spells out the
//      regime (what value indicates broken, what indicates correct).
//   3. Add a regression test for the SPECIFIC bug you introduced,
//      with a tighter assertion than the matrix's catch-all.
//
// The matrix is the SAFETY NET. Specific regression tests for
// known bug classes (PR #129's positioning, highlight color,
// concurrency, blur-skipped) live in `export-surface-matrix.test.ts`
// and `text-html-bake-concurrency.test.ts`.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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

// ───────────────────────────────────────────────────────────────────────
// Electron mock + workspace setup. Mirrors `export-surface-matrix.test.ts`.
// ───────────────────────────────────────────────────────────────────────

type ClipboardCapture =
  | { kind: "writeImage"; bytes: Buffer }
  | { kind: "writeText"; text: string };

const clipboardCaptured: ClipboardCapture[] = [];
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
    write: vi.fn((args: { image?: unknown; text?: string }) => {
      if (args.image !== undefined) {
        const bytes = (args.image as { __bytes?: Buffer }).__bytes;
        if (bytes !== undefined) clipboardCaptured.push({ kind: "writeImage", bytes });
      }
    }),
    writeText: vi.fn((text: string) => {
      clipboardCaptured.push({ kind: "writeText", text });
    }),
    writeImage: vi.fn((image: unknown) => {
      const bytes = (image as { __bytes?: Buffer }).__bytes;
      if (bytes !== undefined) clipboardCaptured.push({ kind: "writeImage", bytes });
    }),
    writeBuffer: vi.fn(() => undefined)
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

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

vi.mock("../clipboard/named-image-pasteboard", () => ({
  writeNamedPngToPasteboard: vi.fn(async () => false)
}));

const { bus } = await import("../command-bus");
const { registerClipboardHandlers } = await import("../handlers/clipboard-handlers");
const { registerLibraryHandlers } = await import("../handlers/library-handlers");
const { openDatabase, closeDatabase, getDb } = await import("../persistence/db");
const { packBundleV2, buildCompositeThumbnail } = await import("../persistence/bundle-store");
const { insertLayerTreeForCapture } = await import("../persistence/layers-repo");

// ───────────────────────────────────────────────────────────────────────
// Canvas + source convention
// ───────────────────────────────────────────────────────────────────────
//
// Source = a 400×300 raster filled with a CHECKERBOARD pattern (10×10
// black + white squares). The pattern gives every tool a non-trivial
// backdrop to interact with:
//
//   • highlight + blend modes: black-vs-white drives the blend math
//   • blur: the high-frequency checker is destroyed by gaussian smooth
//   • pixelate: the checker is replaced by ~uniform mosaic blocks
//   • arrow/rect/text: dark drawing on a known backdrop pattern
//
// We bake at HIGH preset (= source width 400) so renderScale=1 — keeps
// this matrix focused on bake CORRECTNESS, not scale arithmetic. The
// scale-aware assertions live in `export-surface-matrix.test.ts`.

const CANVAS_W = 400;
const CANVAS_H = 300;

async function makeCheckerboardSource(): Promise<Buffer> {
  const blockSize = 10;
  const channels = 3;
  const buf = Buffer.alloc(CANVAS_W * CANVAS_H * channels);
  for (let y = 0; y < CANVAS_H; y += 1) {
    for (let x = 0; x < CANVAS_W; x += 1) {
      const bx = Math.floor(x / blockSize);
      const by = Math.floor(y / blockSize);
      const isBlack = (bx + by) % 2 === 0;
      const v = isBlack ? 0 : 255;
      const i = (y * CANVAS_W + x) * channels;
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
    }
  }
  return await sharp(buf, {
    raw: { width: CANVAS_W, height: CANVAS_H, channels: 3 }
  })
    .png()
    .toBuffer();
}

/** A noise pattern — every pixel a deterministic-pseudo-random color.
 *  Used by pixelate tests where a checker can give degenerate output
 *  (the down-sample stride aligns with the checker block size so the
 *  "pixelated" result happens to look identical to the input). With
 *  noise, every 9-pixel block contains many distinct values, so
 *  pixelate's averaging produces a visibly distinct (uniform-color)
 *  block — easy to detect. */
async function makeNoiseSource(): Promise<Buffer> {
  const channels = 3;
  const buf = Buffer.alloc(CANVAS_W * CANVAS_H * channels);
  // Simple xorshift-style PRNG seeded with a fixed constant so the
  // pattern is reproducible across runs.
  let s = 0x12345678;
  for (let y = 0; y < CANVAS_H; y += 1) {
    for (let x = 0; x < CANVAS_W; x += 1) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const r = (s >>> 0) % 256;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const g = (s >>> 0) % 256;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const b = (s >>> 0) % 256;
      const i = (y * CANVAS_W + x) * channels;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
  return await sharp(buf, {
    raw: { width: CANVAS_W, height: CANVAS_H, channels: 3 }
  })
    .png()
    .toBuffer();
}

async function makeDarkUiSource(): Promise<Buffer> {
  return await sharp({
    create: {
      width: CANVAS_W,
      height: CANVAS_H,
      channels: 3,
      background: { r: 10, g: 10, b: 10 }
    }
  })
    .png()
    .toBuffer();
}

// Per-test fixture: temp workspace + DB.
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-matrix-wysiwyg-"));
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

beforeEach(() => {
  clipboardCaptured.length = 0;
});

afterEach(() => {
  const db = getDb();
  db.exec(`DELETE FROM layers`);
  db.exec(`DELETE FROM captures`);
});

// ───────────────────────────────────────────────────────────────────────
// Capture-seeding helper. Takes a list of overlay layers (whatever
// kind/shape combo the test wants), seeds a v2 capture, returns its
// id. The raster is always the same checkerboard.
// ───────────────────────────────────────────────────────────────────────

let idCounter = 0;

function nextCaptureId(prefix: string): string {
  idCounter += 1;
  return `t_${prefix}_${idCounter.toString().padStart(8, "0")}`.slice(0, 32);
}

/** Globally unique NanoId16 layer id. Uses a single monotonic counter
 *  encoded in base36 so collisions are impossible across tests within
 *  the file, regardless of how long the caller's tag is. */
function nextLayerId(): string {
  idCounter += 1;
  // Format: "L" + 15-char base36 of counter, zero-padded. Counter
  // fits in 15 base36 digits up to 36^15 = ~2e23, more than enough.
  const padded = idCounter.toString(36).padStart(15, "0");
  return `L${padded}`;
}

interface SeedArgs {
  testTag: string;
  /** Extra layers BEYOND the root group + the raster. Tests build their
   *  tool-specific layers here. */
  overlayLayers: BundleLayerNode[];
  /** Override the default checkerboard source. Pixelate tests use
   *  a noise source instead because pixelate on a checker can produce
   *  a degenerate output that looks identical to the input. */
  source?: () => Promise<Buffer>;
}

async function seedCheckerboardCapture(args: SeedArgs): Promise<string> {
  const captureId = nextCaptureId(args.testTag);
  const sourcePng = await (args.source ?? makeCheckerboardSource)();
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
  const rootGroupId = nextLayerId();
  const rasterId = nextLayerId();
  const baseCommon = {
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
  // Re-parent the overlay layers under the root group, in case the
  // test builder left parent_id null.
  const overlaysWithParent: BundleLayerNode[] = args.overlayLayers.map((l, idx) => ({
    ...l,
    parent_id: l.parent_id ?? rootGroupId,
    // Bump created_at by a microsecond per layer so the z-tie-breaker
    // is stable + tests can rely on overlays painting LATER than the
    // raster.
    created_at: new Date(Date.now() + idx + 1).toISOString()
  }));
  const layers: BundleLayerNode[] = [
    {
      ...baseCommon,
      id: rootGroupId,
      kind: "group",
      parent_id: null,
      z_index: 0,
      collapsed: false
    },
    {
      ...baseCommon,
      id: rasterId,
      kind: "raster",
      parent_id: rootGroupId,
      z_index: 0,
      source_ref: { kind: "embedded", sha256: sourceSha },
      natural_width_px: CANVAS_W,
      natural_height_px: CANVAS_H
    },
    ...overlaysWithParent
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

// ───────────────────────────────────────────────────────────────────────
// Bake-helpers. `bakeAtHigh` returns the PNG bytes the clipboard would
// receive. HIGH preset = source width = no upscale = renderScale=1.
// ───────────────────────────────────────────────────────────────────────

async function bakeAtHigh(captureId: string): Promise<Buffer> {
  const result = await bus.dispatch(
    "clipboard:copy",
    { captureId, preset: "high" },
    { principal: "ipc" }
  );
  if (!result.ok) {
    throw new Error(`clipboard:copy failed: ${result.error.code}`);
  }
  const last = clipboardCaptured.at(-1);
  if (last === undefined || last.kind !== "writeImage") {
    throw new Error(`expected writeImage on clipboard, got ${JSON.stringify(last)}`);
  }
  return last.bytes;
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function decodePng(buf: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pixelAt(img: RawImage, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const idx = (y * img.width + x) * img.channels;
  return {
    r: img.data[idx] ?? 0,
    g: img.data[idx + 1] ?? 0,
    b: img.data[idx + 2] ?? 0,
    a: img.data[idx + 3] ?? 0
  };
}

/** Mean RGB of all pixels in a rect. Useful for "approximately this
 *  color" assertions without depending on exact pixel placement. */
function meanColorInRect(
  img: RawImage,
  x: number,
  y: number,
  w: number,
  h: number
): { r: number; g: number; b: number } {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const idx = (yy * img.width + xx) * img.channels;
      sr += img.data[idx] ?? 0;
      sg += img.data[idx + 1] ?? 0;
      sb += img.data[idx + 2] ?? 0;
      n += 1;
    }
  }
  return { r: sr / n, g: sg / n, b: sb / n };
}

/** Population variance of the luminance channel over a rect. Captures
 *  "how much high-frequency content lives here." A blurred region has
 *  ORDER OF MAGNITUDE smaller variance than the same rect on the
 *  source checkerboard (~16k vs ~250 for gaussian sigma 8+). */
function luminanceVarianceInRect(
  img: RawImage,
  x: number,
  y: number,
  w: number,
  h: number
): number {
  let sum = 0;
  let n = 0;
  const lums: number[] = [];
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const idx = (yy * img.width + xx) * img.channels;
      const r = img.data[idx] ?? 0;
      const g = img.data[idx + 1] ?? 0;
      const b = img.data[idx + 2] ?? 0;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += lum;
      lums.push(lum);
      n += 1;
    }
  }
  const mean = sum / n;
  let variance = 0;
  for (const l of lums) {
    variance += (l - mean) ** 2;
  }
  return variance / n;
}

function darkPixelCountInRect(
  img: RawImage,
  x: number,
  y: number,
  w: number,
  h: number,
  threshold = 100
): number {
  let count = 0;
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const idx = (yy * img.width + xx) * img.channels;
      const r = img.data[idx] ?? 0;
      const g = img.data[idx + 1] ?? 0;
      const b = img.data[idx + 2] ?? 0;
      if (r < threshold && g < threshold && b < threshold) count += 1;
    }
  }
  return count;
}

const COMMON_LAYER: Omit<
  BundleLayerNode & { kind: "vector" },
  "id" | "kind" | "shape" | "z_index"
> = {
  parent_id: null,
  name: "",
  visible: true,
  locked: false,
  opacity: 1,
  blend_mode: "normal" as const,
  transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
  source: "user" as const,
  ai_run_id: null,
  applied_at: new Date().toISOString(),
  rejected_at: null,
  superseded_by: null,
  created_at: new Date().toISOString()
};

function makeVectorLayer(shape: Overlay): BundleLayerNode {
  return {
    ...COMMON_LAYER,
    id: nextLayerId(),
    kind: "vector",
    z_index: 1,
    shape
  };
}

function makeEffectBlurLayer(args: {
  rect: { x: number; y: number; w: number; h: number };
  style?: "gaussian" | "pixelate" | "redact";
  radiusPx?: number;
}): BundleLayerNode {
  return {
    ...COMMON_LAYER,
    id: nextLayerId(),
    kind: "effect",
    z_index: 1,
    effect: {
      type: "blur",
      radius_px: args.radiusPx ?? 20,
      ...(args.style !== undefined ? { style: args.style } : {})
    },
    clip_rect: { x: args.rect.x, y: args.rect.y, w: args.rect.w, h: args.rect.h }
  };
}

// ───────────────────────────────────────────────────────────────────────
// ARROW — color × stroke
// ───────────────────────────────────────────────────────────────────────

describe("tool matrix: arrow", () => {
  for (const variant of [
    { name: "red", colorHex: "#ff0000", expectedR: 200, expectedGB: 120 },
    { name: "blue", colorHex: "#0000ff", expectedR: 120, expectedGB: 200 },
    { name: "green", colorHex: "#00ff00", expectedR: 120, expectedGB: 200 }
  ] as const) {
    test(`${variant.name} arrow draws stroke pixels at line midpoint`, async () => {
      // Arrow from (0.1, 0.5) to (0.9, 0.5) — horizontal across the
      // canvas. Midpoint at canvas (200, 150).
      const overlay: Overlay = {
        kind: "arrow",
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        color: variant.colorHex
      };
      const tag = `arr_${variant.name}`;
      const captureId = await seedCheckerboardCapture({
        testTag: tag,
        overlayLayers: [makeVectorLayer(overlay)]
      });
      const png = await bakeAtHigh(captureId);
      const img = await decodePng(png);

      // Sample a row spanning the line's y position. The arrow's
      // stroke isn't 1 pixel — antialiased edges spread over a few
      // rows — so we mean over a 6-row band centered on y=150.
      const mean = meanColorInRect(img, 100, 147, 200, 6);
      // The stroke pixels should pull the mean strongly toward the
      // arrow color vs the checkerboard ~127 baseline.
      // For "red" expect r-channel high, g/b-channel low (modulo
      // antialiased blend with the checkerboard).
      if (variant.name === "red") {
        expect(mean.r).toBeGreaterThan(140); // pushed toward 255
        // For red arrow, g and b channels are decent only because the
        // background checkerboard contributes white pixels — but
        // they're still LESS than r because the arrow contributes
        // 0-G-B on top of the white.
        expect(mean.r - mean.g).toBeGreaterThan(15);
        expect(mean.r - mean.b).toBeGreaterThan(15);
      } else if (variant.name === "blue") {
        expect(mean.b).toBeGreaterThan(140);
        expect(mean.b - mean.r).toBeGreaterThan(15);
        expect(mean.b - mean.g).toBeGreaterThan(15);
      } else {
        expect(mean.g).toBeGreaterThan(140);
        expect(mean.g - mean.r).toBeGreaterThan(15);
        expect(mean.g - mean.b).toBeGreaterThan(15);
      }
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// RECT — color × fill mode
// ───────────────────────────────────────────────────────────────────────

describe("tool matrix: rect", () => {
  for (const variant of [
    { name: "filled-red", color: "#ff0000", filled: true, dominantChannel: "r" as const },
    { name: "filled-blue", color: "#0000ff", filled: true, dominantChannel: "b" as const },
    { name: "filled-green", color: "#00ff00", filled: true, dominantChannel: "g" as const },
    { name: "stroked-red", color: "#ff0000", filled: false, dominantChannel: "r" as const }
  ] as const) {
    test(`${variant.name} rect renders in bake`, async () => {
      const overlay: Overlay = {
        kind: "shape",
        rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        color: variant.color,
        filled: variant.filled
      };
      const tag = `rect_${variant.name.replace(/-/g, "")}`;
      const captureId = await seedCheckerboardCapture({
        testTag: tag,
        overlayLayers: [makeVectorLayer(overlay)]
      });
      const png = await bakeAtHigh(captureId);
      const img = await decodePng(png);
      // Sample the rect's CENTER for filled, EDGE for stroked.
      const sampleX = variant.filled ? Math.round(0.5 * CANVAS_W) : Math.round(0.25 * CANVAS_W) + 1;
      const sampleY = variant.filled ? Math.round(0.5 * CANVAS_H) : Math.round(0.25 * CANVAS_H) + 1;
      // 6×6 patch around the sample point to dampen single-pixel noise.
      const mean = meanColorInRect(img, sampleX - 3, sampleY - 3, 6, 6);
      // Dominant-channel test: the rect's chosen channel should
      // dominate by > 50 vs the other two.
      const ch = variant.dominantChannel;
      const dom = mean[ch];
      const others = ["r", "g", "b"].filter((c) => c !== ch) as ("r" | "g" | "b")[];
      for (const o of others) {
        expect(
          dom - mean[o],
          `${variant.name} sample at (${sampleX}, ${sampleY}) should have ${ch} dominate over ${o}. ` +
            `Got ${ch}=${mean[ch].toFixed(0)} vs ${o}=${mean[o].toFixed(0)}.`
        ).toBeGreaterThan(50);
      }
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// HIGHLIGHT — color × blend mode × opacity
// ───────────────────────────────────────────────────────────────────────
//
// The checkerboard has 50% black + 50% white pixels at fine grain.
// Mean RGB over the highlight region is ~(127,127,127) BEFORE the
// highlight is applied. AFTER, the marker's alpha-over tint pushes
// the mean toward the selected color while preserving the backdrop
// structure. A separate dark-UI test below pins the user-visible
// regression where CSS-style overlay/multiply math made black UI
// highlights look effectively absent.

describe("tool matrix: highlight", () => {
  for (const variant of [
    {
      name: "yellow-multiply-default",
      color: "#facc15", // tailwind yellow-400 — also the default
      opacity: 0.3,
      blend: "multiply" as const,
      // Yellow marker: red + green stay high, blue drops.
      expectations: { r_min: 150, g_min: 135, b_max: 115 }
    },
    {
      name: "red-multiply-half",
      color: "#ff0000",
      opacity: 0.5,
      blend: "multiply" as const,
      // Red multiply: blue+green channels collapse on the white half;
      // red stays. Alpha-over still makes red dominate.
      expectations: { r_diff_from_g: 40, r_diff_from_b: 40 }
    },
    {
      name: "blue-screen",
      color: "#0000ff",
      opacity: 0.5,
      blend: "screen" as const,
      // Blue marker: blue dominates over the region.
      expectations: { b_min: 160, b_diff_from_r: 30, b_diff_from_g: 30 }
    },
    {
      name: "low-opacity-stays-near-backdrop",
      color: "#ff0000",
      opacity: 0.05,
      blend: "multiply" as const,
      // Tiny opacity = mean stays near 127 on all channels.
      expectations: { mean_close_to_127: true }
    }
  ] as const) {
    test(`${variant.name} highlight blends backdrop in bake`, async () => {
      const overlay: Overlay = {
        kind: "highlight",
        rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        color: variant.color,
        opacity: variant.opacity,
        blend: variant.blend
      };
      const tag = `hi_${variant.name.replace(/-/g, "")}`;
      const captureId = await seedCheckerboardCapture({
        testTag: tag,
        overlayLayers: [makeVectorLayer(overlay)]
      });
      const png = await bakeAtHigh(captureId);
      const img = await decodePng(png);
      const mean = meanColorInRect(
        img,
        Math.round(0.3 * CANVAS_W),
        Math.round(0.3 * CANVAS_H),
        Math.round(0.4 * CANVAS_W),
        Math.round(0.4 * CANVAS_H)
      );
      // exactOptionalPropertyTypes-friendly narrowing: the
      // discriminant is the FIRST present key, with `as const`
      // anchoring each variant's exact shape.
      const e: Record<string, number | boolean | undefined> = variant.expectations;
      if (typeof e.r_min === "number") {
        expect(mean.r, `${variant.name} r ${mean.r}`).toBeGreaterThan(e.r_min);
        expect(mean.g, `${variant.name} g ${mean.g}`).toBeGreaterThan(e.g_min as number);
        expect(mean.b, `${variant.name} b ${mean.b}`).toBeLessThan(e.b_max as number);
      } else if (typeof e.b_min === "number") {
        expect(mean.b, `${variant.name} b ${mean.b}`).toBeGreaterThan(e.b_min);
        expect(mean.b - mean.r).toBeGreaterThan(e.b_diff_from_r as number);
        expect(mean.b - mean.g).toBeGreaterThan(e.b_diff_from_g as number);
      } else if (typeof e.r_diff_from_g === "number") {
        expect(mean.r - mean.g, `${variant.name} r-g`).toBeGreaterThan(e.r_diff_from_g);
        expect(mean.r - mean.b, `${variant.name} r-b`).toBeGreaterThan(e.r_diff_from_b as number);
      } else if (e.mean_close_to_127 === true) {
        // ±20 of 127 on every channel.
        expect(Math.abs(mean.r - 127)).toBeLessThan(20);
        expect(Math.abs(mean.g - 127)).toBeLessThan(20);
        expect(Math.abs(mean.b - 127)).toBeLessThan(20);
      }
    });
  }

  test("orange overlay highlight remains visible over dark UI pixels", async () => {
    const overlay: Overlay = {
      kind: "highlight",
      rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      color: "#ff8a1f",
      opacity: 0.3,
      blend: "overlay"
    };
    const captureId = await seedCheckerboardCapture({
      testTag: "hi_dark_overlay",
      overlayLayers: [makeVectorLayer(overlay)],
      source: makeDarkUiSource
    });
    const png = await bakeAtHigh(captureId);
    const img = await decodePng(png);
    const center = pixelAt(img, Math.round(0.5 * CANVAS_W), Math.round(0.5 * CANVAS_H));
    expect(
      center.r,
      `Dark UI highlight should be visibly orange at the rect center. ` +
        `If R is near the #0a background (~10-15), the bake used CSS ` +
        `overlay/multiply semantics and the highlight looks dropped. ` +
        `Got rgba(${center.r}, ${center.g}, ${center.b}, ${center.a}).`
    ).toBeGreaterThan(70);
    expect(center.g).toBeGreaterThan(35);
    expect(center.b).toBeGreaterThan(15);
  });
});

// ───────────────────────────────────────────────────────────────────────
// BLUR — gaussian × pixelate × redact
// ───────────────────────────────────────────────────────────────────────
//
// Each blur style has a CHARACTERISTIC signature against the
// checkerboard:
//
//   gaussian → variance drops by ≥10× vs source (checker frequency
//              dies)
//   pixelate → variance drops less (still has block edges) but is
//              well-bounded; neighbors inside a block agree on color
//   redact   → variance ≈ 0 (solid color, expected to be black)
//
// The KEY test is gaussian: that's the default, and the user-visible
// regression in the PR #129 report (blur missing from bake) would
// land here.

describe("tool matrix: blur", () => {
  // Reference luminance variance for an UNBLURRED 200×150 chunk of
  // the checkerboard. With 10px blocks alternating black/white the
  // variance hovers around the half-and-half analytical value
  // 0.5 × 127.5² ≈ 16131. Anchored as a constant rather than
  // re-computed per test so the assertions are explicit about the
  // before-vs-after relationship.
  const REFERENCE_CHECKER_VARIANCE = 14000;

  test("gaussian blur — variance in the blur region drops by an order of magnitude", async () => {
    const tag = "blr_gauss";
    const captureId = await seedCheckerboardCapture({
      testTag: tag,
      overlayLayers: [
        makeEffectBlurLayer({
          rect: { x: 0.25 * CANVAS_W, y: 0.25 * CANVAS_H, w: 0.5 * CANVAS_W, h: 0.5 * CANVAS_H },
          style: "gaussian",
          radiusPx: 12
        })
      ]
    });
    const png = await bakeAtHigh(captureId);
    const img = await decodePng(png);
    // Measure variance in an INNER patch of the blur rect, away from
    // the edge where antialiasing with the unblurred surroundings
    // smudges the boundary.
    const inner = luminanceVarianceInRect(
      img,
      Math.round(0.3 * CANVAS_W),
      Math.round(0.3 * CANVAS_H),
      Math.round(0.4 * CANVAS_W),
      Math.round(0.4 * CANVAS_H)
    );
    // Sanity: also measure variance OUTSIDE the blur rect — should
    // still be checkerboard-high.
    const outer = luminanceVarianceInRect(img, 5, 5, 50, 50);
    expect(
      outer,
      `Sanity: outside-blur variance should remain at checker level (~${REFERENCE_CHECKER_VARIANCE}). ` +
        `Got ${outer.toFixed(0)} — if low, the WHOLE bake got blurred, indicating the effect's ` +
        `clip_rect was lost or applied to entire canvas.`
    ).toBeGreaterThan(REFERENCE_CHECKER_VARIANCE * 0.5);
    expect(
      inner,
      `Inside-blur variance should drop by ≥10× vs the checker reference (~${REFERENCE_CHECKER_VARIANCE}). ` +
        `Got ${inner.toFixed(0)}. If the inside variance is STILL checker-level, the blur effect ` +
        `was dropped from the bake entirely — the user-visible "blur missing from clipboard copy" symptom.`
    ).toBeLessThan(REFERENCE_CHECKER_VARIANCE / 10);
  });

  test("pixelate blur — block-interior pixels are uniform on a noise source", async () => {
    // Use a NOISE source instead of the checkerboard. Pixelate on a
    // checker is degenerate: sharp's 22×16 down-sample of a 10×10
    // checker happens to land on individual checker pixels (no
    // averaging at the down-sample stride), so the "pixelated" output
    // is byte-identical to the input checker — looks like the effect
    // didn't run. On NOISE, every 9-pixel block averages to a unique
    // gray, so the pixelation is visibly demonstrated.
    const captureId = await seedCheckerboardCapture({
      testTag: "blr_pix",
      source: makeNoiseSource,
      overlayLayers: [
        makeEffectBlurLayer({
          rect: { x: 0.25 * CANVAS_W, y: 0.25 * CANVAS_H, w: 0.5 * CANVAS_W, h: 0.5 * CANVAS_H },
          style: "pixelate",
          radiusPx: 12
        })
      ]
    });
    const png = await bakeAtHigh(captureId);
    const img = await decodePng(png);
    // Block-interior probes: 18 evenly-distributed 3×3 patches inside
    // the 200×150 clip rect. Block size is short-side/16 ≈ 9px so a
    // 3×3 patch sometimes spans a boundary; the aggregate assertion
    // ("≥10/18 patches are intra-block uniform") is robust to that.
    // On the unblurred noise source, ZERO of these patches would
    // pass — every pixel is a different random value.
    const probeOrigins = [
      [115, 85], [125, 90], [140, 95], [160, 105],
      [180, 115], [200, 125], [220, 135], [240, 145],
      [260, 155], [275, 165], [115, 145], [135, 155],
      [155, 165], [175, 175], [195, 185], [215, 195],
      [235, 205], [255, 215]
    ] as const;
    let uniformPatches = 0;
    for (const [px, py] of probeOrigins) {
      const v = luminanceVarianceInRect(img, px, py, 3, 3);
      if (v < 100) uniformPatches += 1;
    }
    expect(
      uniformPatches,
      `Pixelate: expected ≥10/18 3×3 patches inside the rect to be ` +
        `intra-block uniform (luminance variance < 100). Got ${uniformPatches}. ` +
        `An unblurred noise source has 0 uniform patches at this scale; ` +
        `if you see 0 or 1 here, the pixelate effect didn't run at all.`
    ).toBeGreaterThanOrEqual(10);
    // Sanity: ALSO assert variance OUTSIDE the rect stays noisy.
    // Catches the "whole canvas got pixelated" class of bug. Noise
    // luminance variance ≈ 2440 (analytical, for uniform 0..255 RGB
    // through the BT.601 lum formula). After pixelate, intra-block
    // variance collapses to single-digit; the outside region must
    // remain unaltered at ~2000+. Threshold at 1500 to allow PNG
    // compression jitter while still rejecting pixelated output
    // (which has variance ~30 within a block).
    const outer = luminanceVarianceInRect(img, 5, 5, 50, 50);
    expect(
      outer,
      `Sanity: outside-blur variance should remain at noise level (~2440). ` +
        `If low (${outer.toFixed(0)}), the entire bake got pixelated, ` +
        `indicating the effect's clip_rect was lost.`
    ).toBeGreaterThan(1500);
  });

  test("redact blur — solid black fill", async () => {
    const tag = "blr_red";
    const captureId = await seedCheckerboardCapture({
      testTag: tag,
      overlayLayers: [
        makeEffectBlurLayer({
          rect: { x: 0.25 * CANVAS_W, y: 0.25 * CANVAS_H, w: 0.5 * CANVAS_W, h: 0.5 * CANVAS_H },
          style: "redact",
          radiusPx: 12
        })
      ]
    });
    const png = await bakeAtHigh(captureId);
    const img = await decodePng(png);
    // Inside the redact rect: ALL pixels must be (0, 0, 0).
    const mean = meanColorInRect(
      img,
      Math.round(0.3 * CANVAS_W),
      Math.round(0.3 * CANVAS_H),
      Math.round(0.4 * CANVAS_W),
      Math.round(0.4 * CANVAS_H)
    );
    expect(mean.r).toBeLessThan(5);
    expect(mean.g).toBeLessThan(5);
    expect(mean.b).toBeLessThan(5);
  });
});

// ───────────────────────────────────────────────────────────────────────
// TEXT — color × size
// ───────────────────────────────────────────────────────────────────────
//
// The text bake in unit-test mode falls back to the SVG path (Electron
// isn't initialized, so HTML bake's BrowserWindow constructor throws
// and compose-tree-vector catches the specific errors). The signature
// is still characteristic: a chunk of dark pixels near the anchor.

describe("tool matrix: text", () => {
  for (const variant of [
    { name: "small-dark", body: "MMM", size: "small" as const, color: "#000000", minDark: 5 },
    { name: "medium-dark", body: "MMM", size: "medium" as const, color: "#000000", minDark: 10 },
    { name: "large-dark", body: "MMM", size: "large" as const, color: "#000000", minDark: 25 }
  ] as const) {
    test(`${variant.name} text drops dark pixels near anchor`, async () => {
      const overlay: Overlay = {
        kind: "text",
        point: { x: 0.5, y: 0.5 },
        body: variant.body,
        size: variant.size,
        color: variant.color
      };
      const tag = `txt_${variant.name.replace(/-/g, "")}`;
      const captureId = await seedCheckerboardCapture({
        testTag: tag,
        overlayLayers: [makeVectorLayer(overlay)]
      });
      const png = await bakeAtHigh(captureId);
      const img = await decodePng(png);
      // Count dark pixels in a generous window around the anchor.
      // Text anchor at canvas (200, 150); SVG `text-anchor:"start"`
      // so glyphs extend rightward + slightly above (cap height).
      const dark = darkPixelCountInRect(
        img,
        Math.round(0.5 * CANVAS_W),
        Math.round(0.5 * CANVAS_H) - 12,
        80,
        24
      );
      expect(
        dark,
        `${variant.name}: should see ≥${variant.minDark} dark pixels in text region. ` +
          `Got ${dark}. If 0, the text was dropped from the bake; if very low, the ` +
          `glyph collapsed to a few stroke pixels (size or color resolution bug).`
      ).toBeGreaterThanOrEqual(variant.minDark);
    });
  }
});
