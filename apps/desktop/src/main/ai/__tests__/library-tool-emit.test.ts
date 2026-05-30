// Emit-contract tests for the draw + effect tools. They build a
// BundleLayerNode and `safeParse` it before dispatching `layers:upsert`,
// so a drift between a tool's emitted shape and main's Overlay /
// EffectLayer schema would surface HERE rather than at runtime. (This is
// exactly the class that broke `draw_rect` when main renamed the `rect`
// Overlay to the polymorphic `shape` kind.)
//
// We mock the command bus to capture the `layer` payload the tool sends
// to `layers:upsert` (and to satisfy `library:byId` for the effect
// tools' canvas-dim lookup), then assert the captured layer parses.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BundleLayerNode } from "@pwrsnap/shared";

// `vi.hoisted` so the spy exists when the hoisted vi.mock factory runs.
// The bus lives at main/command-bus; from this test (ai/__tests__/) that
// is "../../command-bus" — the SAME resolved module the allowlist imports
// as "../command-bus" from ai/.
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../command-bus", () => ({
  bus: { dispatch: (...args: unknown[]) => dispatch(...args) }
}));

const { LIBRARY_TOOL_ALLOWLIST } = await import("../library-tool-allowlist");

function toolByName(name: string) {
  const tool = LIBRARY_TOOL_ALLOWLIST.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
}

/** The `layer` arg from the most recent `layers:upsert` dispatch. */
function lastUpsertedLayer(): Record<string, unknown> {
  const call = [...dispatch.mock.calls].reverse().find((c) => c[0] === "layers:upsert");
  if (call === undefined) throw new Error("layers:upsert was not dispatched");
  return (call[1] as { layer: Record<string, unknown> }).layer;
}

function lastUpdatedLayer(): Record<string, unknown> {
  const call = [...dispatch.mock.calls].reverse().find((c) => c[0] === "layers:update");
  if (call === undefined) throw new Error("layers:update was not dispatched");
  return (call[1] as { layer: Record<string, unknown> }).layer;
}

function lastCall(name: string): unknown[] {
  const call = [...dispatch.mock.calls].reverse().find((c) => c[0] === name);
  if (call === undefined) throw new Error(`${name} was not dispatched`);
  return call;
}

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockImplementation(async (name: string, req: { id?: string; layer?: unknown }) => {
    if (name === "layers:upsert") return { ok: true, value: req.layer };
    if (name === "layers:update") return { ok: true, value: req.layer };
    // Effect tools fetch canvas dims via library:byId to denormalize.
    if (name === "library:byId") {
      return { ok: true, value: { id: req.id, kind: "image", width_px: 1000, height_px: 800 } };
    }
    return { ok: true, value: {} };
  });
});

describe("draw_arrow emits the full arrow style surface", () => {
  it("passes thickness/end/stem settings through to the vector shape", async () => {
    const res = await toolByName("draw_arrow").dispatch(
      {
        capture_id: "cap1",
        from: { x: 0.1, y: 0.9 },
        to: { x: 0.7, y: 0.2 },
        color: "#0066cc",
        thickness: "x-large",
        end_style: "open-triangle",
        stem_style: "dashed",
        double_ended: true
      },
      { threadId: "t1" }
    );
    expect(res.ok).toBe(true);

    const layer = lastUpsertedLayer();
    expect(layer.kind).toBe("vector");
    const shape = layer.shape as Record<string, unknown>;
    expect(shape).toMatchObject({
      kind: "arrow",
      color: "#0066cc",
      thickness: "x-large",
      endStyle: "open-triangle",
      stemStyle: "dashed",
      doubleEnded: true
    });
    expect(BundleLayerNode.safeParse(layer).success).toBe(true);
  });
});

describe("draw shape tools emit a valid v2 ShapeOverlay layer", () => {
  const cases = [
    ["draw_rect", "rect"],
    ["draw_square", "square"],
    ["draw_circle", "circle"],
    ["draw_oval", "oval"],
    ["draw_parallelogram", "parallelogram"]
  ] as const;

  for (const [name, shapeKind] of cases) {
    it(`${name} → vector layer with shape.kind="shape", shape.shape="${shapeKind}"`, async () => {
      const res = await toolByName(name).dispatch(
        {
          capture_id: "cap1",
          rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
          color: "#ff0000",
          thickness: "large",
          filled: true
        },
        { threadId: "t1" }
      );
      // ok:true means the tool's internal BundleLayerNode.safeParse passed.
      expect(res.ok).toBe(true);

      const layer = lastUpsertedLayer();
      expect(layer.kind).toBe("vector");
      const shape = layer.shape as { kind: string; shape: string };
      expect(shape.kind).toBe("shape");
      expect(shape.shape).toBe(shapeKind);
      expect((layer.shape as { thickness?: string }).thickness).toBe("large");
      // And it round-trips the shared schema.
      expect(BundleLayerNode.safeParse(layer).success).toBe(true);
    });
  }
});

