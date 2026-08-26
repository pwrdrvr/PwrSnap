import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import * as fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { BundleDocumentV2, BundleManifestV2 } from "@pwrsnap/shared";
import type { PortableBundleMetadata } from "../../persistence/portable-bundle-metadata";
import type {
  VerifiedFileConsumer,
  VerifiedFileOptions
} from "../../security/verified-file";
import type {
  ImportStageArtifact,
  PublishedImportArtifact
} from "../pwrsnap-import-install";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  dataRoot: "",
  capturesRoot: "",
  fallbackCapturesRoot: "",
  publishFailure: "none" as "none" | "io" | "permission",
  cleanupFailure: "none" as "none" | "io" | "replace",
  verifiedBarrier: null as null | {
    consumeReturned(): void;
    waitForRelease: Promise<void>;
  }
}));

vi.mock("../../persistence/db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) throw new Error("test db not initialized");
    return mocks.db;
  }
}));

vi.mock("../../persistence/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../persistence/paths")>()),
  getDataRoot: () => mocks.dataRoot,
  getDurableCapturesRoots: () => [
    { kind: "override" as const, path: mocks.capturesRoot },
    ...(mocks.fallbackCapturesRoot.length > 0
      ? [{ kind: "home" as const, path: mocks.fallbackCapturesRoot }]
      : [])
  ]
}));

vi.mock("../../capture/capture-storage-gate", () => ({
  runWithCapturesDirFallback: async <T>(
    operation: (root: string) => Promise<T>
  ): Promise<T> => {
    try {
      return await operation(mocks.capturesRoot);
    } catch (cause) {
      if (
        mocks.fallbackCapturesRoot.length > 0 &&
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        ((cause as NodeJS.ErrnoException).code === "EACCES" ||
          (cause as NodeJS.ErrnoException).code === "EPERM")
      ) {
        return operation(mocks.fallbackCapturesRoot);
      }
      throw cause;
    }
  }
}));

vi.mock("../../security/verified-file", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../security/verified-file")
  >();
  return {
    ...actual,
    withVerifiedFileHandle: async <T>(
      filePath: string,
      options: VerifiedFileOptions,
      consume: VerifiedFileConsumer<T>
    ): Promise<T> => {
      const barrier = mocks.verifiedBarrier;
      if (barrier === null) {
        return actual.withVerifiedFileHandle(filePath, options, consume);
      }

      // Model the security wrapper boundary at its most important moment for
      // import: consume() has returned, but the wrapper has not completed its
      // final stability check or resolved to the caller yet.
      const handle: FileHandle = await fs.open(filePath, "r");
      try {
        const openedStat: BigIntStats = await handle.stat({ bigint: true });
        const value = await consume(handle, openedStat);
        barrier.consumeReturned();
        await barrier.waitForRelease;
        return value;
      } finally {
        await handle.close();
      }
    }
  };
});

vi.mock("../pwrsnap-import-install", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../pwrsnap-import-install")
  >();
  return {
    ...actual,
    publishStagedImport: async (
      stage: ImportStageArtifact,
      destinationPath: string
    ): Promise<PublishedImportArtifact> => {
      if (mocks.publishFailure === "io") {
        throw Object.assign(new Error("injected publish failure"), {
          code: "EIO",
          path: destinationPath
        });
      }
      if (
        mocks.publishFailure === "permission" &&
        destinationPath.startsWith(mocks.capturesRoot)
      ) {
        throw Object.assign(new Error("Documents denied"), {
          code: "EACCES",
          path: destinationPath
        });
      }
      return actual.publishStagedImport(stage, destinationPath);
    },
    removeImportArtifact: async (
      artifact: Parameters<typeof actual.removeImportArtifact>[0]
    ): ReturnType<typeof actual.removeImportArtifact> => {
      if (artifact !== null && "installMode" in artifact) {
        if (mocks.cleanupFailure === "io") {
          throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
        }
        if (mocks.cleanupFailure === "replace") {
          await fs.unlink(artifact.path);
          await fs.writeFile(artifact.path, "raced replacement");
        }
      }
      return actual.removeImportArtifact(artifact);
    }
  };
});

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
  workDir = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "pwrsnap-import-service-"))
  );
  mocks.dataRoot = join(workDir, "data");
  mocks.capturesRoot = join(workDir, "captures");
  mocks.fallbackCapturesRoot = "";
  mocks.publishFailure = "none";
  mocks.cleanupFailure = "none";
  mocks.verifiedBarrier = null;
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(async () => {
  const { __setPwrsnapImportSweepForTest } = await import(
    "../pwrsnap-import-service"
  );
  __setPwrsnapImportSweepForTest(null);
  mocks.db?.close();
  mocks.db = null;
  await fs.rm(workDir, { recursive: true, force: true });
});

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const needsFkOff = sql.startsWith("-- @no-foreign-keys");
    if (needsFkOff) db.pragma("foreign_keys = OFF");
    try {
      db.exec(sql);
    } finally {
      if (needsFkOff) db.pragma("foreign_keys = ON");
    }
  }
}

