import { describe, expect, it } from "vitest";
import { computeRenderHash } from "../render/overlay-hash";
import type { OverlayRow } from "@pwrsnap/shared";

const overlay = (over: Partial<OverlayRow>): Pick<OverlayRow, "id" | "data" | "z_index"> => ({
  id: over.id ?? "x",
  z_index: over.z_index ?? 0,
  data: over.data ?? {
    kind: "arrow",
    from: { x: 0.1, y: 0.1 },
    to: { x: 0.5, y: 0.5 },
    color: "auto"
  }
});

describe("computeRenderHash", () => {
  it("produces a stable 64-char hex hash", () => {
    const h = computeRenderHash({
      format: "png",
      width: 800,
      appliedOverlays: [overlay({ id: "a" })]
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when format differs", () => {
    const png = computeRenderHash({ format: "png", width: 800, appliedOverlays: [] });
    const webp = computeRenderHash({ format: "webp", width: 800, appliedOverlays: [] });
    expect(png).not.toBe(webp);
  });

  it("differs when width differs", () => {
    const a = computeRenderHash({ format: "png", width: 800, appliedOverlays: [] });
    const b = computeRenderHash({ format: "png", width: 1200, appliedOverlays: [] });
    expect(a).not.toBe(b);
  });

  it("is invariant to overlay-array order", () => {
    const a = overlay({ id: "a", z_index: 0 });
    const b = overlay({ id: "b", z_index: 1 });
    const ab = computeRenderHash({ format: "png", width: 800, appliedOverlays: [a, b] });
    const ba = computeRenderHash({ format: "png", width: 800, appliedOverlays: [b, a] });
    expect(ab).toBe(ba);
  });

  it("is invariant to JSON key order in data blob", () => {
    const o1 = overlay({
      id: "x",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" }
    });
    const o2 = overlay({
      id: "x",
      // Same logical content; different JS property insertion order.
      // safe-stable-stringify sorts keys, so the canonical form is identical.
      data: { color: "auto", to: { y: 1, x: 1 }, kind: "arrow", from: { y: 0, x: 0 } } as never
    });
    expect(computeRenderHash({ format: "png", width: 800, appliedOverlays: [o1] })).toBe(
      computeRenderHash({ format: "png", width: 800, appliedOverlays: [o2] })
    );
  });

  it("differs when overlay data changes", () => {
    const before = overlay({
      id: "x",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 0.5, y: 0.5 }, color: "auto" }
    });
    const after = overlay({
      id: "x",
      data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 0.6, y: 0.5 }, color: "auto" }
    });
    expect(computeRenderHash({ format: "png", width: 800, appliedOverlays: [before] })).not.toBe(
      computeRenderHash({ format: "png", width: 800, appliedOverlays: [after] })
    );
  });

  it("differs when z_index changes (visual stack reorder)", () => {
    const a = overlay({ id: "a", z_index: 0 });
    const b = overlay({ id: "b", z_index: 1 });
    const a2 = overlay({ id: "a", z_index: 5 });
    expect(computeRenderHash({ format: "png", width: 800, appliedOverlays: [a, b] })).not.toBe(
      computeRenderHash({ format: "png", width: 800, appliedOverlays: [a2, b] })
    );
  });

  it("ignores caller-side metadata not surfaced to the bake", () => {
    // We project to (z_index, data) only — the caller can pass
    // anything in `id` and the hash is unchanged so long as the
    // sort order is preserved.
    const same = computeRenderHash({
      format: "png",
      width: 800,
      appliedOverlays: [overlay({ id: "a", z_index: 0 }), overlay({ id: "b", z_index: 1 })]
    });
    // Different ids but same z_index ordering → hash should match if
    // the data blobs are identical. This is the property of the
    // sort being a tiebreaker only.
    const ids = computeRenderHash({
      format: "png",
      width: 800,
      appliedOverlays: [overlay({ id: "a", z_index: 0 }), overlay({ id: "c", z_index: 1 })]
    });
    expect(same).toBe(ids);
  });
});
