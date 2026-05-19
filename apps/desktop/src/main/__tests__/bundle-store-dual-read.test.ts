// Test-first specs for the v2 dual-read surface in `bundle-store.ts`.
// Phase 2 of the v2 plan: `openAndValidateBundle` becomes version-aware,
// `readBundleView` exposes a uniform adapter that hides the version
// discriminant from most callers, and `readSourceFromBundle` verifies
// sha256(zipEntryBytes) === filename sha on every extraction.
//
// Three threat models locked in by these tests:
//
//   1. Version dispatch correctness — reading a v1 bundle yields v1
//      shapes; reading a v2 bundle yields v2 shapes. Mixing them up
//      would cause `compose()` to ignore overlays or skip layers.
//   2. Content-integrity verification — attackers who write a v2
//      bundle (AirDrop, peer iCloud) can put attacker-controlled bytes
//      at `sources/<known-good-sha>.png`. Without sha256 verification
//      on read, the dedup invariant becomes a trojan vector.
//   3. v1/v2 IPC poisoning — `readBundleOverlays` called on a v2 bundle
//      must error clearly, not silently return empty overlays (which
//      a buggy doctor could treat as "this capture has no edits").

import archiver from "archiver";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  type BundleDocumentV2,
  type BundleManifestV1,
  type BundleManifestV2,
  type BundleOverlaysV1
} from "@pwrsnap/shared";
import {
  packBundle,
  readBundleDocument,
  readBundleManifest,
  readBundleOverlays,
  readBundleView,
  readSourceFromBundle
} from "../persistence/bundle-store";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-bundle-dual-read-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

const v1Manifest: BundleManifestV1 = {
  bundle_format_version: 1,
  capture_id: "v1-cap-abc12345",
  source_sha256: "0".repeat(64),
  source_dimensions: { width_px: 800, height_px: 600 },
  paired_png_filename: "v1-cap-abc12345.png",
  created_at: "2026-05-07T14:30:22.000Z",
  bundle_modified_at: "2026-05-07T14:30:22.000Z"
};
const v1Overlays: BundleOverlaysV1 = {
  overlays_format_version: 1,
  overlays_version: 0,
  overlays: [],
  tags: [],
  description: null,
  ai_runs: []
};

const fakeSourceBytes = Buffer.from("FAKE_V2_SOURCE_PNG_BYTES_" + "x".repeat(300));
const fakeSourceSha = createHash("sha256").update(fakeSourceBytes).digest("hex");

const v2Manifest: BundleManifestV2 = {
  bundle_format_version: 2,
  capture_id: "v2-cap-abc12345",
  canvas_dimensions: { width_px: 1920, height_px: 1080 },
  paired_png_filename: "v2-cap-abc12345.png",
  created_at: "2026-05-07T14:30:22.000Z",
  bundle_modified_at: "2026-05-07T14:30:22.000Z"
};
const v2Document: BundleDocumentV2 = {
  document_format_version: 1,
  edits_version: 0,
  layers: [],
  tags: [],
  description: null,
  ai_runs: []
};
const fakeCompositeBytes = Buffer.from("FAKE_V2_COMPOSITE_PNG_BYTES_" + "y".repeat(200));

/**
 * Hand-construct a v2 bundle using yazl. Mirrors what `packBundleV2`
 * will do in Phase 4 — until that ships, the read path is tested
 * against bundles assembled here.
 */
async function packV2Bundle(args: {
  manifest: BundleManifestV2;
  document: BundleDocumentV2;
  sources: Map<string, Buffer>;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(args.manifest)), "manifest.json");
    zip.addBuffer(Buffer.from(JSON.stringify(args.document)), "document.json");
    for (const [sha, bytes] of args.sources) {
      zip.addBuffer(bytes, `sources/${sha}.png`, { compress: false });
    }
    zip.addBuffer(fakeCompositeBytes, "composite.png", { compress: false });

    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
    zip.end();
  });
}

/**
 * Construct a v2 bundle with attacker-controlled bytes at a specific
 * sources/<sha>.png filename. The filename sha and the actual content
 * sha diverge — this is the trojan attack the content-integrity check
 * must catch.
 */
async function packTamperedV2Bundle(args: {
  manifest: BundleManifestV2;
  document: BundleDocumentV2;
  claimedSha: string;
  actualBytes: Buffer;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(args.manifest)), "manifest.json");
    zip.addBuffer(Buffer.from(JSON.stringify(args.document)), "document.json");
    zip.addBuffer(args.actualBytes, `sources/${args.claimedSha}.png`, { compress: false });
    zip.addBuffer(fakeCompositeBytes, "composite.png", { compress: false });

    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
    zip.end();
  });
}

