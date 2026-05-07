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
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  type BundleManifestV1,
  type BundleOverlaysV1
} from "@pwrsnap/shared";
import {
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
      compositePng: fakeCompositePng
    });
    expect(buf.length).toBeGreaterThan(0);

    const bundlePath = join(workDir, "round.pwrsnap");
    await writeFile(bundlePath, buf);

    const got = await readBundleManifest(bundlePath);
    expect(got.bundle_format_version).toBe(1);
    expect(got.capture_id).toBe(validManifest.capture_id);
    expect(got.source_sha256).toBe(validManifest.source_sha256);
    expect(got.source_dimensions).toEqual(validManifest.source_dimensions);
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
      compositePng: fakeCompositePng
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

  test("source.png and composite.png survive pack/unpack byte-exact (STORE mode, no recompression)", async () => {
    const buf = await packBundle({
      manifest: validManifest,
      overlays: validOverlays,
      sourcePng: fakeSourcePng,
      compositePng: fakeCompositePng
    });

    const bundlePath = join(workDir, "round.pwrsnap");
    await writeFile(bundlePath, buf);

    const sourceOut = await readBundleEntry(bundlePath, "source.png");
    const compositeOut = await readBundleEntry(bundlePath, "composite.png");

    expect(sourceOut.equals(fakeSourcePng)).toBe(true);
    expect(compositeOut.equals(fakeCompositePng)).toBe(true);
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
      compositePng: fakeCompositePng
    });
    expect(buf.length).toBeGreaterThan(0);
  });

  test("PNG entries use STORE (no DEFLATE) — bundle size is at least source + composite combined", async () => {
    const big = Buffer.alloc(50_000, 0xab); // already-incompressible-ish
    const big2 = Buffer.alloc(40_000, 0xcd);

    const buf = await packBundle({
      manifest: validManifest,
      overlays: validOverlays,
      sourcePng: big,
      compositePng: big2
    });

    // STORE mode means the PNG bytes appear verbatim. Bundle size ≥
    // sum of PNG entries (modulo ZIP framing overhead). If the
    // implementation regresses to DEFLATE on PNG, this test still
    // passes because deflate-on-uniform-bytes is also small — but
    // for incompressible inputs (real PNGs are already DEFLATE'd),
    // STORE is materially cheaper at write time. Check via direct
    // search for the recognizable 0xab/0xcd pattern; STORE leaves
    // it intact in the bundle.
    expect(buf.includes(big)).toBe(true);
    expect(buf.includes(big2)).toBe(true);
  });
});
