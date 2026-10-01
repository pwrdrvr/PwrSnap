// OverlaySvg — Draw strokes. The editor paints a stroke from the same
// shared `strokeGeometry` the bake serializes (compose.ts
// `strokeSvgForV2`), so these tests pin the DOM to that geometry rather
// than to hand-written numbers: if the two ever disagree, the preview
// no longer matches the export.

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { OverlayRow, StrokeOverlay } from "@pwrsnap/shared";
import { annotationBasisPx, DEFAULT_MARKER_OPACITY, strokeGeometry } from "@pwrsnap/shared";

import { OverlaySvg } from "../OverlaySvg";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

const W = 800;
const H = 600;
const BASIS = annotationBasisPx(W, H);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

async function renderSvg(
  overlays: OverlayRow[],
  extra: Partial<Pick<ComponentProps<typeof OverlaySvg>, "draft" | "draftStyle" | "selectedLayerIds">> = {}
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(OverlaySvg, {
        overlays,
        draft: null,
        imageWidthPx: W,
        imageHeightPx: H,
        sourceWidthPx: W,
        sourceHeightPx: H,
        ...extra
      })
    );
  });
  return container;
}

function row(id: string, data: StrokeOverlay): OverlayRow {
  return {
    id,
    capture_id: "cap_1",
    data,
    schema_version: 1,
    created_at: "2026-09-30T00:00:00Z",
    applied_at: "2026-09-30T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 1000
  };
}

const underline: StrokeOverlay = {
  kind: "stroke",
  tool: "marker",
  points: [
    { x: 0.1, y: 0.5 },
    { x: 0.9, y: 0.5 }
  ],
  color: "#2489ff",
  thickness: "medium"
};

describe("OverlaySvg — persisted strokes", () => {
  test("a marker paints the shared geometry: same path, width, flat cap and translucency", async () => {
    const host = await renderSvg([row("m", underline)]);
    const path = host.querySelector<SVGPathElement>("[data-testid='stroke-glyph']");
    expect(path).not.toBeNull();
    const geometry = strokeGeometry(underline, W, H, BASIS);
    if (geometry.kind !== "path") throw new Error("expected a path geometry");
    expect(path!.getAttribute("d")).toBe(geometry.d);
    expect(Number(path!.getAttribute("stroke-width"))).toBeCloseTo(geometry.widthPx, 6);
    expect(path!.getAttribute("stroke-linecap")).toBe("butt");
    expect(Number(path!.getAttribute("opacity"))).toBeCloseTo(DEFAULT_MARKER_OPACITY, 6);
    expect(path!.getAttribute("stroke")).toBe("#2489ff");
    // Rendered in its own z-ordered mini-SVG like every persisted glyph.
    const svg = path!.closest("svg")!;
    expect(svg.getAttribute("data-testid")).toBe("persisted-glyph-svg");
    expect(svg.style.zIndex).toBe("1000");
  });

  test("an airbrush paints the same bands the bake writes", async () => {
    const airbrush: StrokeOverlay = { ...underline, tool: "airbrush", color: "#2489ff" };
    const host = await renderSvg([row("a", airbrush)]);
    const geometry = strokeGeometry(airbrush, W, H, BASIS);
    if (geometry.kind !== "airbrush") throw new Error("expected an airbrush geometry");
    const group = host.querySelector("[data-testid='stroke-glyph']")!;
    expect(group.getAttribute("stroke")).toBe("#2489ff");
    expect(group.getAttribute("stroke-linecap")).toBe("round");
    const paths = Array.from(group.querySelectorAll<SVGPathElement>("path"));
    expect(paths.map((p) => p.getAttribute("d"))).toEqual(geometry.bands.map(() => geometry.d));
    expect(paths.map((p) => Number(p.getAttribute("stroke-width")))).toEqual(
      geometry.bands.map((b) => b.widthPx)
    );
    expect(paths.map((p) => Number(p.getAttribute("opacity")))).toEqual(
      geometry.bands.map((b) => b.opacity)
    );
  });

  test("an 'auto' color paints the theme accent", async () => {
    const host = await renderSvg([row("p", { ...underline, tool: "pen", color: "auto" })]);
    expect(host.querySelector("[data-testid='stroke-glyph']")!.getAttribute("stroke")).toContain(
      "--accent"
    );
  });

  test("a selected stroke gets a dashed outline around its painted box", async () => {
    const host = await renderSvg([row("m", underline)], { selectedLayerIds: ["m"] });
    const outline = host.querySelector("[data-testid='chrome-svg'] [data-testid='selection-outline'] rect");
    expect(outline).not.toBeNull();
    // The box is grown by the marker's half-width, so it is taller than
    // the (zero-height) centerline.
    // Medium marker on this canvas: 900 / 105 × 3 ≈ 25.7px wide.
    expect(Number(outline!.getAttribute("height"))).toBeGreaterThan(25);
  });
});

describe("OverlaySvg — Draw drafts", () => {
  test("a pen draft paints live in the chrome layer, in the picked color", async () => {
    const host = await renderSvg([], {
      draft: {
        kind: "stroke",
        mode: "pen",
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.4, y: 0.3 },
          { x: 0.6, y: 0.2 }
        ]
      },
      draftStyle: { color: "#28c840", thickness: "large" }
    });
    const path = host.querySelector("[data-testid='chrome-svg'] [data-testid='stroke-glyph']");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("data-tool")).toBe("pen");
    expect(path!.getAttribute("stroke")).toBe("#28c840");
  });

  test("an eraser draft shows its trail and previews the cut: the crossed stroke paints as two pieces", async () => {
    const host = await renderSvg([row("m", underline)], {
      draft: {
        kind: "stroke",
        mode: "eraser",
        // A vertical swipe through the middle of the underline.
        points: [
          { x: 0.5, y: 0.3 },
          { x: 0.5, y: 0.7 }
        ]
      },
      draftStyle: { thickness: "small" }
    });
    expect(host.querySelector("[data-testid='eraser-trail']")).not.toBeNull();
    const persisted = host.querySelectorAll(
      "[data-testid='persisted-glyph-svg'] [data-testid='stroke-glyph']"
    );
    expect(persisted.length).toBe(2);
  });

  test("an eraser that misses a stroke leaves it whole", async () => {
    const host = await renderSvg([row("m", underline)], {
      draft: {
        kind: "stroke",
        mode: "eraser",
        points: [
          { x: 0.5, y: 0.05 },
          { x: 0.6, y: 0.05 }
        ]
      },
      draftStyle: { thickness: "small" }
    });
    expect(
      host.querySelectorAll("[data-testid='persisted-glyph-svg'] [data-testid='stroke-glyph']").length
    ).toBe(1);
  });
});
