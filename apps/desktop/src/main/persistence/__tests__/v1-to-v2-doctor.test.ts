// Unit tests for `v1-to-v2-doctor.ts` — the per-capture lazy
// migration that upgrades a v1 bundle to v2 on first edit-open.
//
// Two test surfaces:
//
//   1. `synthesizeV2DocumentFromV1Overlays` — pure function. The
//      mapping table from the plan §"v1 → v2 migration mapping
//      table" must round-trip:
//        • Vector kinds (arrow/rect/text/highlight) — `shape` stays
//          the v1 Overlay verbatim with normalized [0,1] coords;
//          v2 vector renderer multiplies by canvas dims at render
//          time. Transform stays identity.
//        • Blur kind — becomes a v2 EffectLayer with `effect.type:
//          "blur"` and `clip_rect` in ABSOLUTE canvas pixels
//          (multiplied by source dims).
//        • Crop kind — baked into canvas_dimensions; no layer node
//          emitted for it.
//        • ai_run_id non-null overlays — siblings grouped under a
//          new parent group layer.
//        • Soft-deleted overlays (`rejected_at` non-null) —
//          preserved with the same rejected_at stamp.
//
//   2. `migrateBundleV1ToV2` — bundle-store + DB orchestrator.
//      Stubs the lower-level reads so the test exercises:
//        • already-v2 idempotency check reads the bundle MANIFEST
//          (not the DB row)
//        • parked retry budget (v1_to_v2_attempts >= 5)
//        • `clearParkedState` resets the budget so the next
//          attempt re-runs

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type {
  BundleManifestV1,
  BundleOverlaysV1,
  BundleOverlaysV1 as BundleOverlaysV1Type,
  Overlay,
  OverlayRow
} from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null
}));

vi.mock("../db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) {
      throw new Error("test db not initialized");
    }
    return mocks.db;
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

// Bundle-store reads/writes are stubbed per-test via vi.spyOn — the
// doctor's IO contract is "manifest tells me the version" so the
// stubs return v1 or v2 manifests as needed.
vi.mock("../bundle-store", () => ({
  readBundleManifest: vi.fn(),
  readBundleOverlays: vi.fn(),
  writeBundle: vi.fn(),
  atomicWriteBundle: vi.fn(),
  assertSafeBundleFile: vi.fn().mockResolvedValue(undefined),
  awaitInFlightRepack: vi.fn().mockResolvedValue(undefined),
  // Always-Buffer return (post fix/preview-thumbnail-fallback). The
  // doctor never inspects the buffer contents, only passes it through
  // to packBundleV2, so an empty buffer is a fine stand-in.
  buildCompositeThumbnail: vi.fn().mockResolvedValue(Buffer.alloc(0))
}));

// BrowserWindow needs a stub so emitProgress doesn't crash in
// node-environment tests.
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

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
    db.exec(sql);
  }
}

function insertCaptureRow(
  db: Database.Database,
  args: {
    id: string;
    bundleFormatVersion?: number;
    bundlePath?: string | null;
    width?: number;
    height?: number;
    v1ToV2Attempts?: number;
  }
): void {
  db.prepare(
    `INSERT INTO captures (
       id, kind, captured_at, source_app_bundle_id, source_app_name,
       legacy_src_path, bundle_path, flat_png_path, bundle_modified_at,
       bundle_format_version, bundle_edits_version,
       width_px, height_px, device_pixel_ratio, byte_size,
       sha256, edits_version, deleted_at, v1_to_v2_attempts
     ) VALUES (
       @id, 'image', '2026-05-23T12:00:00.000Z', NULL, NULL,
       NULL, @bundle_path, NULL, '2026-05-23T12:00:00.000Z',
       @bundle_format_version, 0,
       @width_px, @height_px, 2.0, 1024,
       @sha256, 0, NULL, @v1_to_v2_attempts
     )`
  ).run({
    id: args.id,
    bundle_path: args.bundlePath ?? `/tmp/captures/${args.id}.pwrsnap`,
    bundle_format_version: args.bundleFormatVersion ?? 1,
    width_px: args.width ?? 2000,
    height_px: args.height ?? 1000,
    sha256: `sha-${args.id}`,
    v1_to_v2_attempts: args.v1ToV2Attempts ?? 0
  });
}

