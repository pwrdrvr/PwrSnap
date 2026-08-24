import archiver from "archiver";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { BundleDocumentV2, BundleManifestV2 } from "@pwrsnap/shared";
import type { PortableBundleMetadata } from "../../persistence/portable-bundle-metadata";

import { packBundleV2 } from "../../persistence/bundle-store";
import { __setVerifiedFileBeforeOpenHookForTest } from "../../security/verified-file";
import {
  readAndValidateInstalledPwrsnapBundle,
  readAndValidatePwrsnapBundle,
  validatePwrsnapBundleBytes
} from "../pwrsnap-import-reader";

let workDir: string;

beforeEach(async () => {
  workDir = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "pwrsnap-import-reader-"))
  );
});

afterEach(async () => {
  __setVerifiedFileBeforeOpenHookForTest(null);
  await fs.rm(workDir, { recursive: true, force: true });
});

async function png(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: color }
  })
    .png()
    .toBuffer();
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeSparseOversizeZip(filePath: string, bytes: Buffer): Promise<void> {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdOffset = bytes.lastIndexOf(eocdSignature);
  if (eocdOffset < 0) throw new Error("test ZIP has no end-of-central-directory record");
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  const sparseGapBytes = 128 * 1024 * 1024 + 1;
  const suffix = Buffer.from(bytes.subarray(centralDirectoryOffset));
  suffix.writeUInt32LE(
    centralDirectoryOffset + sparseGapBytes,
    eocdOffset - centralDirectoryOffset + 16
  );

  const handle = await fs.open(filePath, "w");
  try {
    const prefix = bytes.subarray(0, centralDirectoryOffset);
    await handle.write(prefix, 0, prefix.length, 0);
    await handle.write(suffix, 0, suffix.length, centralDirectoryOffset + sparseGapBytes);
  } finally {
    await handle.close();
  }
}

async function validBundle(overrides: {
  manifest?: Partial<BundleManifestV2>;
  document?: Partial<BundleDocumentV2>;
  sources?: Map<string, Buffer>;
  layerBytes?: Map<string, Buffer>;
  portableMetadata?: PortableBundleMetadata;
} = {}): Promise<{
  bytes: Buffer;
  manifest: BundleManifestV2;
  document: BundleDocumentV2;
  sourceA: Buffer;
  sourceB: Buffer;
  sourceASha: string;
  sourceBSha: string;
}> {
  const sourceA = await png(64, 48, "#ff0000ff");
  const sourceB = await png(20, 10, "#0000ffff");
  const sourceASha = sha(sourceA);
  const sourceBSha = sha(sourceB);
  const createdAt = "2026-08-23T12:00:00.000Z";
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: "foreigncap000001",
    canvas_dimensions: { width_px: 64, height_px: 48 },
    paired_png_filename: "foreign-capture.png",
    created_at: createdAt,
    bundle_modified_at: createdAt,
    ...overrides.manifest
  };
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 7,
    layers: [
      {
        id: "root000000000001",
        parent_id: null,
        kind: "group",
        collapsed: false,
        name: "Root",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 0,
        source: "user",
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: null,
        superseded_by: null,
        created_at: createdAt
      },
      {
        id: "base000000000001",
        parent_id: "root000000000001",
        kind: "raster",
        source_ref: { kind: "embedded", sha256: sourceASha },
        natural_width_px: 64,
        natural_height_px: 48,
        name: "Source",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 0,
        source: "user",
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: null,
        superseded_by: null,
        created_at: createdAt
      },
      {
        id: "paste00000000001",
        parent_id: "root000000000001",
        kind: "raster",
        source_ref: { kind: "embedded", sha256: sourceBSha },
        natural_width_px: 20,
        natural_height_px: 10,
        name: "Pasted image",
        visible: true,
        locked: false,
        opacity: 0.9,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 4, 5],
        z_index: 1000,
        source: "user",
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: null,
        superseded_by: null,
        created_at: createdAt
      },
      {
        id: "vector0000000001",
        parent_id: "root000000000001",
        kind: "vector",
        shape: {
          kind: "shape",
          rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
          color: "#ff8a1f"
        },
        name: "Box",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 2000,
        source: "user",
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: null,
        superseded_by: null,
        created_at: createdAt
      },
      {
        id: "effect0000000001",
        parent_id: "root000000000001",
        kind: "effect",
        effect: { type: "blur", radius_px: 8 },
        clip_rect: { x: 1, y: 2, w: 20, h: 12 },
        name: "Blur",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 3000,
        source: "user",
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: null,
        superseded_by: null,
        created_at: createdAt
      }
    ],
    tags: ["Bug", "Windows"],
    description: "A multi-source capture with live vector and effect layers.",
    ai_runs: [{ id: "foreign-ai-run", kind: "describe", created_at: createdAt }],
    ...overrides.document
  };
  const sources = overrides.sources ?? new Map([
    [sourceASha, sourceA],
    [sourceBSha, sourceB]
  ]);
  const bytes = await packBundleV2({
    manifest,
    document,
    sources,
    layerBytes: overrides.layerBytes ?? new Map(),
    ...(overrides.portableMetadata === undefined
      ? {}
      : { portableMetadata: overrides.portableMetadata })
  });
  return { bytes, manifest, document, sourceA, sourceB, sourceASha, sourceBSha };
}

