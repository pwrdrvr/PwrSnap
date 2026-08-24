import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { BundleDocumentV2, BundleManifestV2 } from "@pwrsnap/shared";
import type { PortableBundleMetadata } from "../../persistence/portable-bundle-metadata";
import { __setVerifiedFileBeforeOpenHookForTest } from "../../security/verified-file";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  compositePath: "",
  composeCalls: 0,
  onCompose: null as (() => void) | null,
  accessFailures: [] as Array<{ path: string; cause: unknown }>,
  accessSuccesses: [] as string[]
}));

vi.mock("../../persistence/db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) throw new Error("test db not initialized");
    return mocks.db;
  }
}));

vi.mock("../../render/compose-tree", () => ({
  composeV2: async () => {
    mocks.composeCalls += 1;
    mocks.onCompose?.();
    return { cachePath: mocks.compositePath };
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

vi.mock("../../storage/captures-access-health", () => ({
  reportCapturesAccessFailure: (path: string, cause: unknown) => {
    mocks.accessFailures.push({ path, cause });
    return true;
  },
  reportCapturesAccessSuccess: (path: string) => {
    mocks.accessSuccesses.push(path);
  }
}));

const MIGRATIONS_DIR = join(__dirname, "..", "..", "persistence", "migrations");
let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), "pwrsnap-import-repack-"));
  mocks.db = new Database(":memory:");
  mocks.composeCalls = 0;
  mocks.onCompose = null;
  mocks.accessFailures.length = 0;
  mocks.accessSuccesses.length = 0;
  mocks.db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const needsFkOff = sql.startsWith("-- @no-foreign-keys");
    if (needsFkOff) mocks.db.pragma("foreign_keys = OFF");
    try {
      mocks.db.exec(sql);
    } finally {
      if (needsFkOff) mocks.db.pragma("foreign_keys = ON");
    }
  }
});

afterEach(async () => {
  __setVerifiedFileBeforeOpenHookForTest(null);
  const { cancelScheduledRepacks } = await import("../../persistence/bundle-store");
  cancelScheduledRepacks();
  mocks.db?.close();
  mocks.db = null;
  await fs.rm(workDir, { recursive: true, force: true });
});

async function seedMinimalRepack(captureId: string): Promise<{
  bundlePath: string;
  document: BundleDocumentV2;
  manifest: BundleManifestV2;
  rootId: string;
  sourceId: string;
  source: Buffer;
}> {
  const createdAt = "2026-08-23T14:00:00.000Z";
  const source = await sharp({
    create: { width: 20, height: 15, channels: 4, background: "#336699ff" }
  })
    .png()
    .toBuffer();
  const sha = createHash("sha256").update(source).digest("hex");
  const layerId = (suffix: string): string =>
    createHash("sha256").update(`${captureId}:${suffix}`).digest("base64url").slice(0, 16);
  const rootId = layerId("root");
  const sourceId = layerId("source");
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 3,
    layers: [
      {
        id: rootId,
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
        id: sourceId,
        parent_id: rootId,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: sha },
        natural_width_px: 20,
        natural_height_px: 15,
        name: "Renamed base",
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
      }
    ],
    tags: ["Original"],
    description: "Original portable description",
    ai_runs: []
  };
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: captureId,
    canvas_dimensions: { width_px: 20, height_px: 15 },
    paired_png_filename: `${captureId}.png`,
    created_at: createdAt,
    bundle_modified_at: createdAt
  };
  const bundlePath = join(workDir, `${captureId}.pwrsnap`);
  mocks.compositePath = join(workDir, `${captureId}-composite.png`);
  await fs.writeFile(mocks.compositePath, source);
  const { packBundleV2 } = await import("../../persistence/bundle-store");
  await fs.writeFile(
    bundlePath,
    await packBundleV2({
      manifest,
      document,
      sources: new Map([[sha, source]]),
      layerBytes: new Map()
    })
  );
  const { insertCapture } = await import("../../persistence/captures-repo");
  const { insertImportedLayerTreeForCapture } = await import(
    "../../persistence/layers-repo"
  );
  const { acceptDescription, addUserTag } = await import(
    "../../persistence/enrichment-repo"
  );
  const { writePortableBundleCarrier } = await import(
    "../../persistence/bundle-carrier-repo"
  );
  insertCapture({
    id: captureId,
    kind: "image",
    captured_at: createdAt,
    source_app_bundle_id: null,
    source_app_name: null,
    legacy_src_path: null,
    bundle_path: bundlePath,
    flat_png_path: null,
    bundle_modified_at: createdAt,
    bundle_format_version: 2,
    bundle_edits_version: 3,
    width_px: 20,
    height_px: 15,
    device_pixel_ratio: 1,
    byte_size: source.length,
    sha256: sha,
    has_alpha: true
  });
  insertImportedLayerTreeForCapture(captureId, document.layers);
  addUserTag(captureId, document.tags[0]!);
  acceptDescription(captureId, document.description!);
  writePortableBundleCarrier(captureId, document);
  mocks.db!
    .prepare(
      "UPDATE captures SET edits_version = 3, bundle_edits_version = 3 WHERE id = ?"
    )
    .run(captureId);
  return { bundlePath, document, manifest, rootId, sourceId, source };
}