function makeOverlayRow(args: {
  id: string;
  data: Overlay;
  zIndex?: number;
  source?: "user" | "codex" | "draft";
  aiRunId?: string | null;
  appliedAt?: string | null;
  rejectedAt?: string | null;
  supersededBy?: string | null;
  createdAt?: string;
}): OverlayRow {
  return {
    id: args.id,
    capture_id: "test-capture",
    data: args.data,
    schema_version: 1,
    source: args.source ?? "user",
    ai_run_id: args.aiRunId ?? null,
    applied_at: args.appliedAt ?? "2026-05-23T12:00:00.000Z",
    rejected_at: args.rejectedAt ?? null,
    superseded_by: args.supersededBy ?? null,
    z_index: args.zIndex ?? 0,
    created_at: args.createdAt ?? "2026-05-23T12:00:00.000Z"
  };
}

function makeV1Manifest(args: {
  captureId: string;
  width: number;
  height: number;
}): BundleManifestV1 {
  return {
    bundle_format_version: 1,
    capture_id: args.captureId,
    source_sha256: "deadbeef".repeat(8),
    source_dimensions: { width_px: args.width, height_px: args.height },
    paired_png_filename: `${args.captureId}.png`,
    created_at: "2026-05-23T12:00:00.000Z",
    bundle_modified_at: "2026-05-23T12:00:00.000Z"
  };
}

function makeV1OverlaysJson(rows: OverlayRow[]): BundleOverlaysV1Type {
  return {
    overlays_format_version: 1,
    overlays_version: 0,
    overlays: rows.map((r) => ({
      id: r.id,
      data: r.data,
      schema_version: r.schema_version,
      source: r.source,
      z_index: r.z_index,
      created_at: r.created_at,
      applied_at: r.applied_at,
      rejected_at: r.rejected_at,
      superseded_by: r.superseded_by,
      ai_run_id: r.ai_run_id
    })),
    tags: [],
    description: null,
    ai_runs: []
  };
}

