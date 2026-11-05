// Rule: crop is a viewport. Source-space positions and immutable payloads
// survive any accepted crop sequence and its Undo/Reset, including rounding.
// Oracle: persisted SQLite rows and source-pixel coordinates; no production
// coordinate-transform helper is used to compute the expected positions.
import Database from "better-sqlite3";
import fc from "fast-check";
import { readFileSync, readdirSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { BundleLayerNode as LayerSchema, type BundleLayerNode } from "@pwrsnap/shared";

let db: Database.Database;
vi.mock("../../persistence/db", () => ({ getDb: () => db }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
const events: Array<{ width: number; height: number; layers: BundleLayerNode[] }> = [];
const repacks = vi.fn();
vi.mock("../broadcast-layers", () => ({
  broadcastLayersChanged: () => {
    const record = getCaptureById(captureId)!;
    events.push({ width: record.width_px, height: record.height_px, layers: listLayerTree(captureId) });
  }
}));
vi.mock("../../persistence/bundle-store", () => ({ scheduleRepack: () => repacks() }));
const { bus } = await import("../../command-bus");
const { getCaptureById } = await import("../../persistence/captures-repo");
const { insertLayerTreeForCapture, listLayerTree } = await import("../../persistence/layers-repo");
const { registerLayersHandlers } = await import("../layers-handlers");
registerLayersHandlers();
const migrations = new URL("../../persistence/migrations/", import.meta.url);
const migrationSql = readdirSync(migrations).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()
  .map((file) => readFileSync(new URL(file, migrations), "utf8")).join("\n");
const captureId = "crop_property";
type Rect = { x: number; y: number; w: number; h: number };
const id = (name: string) => name.padEnd(16, "_");
function seed(width: number, height: number, point: { x: number; y: number }): BundleLayerNode[] {
  db.prepare("INSERT INTO captures (id,kind,captured_at,bundle_format_version,width_px,height_px,device_pixel_ratio,byte_size,sha256,edits_version) VALUES (?, 'image', '2026-05-24T12:00:00.000Z', 2, ?, ?, 1, 0, ?, 0)")
    .run(captureId, width, height, "0".repeat(64));
  const common = {
    parent_id: id("root"), name: "property", visible: true, locked: false,
    opacity: 1, blend_mode: "normal", transform: [1, 0, 0, 1, 0, 0],
    z_index: 0, source: "user", ai_run_id: null, rejected_at: null,
    superseded_by: null, applied_at: "2026-05-24T12:00:00.000Z", created_at: "2026-05-24T12:00:00.000Z"
  };
  const nodes = [
    { ...common, id: id("root"), parent_id: null, kind: "group", collapsed: false },
    { ...common, id: id("source"), kind: "raster", source_ref: { kind: "embedded", sha256: "0".repeat(64) }, natural_width_px: width, natural_height_px: height },
    { ...common, id: id("pasted"), kind: "raster", transform: [1, 0, 0, 1, 123.125, 71.5], source_ref: { kind: "embedded", sha256: "1".repeat(64) }, natural_width_px: 100, natural_height_px: 80, z_index: 1000 },
    { ...common, id: id("vector"), kind: "vector", shape: { kind: "arrow", from: point, to: { x: 0.75, y: 0.8125 }, color: "auto" }, z_index: 2000 },
    { ...common, id: id("effect"), kind: "effect", effect: { type: "blur", radius_px: 10 }, clip_rect: { x: 35.125, y: 83.5, w: 147.25, h: 91.75 }, z_index: 3000 }
  ].map((node) => LayerSchema.parse(node));
  insertLayerTreeForCapture(captureId, nodes);
  return nodes;
}
function assertSourceSpace(original: BundleLayerNode[], width: number, height: number, offset: { x: number; y: number }, source: { width: number; height: number }): void {
  const layers = listLayerTree(captureId);
  const rows = new Map(layers.map((node) => [node.id, node]));
  for (const node of layers) expect(LayerSchema.safeParse(node).success).toBe(true);
  for (const before of original) {
    const after = rows.get(before.id)!;
    expect(after, "a viewport must preserve every non-marker layer ID").toBeDefined();
    if (before.kind === "raster" && after.kind === "raster") {
      expect({ ...after, transform: before.transform }).toEqual(before);
      expect(after.source_ref).toEqual(before.source_ref);
      expect(after.natural_width_px).toBe(before.natural_width_px);
      expect(after.natural_height_px).toBe(before.natural_height_px);
      expect(after.transform.slice(0, 4)).toEqual(before.transform.slice(0, 4));
      expect(after.transform[4] + offset.x).toBeCloseTo(before.transform[4], 7);
      expect(after.transform[5] + offset.y).toBeCloseTo(before.transform[5], 7);
    } else if (before.kind === "vector" && after.kind === "vector" && before.shape.kind === "arrow" && after.shape.kind === "arrow") {
      expect({ ...after, shape: before.shape }).toEqual(before);
      expect({ ...after.shape, from: before.shape.from, to: before.shape.to }).toEqual(before.shape);
      for (const key of ["from", "to"] as const) {
        expect(after.shape[key].x * width + offset.x).toBeCloseTo(before.shape[key].x * source.width, 7);
        expect(after.shape[key].y * height + offset.y).toBeCloseTo(before.shape[key].y * source.height, 7);
      }
      expect(after.shape.color).toBe(before.shape.color);
    } else if (before.kind === "effect" && after.kind === "effect") {
      expect({ ...after, clip_rect: before.clip_rect }).toEqual(before);
      expect(after.effect).toEqual(before.effect);
      expect(after.clip_rect!.w).toBe(before.clip_rect!.w);
      expect(after.clip_rect!.h).toBe(before.clip_rect!.h);
      expect(after.clip_rect!.x + offset.x).toBeCloseTo(before.clip_rect!.x, 7);
      expect(after.clip_rect!.y + offset.y).toBeCloseTo(before.clip_rect!.y, 7);
    } else expect(after).toEqual(before);
  }
}
const step = fc.record({
  widthPercent: fc.integer({ min: 50, max: 95 }), heightPercent: fc.integer({ min: 50, max: 95 }),
  // Edges are deliberately frequent: fractional origins + integer extents
  // produce the half-pixel slack an inverse must account for.
  x: fc.oneof(fc.constant(0), fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
  y: fc.oneof(fc.constant(0), fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true }))
});
const fixture = fc.record({
  width: fc.integer({ min: 513, max: 2049 }), height: fc.integer({ min: 513, max: 1537 }),
  point: fc.record({ x: fc.double({ min: -1, max: 2, noNaN: true }), y: fc.double({ min: -1, max: 2, noNaN: true }) }),
  steps: fc.array(step, { minLength: 1, maxLength: 4 }),
  reset: fc.boolean(), rollback: fc.boolean()
});

test("accepted crop sequences preserve source space, rollback atomically, and round-trip by Undo or Reset", async () => {
  // Each case checks up to eight full layer-tree transactions. Stay within
  // the default 5s timeout when other test files share the CI worker.
  await fc.assert(fc.asyncProperty(fixture, async (input) => {
    db = new Database(":memory:");
    db.exec(migrationSql);
    db.pragma("foreign_keys = ON");
    try {
      const original = seed(input.width, input.height, input.point);
      events.length = 0;
      repacks.mockClear();
      const offset = { x: 0, y: 0 };
      let width = input.width;
      let height = input.height;
      const history: Array<{ rect: Rect; width: number; height: number }> = [];
      async function crop(rect: Rect, restore = false): Promise<void> {
        const count = events.length;
        const result = await bus.dispatch("bundle:cropCanvas", { captureId, rect, ...(restore ? { restore: true as const } : {}) }, { principal: "ipc" });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        offset.x += rect.x * width;
        offset.y += rect.y * height;
        width = Math.round(rect.w * width);
        height = Math.round(rect.h * height);
        expect([result.value.widthPx, result.value.heightPx]).toEqual([width, height]);
        expect(events).toHaveLength(count + 1);
        expect(repacks).toHaveBeenCalledTimes(count + 1);
        expect(events.at(-1)).toEqual({ width, height, layers: result.value.layers });
        assertSourceSpace(original, width, height, offset, input);
      }
      for (const step of input.steps) {
        const rect = { x: (1 - step.widthPercent / 100) * step.x, y: (1 - step.heightPercent / 100) * step.y, w: step.widthPercent / 100, h: step.heightPercent / 100 };
        if (input.rollback && history.length === 0) {
          const before = { layers: db.prepare("SELECT * FROM layers ORDER BY id").all(), capture: getCaptureById(captureId) };
          // Dimensions are written last even when both origins are zero
          // (the effect correctly needs no UPDATE for such a crop).
          db.exec("CREATE TEMP TRIGGER fail_crop BEFORE UPDATE OF width_px, height_px ON captures WHEN NEW.id = '" + captureId + "' BEGIN SELECT RAISE(ABORT, 'generated crop rollback'); END");
          const result = await bus.dispatch("bundle:cropCanvas", { captureId, rect }, { principal: "ipc" });
          expect(result.ok).toBe(false);
          expect({ layers: db.prepare("SELECT * FROM layers ORDER BY id").all(), capture: getCaptureById(captureId) }).toEqual(before);
          expect(events).toHaveLength(0);
          expect(repacks).not.toHaveBeenCalled();
          db.exec("DROP TRIGGER fail_crop");
        }
        const before = { width, height };
        await crop(rect);
        history.push({ ...before, rect: { ...rect, w: width / before.width, h: height / before.height } });
      }
      if (input.reset) {
        // Direct source-pixel inverse, independent of cropRectFromCanvas and
        // inverseCropRect (which callers use in the example regression tests).
        await crop({ x: -offset.x / width, y: -offset.y / height, w: input.width / width, h: input.height / height }, true);
      } else {
        for (const previous of history.reverse()) {
          await crop({ x: -previous.rect.x / previous.rect.w, y: -previous.rect.y / previous.rect.h, w: previous.width / width, h: previous.height / height }, true);
        }
      }
      expect([width, height]).toEqual([input.width, input.height]);
      expect(offset.x).toBeCloseTo(0, 7);
      expect(offset.y).toBeCloseTo(0, 7);
      expect(listLayerTree(captureId)).toHaveLength(original.length);
    } finally { db.close(); }
  }), { numRuns: 50 });
});