describe("draw_highlight emits the full highlight style surface", () => {
  it("passes blend and rotation through to the vector shape", async () => {
    const res = await toolByName("draw_highlight").dispatch(
      {
        capture_id: "cap1",
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
        color: "#facc15",
        opacity: 0.45,
        blend: "overlay",
        rotation: 0.25
      },
      { threadId: "t1" }
    );

    expect(res.ok).toBe(true);
    const layer = lastUpsertedLayer();
    expect(layer.kind).toBe("vector");
    expect(layer.shape).toMatchObject({
      kind: "highlight",
      blend: "overlay",
      rotation: 0.25
    });
    expect(BundleLayerNode.safeParse(layer).success).toBe(true);
  });
});

describe("blur tool exposes explicit effect modes", () => {
  it("mode=redact creates an opaque redaction effect", async () => {
    const res = await toolByName("blur").dispatch(
      {
        capture_id: "cap1",
        rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
        mode: "redact"
      },
      { threadId: "t1" }
    );

    expect(res.ok).toBe(true);
    const layer = lastUpsertedLayer();
    expect(layer.kind).toBe("effect");
    expect((layer.effect as { type: string; style: string; radius_px: number }).style).toBe("redact");
    expect((layer.effect as { type: string; style: string; radius_px: number }).radius_px).toBe(1);
    expect(BundleLayerNode.safeParse(layer).success).toBe(true);
  });
});

describe("update_layer edits existing layers in place", () => {
  it("uses layers:update, not delete+redraw, when changing arrow thickness", async () => {
    const now = new Date().toISOString();
    const existing = {
      id: "arrow_layer_0001",
      parent_id: null,
      kind: "vector",
      name: "AI arrow",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 1000,
      source: "codex",
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now,
      shape: {
        kind: "arrow",
        from: { x: 0.1, y: 0.9 },
        to: { x: 0.7, y: 0.2 },
        color: "auto"
      }
    };
    dispatch.mockImplementation(async (name: string, req: { id?: string; layer?: unknown }) => {
      if (name === "layers:list") return { ok: true, value: [existing] };
      if (name === "layers:update") return { ok: true, value: req.layer };
      if (name === "layers:upsert") return { ok: true, value: req.layer };
      if (name === "library:byId") {
        return { ok: true, value: { id: req.id, kind: "image", width_px: 1000, height_px: 800 } };
      }
      return { ok: true, value: {} };
    });

    const res = await toolByName("update_layer").dispatch(
      {
        capture_id: "cap1",
        layer_id: "arrow_layer_0001",
        thickness: "x-large"
      },
      { threadId: "t1" }
    );
    expect(res.ok).toBe(true);

    const updated = lastUpdatedLayer();
    expect(updated.id).toBe("arrow_layer_0001");
    expect((updated.shape as { thickness?: string }).thickness).toBe("x-large");
    expect(dispatch.mock.calls.some((call) => call[0] === "layers:delete")).toBe(false);
    expect(BundleLayerNode.safeParse(updated).success).toBe(true);
  });

  it("refuses to downgrade an opaque redaction to reversible pixelation", async () => {
    const now = new Date().toISOString();
    const existing = {
      id: "redaction_layer_1",
      parent_id: null,
      kind: "effect",
      name: "AI redaction",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 1000,
      source: "codex",
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now,
      effect: { type: "blur", radius_px: 1, style: "redact" },
      clip_rect: { x: 100, y: 80, w: 200, h: 80 }
    };
    dispatch.mockImplementation(async (name: string, req: { id?: string; layer?: unknown }) => {
      if (name === "layers:list") return { ok: true, value: [existing] };
      if (name === "layers:update") return { ok: true, value: req.layer };
      if (name === "library:byId") {
        return { ok: true, value: { id: req.id, kind: "image", width_px: 1000, height_px: 800 } };
      }
      return { ok: true, value: {} };
    });

    const res = await toolByName("update_layer").dispatch(
      {
        capture_id: "cap1",
        layer_id: "redaction_layer_1",
        pixelate: true
      },
      { threadId: "t1" }
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected redaction downgrade to be refused");
    expect(res.error).toContain("redaction");
    expect(dispatch.mock.calls.some((call) => call[0] === "layers:update")).toBe(false);
  });

  it("updates highlight blend and rotation in place", async () => {
    const now = new Date().toISOString();
    const existing = {
      id: "highlight_layer1",
      parent_id: null,
      kind: "vector",
      name: "AI highlight",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 1000,
      source: "codex",
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now,
      shape: {
        kind: "highlight",
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }
      }
    };
    dispatch.mockImplementation(async (name: string, req: { id?: string; layer?: unknown }) => {
      if (name === "layers:list") return { ok: true, value: [existing] };
      if (name === "layers:update") return { ok: true, value: req.layer };
      return { ok: true, value: {} };
    });

    const res = await toolByName("update_layer").dispatch(
      {
        capture_id: "cap1",
        layer_id: "highlight_layer1",
        blend: "screen",
        rotation: 0.5
      },
      { threadId: "t1" }
    );

    expect(res.ok).toBe(true);
    const updated = lastUpdatedLayer();
    expect(updated.shape).toMatchObject({ kind: "highlight", blend: "screen", rotation: 0.5 });
    expect(BundleLayerNode.safeParse(updated).success).toBe(true);
  });
});