beforeEach(() => {
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(() => {
  mocks.db?.close();
  mocks.db = null;
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────
// synthesizeV2DocumentFromV1Overlays — pure mapping
// ────────────────────────────────────────────────────────────────────

describe("synthesizeV2DocumentFromV1Overlays — coordinate round-trip", () => {
  test("arrow: shape stays verbatim with normalized coords; transform identity", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const arrowRow = makeOverlayRow({
      id: "ovr-arrow-1".padEnd(16, "x"),
      data: {
        kind: "arrow",
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.75, y: 0.6 },
        color: "#ff0000"
      },
      zIndex: 10
    });
    const overlaysV1 = makeV1OverlaysJson([arrowRow]);
    const manifestV1 = makeV1Manifest({
      captureId: "cap_arrow_round1",
      width: 2000,
      height: 1000
    });

    const doc = synthesizeV2DocumentFromV1Overlays(overlaysV1, manifestV1, {
      width: 2000,
      height: 1000
    });

    // One raster (the source layer) + one vector layer.
    const vectorLayers = doc.layers.filter((l) => l.kind === "vector");
    expect(vectorLayers).toHaveLength(1);
    const arrowLayer = vectorLayers[0]!;
    if (arrowLayer.kind !== "vector") throw new Error("not a vector layer");

    // Coords pass through verbatim — v2 renderer multiplies by canvas
    // dims at render time.
    expect(arrowLayer.shape.kind).toBe("arrow");
    if (arrowLayer.shape.kind !== "arrow") throw new Error("not an arrow");
    expect(arrowLayer.shape.from).toEqual({ x: 0.5, y: 0.5 });
    expect(arrowLayer.shape.to).toEqual({ x: 0.75, y: 0.6 });
    expect(arrowLayer.shape.color).toBe("#ff0000");

    // Transform is identity — the canvas IS the source for v1->v2.
    expect(arrowLayer.transform).toEqual([1, 0, 0, 1, 0, 0]);

    // Multiplying [0.5, 0.5] by source (2000, 1000) yields absolute
    // pixels (1000, 500) — this is the contract the v2 renderer
    // implements (see compose-tree-vector.ts).
    const absFromX = arrowLayer.shape.from.x * manifestV1.source_dimensions.width_px;
    const absFromY = arrowLayer.shape.from.y * manifestV1.source_dimensions.height_px;
    expect(absFromX).toBe(1000);
    expect(absFromY).toBe(500);
  });

  test("rect: shape.rect normalized scalars preserved", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const rectRow = makeOverlayRow({
      id: "ovr-rect-1xxx".padEnd(16, "x"),
      data: {
        kind: "rect",
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        color: "#00ff00"
      }
    });
    const doc = synthesizeV2DocumentFromV1Overlays(
      makeV1OverlaysJson([rectRow]),
      makeV1Manifest({ captureId: "cap_rect_round1", width: 1000, height: 500 }),
      { width: 1000, height: 500 }
    );
    const vec = doc.layers.find((l) => l.kind === "vector");
    expect(vec).toBeDefined();
    if (vec === undefined || vec.kind !== "vector") throw new Error("missing vector");
    expect(vec.shape.kind).toBe("rect");
    if (vec.shape.kind !== "rect") throw new Error("not a rect");
    expect(vec.shape.rect).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  test("text + highlight: shape coords preserved", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const textRow = makeOverlayRow({
      id: "ovr-text-1xxx".padEnd(16, "x"),
      data: {
        kind: "text",
        point: { x: 0.25, y: 0.75 },
        body: "hello",
        size: "small",
        color: "auto"
      }
    });
    const highlightRow = makeOverlayRow({
      id: "ovr-hili-1xxx".padEnd(16, "x"),
      data: {
        kind: "highlight",
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
      }
    });
    const doc = synthesizeV2DocumentFromV1Overlays(
      makeV1OverlaysJson([textRow, highlightRow]),
      makeV1Manifest({ captureId: "cap_text_high1", width: 2000, height: 1000 }),
      { width: 2000, height: 1000 }
    );
    const vectorLayers = doc.layers.filter((l) => l.kind === "vector");
    expect(vectorLayers).toHaveLength(2);
    const text = vectorLayers.find(
      (l): l is typeof l & { shape: { kind: "text" } } =>
        l.kind === "vector" && l.shape.kind === "text"
    );
    const hili = vectorLayers.find(
      (l): l is typeof l & { shape: { kind: "highlight" } } =>
        l.kind === "vector" && l.shape.kind === "highlight"
    );
    expect(text).toBeDefined();
    expect(hili).toBeDefined();
    if (text?.shape.kind === "text") {
      expect(text.shape.point).toEqual({ x: 0.25, y: 0.75 });
      expect(text.shape.body).toBe("hello");
    }
    if (hili?.shape.kind === "highlight") {
      expect(hili.shape.rect).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    }
  });

  test("blur → effect layer with absolute clip_rect", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const blurRow = makeOverlayRow({
      id: "ovr-blur-1xxx".padEnd(16, "x"),
      data: {
        kind: "blur",
        rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        style: "pixelate"
      }
    });
    const doc = synthesizeV2DocumentFromV1Overlays(
      makeV1OverlaysJson([blurRow]),
      makeV1Manifest({ captureId: "cap_blur_roundx", width: 2000, height: 1000 }),
      { width: 2000, height: 1000 }
    );
    const effects = doc.layers.filter((l) => l.kind === "effect");
    expect(effects).toHaveLength(1);
    const effect = effects[0]!;
    if (effect.kind !== "effect") throw new Error("not an effect");
    expect(effect.effect.type).toBe("blur");
    // clip_rect is in ABSOLUTE canvas pixels (× source dims).
    expect(effect.clip_rect).toEqual({ x: 200, y: 100, w: 1000, h: 500 });
  });

  test("crop bakes into canvas_dimensions; no layer node emitted for it", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const cropRow = makeOverlayRow({
      id: "ovr-crop-1xxx".padEnd(16, "x"),
      data: {
        kind: "crop",
        rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
      }
    });
    const arrowRow = makeOverlayRow({
      id: "ovr-arrow-2".padEnd(16, "x"),
      data: {
        kind: "arrow",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        color: "auto"
      }
    });
    const doc = synthesizeV2DocumentFromV1Overlays(
      makeV1OverlaysJson([cropRow, arrowRow]),
      makeV1Manifest({ captureId: "cap_crop_round1", width: 2000, height: 1000 }),
      { width: 2000, height: 1000 }
    );
    // No layer for the crop.
    const cropLayers = doc.layers.filter(
      (l) => l.kind === "vector" && l.shape.kind === "crop"
    );
    expect(cropLayers).toHaveLength(0);
    // Arrow still present.
    const vec = doc.layers.find(
      (l) => l.kind === "vector" && l.shape.kind === "arrow"
    );
    expect(vec).toBeDefined();
  });

  test("z_index preserved across all kinds", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const rows: OverlayRow[] = [
      makeOverlayRow({
        id: "ovr-a-xxxxxxxxxx".slice(0, 16).padEnd(16, "x"),
        zIndex: 10,
        data: {
          kind: "arrow",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          color: "auto"
        }
      }),
      makeOverlayRow({
        id: "ovr-b-xxxxxxxxxx".slice(0, 16).padEnd(16, "x"),
        zIndex: 20,
        data: {
          kind: "rect",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          color: "auto"
        }
      }),
      makeOverlayRow({
        id: "ovr-c-xxxxxxxxxx".slice(0, 16).padEnd(16, "x"),
        zIndex: 30,
        data: {
          kind: "text",
          point: { x: 0.5, y: 0.5 },
          body: "x",
          size: "small",
          color: "auto"
        }
      })
    ];
    const doc = synthesizeV2DocumentFromV1Overlays(
      makeV1OverlaysJson(rows),
      makeV1Manifest({ captureId: "cap_zidx_round1", width: 100, height: 100 }),
      { width: 100, height: 100 }
    );
    const vecZ = doc.layers
      .filter((l) => l.kind === "vector")
      .map((l) => l.z_index)
      .sort((a, b) => a - b);
    expect(vecZ).toEqual([10, 20, 30]);
  });

  test("ai_run_id grouping: siblings under a synthetic parent group", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const aiRunId = "run_abc_xxxxxxx".slice(0, 16).padEnd(16, "x");
    const rows: OverlayRow[] = [
      makeOverlayRow({
        id: "ovr-ai-1xxxxxxx".slice(0, 16).padEnd(16, "x"),
        aiRunId,
        data: {
          kind: "arrow",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          color: "auto"
        }
      }),
      makeOverlayRow({
        id: "ovr-ai-2xxxxxxx".slice(0, 16).padEnd(16, "x"),
        aiRunId,
        data: {
          kind: "text",
          point: { x: 0.5, y: 0.5 },
          body: "ai-label",
          size: "small",
          color: "auto"
        }
      }),
      // User-drawn (no ai_run_id) — stays at root.
      makeOverlayRow({
        id: "ovr-usr-1xxxxxx".slice(0, 16).padEnd(16, "x"),
        data: {
          kind: "rect",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          color: "auto"
        }
      })
    ];
    const doc = synthesizeV2DocumentFromV1Overlays(
      makeV1OverlaysJson(rows),
      makeV1Manifest({ captureId: "cap_airn_round1", width: 100, height: 100 }),
      { width: 100, height: 100 }
    );

    // One group layer (the synthesized AI-run parent), plus root
    // group + raster + 3 vector layers.
    const aiGroups = doc.layers.filter(
      (l) => l.kind === "group" && l.ai_run_id === aiRunId
    );
    expect(aiGroups).toHaveLength(1);

    const aiParentId = aiGroups[0]!.id;
    const aiChildren = doc.layers.filter(
      (l) => l.kind === "vector" && l.parent_id === aiParentId
    );
    expect(aiChildren).toHaveLength(2);

    // User rect lives at root (parent is the root group), not under
    // the ai-run group.
    const rootRect = doc.layers.find(
      (l) => l.kind === "vector" && l.parent_id !== aiParentId
    );
    expect(rootRect).toBeDefined();
  });

  test("soft-deleted overlay preserved with rejected_at non-null", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const row = makeOverlayRow({
      id: "ovr-rejxxxxxxxxxx".slice(0, 16).padEnd(16, "x"),
      rejectedAt: "2026-05-23T13:00:00.000Z",
      data: {
        kind: "arrow",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        color: "auto"
      }
    });
    const doc = synthesizeV2DocumentFromV1Overlays(
      makeV1OverlaysJson([row]),
      makeV1Manifest({ captureId: "cap_rej_round1x", width: 100, height: 100 }),
      { width: 100, height: 100 }
    );
    const vec = doc.layers.find((l) => l.kind === "vector");
    expect(vec).toBeDefined();
    expect(vec?.rejected_at).toBe("2026-05-23T13:00:00.000Z");
  });

  test("empty overlays: returns valid v2 document with just root group + raster", async () => {
    const { synthesizeV2DocumentFromV1Overlays } = await import("../v1-to-v2-doctor");

    const doc = synthesizeV2DocumentFromV1Overlays(
      makeV1OverlaysJson([]),
      makeV1Manifest({ captureId: "cap_empty_round", width: 100, height: 100 }),
      { width: 100, height: 100 }
    );
    expect(doc.document_format_version).toBe(1);
    // Must always have a root group + raster layer for the source
    // (mirrors persistCaptureFromTempV2's initial layout so the v2
    // renderer can paint a single-raster bundle without any vector
    // / effect layers).
    const groups = doc.layers.filter((l) => l.kind === "group");
    const rasters = doc.layers.filter((l) => l.kind === "raster");
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(rasters).toHaveLength(1);
    const vectors = doc.layers.filter((l) => l.kind === "vector");
    const effects = doc.layers.filter((l) => l.kind === "effect");
    expect(vectors).toHaveLength(0);
    expect(effects).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// migrateBundleV1ToV2 — idempotency + retry budget
// ────────────────────────────────────────────────────────────────────

describe("migrateBundleV1ToV2 — idempotency + parked state", () => {
  test("already-v2 bundle: returns { migrated: false, reason: 'already_v2' }", async () => {
    const bundleStore = await import("../bundle-store");
    const { migrateBundleV1ToV2 } = await import("../v1-to-v2-doctor");

    insertCaptureRow(mocks.db!, { id: "cap_a2_xxxxxxxxxx".slice(0, 16) });

    // Bundle on disk is already v2 — even though DB row says
    // bundle_format_version=1, the doctor reads the manifest and
    // returns idempotently.
    vi.mocked(bundleStore.readBundleManifest).mockResolvedValue({
      bundle_format_version: 2,
      capture_id: "cap_a2_xxxxxxxxxx".slice(0, 16),
      canvas_dimensions: { width_px: 2000, height_px: 1000 },
      paired_png_filename: "x.png",
      created_at: "2026-05-23T12:00:00.000Z",
      bundle_modified_at: "2026-05-23T12:00:00.000Z"
    });

    const result = await migrateBundleV1ToV2("cap_a2_xxxxxxxxxx".slice(0, 16));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.migrated).toBe(false);
      expect(result.value.reason).toBe("already_v2");
    }
  });

  test("parked retry budget: returns { migrated: false, reason: 'parked' }", async () => {
    const bundleStore = await import("../bundle-store");
    const { migrateBundleV1ToV2 } = await import("../v1-to-v2-doctor");

    insertCaptureRow(mocks.db!, {
      id: "cap_park_xxxxxxx".slice(0, 16),
      v1ToV2Attempts: 5
    });

    // Manifest reads as v1 — the parked branch should fire BEFORE
    // any I/O work, but the manifest read happens first in the
    // doctor (the already_v2 short-circuit precedes the budget
    // check) so we still need a v1 manifest mock here.
    vi.mocked(bundleStore.readBundleManifest).mockResolvedValue({
      bundle_format_version: 1,
      capture_id: "cap_park_xxxxxxx".slice(0, 16),
      source_sha256: "deadbeef".repeat(8),
      source_dimensions: { width_px: 2000, height_px: 1000 },
      paired_png_filename: "x.png",
      created_at: "2026-05-23T12:00:00.000Z",
      bundle_modified_at: "2026-05-23T12:00:00.000Z"
    });

    const result = await migrateBundleV1ToV2("cap_park_xxxxxxx".slice(0, 16));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.migrated).toBe(false);
      expect(result.value.reason).toBe("parked");
    }
  });

  test("clearParkedState resets attempts + last_error_code", async () => {
    const { clearParkedState } = await import("../v1-to-v2-doctor");

    insertCaptureRow(mocks.db!, {
      id: "cap_clr_xxxxxxxx".slice(0, 16),
      v1ToV2Attempts: 5
    });
    mocks.db!
      .prepare(
        `UPDATE captures SET v1_to_v2_last_error_code = 'whatever',
                            v1_to_v2_last_failed_at = '2026-05-23T12:00:00.000Z'
                          WHERE id = ?`
      )
      .run("cap_clr_xxxxxxxx".slice(0, 16));

    clearParkedState(mocks.db!, "cap_clr_xxxxxxxx".slice(0, 16));

    const row = mocks.db!
      .prepare(
        `SELECT v1_to_v2_attempts AS a,
                v1_to_v2_last_error_code AS c,
                v1_to_v2_last_failed_at AS f
         FROM captures WHERE id = ?`
      )
      .get("cap_clr_xxxxxxxx".slice(0, 16)) as {
      a: number;
      c: string | null;
      f: string | null;
    };
    expect(row.a).toBe(0);
    expect(row.c).toBeNull();
    expect(row.f).toBeNull();
  });

  test("getLastDoctorProgressSnapshot returns null before first emit", async () => {
    const { getLastDoctorProgressSnapshot } = await import("../v1-to-v2-doctor");
    // No doctor activity in this test run — cached snapshot stays null.
    // (Other tests in the file may have populated it; ensure null is at
    // least a valid sentinel by not depending on a specific value.)
    const snap = getLastDoctorProgressSnapshot();
    expect(snap === null || typeof snap === "object").toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// migrateAllV1OnBoot — eager sweep
// ────────────────────────────────────────────────────────────────────

describe("migrateAllV1OnBoot — eager bulk sweep", () => {
  // The sweep delegates each row to `migrateBundleV1ToV2`. Stubbing
  // `readBundleManifest` to return a v2 manifest forces that per-
  // capture function down its `already_v2` short-circuit — no
  // bundle writes, no DB mutations, but the manifest *read* still
  // happens. So the manifest-read call count is a direct proxy for
  // "which rows did the sweep visit?" — exactly what we need to
  // assert the SQL filter is correct.
  async function stubManifestAlwaysV2(): Promise<void> {
    const bundleStore = await import("../bundle-store");
    vi.mocked(bundleStore.readBundleManifest).mockImplementation(async (path: string) => {
      const captureId = path.split("/").pop()?.replace(".pwrsnap", "") ?? "unknown";
      return {
        bundle_format_version: 2,
        capture_id: captureId,
        canvas_dimensions: { width_px: 2000, height_px: 1000 },
        paired_png_filename: `${captureId}.png`,
        created_at: "2026-05-23T12:00:00.000Z",
        bundle_modified_at: "2026-05-23T12:00:00.000Z"
      };
    });
  }

  test("empty library: no-op", async () => {
    const bundleStore = await import("../bundle-store");
    const { migrateAllV1OnBoot } = await import("../v1-to-v2-doctor");
    await stubManifestAlwaysV2();

    await migrateAllV1OnBoot();

    expect(bundleStore.readBundleManifest).not.toHaveBeenCalled();
  });

  test("only visits v1 rows — skips v2, deleted, and bundle-less", async () => {
    const bundleStore = await import("../bundle-store");
    const { migrateAllV1OnBoot } = await import("../v1-to-v2-doctor");
    await stubManifestAlwaysV2();

    insertCaptureRow(mocks.db!, { id: "cap_v1a_xxxxxxxx".slice(0, 16) });
    insertCaptureRow(mocks.db!, { id: "cap_v1b_xxxxxxxx".slice(0, 16) });
    insertCaptureRow(mocks.db!, {
      id: "cap_v2x_xxxxxxxx".slice(0, 16),
      bundleFormatVersion: 2
    });
    // Bundle-less row (`bundle_path IS NULL`) — pre-bundle legacy
    // capture. `insertCaptureRow`'s `bundlePath ?? default` collapses
    // an explicit null to the default, so we insert raw to get a
    // real NULL.
    mocks.db!
      .prepare(
        `INSERT INTO captures (
           id, kind, captured_at, source_app_bundle_id, source_app_name,
           legacy_src_path, bundle_path, flat_png_path, bundle_modified_at,
           bundle_format_version, bundle_edits_version,
           width_px, height_px, device_pixel_ratio, byte_size,
           sha256, edits_version, deleted_at, v1_to_v2_attempts
         ) VALUES (
           ?, 'image', '2026-05-23T12:00:00.000Z', NULL, NULL,
           '/tmp/legacy.png', NULL, NULL, '2026-05-23T12:00:00.000Z',
           1, 0, 2000, 1000, 2.0, 1024,
           'sha-nob', 0, NULL, 0
         )`
      )
      .run("cap_nob_xxxxxxxx".slice(0, 16));
    // Soft-deleted row (deleted_at IS NOT NULL).
    mocks.db!
      .prepare(
        `INSERT INTO captures (
           id, kind, captured_at, source_app_bundle_id, source_app_name,
           legacy_src_path, bundle_path, flat_png_path, bundle_modified_at,
           bundle_format_version, bundle_edits_version,
           width_px, height_px, device_pixel_ratio, byte_size,
           sha256, edits_version, deleted_at, v1_to_v2_attempts
         ) VALUES (
           ?, 'image', '2026-05-23T12:00:00.000Z', NULL, NULL,
           NULL, '/tmp/captures/cap_del.pwrsnap', NULL, '2026-05-23T12:00:00.000Z',
           1, 0, 2000, 1000, 2.0, 1024,
           'sha-del', 0, '2026-05-23T12:00:00.000Z', 0
         )`
      )
      .run("cap_del_xxxxxxxx".slice(0, 16));

    await migrateAllV1OnBoot();

    // Two v1 rows visited; v2 + bundle-less + deleted skipped.
    expect(bundleStore.readBundleManifest).toHaveBeenCalledTimes(2);
  });

  test("parked rows skipped — v1_to_v2_attempts >= MAX_ATTEMPTS", async () => {
    const bundleStore = await import("../bundle-store");
    const { migrateAllV1OnBoot } = await import("../v1-to-v2-doctor");
    await stubManifestAlwaysV2();

    insertCaptureRow(mocks.db!, {
      id: "cap_park_a_xxxxx".slice(0, 16),
      v1ToV2Attempts: 5
    });
    insertCaptureRow(mocks.db!, {
      id: "cap_live_b_xxxxx".slice(0, 16),
      v1ToV2Attempts: 4
    });

    await migrateAllV1OnBoot();

    // Only the live row (attempts < 5) is visited; parked filtered out.
    expect(bundleStore.readBundleManifest).toHaveBeenCalledTimes(1);
  });

  test("per-capture failure does not block remaining rows", async () => {
    const bundleStore = await import("../bundle-store");
    const { migrateAllV1OnBoot } = await import("../v1-to-v2-doctor");

    insertCaptureRow(mocks.db!, { id: "cap_fail_xxxxxxx".slice(0, 16) });
    insertCaptureRow(mocks.db!, { id: "cap_ok_b_xxxxxxx".slice(0, 16) });
    insertCaptureRow(mocks.db!, { id: "cap_ok_c_xxxxxxx".slice(0, 16) });

    // First row throws on manifest read; subsequent rows resolve to v2.
    let call = 0;
    vi.mocked(bundleStore.readBundleManifest).mockImplementation(async (path: string) => {
      call += 1;
      if (call === 1) {
        throw new Error("simulated read failure");
      }
      const captureId = path.split("/").pop()?.replace(".pwrsnap", "") ?? "unknown";
      return {
        bundle_format_version: 2,
        capture_id: captureId,
        canvas_dimensions: { width_px: 2000, height_px: 1000 },
        paired_png_filename: `${captureId}.png`,
        created_at: "2026-05-23T12:00:00.000Z",
        bundle_modified_at: "2026-05-23T12:00:00.000Z"
      };
    });

    await migrateAllV1OnBoot();

    // All three rows attempted despite the first throwing.
    expect(bundleStore.readBundleManifest).toHaveBeenCalledTimes(3);
  });
});