async function rawZip(
  entries: Array<{ name: string; bytes: Buffer; mode?: number }>
): Promise<Buffer> {
  const archive = archiver("zip", { store: true });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const entry of entries) {
    archive.append(entry.bytes, {
      name: entry.name,
      ...(entry.mode === undefined ? {} : { mode: entry.mode })
    });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function rawZipWithSymlink(
  entries: Array<{ name: string; bytes: Buffer }>,
  link: { name: string; target: string }
): Promise<Buffer> {
  const archive = archiver("zip", { store: true });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const entry of entries) archive.append(entry.bytes, { name: entry.name });
  archive.symlink(link.name, link.target);
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

describe("validatePwrsnapBundleBytes", () => {
  test("validates a foreign multi-source v2 tree and preserves metadata", async () => {
    const fixture = await validBundle();
    const parsed = await validatePwrsnapBundleBytes(fixture.bytes);

    expect(parsed.baseSourceSha256).toBe(fixture.sourceASha);
    expect(parsed.sources).toEqual(
      new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ])
    );
    expect(parsed.document.layers.map((layer) => layer.kind)).toEqual([
      "group",
      "raster",
      "raster",
      "vector",
      "effect"
    ]);
    expect(parsed.document.tags).toEqual(["Bug", "Windows"]);
    expect(parsed.document.description).toContain("multi-source");
    expect(parsed.document.ai_runs).toHaveLength(1);
    expect(parsed.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("preserves only bounded portable metadata and fingerprints it", async () => {
    const portableMetadata: PortableBundleMetadata = {
      version: 1,
      manifest: {
        portable_origin: { device: "other-mac", version: 3 },
        canvas_dimensions: { portable_color_space: "display-p3" }
      },
      document: { portable_workspace: { grid: true } },
      layers: {
        vector0000000001: {
          portable_layer: { tool: "future-shape" },
          shape: { portable_shape_hint: "keep-with-vector" }
        }
      },
      aiRuns: {
        "foreign-ai-run": { portable_model_hint: "future-model" }
      }
    };
    const fixture = await validBundle({ portableMetadata });
    const parsed = await validatePwrsnapBundleBytes(fixture.bytes);
    expect(parsed.portableMetadata).toEqual(portableMetadata);

    const changed = await validBundle({
      portableMetadata: {
        ...portableMetadata,
        document: { portable_workspace: { grid: false } }
      }
    });
    expect((await validatePwrsnapBundleBytes(changed.bytes)).contentDigest).not.toBe(
      parsed.contentDigest
    );

    const rawManifest = {
      ...fixture.manifest,
      unrelated_unknown: "discarded",
      portable_too_large: "x".repeat(70 * 1024)
    };
    const oversized = await rawZip([
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(rawManifest)) },
      { name: "document.json", bytes: Buffer.from(JSON.stringify(fixture.document)) }
    ]);
    await expect(validatePwrsnapBundleBytes(oversized)).rejects.toMatchObject({
      code: "portable_metadata_invalid"
    });
  });

  test("uses the first live raster when a multi-source base layer was renamed", async () => {
    const fixture = await validBundle();
    const layers = fixture.document.layers.map((layer) =>
      layer.id === "base000000000001" ? { ...layer, name: "Desktop screenshot" } : layer
    );
    const bytes = await packBundleV2({
      manifest: fixture.manifest,
      document: { ...fixture.document, layers },
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map()
    });

    await expect(validatePwrsnapBundleBytes(bytes)).resolves.toMatchObject({
      baseSourceSha256: fixture.sourceASha
    });
  });

  test("rejects a rejected root and a live raster disconnected by rejected ancestry", async () => {
    const fixture = await validBundle();
    const rejectedRoot = fixture.document.layers.map((layer) =>
      layer.id === "root000000000001"
        ? { ...layer, rejected_at: "2026-08-23T12:01:00.000Z" }
        : layer
    );
    const rejectedRootBytes = await packBundleV2({
      manifest: fixture.manifest,
      document: { ...fixture.document, layers: rejectedRoot },
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map()
    });
    await expect(validatePwrsnapBundleBytes(rejectedRootBytes)).rejects.toMatchObject({
      code: "live_layer_root_invalid"
    });

    const createdAt = fixture.document.layers[0]!.created_at;
    const rejectedGroupId = "rejectedgroup001";
    const disconnectedLayers = [
      ...fixture.document.layers.map((layer) =>
        layer.id === "base000000000001"
          ? { ...layer, parent_id: rejectedGroupId }
          : layer
      ),
      {
        id: rejectedGroupId,
        parent_id: "root000000000001",
        kind: "group" as const,
        collapsed: false,
        name: "Rejected parent",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal" as const,
        transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
        z_index: 0,
        source: "user" as const,
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: "2026-08-23T12:01:00.000Z",
        superseded_by: null,
        created_at: createdAt
      }
    ];
    const disconnectedBytes = await packBundleV2({
      manifest: fixture.manifest,
      document: { ...fixture.document, layers: disconnectedLayers },
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map()
    });
    await expect(validatePwrsnapBundleBytes(disconnectedBytes)).rejects.toMatchObject({
      code: "live_layer_disconnected"
    });
  });

  test("rejects dangling layer AI metadata and orphan embedded sources", async () => {
    const fixture = await validBundle();
    const danglingLayers = fixture.document.layers.map((layer) =>
      layer.id === "vector0000000001"
        ? { ...layer, ai_run_id: "missing-ai-run" }
        : layer
    );
    const danglingBytes = await packBundleV2({
      manifest: fixture.manifest,
      document: { ...fixture.document, layers: danglingLayers },
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map()
    });
    await expect(validatePwrsnapBundleBytes(danglingBytes)).rejects.toMatchObject({
      code: "layer_ai_run_dangling"
    });

    const orphan = await png(3, 2, "#00ffffff");
    const orphanBytes = await packBundleV2({
      manifest: fixture.manifest,
      document: fixture.document,
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB],
        [sha(orphan), orphan]
      ]),
      layerBytes: new Map()
    });
    await expect(validatePwrsnapBundleBytes(orphanBytes)).rejects.toMatchObject({
      code: "source_asset_orphan"
    });
  });

  test("binds each opaque layer payload to its canonical layer identity", async () => {
    const fixture = await validBundle();
    const firstPayload = await png(7, 5, "#123456ff");
    const secondPayload = await png(9, 6, "#abcdef88");
    const firstBytes = await packBundleV2({
      manifest: fixture.manifest,
      document: fixture.document,
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map([
        ["vector0000000001", firstPayload],
        ["effect0000000001", secondPayload]
      ])
    });
    const swappedBytes = await packBundleV2({
      manifest: fixture.manifest,
      document: fixture.document,
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map([
        ["vector0000000001", secondPayload],
        ["effect0000000001", firstPayload]
      ])
    });

    const first = await validatePwrsnapBundleBytes(firstBytes);
    const swapped = await validatePwrsnapBundleBytes(swappedBytes);
    expect(first.contentDigest).not.toBe(swapped.contentDigest);
  });

  test("classifies v1 and future bundle versions as unsupported", async () => {
    const fixture = await validBundle();
    for (const version of [1, 3]) {
      const bytes = await rawZip([
        {
          name: "manifest.json",
          bytes: Buffer.from(JSON.stringify({ ...fixture.manifest, bundle_format_version: version }))
        },
        { name: "document.json", bytes: Buffer.from(JSON.stringify(fixture.document)) }
      ]);
      await expect(validatePwrsnapBundleBytes(bytes)).rejects.toMatchObject({
        kind: "unsupported"
      });
    }

    const futureDocument = await rawZip([
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(fixture.manifest)) },
      {
        name: "document.json",
        bytes: Buffer.from(JSON.stringify({ ...fixture.document, document_format_version: 2 }))
      }
    ]);
    await expect(validatePwrsnapBundleBytes(futureDocument)).rejects.toMatchObject({
      kind: "unsupported",
      code: "future_document_unsupported"
    });
  });

  test("rejects traversal entries before extracting them", async () => {
    const fixture = await validBundle();
    const bytes = await rawZip([
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(fixture.manifest)) },
      { name: "document.json", bytes: Buffer.from(JSON.stringify(fixture.document)) },
      { name: `sources/${fixture.sourceASha}.png`, bytes: fixture.sourceA },
      { name: "../outside.txt", bytes: Buffer.from("not written") }
    ]);
    await expect(validatePwrsnapBundleBytes(bytes)).rejects.toMatchObject({
      kind: "corrupt",
      code: "zip_entries_invalid"
    });
  });

  test("rejects duplicate and ZIP-symlink entries", async () => {
    const fixture = await validBundle();
    const duplicate = await rawZip([
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(fixture.manifest)) },
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(fixture.manifest)) },
      { name: "document.json", bytes: Buffer.from(JSON.stringify(fixture.document)) }
    ]);
    await expect(validatePwrsnapBundleBytes(duplicate)).rejects.toMatchObject({
      code: "zip_duplicate_entry"
    });

    const zipLink = await rawZipWithSymlink(
      [
        { name: "manifest.json", bytes: Buffer.from(JSON.stringify(fixture.manifest)) },
        { name: "document.json", bytes: Buffer.from(JSON.stringify(fixture.document)) }
      ],
      { name: `sources/${fixture.sourceASha}.png`, target: "../../outside" }
    );
    await expect(validatePwrsnapBundleBytes(zipLink)).rejects.toMatchObject({
      code: "zip_non_regular_entry"
    });
  });

  test("rejects a source whose bytes do not match its content-addressed path", async () => {
    const fixture = await validBundle();
    const wrong = await png(64, 48, "#00ff00ff");
    const bytes = await rawZip([
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(fixture.manifest)) },
      { name: "document.json", bytes: Buffer.from(JSON.stringify(fixture.document)) },
      { name: `sources/${fixture.sourceASha}.png`, bytes: wrong },
      { name: `sources/${fixture.sourceBSha}.png`, bytes: fixture.sourceB }
    ]);
    await expect(validatePwrsnapBundleBytes(bytes)).rejects.toMatchObject({
      code: "source_hash_mismatch"
    });
  });

  test("rejects an image whose header parses but whose pixel data is truncated", async () => {
    const fixture = await validBundle();
    const truncated = fixture.sourceA.subarray(0, Math.ceil(fixture.sourceA.length / 2));
    await expect(sharp(truncated).metadata()).resolves.toMatchObject({
      width: 64,
      height: 48
    });
    const truncatedSha = sha(truncated);
    const layers = fixture.document.layers.map((layer) =>
      layer.id === "base000000000001" && layer.kind === "raster"
        ? { ...layer, source_ref: { kind: "embedded" as const, sha256: truncatedSha } }
        : layer
    );
    const bytes = await packBundleV2({
      manifest: fixture.manifest,
      document: { ...fixture.document, layers },
      sources: new Map([
        [truncatedSha, truncated],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map()
    });

    await expect(validatePwrsnapBundleBytes(bytes)).rejects.toMatchObject({
      code: "image_invalid"
    });
  });

  test("rejects decoded dimensions that disagree with a raster layer", async () => {
    const fixture = await validBundle();
    const layers = fixture.document.layers.map((layer) =>
      layer.id === "base000000000001" && layer.kind === "raster"
        ? { ...layer, natural_width_px: 63 }
        : layer
    );
    const bytes = await packBundleV2({
      manifest: fixture.manifest,
      document: { ...fixture.document, layers },
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map()
    });
    await expect(validatePwrsnapBundleBytes(bytes)).rejects.toMatchObject({
      code: "source_dimensions_mismatch"
    });
  });

  test("rejects parent cycles and a canvas allocation bomb", async () => {
    const fixture = await validBundle();
    const cycledLayers = fixture.document.layers.map((layer) =>
      layer.id === "root000000000001"
        ? { ...layer, parent_id: "root000000000001" }
        : layer
    );
    const cyclic = await packBundleV2({
      manifest: fixture.manifest,
      document: { ...fixture.document, layers: cycledLayers },
      sources: new Map([
        [fixture.sourceASha, fixture.sourceA],
        [fixture.sourceBSha, fixture.sourceB]
      ]),
      layerBytes: new Map()
    });
    await expect(validatePwrsnapBundleBytes(cyclic)).rejects.toMatchObject({
      kind: "corrupt"
    });

    const bomb = await validBundle({
      manifest: { canvas_dimensions: { width_px: 32_768, height_px: 32_768 } }
    });
    await expect(validatePwrsnapBundleBytes(bomb.bytes)).rejects.toMatchObject({
      code: "canvas_pixel_limit"
    });
  });
});

