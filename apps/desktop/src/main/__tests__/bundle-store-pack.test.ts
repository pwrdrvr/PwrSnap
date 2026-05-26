// Test-first specs for the yazl/yauzl pack + unpack surface in
// `bundle-store.ts`. Three threat models locked in here:
//
//   1. Pack/unpack byte-exact roundtrip — what we put in is what we
//      get back. PNG bytes survive STORE-mode (no DEFLATE recompress),
//      JSON roundtrips through DEFLATE.
//   2. Zip-Slip on read — yauzl does NOT auto-validate filenames in
//      the central directory. A malicious bundle with `../etc/passwd`
//      as an entry name must be rejected before any extraction.
//   3. Allowlist enforcement on read — every entry must be one of the
//      four canonical names. A bundle with an extra entry (even a
//      benign-looking one like `LICENSE`) is rejected because the
//      bundle format reserves all valid names.

import archiver from "archiver";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  type BundleManifestV1,
  type BundleOverlaysV1
} from "@pwrsnap/shared";
import {
  buildCompositeThumbnail,
  COMPOSITE_THUMBNAIL_MAX_DIM_PX,
  packBundle,
  readBundleManifest,
  readBundleOverlays,
  readBundleEntry
} from "../persistence/bundle-store";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-bundle-pack-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
  }
});

const validManifest: BundleManifestV1 = {
  bundle_format_version: 1,
  capture_id: "test-cap-001",
  source_sha256: "0".repeat(64),
  source_dimensions: { width_px: 800, height_px: 600 },
  paired_png_filename: "test-cap-001.png",
  created_at: "2026-05-07T14:30:22.000Z",
  bundle_modified_at: "2026-05-07T14:30:22.000Z"
};

const validOverlays: BundleOverlaysV1 = {
  overlays_format_version: 1,
  overlays_version: 0,
  overlays: [],
  tags: [],
  description: null,
  ai_runs: []
};

// Synthetic byte buffers — bundle-store doesn't validate PNG magic
// (sharp does that downstream). Distinct content per "PNG" so we
// can prove byte-exact extraction.
const fakeSourcePng = Buffer.from("FAKE_SOURCE_PNG_BYTES_" + "x".repeat(200));
const fakeCompositePng = Buffer.from("FAKE_COMPOSITE_PNG_BYTES_" + "y".repeat(150));

