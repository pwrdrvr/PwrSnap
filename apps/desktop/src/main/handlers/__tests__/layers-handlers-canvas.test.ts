// Tests for `bundle:updateCanvasDimensions` — the v2-native crop
// handler. Covers the validation surface (positive ints, refuses v1,
// won't grow past the source raster) plus the happy path (writes
// new dims, returns the previous dims, bumps edits_version).
//
// Wires the test DB the same way ai-enrichment-repo.test.ts does:
// in-memory better-sqlite3 with the migrations applied, mocked
// `getDb()` so the production code reaches the test instance.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cropRectFromCanvas, inverseCropRect, BundleLayerNode as LayerSchema, type BundleLayerNode } from "@pwrsnap/shared";

let testDb: Database.Database;

vi.mock("../../persistence/db", () => ({
  getDb: () => testDb
}));

// Mock electron's BrowserWindow so broadcasts don't try to reach real
// renderers. The handler iterates getAllWindows() and calls
// webContents.send — return an empty array so the iteration no-ops.
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

// Mock the bundle store's scheduleRepack so we don't actually pack
// bundles in unit tests. We just observe that it's called.
const repackCalls: string[] = [];
const publications: { captureId: string; layers: BundleLayerNode[]; width: number }[] = [];
vi.mock("../broadcast-layers", () => ({
  broadcastLayersChanged: (captureId: string) => {
    const width = testDb.prepare<[string], { width_px: number }>("SELECT width_px FROM captures WHERE id = ?").get(captureId)!.width_px;
    publications.push({ captureId, layers: listLayerTree(captureId), width });
  }
}));
vi.mock("../../persistence/bundle-store", () => ({
  scheduleRepack: (captureId: string): void => {
    repackCalls.push(captureId);
  }
}));

const { nanoidState } = vi.hoisted(() => ({
  nanoidState: { queued: [] as string[], counter: 0 }
}));
vi.mock("nanoid", () => ({
  nanoid: (size = 16): string => {
    const queued = nanoidState.queued.shift();
    if (queued !== undefined) return queued;
    nanoidState.counter += 1;
    return `crop_${nanoidState.counter}`.padEnd(size, "x").slice(0, size);
  }
}));

const { bus } = await import("../../command-bus");
const { registerLayersHandlers } = await import("../layers-handlers");
const { insertLayerTreeForCapture, listLayerTree } = await import("../../persistence/layers-repo");

registerLayersHandlers();

function applyAllMigrations(): void {
  const dir = new URL("../../persistence/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  // Toggle FKs OFF for migrations that ALTER TABLE captures via
  // rename-and-recreate (0007). Same dance as
  // ai-enrichment-repo.test.ts.
  testDb.pragma("foreign_keys = OFF");
  for (const file of files) {
    testDb.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  testDb.pragma("foreign_keys = ON");
}

function seedV2Capture(
  id: string,
  widthPx: number,
  heightPx: number,
  naturalWidthPx: number,
  naturalHeightPx: number
): void {
  testDb
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name,
        legacy_src_path, bundle_path, flat_png_path,
        bundle_modified_at, bundle_format_version, bundle_edits_version,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, edits_version, deleted_at
      ) VALUES (
        @id, 'image', '2026-05-24T12:00:00.000Z',
        NULL, NULL,
        NULL, @bundlePath, NULL,
        '2026-05-24T12:00:00.000Z', 2, 0,
        @width, @height, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({
      id,
      bundlePath: `/tmp/${id}.pwrsnap`,
      width: widthPx,
      height: heightPx,
      sha: `sha_${id}`
    });
  // Seed a root group + raster so the natural-dim cap has data to
  // read. Mirrors what persistCaptureFromTempV2 + v1-to-v2-doctor
  // both produce on real captures.
  const rootId = `root_${id}`.padEnd(16, "x");
  const rasterId = `rstr_${id}`.padEnd(16, "x");
  const now = new Date().toISOString();
  const nodes: BundleLayerNode[] = [
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
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now
    },
    {
      id: rasterId,
      parent_id: rootId,
      kind: "raster",
      source_ref: { kind: "embedded", sha256: "0".repeat(64) },
      natural_width_px: naturalWidthPx,
      natural_height_px: naturalHeightPx,
      name: "Source",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now
    }
  ];
  insertLayerTreeForCapture(id, nodes);
}

function seedV1Capture(id: string): void {
  testDb
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name,
        legacy_src_path, bundle_path, flat_png_path,
        bundle_modified_at, bundle_format_version, bundle_edits_version,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, edits_version, deleted_at
      ) VALUES (
        @id, 'image', '2026-05-24T12:00:00.000Z',
        NULL, NULL,
        NULL, NULL, NULL,
        NULL, 1, 0,
        1000, 1000, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, sha: `sha_${id}` });
}

