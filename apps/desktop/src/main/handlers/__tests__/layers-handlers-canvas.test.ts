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
import type { BundleLayerNode } from "@pwrsnap/shared";

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
  });

  test("bundle:cropCanvas rolls back layer updates when a later crop write fails", async () => {
    const captureId = "cap_roll";
    seedV2Capture(captureId, 1000, 800, 1000, 800);
    const rasterId = `rstr_${captureId}`.padEnd(16, "x");
    nanoidState.queued.push(rasterId);

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