describe("packBundle + readBundleManifest roundtrip", () => {
  test("manifest fields survive pack/unpack byte-for-byte", async () => {
    const buf = await packBundle({
      manifest: validManifest,
      overlays: validOverlays,
      sourcePng: fakeSourcePng,
      thumbnailJpg: fakeCompositePng
    });
    expect(buf.length).toBeGreaterThan(0);

    const bundlePath = join(workDir, "round.pwrsnap");
    await writeFile(bundlePath, buf);

    const got = await readBundleManifest(bundlePath);
    expect(got.bundle_format_version).toBe(1);
    expect(got.capture_id).toBe(validManifest.capture_id);
    if (got.bundle_format_version === 1) {
      expect(got.source_sha256).toBe(validManifest.source_sha256);
      expect(got.source_dimensions).toEqual(validManifest.source_dimensions);
    }
    expect(got.paired_png_filename).toBe(validManifest.paired_png_filename);
    expect(got.created_at).toBe(validManifest.created_at);
    expect(got.bundle_modified_at).toBe(validManifest.bundle_modified_at);
  });

  test("overlays roundtrip preserves overlays_version + tags + description", async () => {
    const populated: BundleOverlaysV1 = {
      overlays_format_version: 1,
      overlays_version: 5,
      overlays: [],
      tags: ["work", "screenshot"],
      description: "a roundtrip test capture",
      ai_runs: []
    };

    const buf = await packBundle({
      manifest: validManifest,
      overlays: populated,
      sourcePng: fakeSourcePng,
      thumbnailJpg: fakeCompositePng
    });

    const bundlePath = join(workDir, "round.pwrsnap");
    await writeFile(bundlePath, buf);

    const got = await readBundleOverlays(bundlePath);
    expect(got.overlays_version).toBe(5);
    expect(got.tags).toEqual(["work", "screenshot"]);
    expect(got.description).toBe("a roundtrip test capture");
    expect(got.overlays).toEqual([]);
    expect(got.ai_runs).toEqual([]);
  });

  test("source.png and composite_thumbnail.jpg survive pack/unpack byte-exact (STORE mode, no recompression)", async () => {
    const buf = await packBundle({
      manifest: validManifest,
      overlays: validOverlays,
      sourcePng: fakeSourcePng,
      thumbnailJpg: fakeCompositePng
    });

    const bundlePath = join(workDir, "round.pwrsnap");
    await writeFile(bundlePath, buf);

    const sourceOut = await readBundleEntry(bundlePath, "source.png");
    const thumbnailOut = await readBundleEntry(bundlePath, "composite_thumbnail.jpg");

    expect(sourceOut.equals(fakeSourcePng)).toBe(true);
    expect(thumbnailOut.equals(fakeCompositePng)).toBe(true);
  });

  test("omits composite_thumbnail.jpg when thumbnailJpg is null (small captures)", async () => {
    const buf = await packBundle({
      manifest: validManifest,
      overlays: validOverlays,
      sourcePng: fakeSourcePng,
      thumbnailJpg: null
    });

    const bundlePath = join(workDir, "no-thumb.pwrsnap");
    await writeFile(bundlePath, buf);

    // source.png + manifest + overlays are present; composite_thumbnail.jpg
    // is absent. The validator's required-set check still passes.
    const sourceOut = await readBundleEntry(bundlePath, "source.png");
    expect(sourceOut.equals(fakeSourcePng)).toBe(true);
    await expect(
      readBundleEntry(bundlePath, "composite_thumbnail.jpg")
    ).rejects.toThrow();
  });

  test("does NOT write full-resolution composite.png (legacy field removed)", async () => {
    const buf = await packBundle({
      manifest: validManifest,
      overlays: validOverlays,
      sourcePng: fakeSourcePng,
      thumbnailJpg: fakeCompositePng
    });

    const bundlePath = join(workDir, "no-composite.pwrsnap");
    await writeFile(bundlePath, buf);

    // composite.png is no longer written. Readers reconstruct the
    // composite from source + overlays via compose() when they need
    // it full-res, and the Thumbnail Extension uses composite_thumbnail.
    await expect(readBundleEntry(bundlePath, "composite.png")).rejects.toThrow();
  });

  test("rejects a manifest that fails zod validation on read (corrupt-bundle path)", async () => {
    // Pack a bundle whose manifest.json has a forbidden paired_png_filename.
    const zip = new yazl.ZipFile();
    const badManifest = JSON.stringify({
      ...validManifest,
      paired_png_filename: "../escape.png" // rejected by the schema
    });
    zip.addBuffer(Buffer.from(badManifest), "manifest.json");
    zip.addBuffer(Buffer.from(JSON.stringify(validOverlays)), "overlays.json");
    zip.addBuffer(fakeSourcePng, "source.png", { compress: false });
    zip.addBuffer(fakeCompositePng, "composite.png", { compress: false });
    zip.end();

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
      zip.outputStream.on("end", () => resolve());
      zip.outputStream.on("error", reject);
    });

    const bundlePath = join(workDir, "bad-manifest.pwrsnap");
    await writeFile(bundlePath, Buffer.concat(chunks));

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });
});

describe("readBundleManifest — Zip-Slip and allowlist enforcement", () => {
  // Helper to assemble a malicious bundle with attacker-chosen central
  // directory entries. yazl validates filenames at write time (refuses
  // `..`, null bytes, etc.), so we use `archiver` here — it lets us
  // emit arbitrary entry names, which is exactly the threat model
  // we're defending against on read.
  async function packBundleWithRawEntries(
    entries: Array<{ name: string; data: Buffer }>
  ): Promise<string> {
    const bundlePath = join(workDir, `evil-${Math.random().toString(36).slice(2)}.pwrsnap`);
    const archive = archiver("zip", { store: true });
    const chunks: Buffer[] = [];
    archive.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", reject);
    });
    for (const e of entries) {
      archive.append(e.data, { name: e.name });
    }
    await archive.finalize();
    await done;
    await writeFile(bundlePath, Buffer.concat(chunks));
    return bundlePath;
  }

  test("rejects a bundle whose central directory contains a `../etc/passwd` entry (Zip-Slip)", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: "overlays.json", data: Buffer.from(JSON.stringify(validOverlays)) },
      { name: "source.png", data: fakeSourcePng },
      { name: "composite.png", data: fakeCompositePng },
      { name: "../etc/passwd", data: Buffer.from("attacker-controlled") }
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });

  test("rejects a bundle with an extra benign-looking entry (LICENSE)", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: "overlays.json", data: Buffer.from(JSON.stringify(validOverlays)) },
      { name: "source.png", data: fakeSourcePng },
      { name: "composite.png", data: fakeCompositePng },
      { name: "LICENSE", data: Buffer.from("MIT or whatever") }
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });

  test("rejects a bundle with a duplicate manifest.json (shadow-entry attack)", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ evil: true })) },
      { name: "overlays.json", data: Buffer.from(JSON.stringify(validOverlays)) },
      { name: "source.png", data: fakeSourcePng},
      { name: "composite.png", data: fakeCompositePng}
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });

  test("rejects a bundle missing required source.png", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: "overlays.json", data: Buffer.from(JSON.stringify(validOverlays)) },
      { name: "composite.png", data: fakeCompositePng}
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });

  test("rejects a bundle whose entry name has a null byte (filename injection)", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json\0../injected", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: "overlays.json", data: Buffer.from(JSON.stringify(validOverlays)) },
      { name: "source.png", data: fakeSourcePng},
      { name: "composite.png", data: fakeCompositePng}
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });
});