describe("bundle:updateCanvasDimensions handler", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    testDb.pragma("foreign_keys = ON");
    applyAllMigrations();
    repackCalls.length = 0;
    publications.length = 0;
    nanoidState.queued.length = 0;
    nanoidState.counter = 0;
  });

  afterEach(() => {
    testDb.close();
  });

  test("happy path: writes new dims, returns previous, bumps edits_version", async () => {
    seedV2Capture("cap_a", 1920, 1080, 1920, 1080);
    // insertLayerTreeForCapture bumped edits_version when seeding;
    // snapshot it so we assert the handler's bump as a delta of +1.
    const before = testDb
      .prepare<[string], { edits_version: number }>(
        `SELECT edits_version FROM captures WHERE id = ?`
      )
      .get("cap_a");

    const result = await bus.dispatch(
      "bundle:updateCanvasDimensions",
      { captureId: "cap_a", widthPx: 960, heightPx: 540 },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual({
      previousWidthPx: 1920,
      previousHeightPx: 1080
    });

    const row = testDb
      .prepare<[string], { width_px: number; height_px: number; edits_version: number }>(
        `SELECT width_px, height_px, edits_version FROM captures WHERE id = ?`
      )
      .get("cap_a");
    expect(row?.width_px).toBe(960);
    expect(row?.height_px).toBe(540);
    expect(row?.edits_version).toBe((before?.edits_version ?? 0) + 1);
    expect(repackCalls).toEqual(["cap_a"]);
  });

  test("bundle:cropCanvas transforms layers and canvas in one command", async () => {
    seedV2Capture("cap_crop", 1000, 800, 1000, 800);

    const result = await bus.dispatch(
      "bundle:cropCanvas",
      {
        captureId: "cap_crop",
        rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
        source: "codex"
      },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toMatchObject({
      previousWidthPx: 1000,
      previousHeightPx: 800,
      widthPx: 500,
      heightPx: 400
    });

    const row = testDb
      .prepare<[string], { width_px: number; height_px: number }>(
        `SELECT width_px, height_px FROM captures WHERE id = ?`
      )
      .get("cap_crop");
    expect(row).toEqual({ width_px: 500, height_px: 400 });

    const layers = listLayerTree("cap_crop");
    const raster = layers.find((layer) => layer.kind === "raster");
    expect(raster?.transform).toEqual([1, 0, 0, 1, -100, -160]);
    const crop = layers.find((layer) => layer.kind === "vector" && layer.shape.kind === "crop");
    expect(crop).toMatchObject({
      name: "AI crop",
      source: "codex",
      shape: { kind: "crop", rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } }
    });
    expect(repackCalls).toEqual(["cap_crop"]);
    expect(publications).toEqual([{ captureId: "cap_crop", layers, width: 500 }]);
    expect(result.value.layers).toEqual(layers);
    expect(result.value.record.width_px).toBe(500);
  });

  test("bundle:cropCanvas rolls back layer updates when a later crop write fails", async () => {
    const captureId = "cap_roll";
    seedV2Capture(captureId, 1000, 800, 1000, 800);
    const rasterId = `rstr_${captureId}`.padEnd(16, "x");
    nanoidState.queued.push(rasterId);
    const beforeRows = testDb.prepare("SELECT * FROM layers ORDER BY id").all();
    const beforeCapture = testDb.prepare("SELECT * FROM captures").all();

    const result = await bus.dispatch(
      "bundle:cropCanvas",
      {
        captureId,
        rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
        source: "codex"
      },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);

    const row = testDb
      .prepare<[string], { width_px: number; height_px: number }>(
        `SELECT width_px, height_px FROM captures WHERE id = ?`
      )
      .get(captureId);
    expect(row).toEqual({ width_px: 1000, height_px: 800 });

    const layers = listLayerTree(captureId);
    const raster = layers.find((layer) => layer.kind === "raster");
    expect(raster?.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(layers.some((layer) => layer.kind === "vector" && layer.shape.kind === "crop")).toBe(
      false
    );
    expect(repackCalls).toEqual([]);
    expect(publications).toEqual([]);
    expect(testDb.prepare("SELECT * FROM layers ORDER BY id").all()).toEqual(beforeRows);
    expect(testDb.prepare("SELECT * FROM captures").all()).toEqual(beforeCapture);
  });

  test("atomic crop and its inverse preserve off-origin effects, outside vectors, source identity and z order", async () => {
    const captureId = "cap_rt";
    seedV2Capture(captureId, 1000, 800, 1000, 800);
    const original = listLayerTree(captureId);
    const base = original.find((l) => l.kind === "raster")!;
    const extra: BundleLayerNode[] = [
      { ...base, id: "text".padEnd(16, "x"), kind: "vector", z_index: 2000, shape: { kind: "text", point: { x: 0.95, y: 0.9 }, body: "outside", size: "small", color: "auto" } },
      { ...base, id: "blur".padEnd(16, "x"), kind: "effect", z_index: 3000, effect: { type: "blur", radius_px: 10 }, clip_rect: { x: 40, y: 80, w: 200, h: 120 } },
      { ...base, id: "highlight".padEnd(16, "x"), kind: "effect", z_index: 4000, effect: { type: "highlight", tint_hex: "#ff8a1f", opacity: 0.3, rotation: 0.2 }, clip_rect: { x: 140, y: 180, w: 200, h: 120 } }
    ];
    insertLayerTreeForCapture(captureId, extra);
    const before = listLayerTree(captureId);
    const forward = await bus.dispatch("bundle:cropCanvas", { captureId, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } }, { principal: "ipc" });
    expect(forward.ok).toBe(true);
    const cropped = listLayerTree(captureId);
    expect(cropped.find((l) => l.id === extra[0]!.id)).toMatchObject({ shape: { point: { x: 1.7, y: 1.4 } } });
    expect(cropped.find((l) => l.id === extra[1]!.id)).toMatchObject({ clip_rect: { x: -60, y: -80, w: 200, h: 120 } });
    // A second crop, its undo, redo, and undo must return to the first
    // viewport with every layer still at the same absolute position.
    const firstViewport = listLayerTree(captureId).filter((l) => !(l.kind === "vector" && l.shape.kind === "crop"));
    for (let cycle = 0; cycle < 2; cycle += 1) {
      expect((await bus.dispatch("bundle:cropCanvas", { captureId, rect: { x: 0.2, y: 0.1, w: 0.5, h: 0.5 } }, { principal: "ipc" })).ok).toBe(true);
      expect((await bus.dispatch("bundle:cropCanvas", { captureId, rect: { x: -0.4, y: -0.2, w: 2, h: 2 }, restore: true }, { principal: "ipc" })).ok).toBe(true);
      const viewport = listLayerTree(captureId);
      for (const node of firstViewport) {
        const actual = viewport.find((l) => l.id === node.id)!;
        if (actual.kind === "vector" && actual.shape.kind === "text" && node.kind === "vector" && node.shape.kind === "text") {
          expect(actual.shape.point.x).toBeCloseTo(node.shape.point.x);
          expect(actual.shape.point.y).toBeCloseTo(node.shape.point.y);
        }
        else
          expect(actual).toEqual(node);
      }
      expect(viewport.filter((l) => l.kind === "vector" && l.shape.kind === "crop")).toHaveLength(1);
    }
    const undone = await bus.dispatch("bundle:cropCanvas", { captureId, rect: { x: -0.2, y: -0.4, w: 2, h: 2 }, restore: true }, { principal: "ipc" });
    expect(undone.ok).toBe(true);
    const restored = listLayerTree(captureId);
    expect(restored).toHaveLength(before.length);
    for (const node of before) {
      const actual = restored.find((l) => l.id === node.id)!;
      if (actual.kind === "vector" && actual.shape.kind === "text" && node.kind === "vector" && node.shape.kind === "text") {
        expect(actual.shape.point.x).toBeCloseTo(node.shape.point.x);
        expect(actual.shape.point.y).toBeCloseTo(node.shape.point.y);
      }
      else
        expect(actual).toEqual(node);
    }
    expect(repackCalls).toHaveLength(6);
    expect(publications).toHaveLength(6);
    expect(publications.map((p) => p.width)).toEqual([500, 250, 500, 250, 500, 1000]);
    // Reset uses the cumulative raster viewport rather than just the last
    // crop marker. Exercise that route after two forward crops.
    for (let i = 0; i < 2; i += 1) {
      expect((await bus.dispatch("bundle:cropCanvas", { captureId, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } }, { principal: "ipc" })).ok).toBe(true);
    }
    const source = listLayerTree(captureId).find((l) => l.kind === "raster")!;
    if (source.kind !== "raster")
      throw new Error("missing source");
    const cumulative = cropRectFromCanvas({ canvasWidthPx: 250, canvasHeightPx: 200, sourceWidthPx: 1000, sourceHeightPx: 800, rasterTranslateXPx: source.transform[4], rasterTranslateYPx: source.transform[5] })!;
    const reset = await bus.dispatch("bundle:cropCanvas", { captureId, rect: inverseCropRect(cumulative)!, restore: true }, { principal: "ipc" });
    expect(reset.ok).toBe(true);
    const resetLayers = listLayerTree(captureId);
    expect(resetLayers).toHaveLength(before.length);
    for (const node of resetLayers)
      expect(LayerSchema.safeParse(node).success).toBe(true);
    for (const node of before) {
      const actual = resetLayers.find((l) => l.id === node.id)!;
      if (actual.kind === "vector" && actual.shape.kind === "text" && node.kind === "vector" && node.shape.kind === "text") {
        expect(actual.shape.point.x).toBeCloseTo(node.shape.point.x);
        expect(actual.shape.point.y).toBeCloseTo(node.shape.point.y);
      }
      else
        expect(actual).toEqual(node);
    }
  });

  test("rounded crop and inverse restore the original vector coordinates", async () => {
    const captureId = "cap_odd";
    seedV2Capture(captureId, 1001, 803, 1001, 803);
    const base = listLayerTree(captureId).find((l) => l.kind === "raster")!;
    const text: BundleLayerNode = { ...base, id: "odd_text".padEnd(16, "x"), kind: "vector", shape: { kind: "text", point: { x: 0.95, y: 0.9 }, body: "outside", size: "small", color: "auto" } };
    insertLayerTreeForCapture(captureId, [text]);
    const forward = await bus.dispatch("bundle:cropCanvas", { captureId, rect: { x: 0.15, y: 0.2, w: 0.333, h: 0.517 } }, { principal: "ipc" });
    if (!forward.ok)
      throw new Error("crop failed");
    const effective = { x: 0.15, y: 0.2, w: forward.value.widthPx / forward.value.previousWidthPx, h: forward.value.heightPx / forward.value.previousHeightPx };
    const reverse = await bus.dispatch("bundle:cropCanvas", { captureId, rect: inverseCropRect(effective)!, restore: true }, { principal: "ipc" });
    expect(reverse.ok).toBe(true);
    const actual = listLayerTree(captureId).find((l) => l.id === text.id)!;
    if (actual.kind !== "vector" || actual.shape.kind !== "text")
      throw new Error("missing text");
    expect(actual.shape.point.x).toBeCloseTo(0.95, 12);
    expect(actual.shape.point.y).toBeCloseTo(0.9, 12);
  });

  test.each([
    { mode: "undo", sourceWidth: 1001, sourceHeight: 803, y: 0.5 },
    { mode: "reset", sourceWidth: 1001, sourceHeight: 803, y: 0.5 },
    // Shrunk property counterexample: one right/top half-crop of 513×513.
    { mode: "undo", sourceWidth: 513, sourceHeight: 513, y: 0 },
    { mode: "reset", sourceWidth: 513, sourceHeight: 513, y: 0 }
  ])("odd-size $sourceWidth×$sourceHeight edge crop supports $mode with pixel-rounded extents", async ({ mode, sourceWidth, sourceHeight, y }) => {
    const captureId = "odd_edge";
    seedV2Capture(captureId, sourceWidth, sourceHeight, sourceWidth, sourceHeight);
    const before = listLayerTree(captureId);
    const base = before.find((layer) => layer.kind === "raster")!;
    insertLayerTreeForCapture(captureId, [
      { ...base, id: "edge_text".padEnd(16, "x"), kind: "vector", shape: { kind: "text", point: { x: 0.95, y: 0.9 }, body: "edge", size: "small", color: "auto" } },
      { ...base, id: "edge_blur".padEnd(16, "x"), kind: "effect", effect: { type: "blur", radius_px: 10 }, clip_rect: { x: 40, y: 80, w: 200, h: 120 } }
    ]);
    const original = listLayerTree(captureId);
    const rect = { x: 0.5, y, w: 0.5, h: 0.5 };
    const forward = await bus.dispatch("bundle:cropCanvas", { captureId, rect }, { principal: "ipc" });
    if (!forward.ok) throw new Error("edge crop failed");
    const halfWidth = Math.round(sourceWidth / 2);
    const halfHeight = Math.round(sourceHeight / 2);
    expect([forward.value.widthPx, forward.value.heightPx]).toEqual([halfWidth, halfHeight]);
    let width = forward.value.widthPx;
    let height = forward.value.heightPx;
    if (mode === "reset") {
      const second = await bus.dispatch("bundle:cropCanvas", { captureId, rect }, { principal: "ipc" });
      if (!second.ok) throw new Error("second edge crop failed");
      width = second.value.widthPx;
      height = second.value.heightPx;
    }
    const raster = listLayerTree(captureId).find((layer) => layer.kind === "raster")!;
    if (raster.kind !== "raster") throw new Error("missing raster");
    const cumulative = cropRectFromCanvas({ canvasWidthPx: width, canvasHeightPx: height, sourceWidthPx: sourceWidth, sourceHeightPx: sourceHeight, rasterTranslateXPx: raster.transform[4], rasterTranslateYPx: raster.transform[5] })!;
    const effective = { ...rect, w: halfWidth / sourceWidth, h: halfHeight / sourceHeight };
    const reverse = await bus.dispatch("bundle:cropCanvas", { captureId, rect: inverseCropRect(mode === "reset" ? cumulative : effective)!, restore: true }, { principal: "ipc" });
    expect(reverse.ok).toBe(true);
    if (!reverse.ok) throw new Error("edge restore failed");
    expect([reverse.value.widthPx, reverse.value.heightPx]).toEqual([sourceWidth, sourceHeight]);
    const restored = listLayerTree(captureId);
    for (const layer of restored) expect(LayerSchema.safeParse(layer).success).toBe(true);
    for (const layer of original) {
      const actual = restored.find((row) => row.id === layer.id)!;
      if (actual.kind === "vector" && actual.shape.kind === "text") {
        expect(actual.shape.point.x).toBeCloseTo(0.95, 12);
        expect(actual.shape.point.y).toBeCloseTo(0.9, 12);
      } else if (actual.kind === "raster" && layer.kind === "raster") {
        // Inverting odd fractional origins may leave floating-point noise;
        // source identity, metadata and the linear transform stay exact.
        expect({ ...actual, transform: layer.transform }).toEqual(layer);
        actual.transform.forEach((value, index) => expect(value).toBeCloseTo(layer.transform[index]!, 12));
      } else if (actual.kind === "effect" && layer.kind === "effect") {
        expect({ ...actual, clip_rect: layer.clip_rect }).toEqual(layer);
        expect(actual.clip_rect?.w).toBe(layer.clip_rect?.w);
        expect(actual.clip_rect?.h).toBe(layer.clip_rect?.h);
        expect(actual.clip_rect!.x).toBeCloseTo(layer.clip_rect!.x, 12);
        expect(actual.clip_rect!.y).toBeCloseTo(layer.clip_rect!.y, 12);
      } else expect(actual).toEqual(layer);
    }
    expect(restored).toHaveLength(original.length);
    expect(publications).toHaveLength(mode === "reset" ? 3 : 2);
    expect(repackCalls).toHaveLength(mode === "reset" ? 3 : 2);
  });

  test("restore refuses an authenticated MCP editor grant", async () => {
    seedV2Capture("cap_mcp", 500, 400, 1000, 800);
    bus.installLocalAgentAuthorizer(async () => ({ clientId: "fixture", capabilities: ["capture.edit"] }));
    try {
      const result = await bus.dispatch("bundle:cropCanvas", { captureId: "cap_mcp", rect: { x: 0, y: 0, w: 2, h: 2 }, restore: true }, { principal: "mcp", localAgent: { clientId: "fixture", capabilities: ["capture.edit"] } });
      expect(result).toMatchObject({ ok: false, error: { code: "restore_requires_ipc" } });
      expect(publications).toEqual([]);
      expect(repackCalls).toEqual([]);
    }
    finally {
      bus.uninstallLocalAgentAuthorizerForTests();
    }
  });

  test.each(["rpc", "bridge", "seeder"] as const)("restore refuses %s principals without changing or publishing state", async (principal) => {
    seedV2Capture("cap_scope", 500, 400, 1000, 800);
    const before = listLayerTree("cap_scope");
    const result = await bus.dispatch("bundle:cropCanvas", { captureId: "cap_scope", rect: { x: 0, y: 0, w: 2, h: 2 }, restore: true }, { principal });
    expect(result).toMatchObject({ ok: false, error: { code: "restore_requires_ipc" } });
    expect(listLayerTree("cap_scope")).toEqual(before);
    expect(publications).toEqual([]);
    expect(repackCalls).toEqual([]);
  });

  test.each([
    { rect: { x: -0.1, y: 0, w: 0.5, h: 0.5 } },
    { rect: { x: 0.8, y: 0, w: 0.5, h: 0.5 } },
    { rect: { x: 0, y: 0, w: 0, h: 1 } },
    { rect: { x: 0, y: 0, w: NaN, h: 1 } },
    { rect: { x: 0, y: Infinity, w: 1, h: 1 }, restore: true },
    { rect: { x: -2, y: 0, w: 2, h: 2 }, restore: true },
    { rect: { x: -0.1, y: 0, w: 1.0994999, h: 1 }, restore: true },
    { rect: { x: 0.1, y: 0, w: 2, h: 2 }, restore: true },
    { rect: { x: 0, y: 0, w: 1, h: 1 }, restore: "true" },
    { rect: { x: 0, y: 0, w: 1, h: 1 }, restore: false },
    { rect: { x: 0, y: 0, w: 1, h: 1 }, restore: null },
    { rect: { x: 0, y: 0, w: 0.01, h: 0.01 } },
    { rect: { x: 0, y: 0, w: 3, h: 3 }, restore: true }
  ])("invalid crop/restore %# leaves every row unchanged", async (input) => {
    seedV2Capture("cap_bad", 1000, 800, 1000, 800);
    const before = testDb.prepare("SELECT * FROM layers ORDER BY id").all();
    const captureBefore = testDb.prepare("SELECT * FROM captures").all();
    const result = await bus.dispatch("bundle:cropCanvas", { captureId: "cap_bad", ...input } as never, { principal: "ipc" });
    expect(result.ok).toBe(false);
    expect(testDb.prepare("SELECT * FROM layers ORDER BY id").all()).toEqual(before);
    expect(testDb.prepare("SELECT * FROM captures").all()).toEqual(captureBefore);
    expect(publications).toEqual([]);
    expect(repackCalls).toEqual([]);
  });

  test("cancelled bridge crop cannot mutate or publish", async () => {
    seedV2Capture("cap_cancel", 1000, 800, 1000, 800);
    const before = listLayerTree("cap_cancel");
    const result = bus.dispatch("bundle:cropCanvas", { captureId: "cap_cancel", rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } }, { principal: "bridge", cancellationKey: "cancel-crop" });
    bus.cancel("cancel-crop");
    expect((await result).ok).toBe(false);
    expect(listLayerTree("cap_cancel")).toEqual(before);
    expect(publications).toEqual([]);
  });

  test("refuses v1 captures (v1_capture_use_overlays_ipc)", async () => {
    seedV1Capture("cap_v1");

    const result = await bus.dispatch(
      "bundle:updateCanvasDimensions",
      { captureId: "cap_v1", widthPx: 100, heightPx: 100 },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("v1_capture_use_overlays_ipc");
  });

  test("refuses zero or negative dims", async () => {
    seedV2Capture("cap_b", 1920, 1080, 1920, 1080);

    for (const dims of [
      { widthPx: 0, heightPx: 100 },
      { widthPx: 100, heightPx: 0 },
      { widthPx: -5, heightPx: 100 },
      { widthPx: 100, heightPx: -5 }
    ]) {
      const result = await bus.dispatch(
        "bundle:updateCanvasDimensions",
        { captureId: "cap_b", ...dims },
        { principal: "ipc" }
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("invalid_canvas_dimensions");
    }
  });

  test("refuses non-integer dims", async () => {
    seedV2Capture("cap_c", 1920, 1080, 1920, 1080);

    const result = await bus.dispatch(
      "bundle:updateCanvasDimensions",
      { captureId: "cap_c", widthPx: 100.5, heightPx: 100 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_canvas_dimensions");
  });

  test("refuses dims exceeding source raster (canvas_exceeds_source)", async () => {
    // Natural raster is 1000x1000; current canvas already 800x800.
    // Asking for 1500x800 should fail — can't grow past source.
    seedV2Capture("cap_d", 800, 800, 1000, 1000);

    const result = await bus.dispatch(
      "bundle:updateCanvasDimensions",
      { captureId: "cap_d", widthPx: 1500, heightPx: 800 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("canvas_exceeds_source");
  });

  test("allows growing back UP TO source raster (undo a previous crop)", async () => {
    // Capture cropped from 1000x1000 to 500x500; user hits ⌘Z.
    // Should accept 1000x1000 since the raster supports it.
    seedV2Capture("cap_e", 500, 500, 1000, 1000);

    const result = await bus.dispatch(
      "bundle:updateCanvasDimensions",
      { captureId: "cap_e", widthPx: 1000, heightPx: 1000 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.previousWidthPx).toBe(500);
    expect(result.value.previousHeightPx).toBe(500);
  });

  test("not_found for missing capture id", async () => {
    const result = await bus.dispatch(
      "bundle:updateCanvasDimensions",
      { captureId: "does_not_exist", widthPx: 100, heightPx: 100 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("not_found");
  });
});