describe("reorder_layers emits one bulk z-order command", () => {
  it("maps bottom-to-top ids to gap-based z_index values", async () => {
    const res = await toolByName("reorder_layers").dispatch(
      { ordered_layer_ids: ["bottom", "middle", "top"] },
      { threadId: "t1" }
    );

    expect(res.ok).toBe(true);
    const call = lastCall("layers:reorderMany");
    expect(call[1]).toEqual({
      orders: [
        { id: "bottom", zIndex: 0 },
        { id: "middle", zIndex: 1000 },
        { id: "top", zIndex: 2000 }
      ]
    });
  });
});

describe("crop tool applies viewport crop layer transforms", () => {
  it("translates raster layers and shrinks the canvas", async () => {
    const now = new Date().toISOString();
    const root = {
      id: "root_layer_0001",
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
    };
    const raster = {
      id: "raster_layer_01",
      parent_id: root.id,
      kind: "raster",
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
      created_at: now,
      source_ref: { kind: "bundle", path: "sources/source.png" },
      natural_width_px: 1000,
      natural_height_px: 800
    };
    dispatch.mockImplementation(async (name: string, req: { id?: string; layer?: unknown }) => {
      if (name === "library:byId") {
        return { ok: true, value: { id: req.id, kind: "image", width_px: 1000, height_px: 800 } };
      }
      if (name === "layers:list") return { ok: true, value: [root, raster] };
      if (name === "layers:update") return { ok: true, value: req.layer };
      if (name === "layers:upsert") return { ok: true, value: req.layer };
      if (name === "bundle:updateCanvasDimensions") return { ok: true, value: {} };
      return { ok: true, value: {} };
    });

    const res = await toolByName("crop").dispatch(
      { capture_id: "cap1", rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } },
      { threadId: "t1" }
    );

    expect(res.ok).toBe(true);
    const rasterUpdate = dispatch.mock.calls.find(
      (call) => call[0] === "layers:update" && ((call[1] as { layer: { id: string } }).layer.id === "raster_layer_01")
    );
    expect((rasterUpdate?.[1] as { layer: { transform: number[] } }).layer.transform).toEqual([
      1, 0, 0, 1, -100, -160
    ]);
    expect(lastCall("bundle:updateCanvasDimensions")[1]).toMatchObject({
      captureId: "cap1",
      widthPx: 500,
      heightPx: 400
    });
  });
});

describe("effect tools emit a valid v2 EffectLayer with a pixel clip_rect", () => {
  it("redact → opaque blackout (style: redact)", async () => {
    const res = await toolByName("redact").dispatch(
      { capture_id: "cap1", rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } },
      { threadId: "t1" }
    );
    expect(res.ok).toBe(true);
    const layer = lastUpsertedLayer();
    expect(layer.kind).toBe("effect");
    expect((layer.effect as { type: string; style: string }).style).toBe("redact");
    // Normalized 0.1*1000 = 100, 0.1*800 = 80 → pixel clip_rect.
    expect(layer.clip_rect).toMatchObject({ x: 100, y: 80, w: 200, h: 80 });
    expect(BundleLayerNode.safeParse(layer).success).toBe(true);
  });

  it("blur with pixelate=true → reversible mosaic (style: pixelate)", async () => {
    const res = await toolByName("blur").dispatch(
      { capture_id: "cap1", rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, pixelate: true },
      { threadId: "t1" }
    );
    expect(res.ok).toBe(true);
    const layer = lastUpsertedLayer();
    expect(layer.kind).toBe("effect");
    expect((layer.effect as { type: string; style: string }).style).toBe("pixelate");
    expect(BundleLayerNode.safeParse(layer).success).toBe(true);
  });
});