async function makeBundle(input: {
  captureId: string;
  filename: string;
  color: string;
  description: string;
  layerPrefix?: string;
  includePortableMetadata?: boolean;
}): Promise<{
  bytes: Buffer;
  document: BundleDocumentV2;
  baseSha: string;
  layerPayload: Buffer;
  vectorId: string;
  effectId: string;
  portableMetadata: PortableBundleMetadata;
}> {
  const base = await sharp({
    create: { width: 80, height: 50, channels: 4, background: input.color }
  })
    .png()
    .toBuffer();
  const pasted = await sharp({
    create: { width: 10, height: 12, channels: 4, background: "#00ff00ff" }
  })
    .png()
    .toBuffer();
  const baseSha = createHash("sha256").update(base).digest("hex");
  const pastedSha = createHash("sha256").update(pasted).digest("hex");
  const prefix = input.layerPrefix ?? "";
  const id = (name: string): string => `${prefix}${name}`.slice(0, 16).padEnd(16, "0");
  const createdAt = "2026-08-23T14:00:00.000Z";
  const rootId = id("root");
  const baseId = id("base");
  const pasteId = id("paste");
  const vectorId = id("vector");
  const effectId = id("effect");
  const layerPayload = await sharp({
    create: { width: 6, height: 4, channels: 4, background: "#123456cc" }
  })
    .png()
    .toBuffer();
  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 9,
    // Child-first order pins the import-only two-pass FK insertion.
    layers: [
      {
        id: baseId,
        parent_id: rootId,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: baseSha },
        natural_width_px: 80,
        natural_height_px: 50,
        name: "Source",
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
        id: pasteId,
        parent_id: rootId,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: pastedSha },
        natural_width_px: 10,
        natural_height_px: 12,
        name: "Pasted",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 5, 6],
        z_index: 1000,
        source: "user",
        ai_run_id: null,
        applied_at: createdAt,
        rejected_at: null,
        superseded_by: null,
        created_at: createdAt
      },
      {
        id: vectorId,
        parent_id: rootId,
        kind: "vector",
        shape: {
          kind: "shape",
          rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
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
        // Forward relation pins import's second FK pass and its rewrite.
        superseded_by: effectId,
        created_at: createdAt
      },
      {
        id: effectId,
        parent_id: rootId,
        kind: "effect",
        effect: { type: "highlight", tint_hex: "#ffff00", opacity: 0.3 },
        clip_rect: { x: 1, y: 2, w: 20, h: 10 },
        name: "Highlight",
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
      },
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
      }
    ],
    tags: ["Bug", "Windows"],
    description: input.description,
    ai_runs: [{ id: "foreign-run", kind: "describe", created_at: createdAt }]
  };
  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: input.captureId,
    canvas_dimensions: { width_px: 80, height_px: 50 },
    paired_png_filename: input.filename,
    created_at: createdAt,
    bundle_modified_at: createdAt
  };
  const portableMetadata: PortableBundleMetadata = input.includePortableMetadata === true
    ? {
        version: 1,
        manifest: {
          portable_origin: { device: "foreign-device" },
          canvas_dimensions: { portable_color_space: "display-p3" }
        },
        document: { portable_workspace: { grid: true } },
        layers: {
          [vectorId]: {
            portable_layer: { owner: "vector" },
            shape: { portable_shape_hint: "round-trip" }
          }
        },
        aiRuns: {
          "foreign-run": { portable_model_hint: "future-model" }
        }
      }
    : { version: 1, manifest: {}, document: {}, layers: {}, aiRuns: {} };
  const { packBundleV2 } = await import("../../persistence/bundle-store");
  const bytes = await packBundleV2({
    manifest,
    document,
    portableMetadata,
    sources: new Map([
      [baseSha, base],
      [pastedSha, pasted]
    ]),
    layerBytes: new Map([[vectorId, layerPayload]])
  });
  return {
    bytes,
    document,
    baseSha,
    layerPayload,
    vectorId,
    effectId,
    portableMetadata
  };
}