describe("packBundle — output structure invariants", () => {
  test("produces a non-empty buffer", async () => {
    const buf = await packBundle({
      manifest: validManifest,
      overlays: validOverlays,
      sourcePng: fakeSourcePng,
      thumbnailJpg: fakeCompositePng
    });
    expect(buf.length).toBeGreaterThan(0);
  });

  test("PNG + thumbnail entries use STORE (no DEFLATE) — bytes appear verbatim", async () => {
    const big = Buffer.alloc(50_000, 0xab); // already-incompressible-ish
    const big2 = Buffer.alloc(40_000, 0xcd);

    const buf = await packBundle({
      manifest: validManifest,
      overlays: validOverlays,
      sourcePng: big,
      thumbnailJpg: big2
    });

    // STORE mode means the PNG/JPG bytes appear verbatim. If the
    // implementation regresses to DEFLATE on already-compressed input,
    // this test still passes for uniform fills (deflate-on-uniform is
    // also small) — but for real PNGs (which are already DEFLATE'd
    // internally), STORE is materially cheaper at write time. Check
    // via direct search for the recognizable 0xab/0xcd patterns;
    // STORE leaves them intact in the bundle.
    expect(buf.includes(big)).toBe(true);
    expect(buf.includes(big2)).toBe(true);
  });
});

// ----------------------------------------------------------------------
// buildCompositeThumbnail — always-Buffer contract
// ----------------------------------------------------------------------
//
// Pre-fix this function returned null for sources ≤ 1024px long edge
// as a perf optimization. That broke v2 bundles in Finder and Quick
// Look because the Swift extensions' fallback chains can't see v2's
// `sources/<sha>.png` layout — without a `composite_thumbnail.jpg` in
// the bundle they had nothing to render. The function now ALWAYS
// returns a JPEG Buffer (uses sharp's `withoutEnlargement` so tiny
// sources don't get upscaled, just re-encoded). These tests pin that
// contract.

describe("buildCompositeThumbnail — always-Buffer (no size skip)", () => {
  test("tiny source returns a Buffer, not null", async () => {
    // 100×100 — well under COMPOSITE_THUMBNAIL_MAX_DIM_PX. Pre-fix
    // this returned null.
    const tinyPng = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    const out = await buildCompositeThumbnail(tinyPng);

    expect(out).toBeInstanceOf(Buffer);
    expect(out.length).toBeGreaterThan(0);
    // JPEG SOI marker (FF D8) — confirms we got JPEG-encoded bytes,
    // not the PNG passed through.
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
  });

  test("source already at max dim returns a Buffer (not null)", async () => {
    const atMaxPng = await sharp({
      create: {
        width: COMPOSITE_THUMBNAIL_MAX_DIM_PX,
        height: COMPOSITE_THUMBNAIL_MAX_DIM_PX,
        channels: 4,
        background: { r: 0, g: 255, b: 0, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    const out = await buildCompositeThumbnail(atMaxPng);

    expect(out).toBeInstanceOf(Buffer);
    expect(out.length).toBeGreaterThan(0);
  });

  test("oversized source is resized to fit COMPOSITE_THUMBNAIL_MAX_DIM_PX on long edge", async () => {
    const bigPng = await sharp({
      create: {
        width: 2000,
        height: 1500,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    const out = await buildCompositeThumbnail(bigPng);

    expect(out).toBeInstanceOf(Buffer);
    // Decode the JPEG and verify its long edge is exactly the cap.
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(COMPOSITE_THUMBNAIL_MAX_DIM_PX);
    expect(meta.height).toBe(Math.round(1500 * (COMPOSITE_THUMBNAIL_MAX_DIM_PX / 2000)));
  });

  test("withoutEnlargement: tiny source stays at its natural dims (no upscale)", async () => {
    // The whole point of `withoutEnlargement: true` — a 100×100
    // source must NOT come back as a 1024×1024 thumbnail.
    const tinyPng = await sharp({
      create: {
        width: 100,
        height: 75,
        channels: 4,
        background: { r: 128, g: 128, b: 128, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    const out = await buildCompositeThumbnail(tinyPng);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(75);
  });
});