/**
 * Adversarial bundle whose central directory contains a malicious
 * entry (e.g., `sources/../etc/passwd`). yazl validates filenames at
 * write time, so we use archiver to slip past that.
 */
async function packAdversarialBundle(
  entries: Array<{ name: string; data: Buffer }>
): Promise<Buffer> {
  const archive = archiver("zip", { store: true });
  const chunks: Buffer[] = [];
  archive.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", reject);
  });
  for (const e of entries) archive.append(e.data, { name: e.name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

// --------------------------------------------------------------------
// readBundleView — public adapter that hides the version discriminant
// --------------------------------------------------------------------

describe("readBundleView — uniform adapter for v1 + v2", () => {
  test("v1 bundle: returns BundleView with version=1 + canvas from source_dimensions", async () => {
    const buf = await packBundle({
      manifest: v1Manifest,
      overlays: v1Overlays,
      sourcePng: Buffer.from("fake-source"),
      compositePng: Buffer.from("fake-composite")
    });
    const bundlePath = join(workDir, "v1.pwrsnap");
    await writeFile(bundlePath, buf);

    const view = await readBundleView(bundlePath);
    expect(view.version).toBe(1);
    expect(view.capture_id).toBe(v1Manifest.capture_id);
    expect(view.canvas).toEqual(v1Manifest.source_dimensions);
    expect(view.paired_png_filename).toBe(v1Manifest.paired_png_filename);
    expect(view.bundle_modified_at).toBe(v1Manifest.bundle_modified_at);
  });

  test("v2 bundle: returns BundleView with version=2 + canvas from canvas_dimensions", async () => {
    const buf = await packV2Bundle({
      manifest: v2Manifest,
      document: v2Document,
      sources: new Map([[fakeSourceSha, fakeSourceBytes]])
    });
    const bundlePath = join(workDir, "v2.pwrsnap");
    await writeFile(bundlePath, buf);

    const view = await readBundleView(bundlePath);
    expect(view.version).toBe(2);
    expect(view.capture_id).toBe(v2Manifest.capture_id);
    expect(view.canvas).toEqual(v2Manifest.canvas_dimensions);
    expect(view.paired_png_filename).toBe(v2Manifest.paired_png_filename);
    expect(view.bundle_modified_at).toBe(v2Manifest.bundle_modified_at);
  });

  test("BundleView shape is uniform regardless of underlying version", async () => {
    // Same keys, same field types — that's the value of the adapter.
    const v1Buf = await packBundle({
      manifest: v1Manifest,
      overlays: v1Overlays,
      sourcePng: Buffer.from("v1"),
      compositePng: Buffer.from("v1c")
    });
    const v2Buf = await packV2Bundle({
      manifest: v2Manifest,
      document: v2Document,
      sources: new Map([[fakeSourceSha, fakeSourceBytes]])
    });
    const v1Path = join(workDir, "v1u.pwrsnap");
    const v2Path = join(workDir, "v2u.pwrsnap");
    await writeFile(v1Path, v1Buf);
    await writeFile(v2Path, v2Buf);

    const v1View = await readBundleView(v1Path);
    const v2View = await readBundleView(v2Path);
    expect(Object.keys(v1View).sort()).toEqual(Object.keys(v2View).sort());
  });
});

// --------------------------------------------------------------------
// readBundleManifest — version-discriminated return type
// --------------------------------------------------------------------

describe("readBundleManifest — version dispatch", () => {
  test("v1 manifest: returns BundleManifestV1 shape", async () => {
    const buf = await packBundle({
      manifest: v1Manifest,
      overlays: v1Overlays,
      sourcePng: Buffer.from("a"),
      compositePng: Buffer.from("b")
    });
    const bundlePath = join(workDir, "v1.pwrsnap");
    await writeFile(bundlePath, buf);

    const got = await readBundleManifest(bundlePath);
    expect(got.bundle_format_version).toBe(1);
    if (got.bundle_format_version === 1) {
      expect(got.source_sha256).toBe(v1Manifest.source_sha256);
      expect(got.source_dimensions).toEqual(v1Manifest.source_dimensions);
    }
  });

  test("v2 manifest: returns BundleManifestV2 shape", async () => {
    const buf = await packV2Bundle({
      manifest: v2Manifest,
      document: v2Document,
      sources: new Map([[fakeSourceSha, fakeSourceBytes]])
    });
    const bundlePath = join(workDir, "v2.pwrsnap");
    await writeFile(bundlePath, buf);

    const got = await readBundleManifest(bundlePath);
    expect(got.bundle_format_version).toBe(2);
    if (got.bundle_format_version === 2) {
      expect(got.canvas_dimensions).toEqual(v2Manifest.canvas_dimensions);
    }
  });
});

// --------------------------------------------------------------------
// readBundleDocument — v2 only
// --------------------------------------------------------------------

describe("readBundleDocument — v2 only", () => {
  test("returns BundleDocumentV2 from a v2 bundle", async () => {
    const docWithContent: BundleDocumentV2 = {
      document_format_version: 1,
      edits_version: 7,
      layers: [],
      tags: ["work"],
      description: "a v2 capture",
      ai_runs: []
    };
    const buf = await packV2Bundle({
      manifest: v2Manifest,
      document: docWithContent,
      sources: new Map([[fakeSourceSha, fakeSourceBytes]])
    });
    const bundlePath = join(workDir, "v2.pwrsnap");
    await writeFile(bundlePath, buf);

    const got = await readBundleDocument(bundlePath);
    expect(got.document_format_version).toBe(1);
    expect(got.edits_version).toBe(7);
    expect(got.tags).toEqual(["work"]);
    expect(got.description).toBe("a v2 capture");
  });

  test("errors on a v1 bundle (no document.json present)", async () => {
    const buf = await packBundle({
      manifest: v1Manifest,
      overlays: v1Overlays,
      sourcePng: Buffer.from("a"),
      compositePng: Buffer.from("b")
    });
    const bundlePath = join(workDir, "v1.pwrsnap");
    await writeFile(bundlePath, buf);

    await expect(readBundleDocument(bundlePath)).rejects.toThrow();
  });
});

// --------------------------------------------------------------------
// readBundleOverlays — v1 only; v2 must reject cleanly
// --------------------------------------------------------------------

describe("readBundleOverlays — v1 only", () => {
  test("returns BundleOverlaysV1 from a v1 bundle", async () => {
    const buf = await packBundle({
      manifest: v1Manifest,
      overlays: v1Overlays,
      sourcePng: Buffer.from("a"),
      compositePng: Buffer.from("b")
    });
    const bundlePath = join(workDir, "v1.pwrsnap");
    await writeFile(bundlePath, buf);

    const got = await readBundleOverlays(bundlePath);
    expect(got.overlays_format_version).toBe(1);
  });

  test("errors on a v2 bundle — caller should use readBundleDocument", async () => {
    const buf = await packV2Bundle({
      manifest: v2Manifest,
      document: v2Document,
      sources: new Map([[fakeSourceSha, fakeSourceBytes]])
    });
    const bundlePath = join(workDir, "v2.pwrsnap");
    await writeFile(bundlePath, buf);

    await expect(readBundleOverlays(bundlePath)).rejects.toThrow();
  });
});

// --------------------------------------------------------------------
// readSourceFromBundle — content-integrity verification
// --------------------------------------------------------------------

describe("readSourceFromBundle — sha256 content-integrity verify", () => {
  test("returns bytes when sha256(bytes) === filename sha (happy path)", async () => {
    const buf = await packV2Bundle({
      manifest: v2Manifest,
      document: v2Document,
      sources: new Map([[fakeSourceSha, fakeSourceBytes]])
    });
    const bundlePath = join(workDir, "v2.pwrsnap");
    await writeFile(bundlePath, buf);

    const got = await readSourceFromBundle(bundlePath, fakeSourceSha);
    expect(got.equals(fakeSourceBytes)).toBe(true);
  });

  test("rejects when content sha differs from filename sha (trojan attack)", async () => {
    // Attacker ships a bundle with bytes that DON'T match the claimed
    // sha. Without content-integrity verify on read, the dedup
    // invariant becomes a poisoning vector.
    const attackerBytes = Buffer.from("MALICIOUS_BYTES_" + "z".repeat(100));
    const claimedSha = createHash("sha256").update(Buffer.from("different-content")).digest("hex");
    const buf = await packTamperedV2Bundle({
      manifest: v2Manifest,
      document: v2Document,
      claimedSha,
      actualBytes: attackerBytes
    });
    const bundlePath = join(workDir, "tampered.pwrsnap");
    await writeFile(bundlePath, buf);

    await expect(readSourceFromBundle(bundlePath, claimedSha)).rejects.toThrow();
  });

  test("rejects with sanitized error — no attacker sha or bytes in message", async () => {
    const attackerBytes = Buffer.from("evil-bytes");
    const claimedSha = "a".repeat(64);
    const buf = await packTamperedV2Bundle({
      manifest: v2Manifest,
      document: v2Document,
      claimedSha,
      actualBytes: attackerBytes
    });
    const bundlePath = join(workDir, "tampered2.pwrsnap");
    await writeFile(bundlePath, buf);

    try {
      await readSourceFromBundle(bundlePath, claimedSha);
      throw new Error("expected readSourceFromBundle to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Error message must NOT echo the full claimed sha (attacker-
      // controlled identifier) into renderer-bound logs. A short prefix
      // for diagnostics is fine.
      expect(message).not.toContain(claimedSha);
      // Error message must NOT echo attacker bytes.
      expect(message).not.toContain(attackerBytes.toString("hex"));
      expect(message).not.toContain(attackerBytes.toString("utf8"));
    }
  });

  test("errors when requested sha is not in the bundle's central directory", async () => {
    const buf = await packV2Bundle({
      manifest: v2Manifest,
      document: v2Document,
      sources: new Map([[fakeSourceSha, fakeSourceBytes]])
    });
    const bundlePath = join(workDir, "v2.pwrsnap");
    await writeFile(bundlePath, buf);

    const otherSha = "f".repeat(64);
    await expect(readSourceFromBundle(bundlePath, otherSha)).rejects.toThrow();
  });
});

// --------------------------------------------------------------------
// Malicious v2 bundle ingestion — Zip-Slip carries forward through
// the version-aware dispatch path
// --------------------------------------------------------------------

describe("openAndValidateBundle — Zip-Slip on v2 bundles", () => {
  test("v2 bundle with sources/../etc/passwd is quarantined", async () => {
    // Build a v2-shaped central directory but with a malicious entry
    // alongside the fixed three. yazl validates filenames; archiver
    // does not, so we use archiver to slip the bad path past write.
    const buf = await packAdversarialBundle([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(v2Manifest)) },
      { name: "document.json", data: Buffer.from(JSON.stringify(v2Document)) },
      { name: `sources/${fakeSourceSha}.png`, data: fakeSourceBytes },
      { name: "composite.png", data: fakeCompositeBytes },
      { name: "sources/../etc/passwd", data: Buffer.from("attacker-controlled") }
    ]);
    const bundlePath = join(workDir, "evil.pwrsnap");
    await writeFile(bundlePath, buf);

    await expect(readBundleView(bundlePath)).rejects.toThrow();
  });

  test("v2 bundle with extra LICENSE entry is rejected (not in v2 allowlist)", async () => {
    const buf = await packAdversarialBundle([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(v2Manifest)) },
      { name: "document.json", data: Buffer.from(JSON.stringify(v2Document)) },
      { name: `sources/${fakeSourceSha}.png`, data: fakeSourceBytes },
      { name: "composite.png", data: fakeCompositeBytes },
      { name: "LICENSE", data: Buffer.from("MIT") }
    ]);
    const bundlePath = join(workDir, "evil2.pwrsnap");
    await writeFile(bundlePath, buf);

    await expect(readBundleView(bundlePath)).rejects.toThrow();
  });

  test("v2 bundle with missing manifest.json rejected (cannot determine version)", async () => {
    const buf = await packAdversarialBundle([
      { name: "document.json", data: Buffer.from(JSON.stringify(v2Document)) },
      { name: `sources/${fakeSourceSha}.png`, data: fakeSourceBytes },
      { name: "composite.png", data: fakeCompositeBytes }
    ]);
    const bundlePath = join(workDir, "no-manifest.pwrsnap");
    await writeFile(bundlePath, buf);

    await expect(readBundleView(bundlePath)).rejects.toThrow();
  });

  test("v2 bundle with duplicate manifest.json is rejected (shadow-entry attack)", async () => {
    const buf = await packAdversarialBundle([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(v2Manifest)) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ evil: true })) },
      { name: "document.json", data: Buffer.from(JSON.stringify(v2Document)) },
      { name: `sources/${fakeSourceSha}.png`, data: fakeSourceBytes },
      { name: "composite.png", data: fakeCompositeBytes }
    ]);
    const bundlePath = join(workDir, "shadow.pwrsnap");
    await writeFile(bundlePath, buf);

    await expect(readBundleView(bundlePath)).rejects.toThrow();
  });
});
