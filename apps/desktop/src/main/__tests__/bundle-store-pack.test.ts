// Test-first specs for the yauzl read surface + thumbnail builder in
// `bundle-store.ts`. Two threat models locked in here:
//
//   1. Zip-Slip on read — yauzl does NOT auto-validate filenames in
//      the central directory. A malicious bundle with `../etc/passwd`
//      as an entry name must be rejected before any extraction.
//   2. Allowlist enforcement on read — every entry must be one of the
//      canonical names. A bundle with an extra entry (even a
//      benign-looking one like `LICENSE`) is rejected because the
//      bundle format reserves all valid names.
//
// The v1 `packBundle` round-trip + `readBundleOverlays` specs that
// used to live here were removed with the v1 write path; the v1 read
// path is gone too. The v2 pack/read round-trip is exercised through
// the real capture flow in `export-surface-matrix.test.ts`; the
// security gate below validates `readBundleManifest` against
// attacker-crafted v2 bundles (the only format the reader accepts).

import archiver from "archiver";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  type BundleDocumentV2,
  type BundleManifestV2
} from "@pwrsnap/shared";
import {
  buildCompositeThumbnail,
  COMPOSITE_THUMBNAIL_MAX_DIM_PX,
  readBundleManifest
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

// Content hash of `fakeSourcePng`, computed below — the v2 source entry
// is keyed by sha256, and the reader's allowlist matches `sources/<sha>.png`.
const fakeSourcePng = Buffer.from("FAKE_SOURCE_PNG_BYTES_" + "x".repeat(200));
const fakeSourceSha = createHash("sha256").update(fakeSourcePng).digest("hex");
const fakeSourceEntry = `sources/${fakeSourceSha}.png`;

const validManifest: BundleManifestV2 = {
  bundle_format_version: 2,
  capture_id: "test-cap-001",
  canvas_dimensions: { width_px: 800, height_px: 600 },
  paired_png_filename: "test-cap-001.png",
  created_at: "2026-05-07T14:30:22.000Z",
  bundle_modified_at: "2026-05-07T14:30:22.000Z"
};

const validDocument: BundleDocumentV2 = {
  document_format_version: 1,
  edits_version: 0,
  layers: [],
  tags: [],
  description: null,
  ai_runs: []
};

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
      { name: "document.json", data: Buffer.from(JSON.stringify(validDocument)) },
      { name: fakeSourceEntry, data: fakeSourcePng },
      { name: "../etc/passwd", data: Buffer.from("attacker-controlled") }
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });

  test("rejects a bundle with an extra benign-looking entry (LICENSE)", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: "document.json", data: Buffer.from(JSON.stringify(validDocument)) },
      { name: fakeSourceEntry, data: fakeSourcePng },
      { name: "LICENSE", data: Buffer.from("MIT or whatever") }
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });

  test("rejects a bundle with a duplicate manifest.json (shadow-entry attack)", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ evil: true })) },
      { name: "document.json", data: Buffer.from(JSON.stringify(validDocument)) },
      { name: fakeSourceEntry, data: fakeSourcePng }
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });

  test("rejects a bundle missing required document.json", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: fakeSourceEntry, data: fakeSourcePng }
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
  });

  test("rejects a bundle whose entry name has a null byte (filename injection)", async () => {
    const bundlePath = await packBundleWithRawEntries([
      { name: "manifest.json\0../injected", data: Buffer.from(JSON.stringify(validManifest)) },
      { name: "document.json", data: Buffer.from(JSON.stringify(validDocument)) },
      { name: fakeSourceEntry, data: fakeSourcePng }
    ]);

    await expect(readBundleManifest(bundlePath)).rejects.toThrow();
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
