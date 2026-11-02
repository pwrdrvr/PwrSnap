// composeV2 paints adjacent arrows, shapes and Draw strokes as ONE run —
// one SVG raster, one composite — instead of one full-canvas pass per
// layer. A page of handwriting is dozens of stroke layers, and every
// pass rewrites the whole accumulator, so per-layer cost was strokes ×
// canvas pixels. These tests pin that the run paints what the per-layer
// path painted, in the same order, and that a layer which cannot join a
// run still lands between the runs around it.
//
// `PWRSNAP_BAKE_BENCH=1` also runs the timing comparison at the bottom
// (skipped by default: it is a measurement, not a contract).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { BundleLayerNode, Overlay, OverlayRow } from "@pwrsnap/shared";

const cacheRoot = mkdtempSync(join(tmpdir(), "pwrsnap-vector-run-"));
let tree: BundleLayerNode[] = [];

vi.mock("../../persistence/layers-repo", () => ({ listLayerTree: () => tree }));
vi.mock("../../persistence/captures-repo", () => ({ getCaptureById: () => undefined }));
vi.mock("../../persistence/bundle-store", () => ({ readSourceForCapture: vi.fn() }));
vi.mock("../../persistence/paths", () => ({ getCacheRoot: () => cacheRoot }));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const { composeV2 } = await import("../compose-tree");
const { buildCompositeLayersForV2 } = await import("../compose-tree-vector");

afterAll(() => rmSync(cacheRoot, { recursive: true, force: true }));

let seq = 0;
function vectorNode(shape: Overlay): BundleLayerNode {
  seq += 1;
  return {
    id: `layer${String(seq).padStart(11, "0")}`.slice(0, 16),
    parent_id: null,
    name: shape.kind,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: seq,
    source: "user",
    ai_run_id: null,
    applied_at: null,
    rejected_at: null,
    superseded_by: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    kind: "vector",
    shape
  } as BundleLayerNode;
}

/** A wavy stroke across the canvas at height `y`. */
function stroke(tool: "pen" | "marker" | "airbrush", y: number, color: string): Overlay {
  const points = Array.from({ length: 40 }, (_, i) => ({
    x: 0.05 + (i / 39) * 0.9,
    y: y + Math.sin(i / 3) * 0.04
  }));
  return { kind: "stroke", tool, points, color, thickness: "large" };
}

/** The pre-batching path: every layer rasterized and composited alone. */
async function bakePerLayer(nodes: readonly BundleLayerNode[], w: number, h: number): Promise<Buffer> {
  const info = { width: w, height: h, channels: 4 as const };
  let acc = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .raw()
    .toBuffer();
  for (const node of nodes) {
    if (node.kind !== "vector") continue;
    const row = { id: node.id, data: node.shape } as OverlayRow;
    const layers = await buildCompositeLayersForV2(row, {
      renderWidthPx: w,
      renderHeightPx: h,
      canvasWidthPx: w,
      canvasHeightPx: h
    });
    acc = await sharp(acc, { raw: info }).composite(layers).ensureAlpha().raw().toBuffer();
  }
  return acc;
}

async function bakeComposeV2(w: number, h: number): Promise<Buffer> {
  const result = await composeV2({
    captureId: `cap-${seq}-${w}x${h}`,
    bundlePath: "",
    canvasWidthPx: w,
    canvasHeightPx: h,
    width: w,
    format: "png"
  });
  return sharp(readFileSync(result.cachePath)).ensureAlpha().raw().toBuffer();
}

function maxChannelDiff(a: Buffer, b: Buffer): number {
  expect(a.length).toBe(b.length);
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > max) max = d;
  }
  return max;
}

beforeEach(() => {
  tree = [];
});

