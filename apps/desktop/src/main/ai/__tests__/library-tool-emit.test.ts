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

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockImplementation(async (name: string, req: { id?: string; layer?: unknown }) => {
    if (name === "layers:upsert") return { ok: true, value: req.layer };
    // Effect tools fetch canvas dims via library:byId to denormalize.
    if (name === "library:byId") {
      return { ok: true, value: { id: req.id, kind: "image", width_px: 1000, height_px: 800 } };
    }
    return { ok: true, value: {} };
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
        { capture_id: "cap1", rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, color: "#ff0000", filled: true },
        { threadId: "t1" }
      );
      // ok:true means the tool's internal BundleLayerNode.safeParse passed.
      expect(res.ok).toBe(true);

      const layer = lastUpsertedLayer();
      expect(layer.kind).toBe("vector");
      const shape = layer.shape as { kind: string; shape: string };
      expect(shape.kind).toBe("shape");
      expect(shape.shape).toBe(shapeKind);
      // And it round-trips the shared schema.
      expect(BundleLayerNode.safeParse(layer).success).toBe(true);
    });
  }
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