describe("imported v2 ordinary repack", () => {
  test("preserves history, full metadata, AI carriers, sources, and layer payloads", async () => {
    const captureId = "repackforeign001";
    const createdAt = "2026-08-23T14:00:00.000Z";
    const source = await sharp({
      create: { width: 40, height: 30, channels: 4, background: "#336699ff" }
    })
      .png()
      .toBuffer();
    const layerPayload = await sharp({
      create: { width: 5, height: 4, channels: 4, background: "#ff8a1fcc" }
    })
      .png()
      .toBuffer();
    const historySource = await sharp({
      create: { width: 7, height: 6, channels: 4, background: "#00aa44ff" }
    })
      .png()
      .toBuffer();
    const pastedSource = await sharp({
      create: { width: 8, height: 5, channels: 4, background: "#cc5522ff" }
    })
      .png()
      .toBuffer();
    const sha = createHash("sha256").update(source).digest("hex");
    const historySha = createHash("sha256").update(historySource).digest("hex");
    const pastedSha = createHash("sha256").update(pastedSource).digest("hex");
    const fullDescription = `Portable ${"description ".repeat(220)}`.slice(0, 2_600);
    const rootId = "repackroot000001";
    const sourceId = "repacksource0001";
    const historyId = "repackhistory001";
    const pastedId = "repackpaste00001";
    const supersededId = "repackold0000001";
    const replacementId = "repacknew0000001";
    const document: BundleDocumentV2 = {
      document_format_version: 1,
      edits_version: 9,
      layers: [
        {
          id: rootId,
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
          id: sourceId,
          parent_id: rootId,
          kind: "raster",
          source_ref: { kind: "embedded", sha256: sha },
          natural_width_px: 40,
          natural_height_px: 30,
          name: "Renamed base",
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          z_index: 0,
          source: "user",
          ai_run_id: "foreign-run",
          applied_at: createdAt,
          rejected_at: null,
          superseded_by: null,
          created_at: createdAt
        },
        {
          id: pastedId,
          parent_id: rootId,
          kind: "raster",
          source_ref: { kind: "embedded", sha256: pastedSha },
          natural_width_px: 8,
          natural_height_px: 5,
          name: "Pasted image",
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 5, 5],
          z_index: 500,
          source: "user",
          ai_run_id: null,
          applied_at: createdAt,
          rejected_at: null,
          superseded_by: null,
          created_at: createdAt
        },
        {
          id: historyId,
          parent_id: rootId,
          kind: "raster",
          source_ref: { kind: "embedded", sha256: historySha },
          natural_width_px: 7,
          natural_height_px: 6,
          name: "Rejected historical source",
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          z_index: 1000,
          source: "user",
          ai_run_id: "foreign-run",
          applied_at: createdAt,
          rejected_at: "2026-08-23T14:01:00.000Z",
          superseded_by: null,
          created_at: createdAt
        },
        {
          id: supersededId,
          parent_id: rootId,
          kind: "vector",
          shape: {
            kind: "shape",
            rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
            color: "#ff8a1f"
          },
          name: "Superseded history",
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          z_index: 2000,
          source: "user",
          ai_run_id: "foreign-run",
          applied_at: createdAt,
          rejected_at: null,
          superseded_by: replacementId,
          created_at: createdAt
        },
        {
          id: replacementId,
          parent_id: rootId,
          kind: "effect",
          effect: { type: "highlight", tint_hex: "#ffff00", opacity: 0.3 },
          clip_rect: { x: 1, y: 2, w: 10, h: 8 },
          name: "Replacement",
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          z_index: 3000,
          source: "user",
          ai_run_id: "foreign-run",
          applied_at: createdAt,
          rejected_at: null,
          superseded_by: null,
          created_at: createdAt
        }
      ],
      tags: ["Portable", "portable", "History"],
      description: fullDescription,
      ai_runs: [
        {
          id: "foreign-run",
          kind: "describe",
          created_at: createdAt
        }
      ]
    };
    const manifest: BundleManifestV2 = {
      bundle_format_version: 2,
      capture_id: captureId,
      canvas_dimensions: { width_px: 40, height_px: 30 },
      paired_png_filename: "portable-roundtrip.png",
      created_at: createdAt,
      bundle_modified_at: createdAt
    };
    const portableMetadata: PortableBundleMetadata = {
      version: 1,
      manifest: { portable_origin: { device: "foreign-device" } },
      document: { portable_workspace: { mode: "future" } },
      layers: {
        [supersededId]: {
          portable_history: { reason: "kept" },
          shape: { portable_shape_hint: "opaque-v2" }
        }
      },
      aiRuns: {
        "foreign-run": { portable_model_hint: "future-model" }
      }
    };
    const bundlePath = join(workDir, "portable-roundtrip.pwrsnap");
    mocks.compositePath = join(workDir, "composite.png");
    await fs.writeFile(mocks.compositePath, source);
    const { packBundleV2, repackCaptureNow } = await import(
      "../../persistence/bundle-store"
    );
    await fs.writeFile(
      bundlePath,
      await packBundleV2({
        manifest,
        document,
        portableMetadata,
        sources: new Map([
          [sha, source],
          [pastedSha, pastedSource],
          [historySha, historySource]
        ]),
        layerBytes: new Map([
          [historyId, layerPayload],
          [supersededId, layerPayload]
        ])
      })
    );

    const { insertCapture } = await import("../../persistence/captures-repo");
    const { insertImportedLayerTreeForCapture } = await import(
      "../../persistence/layers-repo"
    );
    const { acceptDescription, addUserTag } = await import(
      "../../persistence/enrichment-repo"
    );
    const { writePortableBundleCarrier } = await import(
      "../../persistence/bundle-carrier-repo"
    );
    insertCapture({
      id: captureId,
      kind: "image",
      captured_at: createdAt,
      source_app_bundle_id: null,
      source_app_name: null,
      legacy_src_path: null,
      bundle_path: bundlePath,
      flat_png_path: null,
      bundle_modified_at: createdAt,
      bundle_format_version: 2,
      bundle_edits_version: 9,
      width_px: 40,
      height_px: 30,
      device_pixel_ratio: 1,
      byte_size: source.length,
      sha256: sha,
      has_alpha: true
    });
    insertImportedLayerTreeForCapture(captureId, document.layers);
    for (const tag of document.tags) addUserTag(captureId, tag);
    acceptDescription(captureId, fullDescription.slice(0, 2_000));
    writePortableBundleCarrier(captureId, document, portableMetadata);
    mocks.db!
      .prepare(
        "UPDATE captures SET edits_version = 10, bundle_edits_version = 9 WHERE id = ?"
      )
      .run(captureId);
    mocks.db!
      .prepare("UPDATE layers SET name = 'Edited after import' WHERE id = ?")
      .run(sourceId);

    await repackCaptureNow(captureId);

    const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
    const repacked = await validatePwrsnapBundleBytes(await fs.readFile(bundlePath));
    expect(repacked.document.layers.map((layer) => layer.id)).toEqual(
      document.layers.map((layer) => layer.id)
    );
    expect(repacked.document.layers.find((layer) => layer.id === historyId)).toMatchObject({
      rejected_at: "2026-08-23T14:01:00.000Z"
    });
    expect(repacked.document.layers.find((layer) => layer.id === sourceId)).toMatchObject({
      name: "Edited after import"
    });
    expect(repacked.document.layers.find((layer) => layer.id === supersededId)).toMatchObject({
      superseded_by: replacementId
    });
    expect(repacked.document.tags).toEqual(["Portable", "portable", "History"]);
    expect(repacked.document.description).toBe(fullDescription);
    expect(repacked.document.ai_runs).toEqual(document.ai_runs);
    expect(repacked.portableMetadata).toEqual(portableMetadata);
    expect(repacked.layerBytes.get(historyId)).toEqual(layerPayload);
    expect(repacked.layerBytes.get(supersededId)).toEqual(layerPayload);
    expect(repacked.sources.get(sha)).toEqual(source);
    expect(repacked.sources.get(pastedSha)).toEqual(pastedSource);
    expect(repacked.sources.get(historySha)).toEqual(historySource);
    expect(repacked.baseSourceSha256).toBe(sha);
    const { listLayerTree } = await import("../../persistence/layers-repo");
    expect(listLayerTree(captureId).map((layer) => layer.id).sort()).toEqual(
      [rootId, sourceId, pastedId, replacementId].sort()
    );
  }, 15_000);

  test("does not overwrite a bundle when rejected raster history has no recoverable source", async () => {
    const captureId = "repackmissing001";
    const createdAt = "2026-08-23T15:00:00.000Z";
    const source = await sharp({
      create: { width: 40, height: 30, channels: 4, background: "#446688ff" }
    })
      .png()
      .toBuffer();
    const sourceSha = createHash("sha256").update(source).digest("hex");
    const missingSha = createHash("sha256").update("missing history").digest("hex");
    const rootId = "abortroot0000001";
    const sourceId = "abortsource00001";
    const historyId = "aborthistory0001";
    const allLayers: BundleDocumentV2["layers"] = [
      {
        id: rootId,
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
        id: sourceId,
        parent_id: rootId,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: sourceSha },
        natural_width_px: 40,
        natural_height_px: 30,
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
        id: historyId,
        parent_id: rootId,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: missingSha },
        natural_width_px: 10,
        natural_height_px: 10,
        name: "Rejected raster history",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 1_000,
        source: "user",
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: "2026-08-23T15:01:00.000Z",
        superseded_by: null,
        created_at: createdAt
      }
    ];
    const oldDocument: BundleDocumentV2 = {
      document_format_version: 1,
      edits_version: 4,
      layers: allLayers.slice(0, 2),
      tags: [],
      description: null,
      ai_runs: []
    };
    const manifest: BundleManifestV2 = {
      bundle_format_version: 2,
      capture_id: captureId,
      canvas_dimensions: { width_px: 40, height_px: 30 },
      paired_png_filename: "missing-history.png",
      created_at: createdAt,
      bundle_modified_at: createdAt
    };
    const bundlePath = join(workDir, "missing-history.pwrsnap");
    mocks.compositePath = join(workDir, "missing-history-composite.png");
    await fs.writeFile(mocks.compositePath, source);
    const { packBundleV2, repackCaptureNow } = await import(
      "../../persistence/bundle-store"
    );
    const originalBytes = await packBundleV2({
      manifest,
      document: oldDocument,
      sources: new Map([[sourceSha, source]]),
      layerBytes: new Map()
    });
    await fs.writeFile(bundlePath, originalBytes);

    const { insertCapture, getCaptureById } = await import(
      "../../persistence/captures-repo"
    );
    const { insertImportedLayerTreeForCapture } = await import(
      "../../persistence/layers-repo"
    );
    insertCapture({
      id: captureId,
      kind: "image",
      captured_at: createdAt,
      source_app_bundle_id: null,
      source_app_name: null,
      legacy_src_path: null,
      bundle_path: bundlePath,
      flat_png_path: null,
      bundle_modified_at: createdAt,
      bundle_format_version: 2,
      bundle_edits_version: 4,
      width_px: 40,
      height_px: 30,
      device_pixel_ratio: 1,
      byte_size: source.length,
      sha256: sourceSha,
      has_alpha: true
    });
    insertImportedLayerTreeForCapture(captureId, allLayers);
    mocks.db!
      .prepare("UPDATE captures SET edits_version = 5 WHERE id = ?")
      .run(captureId);

    await expect(repackCaptureNow(captureId)).rejects.toThrow();
    await expect(fs.readFile(bundlePath)).resolves.toEqual(originalBytes);
    expect(getCaptureById(captureId)?.bundle_edits_version).toBe(4);

    const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
    await expect(validatePwrsnapBundleBytes(await fs.readFile(bundlePath))).resolves.toMatchObject({
      document: { layers: expect.arrayContaining([expect.objectContaining({ id: sourceId })]) }
    });
  });

  test("uses current DB tags and description instead of stale installed-bundle values", async () => {
    const captureId = "currentmeta00001";
    const fixture = await seedMinimalRepack(captureId);
    const { acceptDescription, addUserTag } = await import(
      "../../persistence/enrichment-repo"
    );
    acceptDescription(captureId, "Edited in the library");
    addUserTag(captureId, "Current");
    mocks.db!
      .prepare("UPDATE captures SET edits_version = edits_version + 1 WHERE id = ?")
      .run(captureId);

    const { repackCaptureNow } = await import("../../persistence/bundle-store");
    await repackCaptureNow(captureId);

    const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
    const repacked = await validatePwrsnapBundleBytes(await fs.readFile(fixture.bundlePath));
    expect(repacked.document.description).toBe("Edited in the library");
    expect(repacked.document.tags).toEqual(["Current", "Original"]);
    expect(mocks.accessSuccesses).toContain(fixture.bundlePath);
  });

  test.runIf(process.platform !== "win32")(
    "reports a verified internal read denial before path-free error translation",
    async () => {
      const captureId = "repackdenied0001";
      const fixture = await seedMinimalRepack(captureId);
      const originalBytes = await fs.readFile(fixture.bundlePath);
      __setVerifiedFileBeforeOpenHookForTest(async () => {
        await fs.chmod(fixture.bundlePath, 0o000);
      });

      const { repackCaptureNow } = await import("../../persistence/bundle-store");
      try {
        await expect(repackCaptureNow(captureId)).rejects.toThrow();
      } finally {
        __setVerifiedFileBeforeOpenHookForTest(null);
        await fs.chmod(fixture.bundlePath, 0o600);
      }

      expect(mocks.accessFailures).toEqual([
        {
          path: fixture.bundlePath,
          cause: expect.objectContaining({ code: "EACCES" })
        }
      ]);
      expect(mocks.accessSuccesses).not.toContain(fixture.bundlePath);
      expect(await fs.readFile(fixture.bundlePath)).toEqual(originalBytes);
    }
  );

  test("retries when an edit lands during compose and checkpoints the matching projection", async () => {
    const captureId = "repackrace000001";
    const fixture = await seedMinimalRepack(captureId);
    mocks.onCompose = () => {
      mocks.onCompose = null;
      mocks.db!
        .prepare("UPDATE layers SET name = 'Edit during compose' WHERE id = ?")
        .run(fixture.sourceId);
      mocks.db!
        .prepare("UPDATE captures SET edits_version = edits_version + 1 WHERE id = ?")
        .run(captureId);
    };

    const { repackCaptureNow } = await import("../../persistence/bundle-store");
    await repackCaptureNow(captureId);

    expect(mocks.composeCalls).toBe(2);
    const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
    const repacked = await validatePwrsnapBundleBytes(await fs.readFile(fixture.bundlePath));
    expect(repacked.document.edits_version).toBe(4);
    expect(repacked.document.layers.find((layer) => layer.id === fixture.sourceId)?.name)
      .toBe("Edit during compose");
    expect(
      mocks.db!
        .prepare("SELECT edits_version, bundle_edits_version FROM captures WHERE id = ?")
        .get(captureId)
    ).toEqual({ edits_version: 4, bundle_edits_version: 4 });
  });

  test("a missing referenced source makes repack non-destructive", async () => {
    const captureId = "failedpack000001";
    const fixture = await seedMinimalRepack(captureId);
    const originalBytes = await fs.readFile(fixture.bundlePath);
    const { insertLayer } = await import("../../persistence/layers-repo");
    insertLayer({
      captureId,
      node: {
        id: "missingsrc000001",
        parent_id: fixture.rootId,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: "0".repeat(64) },
        natural_width_px: 2,
        natural_height_px: 2,
        name: "Missing source",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 1000,
        source: "user",
        ai_run_id: null,
        applied_at: fixture.manifest.created_at,
        rejected_at: null,
        superseded_by: null,
        created_at: fixture.manifest.created_at
      }
    });
    const before = mocks.db!
      .prepare("SELECT edits_version, bundle_edits_version FROM captures WHERE id = ?")
      .get(captureId);

    const { repackCaptureNow } = await import("../../persistence/bundle-store");
    await expect(repackCaptureNow(captureId)).rejects.toThrow();

    expect(await fs.readFile(fixture.bundlePath)).toEqual(originalBytes);
    expect(
      mocks.db!
        .prepare("SELECT edits_version, bundle_edits_version FROM captures WHERE id = ?")
        .get(captureId)
    ).toEqual(before);
  });

  test("an unparseable durable layer fails closed instead of being omitted", async () => {
    const captureId = "futurelayer00001";
    const fixture = await seedMinimalRepack(captureId);
    const originalBytes = await fs.readFile(fixture.bundlePath);
    mocks.db!
      .prepare("UPDATE layers SET data = '{\"future_kind\":true}' WHERE id = ?")
      .run(fixture.sourceId);
    mocks.db!
      .prepare("UPDATE captures SET edits_version = edits_version + 1 WHERE id = ?")
      .run(captureId);

    const { repackCaptureNow } = await import("../../persistence/bundle-store");
    await expect(repackCaptureNow(captureId)).rejects.toThrow(
      /durable layer history contains a row this build cannot parse/u
    );
    expect(await fs.readFile(fixture.bundlePath)).toEqual(originalBytes);
    expect(
      mocks.db!
        .prepare("SELECT edits_version, bundle_edits_version FROM captures WHERE id = ?")
        .get(captureId)
    ).toEqual({ edits_version: 4, bundle_edits_version: 3 });
  });
});
