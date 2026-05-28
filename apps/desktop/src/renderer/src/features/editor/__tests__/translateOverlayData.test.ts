// Pure-math coverage for the copy/paste/duplicate translate helper.
// Distinct from translateOverlayGeometry (which returns the geometry-
// only fragment for updateGeometry dispatches) — translateOverlayData
// preserves every non-geometry field (color, thickness, body, etc.)
// because paste creates a brand-new overlay rather than mutating an
// existing one.

import { describe, expect, test } from "vitest";
import type { Overlay } from "@pwrsnap/shared";

import { translateOverlayData } from "../Editor";

describe("translateOverlayData", () => {
  test("arrow translates both endpoints AND preserves color / endStyle / thickness", () => {
    const original: Overlay = {
      kind: "arrow",
      from: { x: 0.2, y: 0.5 },
      to: { x: 0.8, y: 0.5 },
      color: "#ff0000",
      endStyle: "open-triangle",
      thickness: "large",
      doubleEnded: true
    };
    const result = translateOverlayData(original, 0.05, -0.1);
    expect(result.kind).toBe("arrow");
    if (result.kind !== "arrow") return;
    expect(result.from.x).toBeCloseTo(0.25, 9);
    expect(result.from.y).toBeCloseTo(0.4, 9);
    expect(result.to.x).toBeCloseTo(0.85, 9);
    expect(result.to.y).toBeCloseTo(0.4, 9);
    expect(result.color).toBe("#ff0000");
    expect(result.endStyle).toBe("open-triangle");
    expect(result.thickness).toBe("large");
    expect(result.doubleEnded).toBe(true);
  });

  test("rect preserves filled + thickness while translating x / y", () => {
    const original: Overlay = {
      kind: "rect",
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      color: "auto",
      filled: true,
      thickness: "small"
    };
    const result = translateOverlayData(original, 0.05, 0.05);
    expect(result.kind).toBe("rect");
    if (result.kind !== "rect") return;
    expect(result.rect.x).toBeCloseTo(0.15, 9);
    expect(result.rect.y).toBeCloseTo(0.25, 9);
    expect(result.rect.w).toBeCloseTo(0.3, 9);
    expect(result.rect.h).toBeCloseTo(0.4, 9);
    expect(result.filled).toBe(true);
    expect(result.thickness).toBe("small");
  });

  test("highlight preserves blend + opacity + color", () => {
    const original: Overlay = {
      kind: "highlight",
      rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
      color: "#ffff00",
      blend: "multiply",
      opacity: 0.5
    };
    const result = translateOverlayData(original, 0.02, 0.03);
    expect(result.kind).toBe("highlight");
    if (result.kind !== "highlight") return;
    expect(result.rect.x).toBeCloseTo(0.12, 9);
    expect(result.rect.y).toBeCloseTo(0.13, 9);
    expect(result.color).toBe("#ffff00");
    expect(result.blend).toBe("multiply");
    expect(result.opacity).toBe(0.5);
  });

  test("text preserves body / size / color / weight", () => {
    const original: Overlay = {
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "hello\nworld",
      size: "large",
      color: "#0000ff",
      weight: "bold",
      sizePx: 128
    };
    const result = translateOverlayData(original, 0.02, 0.03);
    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.point.x).toBeCloseTo(0.52, 9);
    expect(result.point.y).toBeCloseTo(0.53, 9);
    expect(result.body).toBe("hello\nworld");
    expect(result.size).toBe("large");
    expect(result.color).toBe("#0000ff");
    expect(result.weight).toBe("bold");
    expect(result.sizePx).toBe(128);
  });

  test("zero delta returns a structurally-equal payload (paste-in-place would land on top)", () => {
    const original: Overlay = {
      kind: "rect",
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      color: "auto"
    };
    const result = translateOverlayData(original, 0, 0);
    expect(result).toEqual(original);
  });

  test("does not mutate the input (returns a fresh object)", () => {
    const original: Overlay = {
      kind: "arrow",
      from: { x: 0.2, y: 0.5 },
      to: { x: 0.8, y: 0.5 },
      color: "auto"
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    translateOverlayData(original, 0.05, 0.05);
    expect(original).toEqual(snapshot);
  });
});