describe("composeV2 vector runs", () => {
  test("a run of strokes, an arrow and a box paints what per-layer compositing painted", async () => {
    const W = 320;
    const H = 200;
    tree = [
      vectorNode(stroke("pen", 0.2, "#e03131")),
      vectorNode(stroke("marker", 0.3, "#f08c00")),
      vectorNode(stroke("airbrush", 0.45, "#1971c2")),
      vectorNode({
        kind: "arrow",
        from: { x: 0.1, y: 0.9 },
        to: { x: 0.8, y: 0.55 },
        color: "#2f9e44"
      } as Overlay),
      vectorNode({
        kind: "shape",
        shape: "rect",
        rect: { x: 0.3, y: 0.15, w: 0.4, h: 0.6 },
        color: "#9c36b5"
      } as Overlay),
      vectorNode(stroke("marker", 0.6, "#e03131"))
    ];
    const [batched, perLayer] = await Promise.all([bakeComposeV2(W, H), bakePerLayer(tree, W, H)]);
    // Rounding only: the stack is rounded to 8 bits once, where the
    // per-layer path rounded every layer — translucent marker and
    // airbrush bands accumulate a few levels of that.
    expect(maxChannelDiff(batched, perLayer)).toBeLessThanOrEqual(4);
  });

  test("a layer that cannot join a run still paints between the runs around it", async () => {
    const W = 200;
    const H = 120;
    // Opaque red stroke, then a legacy vector highlight (its own pass),
    // then an opaque blue stroke over both. If the highlight were
    // hoisted after the blue stroke, the blue would be tinted.
    tree = [
      vectorNode(stroke("pen", 0.5, "#ff0000")),
      vectorNode({
        kind: "highlight",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        color: "#ffff00",
        opacity: 0.5
      } as Overlay),
      vectorNode({
        kind: "shape",
        shape: "rect",
        rect: { x: 0.4, y: 0.2, w: 0.2, h: 0.6 },
        color: "#0000ff",
        filled: true
      } as Overlay)
    ];
    const batched = await bakeComposeV2(W, H);
    const center = ((H / 2) * W + W / 2) * 4;
    expect([...batched.subarray(center, center + 4)]).toEqual([0, 0, 255, 255]);
  });

  test("hidden layers, a group and a crop inside a run paint nothing", async () => {
    const W = 160;
    const H = 100;
    const hidden = { ...vectorNode(stroke("pen", 0.5, "#00ff00")), visible: false } as BundleLayerNode;
    const { shape: _shape, ...common } = vectorNode(stroke("pen", 0.5, "#00ff00")) as Extract<
      BundleLayerNode,
      { kind: "vector" }
    >;
    const group = { ...common, kind: "group", collapsed: false } as BundleLayerNode;
    const crop = vectorNode({ kind: "crop", rect: { x: 0, y: 0, w: 1, h: 1 } } as Overlay);
    tree = [
      vectorNode(stroke("pen", 0.3, "#ff0000")),
      hidden,
      group,
      crop,
      vectorNode(stroke("pen", 0.7, "#0000ff"))
    ];
    const batched = await bakeComposeV2(W, H);
    const perLayer = await bakePerLayer(
      tree.filter((n) => n.visible && n.kind === "vector" && n.shape.kind === "stroke"),
      W,
      H
    );
    expect(maxChannelDiff(batched, perLayer)).toBeLessThanOrEqual(4);
  });

  test.skipIf(process.env.PWRSNAP_BAKE_BENCH !== "1")(
    "timing: a handwritten page (150 short pen strokes) on a 4K canvas, batched vs per-layer",
    async () => {
      const W = 3840;
      const H = 2160;
      // Ten lines of fifteen word-sized squiggles, medium pen.
      tree = Array.from({ length: 150 }, (_, i) => {
        const x0 = 0.05 + (i % 15) * 0.06;
        const y0 = 0.08 + Math.floor(i / 15) * 0.09;
        const points = Array.from({ length: 30 }, (_, k) => ({
          x: x0 + (k / 29) * 0.045,
          y: y0 + Math.sin(k / 2) * 0.015
        }));
        return vectorNode({ kind: "stroke", tool: "pen", points, color: "#1c1c1c", thickness: "medium" });
      });
      const t0 = performance.now();
      await bakePerLayer(tree, W, H);
      const perLayerMs = performance.now() - t0;
      const t1 = performance.now();
      await bakeComposeV2(W, H);
      const batchedMs = performance.now() - t1;
      // eslint-disable-next-line no-console
      console.log(
        `[bake bench] 150 pen strokes @ ${W}x${H}: per-layer ${perLayerMs.toFixed(0)} ms, ` +
          `batched (incl. PNG encode) ${batchedMs.toFixed(0)} ms`
      );
    },
    600_000
  );
});