describe("readAndValidatePwrsnapBundle", () => {
  test("validates through the shared descriptor boundary and rejects a leaf symlink", async () => {
    const fixture = await validBundle();
    const source = join(workDir, "source.pwrsnap");
    await fs.writeFile(source, fixture.bytes);
    await expect(readAndValidatePwrsnapBundle(source)).resolves.toMatchObject({
      sourceBytes: fixture.bytes,
      manifest: fixture.manifest
    });

    const directLink = join(workDir, "direct.pwrsnap");
    await fs.symlink(source, directLink);
    await expect(readAndValidatePwrsnapBundle(directLink)).rejects.toMatchObject({
      kind: "unsafe",
      code: "verified_file_symlink"
    });
  });

  test("rejects a regular-file leaf swap before the verified descriptor opens", async () => {
    const original = await validBundle();
    const replacement = await validBundle({
      manifest: { capture_id: "replacement00001" }
    });
    const source = join(workDir, "source.pwrsnap");
    const moved = join(workDir, "original.pwrsnap");
    await fs.writeFile(source, original.bytes);
    __setVerifiedFileBeforeOpenHookForTest(async () => {
      await fs.rename(source, moved);
      await fs.writeFile(source, replacement.bytes);
    });

    await expect(readAndValidatePwrsnapBundle(source)).rejects.toMatchObject({
      kind: "unsafe",
      code: "verified_file_file_changed"
    });
  });

  test("rejects a parent symlink or junction retargeted before descriptor open", async () => {
    const first = await validBundle();
    const second = await validBundle({
      manifest: { capture_id: "junctiontarget02" }
    });
    const firstParent = join(workDir, "first-parent");
    const secondParent = join(workDir, "second-parent");
    const linkedParent = join(workDir, "linked-parent");
    await fs.mkdir(firstParent);
    await fs.mkdir(secondParent);
    await fs.writeFile(join(firstParent, "parent.pwrsnap"), first.bytes);
    await fs.writeFile(join(secondParent, "parent.pwrsnap"), second.bytes);
    await fs.symlink(firstParent, linkedParent, "dir");
    __setVerifiedFileBeforeOpenHookForTest(async () => {
      await fs.unlink(linkedParent);
      await fs.symlink(secondParent, linkedParent, "dir");
    });

    await expect(
      readAndValidatePwrsnapBundle(join(linkedParent, "parent.pwrsnap"))
    ).rejects.toMatchObject({
      kind: "unsafe",
      code: "verified_file_file_changed"
    });
  });

  test("keeps installed bundle reads outside the external archive-size ceiling", async () => {
    const fixture = await validBundle();
    const source = join(workDir, "installed-large-carrier.pwrsnap");
    await writeSparseOversizeZip(source, fixture.bytes);

    await expect(readAndValidatePwrsnapBundle(source)).rejects.toMatchObject({
      code: "archive_size_invalid"
    });
    const installed = await readAndValidateInstalledPwrsnapBundle(source);
    expect(installed.manifest).toEqual(fixture.manifest);
    expect(installed.document).toEqual(fixture.document);
    expect(installed.sources.get(fixture.sourceASha)).toEqual(fixture.sourceA);
    expect("sourceBytes" in installed).toBe(false);
  });
});
