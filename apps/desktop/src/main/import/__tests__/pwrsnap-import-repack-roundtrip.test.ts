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

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  compositePath: ""
}));

vi.mock("../../persistence/db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) throw new Error("test db not initialized");
    return mocks.db;
  }
}));

vi.mock("../../render/compose-tree", () => ({
  composeV2: async () => ({ cachePath: mocks.compositePath })
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const MIGRATIONS_DIR = join(__dirname, "..", "..", "persistence", "migrations");
let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), "pwrsnap-import-repack-"));
  mocks.db = new Database(":memory:");
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
  const { cancelScheduledRepacks } = await import("../../persistence/bundle-store");
  cancelScheduledRepacks();
  mocks.db?.close();
  mocks.db = null;
  await fs.rm(workDir, { recursive: true, force: true });
});

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
    const sha = createHash("sha256").update(source).digest("hex");
    const fullDescription = `Portable ${"description ".repeat(220)}`.slice(0, 2_600);
    const rootId = "repackroot000001";
    const sourceId = "repacksource0001";
    const historyId = "repackhistory001";
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
          id: historyId,
          parent_id: rootId,
          kind: "vector",
          shape: {
            kind: "shape",
            rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
            color: "#ff8a1f"
          },
          name: "Rejected history",
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
        }
      ],
      tags: ["Portable", "History"],
      description: fullDescription,
      ai_runs: [{ id: "foreign-run", kind: "describe", created_at: createdAt }]
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
        [historyId]: {
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
        sources: new Map([[sha, source]]),
        layerBytes: new Map([[historyId, layerPayload]])
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
    expect(repacked.document.layers).toHaveLength(3);
    expect(repacked.document.layers.find((layer) => layer.id === historyId)).toMatchObject({
      rejected_at: "2026-08-23T14:01:00.000Z"
    });
    expect(repacked.document.layers.find((layer) => layer.id === sourceId)).toMatchObject({
      name: "Edited after import"
    });
    expect(repacked.document.tags).toEqual(["Portable", "History"]);
    expect(repacked.document.description).toBe(fullDescription);
    expect(repacked.document.ai_runs).toEqual(document.ai_runs);
    expect(repacked.portableMetadata).toEqual(portableMetadata);
    expect(repacked.layerBytes.get(historyId)).toEqual(layerPayload);
    expect(repacked.sources.get(sha)).toEqual(source);
  }, 15_000);
});