async function writeExternal(name: string, bytes: Buffer): Promise<string> {
  const externalDir = join(workDir, "external");
  await fs.mkdir(externalDir, { recursive: true });
  const path = join(externalDir, name);
  await fs.writeFile(path, bytes);
  return path;
}

describe("importPwrsnapBundle", () => {
  test("does not stage, publish, or write SQLite until verified-file resolves", async () => {
    const fixture = await makeBundle({
      captureId: "verifiedwait0001",
      filename: "verified-wait.png",
      color: "#112233ff",
      description: "Wait for the final stability check"
    });
    const sourcePath = await writeExternal("verified-wait.pwrsnap", fixture.bytes);
    let markConsumeReturned!: () => void;
    let releaseWrapper!: () => void;
    const consumeReturned = new Promise<void>((resolve) => {
      markConsumeReturned = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      releaseWrapper = resolve;
    });
    mocks.verifiedBarrier = {
      consumeReturned: markConsumeReturned,
      waitForRelease
    };
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");

    const pendingImport = importPwrsnapBundle(sourcePath);
    await consumeReturned;
    try {
      expect(
        (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as {
          count: number;
        }).count
      ).toBe(0);
      await expect(
        fs.lstat(join(mocks.dataRoot, "import-staging"))
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(mocks.capturesRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      releaseWrapper();
    }

    await expect(pendingImport).resolves.toMatchObject({ status: "imported" });
  }, 15_000);

  test("imports a foreign multi-source tree and metadata transactionally", async () => {
    const fullDescription = `Imported ${"description ".repeat(220)}`.slice(0, 2_500);
    const fixture = await makeBundle({
      captureId: "foreigncap000001",
      filename: "foreign.png",
      color: "#ff0000ff",
      description: fullDescription
    });
    const sourcePath = await writeExternal("foreign.pwrsnap", fixture.bytes);
    const before = await fs.stat(sourcePath);
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");

    const outcome = await importPwrsnapBundle(sourcePath);

    expect(outcome.status).toBe("imported");
    if (outcome.status !== "imported") throw new Error("expected import");
    expect(outcome.record).toMatchObject({
      id: "foreigncap000001",
      kind: "image",
      bundle_format_version: 2,
      edits_version: 9,
      bundle_edits_version: 9,
      width_px: 80,
      height_px: 50,
      // v2 does not serialize display identity/density. Match #512's
      // truthful unknown/imported fallback instead of inventing Retina detail.
      device_pixel_ratio: 1,
      sha256: fixture.baseSha
    });
    expect(outcome.record.bundle_path).not.toBe(sourcePath);
    await expect(fs.readFile(outcome.record.bundle_path!)).resolves.toEqual(fixture.bytes);
    await expect(fs.readFile(sourcePath)).resolves.toEqual(fixture.bytes);
    expect((await fs.stat(sourcePath)).mtimeMs).toBe(before.mtimeMs);

    const db = mocks.db!;
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM layers WHERE capture_id = ?").get(outcome.record.id) as { count: number }).count
    ).toBe(5);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM capture_tags WHERE capture_id = ?").get(outcome.record.id) as { count: number }).count
    ).toBe(2);
    expect(
      db.prepare("SELECT accepted_description FROM capture_enrichments WHERE capture_id = ?").get(outcome.record.id)
    ).toEqual({ accepted_description: fullDescription.slice(0, 2_000) });
    expect(
      db.prepare(
        `SELECT full_description, projected_description, ai_runs_json
           FROM capture_bundle_carriers WHERE capture_id = ?`
      ).get(outcome.record.id)
    ).toEqual({
      full_description: fullDescription,
      projected_description: fullDescription.slice(0, 2_000),
      ai_runs_json: JSON.stringify(fixture.document.ai_runs)
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM ai_runs WHERE capture_id = ?").get(outcome.record.id) as { count: number }).count
    ).toBe(0);
    expect(
      (db.prepare("SELECT COALESCE(SUM(count), 0) AS count FROM app_stats").get() as { count: number }).count
    ).toBe(1);
    const indexed =
      db.prepare(
        "SELECT description, accepted_tags FROM capture_search_fts WHERE capture_id = ?"
      ).get(outcome.record.id) as { description: string; accepted_tags: string };
    expect(indexed.description).toBe(fullDescription.slice(0, 2_000));
    expect(indexed.accepted_tags.split(" ").sort()).toEqual(["Bug", "Windows"]);
    const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
    const copied = await validatePwrsnapBundleBytes(
      await fs.readFile(outcome.record.bundle_path!)
    );
    expect(copied.document.description).toBe(fullDescription);
    expect(copied.document.ai_runs).toEqual(fixture.document.ai_runs);
  }, 15_000);

  test("opens an identical duplicate without DB or file writes", async () => {
    const fixture = await makeBundle({
      captureId: "duplicatecap0001",
      filename: "duplicate.png",
      color: "#ff0000ff",
      description: "Same"
    });
    const sourcePath = await writeExternal("duplicate.pwrsnap", fixture.bytes);
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");
    const first = await importPwrsnapBundle(sourcePath);
    if (first.status !== "imported") throw new Error("expected first import");
    const libraryBefore = await fs.readdir(mocks.capturesRoot);
    const rowsBefore = mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as {
      count: number;
    };

    const duplicate = await importPwrsnapBundle(sourcePath);

    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.record.id).toBe(first.record.id);
    expect(await fs.readdir(mocks.capturesRoot)).toEqual(libraryBefore);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count
    ).toBe(rowsBefore.count);
  });

  test.each([
    ["debounced repack is still pending", "dirtyduplicate01", 10],
    ["the latest repack failed", "dirtyduplicate02", 11]
  ])(
    "opens its owned logical bundle when %s",
    async (_scenario, captureId, editsVersion) => {
      const fixture = await makeBundle({
        captureId,
        filename: `${captureId}.png`,
        color: "#aa3300ff",
        description: "Owned stale checkpoint"
      });
      const sourcePath = await writeExternal(`${captureId}.pwrsnap`, fixture.bytes);
      const { importPwrsnapBundle } = await import("../pwrsnap-import-service");
      const first = await importPwrsnapBundle(sourcePath);
      if (first.status !== "imported") throw new Error("expected first import");
      mocks.db!
        .prepare("UPDATE captures SET edits_version = ? WHERE id = ?")
        .run(editsVersion, captureId);

      const reopened = await importPwrsnapBundle(first.record.bundle_path!);

      expect(reopened).toMatchObject({ status: "duplicate", record: { id: captureId } });
      expect(
        (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as {
          count: number;
        }).count
      ).toBe(1);
      expect(
        mocks.db!
          .prepare("SELECT edits_version, bundle_edits_version FROM captures WHERE id = ?")
          .get(captureId)
      ).toEqual({ edits_version: editsVersion, bundle_edits_version: 9 });
    }
  );

  test("imports a conflicting capture ID under one deterministic new ID and remaps colliding layers", async () => {
    const original = await makeBundle({
      captureId: "collisioncap0001",
      filename: "collision.png",
      color: "#ff0000ff",
      description: "Original"
    });
    const incoming = await makeBundle({
      captureId: "collisioncap0001",
      filename: "collision.png",
      color: "#0000ffff",
      description: "Incoming",
      includePortableMetadata: true
    });
    const originalPath = await writeExternal("original.pwrsnap", original.bytes);
    const incomingPath = await writeExternal("incoming.pwrsnap", incoming.bytes);
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");
    const first = await importPwrsnapBundle(originalPath);
    if (first.status !== "imported") throw new Error("expected original import");
    const originalOwnedBytes = await fs.readFile(first.record.bundle_path!);
    const incomingBefore = await fs.readFile(incomingPath);

    const conflict = await importPwrsnapBundle(incomingPath);

    expect(conflict.status).toBe("imported");
    if (conflict.status !== "imported") throw new Error("expected collision import");
    expect(conflict.record.id).not.toBe(first.record.id);
    expect(conflict.record.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(conflict.captureIdChanged).toBe(true);
    expect(conflict.remappedLayerCount).toBe(5);
    await expect(fs.readFile(first.record.bundle_path!)).resolves.toEqual(originalOwnedBytes);
    await expect(fs.readFile(incomingPath)).resolves.toEqual(incomingBefore);
    const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
    const copiedConflict = await validatePwrsnapBundleBytes(
      await fs.readFile(conflict.record.bundle_path!)
    );
    expect(copiedConflict.manifest.capture_id).toBe(conflict.record.id);
    expect(copiedConflict.document.tags).toEqual(incoming.document.tags);
    expect(copiedConflict.document.ai_runs).toEqual(incoming.document.ai_runs);
    const copiedVector = copiedConflict.document.layers.find(
      (layer) => layer.kind === "vector" && layer.name === "Box"
    );
    const copiedEffect = copiedConflict.document.layers.find(
      (layer) => layer.kind === "effect" && layer.name === "Highlight"
    );
    if (copiedVector === undefined || copiedEffect === undefined) {
      throw new Error("expected rewritten vector/effect layers");
    }
    expect(copiedVector.id).not.toBe(incoming.vectorId);
    expect(copiedVector.superseded_by).toBe(copiedEffect.id);
    expect(copiedConflict.layerBytes.get(copiedVector.id)).toEqual(incoming.layerPayload);
    expect(copiedConflict.layerBytes.has(incoming.vectorId)).toBe(false);
    expect(copiedConflict.portableMetadata).toEqual({
      ...incoming.portableMetadata,
      layers: {
        [copiedVector.id]: incoming.portableMetadata.layers[incoming.vectorId]
      }
    });
    const carrierMetadata = JSON.parse(
      (
        mocks.db!
          .prepare(
            "SELECT portable_metadata_json FROM capture_bundle_carriers WHERE capture_id = ?"
          )
          .get(conflict.record.id) as { portable_metadata_json: string }
      ).portable_metadata_json
    ) as unknown;
    expect(carrierMetadata).toEqual(copiedConflict.portableMetadata);
    const copiedVectorRow = mocks.db!.prepare(
      "SELECT id, parent_id, superseded_by FROM layers WHERE capture_id = ? AND kind = 'vector'"
    ).get(conflict.record.id) as {
      id: string;
      parent_id: string | null;
      superseded_by: string | null;
    };
    expect(copiedVectorRow).toEqual({
      id: copiedVector.id,
      parent_id: copiedVector.parent_id,
      superseded_by: copiedEffect.id
    });
    expect(copiedConflict.contentDigest).toBe(
      (await validatePwrsnapBundleBytes(incoming.bytes)).contentDigest
    );

    const repeated = await importPwrsnapBundle(incomingPath);
    expect(repeated.status).toBe("duplicate");
    expect(repeated.record.id).toBe(conflict.record.id);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count
    ).toBe(2);
  });

  test("remaps a global layer-ID collision even when the capture ID is unique", async () => {
    const firstFixture = await makeBundle({
      captureId: "layerowner000001",
      filename: "layer-owner.png",
      color: "#ff0000ff",
      description: "Owner"
    });
    const secondFixture = await makeBundle({
      captureId: "layerguest000001",
      filename: "layer-guest.png",
      color: "#0000ffff",
      description: "Guest"
    });
    const firstPath = await writeExternal("layer-owner.pwrsnap", firstFixture.bytes);
    const secondPath = await writeExternal("layer-guest.pwrsnap", secondFixture.bytes);
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");
    await importPwrsnapBundle(firstPath);

    const imported = await importPwrsnapBundle(secondPath);

    expect(imported.status).toBe("imported");
    if (imported.status !== "imported") throw new Error("expected import");
    expect(imported.record.id).toBe("layerguest000001");
    expect(imported.captureIdChanged).toBe(false);
    expect(imported.remappedLayerCount).toBe(5);
  });

  test("preserves an identical trashed capture and imports one new live copy", async () => {
    const fixture = await makeBundle({
      captureId: "trashedcap000001",
      filename: "trashed.png",
      color: "#aa00ffff",
      description: "Keep the trash row"
    });
    const sourcePath = await writeExternal("trashed.pwrsnap", fixture.bytes);
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");
    const { softDeleteCapture } = await import("../../persistence/captures-repo");
    const first = await importPwrsnapBundle(sourcePath);
    if (first.status !== "imported") throw new Error("expected first import");
    const firstOwnedBytes = await fs.readFile(first.record.bundle_path!);
    softDeleteCapture(first.record.id);

    const reopened = await importPwrsnapBundle(sourcePath);

    expect(reopened.status).toBe("imported");
    if (reopened.status !== "imported") throw new Error("expected live re-import");
    expect(reopened.record.id).not.toBe(first.record.id);
    expect(reopened.record.deleted_at).toBeNull();
    expect(
      mocks.db!.prepare("SELECT deleted_at FROM captures WHERE id = ?").get(first.record.id)
    ).toMatchObject({ deleted_at: expect.any(String) });
    await expect(fs.readFile(first.record.bundle_path!)).resolves.toEqual(firstOwnedBytes);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count
    ).toBe(2);
    expect(
      (mocks.db!.prepare("SELECT COALESCE(SUM(count), 0) AS count FROM app_stats").get() as { count: number }).count
    ).toBe(1);
  });

  test("uses a bounded portable fallback for a valid maximum-length paired filename", async () => {
    const filename = `${"界".repeat(83)}a.png`;
    expect(filename.length).toBeLessThanOrEqual(255);
    expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(255);
    const fixture = await makeBundle({
      captureId: "longfilename0001",
      filename,
      color: "#445566ff",
      description: "Portable long filename",
      includePortableMetadata: true
    });
    const sourcePath = await writeExternal("long-name.pwrsnap", fixture.bytes);
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");

    const imported = await importPwrsnapBundle(sourcePath);

    expect(imported.status).toBe("imported");
    if (imported.status !== "imported") throw new Error("expected import");
    const ownedName = basename(imported.record.bundle_path!);
    expect(ownedName.length).toBeLessThanOrEqual(255);
    expect(Buffer.byteLength(ownedName)).toBeLessThanOrEqual(255);
    const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
    const copied = await validatePwrsnapBundleBytes(
      await fs.readFile(imported.record.bundle_path!)
    );
    expect(copied.manifest.paired_png_filename).toBe(
      `${ownedName.slice(0, -".pwrsnap".length)}.png`
    );
    expect(copied.portableMetadata).toEqual(fixture.portableMetadata);
  });

  test("reconciles a power loss after final publication without duplicating the capture", async () => {
    const captureId = "crashrecover0001";
    const fixture = await makeBundle({
      captureId,
      filename: "crash-recover.png",
      color: "#224466ff",
      description: "Crash durable"
    });
    const sourcePath = await writeExternal("crash-recover.pwrsnap", fixture.bytes);
    const { validatePwrsnapBundleBytes } = await import("../pwrsnap-import-reader");
    const validated = await validatePwrsnapBundleBytes(fixture.bytes);
    const {
      closeImportArtifact,
      publishStagedImport,
      removeImportArtifact,
      writeImportStage
    } = await import("../pwrsnap-import-install");
    const {
      createPwrsnapImportIntent,
      markPwrsnapImportPublished
    } = await import("../pwrsnap-import-intent");
    const destination = join(mocks.capturesRoot, "crash-recover.pwrsnap");
    const stage = await writeImportStage(mocks.dataRoot, fixture.bytes);
    const intent = createPwrsnapImportIntent({
      captureId,
      bundlePath: destination,
      stage,
      contentDigest: validated.contentDigest,
      captureIdChanged: false,
      remappedLayerCount: 0
    });
    const published = await publishStagedImport(stage, destination);
    markPwrsnapImportPublished(intent.id, published.identity);
    await closeImportArtifact(stage);
    await removeImportArtifact(stage);
    const orphanStage = join(
      mocks.dataRoot,
      "import-staging",
      ".pwrsnap-import-11111111-2222-4333-8444-555555555555.tmp"
    );
    const innocentStage = join(mocks.dataRoot, "import-staging", "keep-me.txt");
    const orphanDestinationTemp = join(
      mocks.capturesRoot,
      ".orphan.pwrsnap.import-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp"
    );
    const innocentDestination = join(mocks.capturesRoot, ".keep-import.tmp");
    await fs.writeFile(orphanStage, "orphan stage");
    await fs.writeFile(innocentStage, "not an import temp");
    await fs.writeFile(orphanDestinationTemp, "orphan destination temp");
    await fs.writeFile(innocentDestination, "not an import temp");

    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count
    ).toBe(0);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM pwrsnap_import_intents").get() as { count: number }).count
    ).toBe(1);

    const {
      importPwrsnapBundle,
      reconcileAndSweepPwrsnapImportsOnBoot
    } = await import("../pwrsnap-import-service");
    await expect(reconcileAndSweepPwrsnapImportsOnBoot()).resolves.toEqual([captureId]);
    await expect(fs.lstat(orphanStage)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(orphanDestinationTemp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(innocentStage, "utf8")).resolves.toBe(
      "not an import temp"
    );
    await expect(fs.readFile(innocentDestination, "utf8")).resolves.toBe(
      "not an import temp"
    );
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM pwrsnap_import_intents").get() as { count: number }).count
    ).toBe(0);
    await expect(importPwrsnapBundle(sourcePath)).resolves.toMatchObject({
      status: "duplicate",
      record: { id: captureId }
    });
    expect((await fs.readdir(mocks.capturesRoot)).filter((name) => name.endsWith(".pwrsnap"))).toEqual([
      "crash-recover.pwrsnap"
    ]);
  });

  test("bounds a parked destination sweep so queued file-open imports continue", async () => {
    await fs.mkdir(join(mocks.dataRoot, "import-staging"), { recursive: true });
    await fs.mkdir(mocks.capturesRoot, { recursive: true });
    const fixture = await makeBundle({
      captureId: "boundedboot0001",
      filename: "bounded-boot.png",
      color: "#225588ff",
      description: "Bounded boot sweep"
    });
    const sourcePath = await writeExternal("bounded-boot.pwrsnap", fixture.bytes);
    let sweepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sweepStarted = resolve;
    });
    let releaseSweep!: () => void;
    const parked = new Promise<Dirent[]>((resolve) => {
      releaseSweep = () => resolve([]);
    });
    const {
      __setPwrsnapImportSweepForTest,
      importPwrsnapBundle,
      reconcileAndSweepPwrsnapImportsOnBoot
    } = await import("../pwrsnap-import-service");
    __setPwrsnapImportSweepForTest({
      waitMs: 10,
      readdir: async (directory) => {
        if (directory === mocks.capturesRoot) {
          sweepStarted();
          return parked;
        }
        return fs.readdir(directory, { withFileTypes: true });
      }
    });

    const boot = reconcileAndSweepPwrsnapImportsOnBoot();
    await started;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const imported = await Promise.race([
        importPwrsnapBundle(sourcePath),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("queued import remained blocked behind destination sweep")),
            1_000
          );
        })
      ]);
      expect(imported).toMatchObject({
        status: "imported",
        record: { id: "boundedboot0001" }
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      releaseSweep();
    }
    await expect(boot).resolves.toEqual([]);
  });

  test("retains the durable intent when rollback cleanup fails, then recovers", async () => {
    const captureId = "cleanuprecover01";
    const fixture = await makeBundle({
      captureId,
      filename: "cleanup-recover.png",
      color: "#335577ff",
      description: "Recover cleanup"
    });
    const sourcePath = await writeExternal("cleanup-recover.pwrsnap", fixture.bytes);
    mocks.db!.exec(`CREATE TRIGGER fail_cleanup_recovery_layer
      BEFORE INSERT ON layers
      WHEN NEW.capture_id = 'cleanuprecover01'
      BEGIN SELECT RAISE(ABORT, 'injected layer failure'); END`);
    mocks.cleanupFailure = "io";
    const { importPwrsnapBundle, reconcilePendingPwrsnapImports } = await import(
      "../pwrsnap-import-service"
    );

    await expect(importPwrsnapBundle(sourcePath)).rejects.toMatchObject({
      code: "database_import_failed"
    });
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM pwrsnap_import_intents").get() as { count: number }).count
    ).toBe(1);
    mocks.db!.exec("DROP TRIGGER fail_cleanup_recovery_layer");
    mocks.cleanupFailure = "none";

    await expect(reconcilePendingPwrsnapImports()).resolves.toEqual([
      captureId
    ]);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count
    ).toBe(1);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM pwrsnap_import_intents").get() as { count: number }).count
    ).toBe(0);
  });

  test("does not unlink or adopt a raced replacement during DB rollback", async () => {
    const fixture = await makeBundle({
      captureId: "rollbackrace001",
      filename: "rollback-race.png",
      color: "#446688ff",
      description: "Rollback race"
    });
    const sourcePath = await writeExternal("rollback-race.pwrsnap", fixture.bytes);
    mocks.db!.exec(`CREATE TRIGGER fail_rollback_race_layer
      BEFORE INSERT ON layers
      WHEN NEW.capture_id = 'rollbackrace001'
      BEGIN SELECT RAISE(ABORT, 'injected layer failure'); END`);
    mocks.cleanupFailure = "replace";
    const { importPwrsnapBundle, reconcilePendingPwrsnapImports } = await import(
      "../pwrsnap-import-service"
    );

    await expect(importPwrsnapBundle(sourcePath)).rejects.toMatchObject({
      code: "database_import_failed"
    });
    const intent = mocks.db!
      .prepare("SELECT bundle_path FROM pwrsnap_import_intents")
      .get() as { bundle_path: string };
    await expect(fs.readFile(intent.bundle_path, "utf8")).resolves.toBe(
      "raced replacement"
    );
    mocks.cleanupFailure = "none";
    await expect(reconcilePendingPwrsnapImports()).resolves.toEqual([]);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count
    ).toBe(0);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM pwrsnap_import_intents").get() as { count: number }).count
    ).toBe(1);
    await expect(fs.readFile(intent.bundle_path, "utf8")).resolves.toBe(
      "raced replacement"
    );
  });

  test("rolls back every DB row and removes only the owned file when layer insertion fails", async () => {
    const fixture = await makeBundle({
      captureId: "failcapture00001",
      filename: "failure.png",
      color: "#ff00ffff",
      description: "Must roll back",
      layerPrefix: "f"
    });
    const sourcePath = await writeExternal("failure.pwrsnap", fixture.bytes);
    const sourceBefore = await fs.readFile(sourcePath);
    mocks.db!.exec(`CREATE TRIGGER fail_import_layer
      BEFORE INSERT ON layers
      WHEN NEW.capture_id = 'failcapture00001'
      BEGIN SELECT RAISE(ABORT, 'injected layer failure'); END`);
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");

    await expect(importPwrsnapBundle(sourcePath)).rejects.toMatchObject({
      kind: "database",
      code: "database_import_failed"
    });

    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count
    ).toBe(0);
    expect(
      (mocks.db!.prepare("SELECT COALESCE(SUM(count), 0) AS count FROM app_stats").get() as { count: number }).count
    ).toBe(0);
    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM layers").get() as { count: number }).count
    ).toBe(0);
    expect(await fs.readdir(mocks.capturesRoot)).toEqual([]);
    await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
  });

  test("does not create DB rows when publishing the owned file fails", async () => {
    const fixture = await makeBundle({
      captureId: "filefailure00001",
      filename: "file-failure.png",
      color: "#ff00ffff",
      description: "File failure",
      layerPrefix: "q"
    });
    const sourcePath = await writeExternal("file-failure.pwrsnap", fixture.bytes);
    const sourceBefore = await fs.readFile(sourcePath);
    mocks.publishFailure = "io";
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");

    await expect(importPwrsnapBundle(sourcePath)).rejects.toBeDefined();

    expect(
      (mocks.db!.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count
    ).toBe(0);
    await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
    await expect(fs.readdir(join(mocks.dataRoot, "import-staging"))).resolves.toEqual([]);
    await expect(fs.lstat(mocks.capturesRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retries a raw Documents permission denial in the captures fallback root", async () => {
    const fixture = await makeBundle({
      captureId: "fallbackcap00001",
      filename: "fallback.png",
      color: "#778899ff",
      description: "TCC fallback"
    });
    const sourcePath = await writeExternal("fallback.pwrsnap", fixture.bytes);
    mocks.fallbackCapturesRoot = join(workDir, "home-captures");
    mocks.publishFailure = "permission";
    const { importPwrsnapBundle } = await import("../pwrsnap-import-service");

    const imported = await importPwrsnapBundle(sourcePath);

    expect(imported.status).toBe("imported");
    if (imported.status !== "imported") throw new Error("expected fallback import");
    expect(imported.record.bundle_path).toContain(mocks.fallbackCapturesRoot);
    await expect(fs.readFile(imported.record.bundle_path!)).resolves.toBeDefined();
    await expect(fs.lstat(mocks.capturesRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
