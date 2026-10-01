import { describe, expect, it } from "vitest";

import {
  annotationBasisPx,
  annotationStrokeWidthPx
} from "../annotation-scale";
import {
  DEFAULT_MARKER_OPACITY,
  distanceToPolylinePx,
  eraseStroke,
  eraseStrokeOverlay,
  eraserPathPx,
  eraserRadiusPx,
  MAX_SPRAY_DOTS,
  polylineLengthPx,
  readStrokeOpacity,
  simplifyStrokePoints,
  smoothStrokePathD,
  sprayDots,
  strokeBoundsN,
  strokeGeometry,
  strokePointsToNormalized,
  strokePointsToPx,
  strokeSvgElements,
  strokeWidthPx,
  type StrokePointPx
} from "../freehand-stroke";
import { MAX_STROKE_POINTS, Overlay } from "../overlay-schemas";
import { inverseTransformOverlayByCrop } from "../crop-viewport";

const line = (x0: number, x1: number, y: number, step: number): StrokePointPx[] => {
  const pts: StrokePointPx[] = [];
  for (let x = x0; x <= x1; x += step) pts.push({ x, y });
  return pts;
};

describe("stroke schema", () => {
  it("parses a pen stroke through the Overlay union", () => {
    const parsed = Overlay.parse({
      kind: "stroke",
      tool: "pen",
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.3, y: 0.4 }
      ],
      color: "#ff0000",
      thickness: "small"
    });
    expect(parsed.kind).toBe("stroke");
  });

  it("rejects an empty stroke, an unknown tool, and the eraser", () => {
    const base = { kind: "stroke", points: [{ x: 0, y: 0 }], color: "#ff0000" };
    expect(Overlay.safeParse({ ...base, tool: "pen", points: [] }).success).toBe(false);
    expect(Overlay.safeParse({ ...base, tool: "crayon" }).success).toBe(false);
    // The eraser never commits a row of its own.
    expect(Overlay.safeParse({ ...base, tool: "eraser" }).success).toBe(false);
  });

  it("caps the stored point count", () => {
    const points = Array.from({ length: MAX_STROKE_POINTS + 1 }, (_, i) => ({
      x: i / MAX_STROKE_POINTS,
      y: 0.5
    }));
    expect(
      Overlay.safeParse({ kind: "stroke", tool: "pen", points, color: "#ff0000" }).success
    ).toBe(false);
  });

  it("moves every point with a crop, like an arrow endpoint", () => {
    const moved = inverseTransformOverlayByCrop(
      {
        kind: "stroke",
        tool: "marker",
        points: [
          { x: 0.5, y: 0.5 },
          { x: 0.75, y: 0.5 }
        ],
        color: "#ff0000"
      },
      { x: 0.5, y: 0, w: 0.5, h: 1 }
    );
    expect(moved).toMatchObject({
      points: [
        { x: 0, y: 0.5 },
        { x: 0.5, y: 0.5 }
      ]
    });
  });
});

describe("stroke widths ride the annotation ladder", () => {
  const basis = annotationBasisPx(1920, 1080);

  it("pen at a preset is exactly the arrow stroke at that preset", () => {
    for (const preset of ["small", "medium", "large", "x-large"] as const) {
      expect(strokeWidthPx("pen", preset, basis)).toBeCloseTo(
        annotationStrokeWidthPx(preset, basis)
      );
    }
  });

  it("auto is the Medium rung", () => {
    expect(strokeWidthPx("pen", "auto", basis)).toBe(strokeWidthPx("pen", "medium", basis));
    expect(strokeWidthPx("pen", undefined, basis)).toBe(strokeWidthPx("pen", "medium", basis));
  });

  it("marker and spray are wider than the pen at the same preset", () => {
    expect(strokeWidthPx("marker", "small", basis)).toBeGreaterThan(
      strokeWidthPx("pen", "small", basis) * 2
    );
    expect(strokeWidthPx("spray", "small", basis)).toBeGreaterThan(
      strokeWidthPx("pen", "small", basis) * 2
    );
  });

  it("the eraser is as wide as a marker", () => {
    expect(eraserRadiusPx("large", basis) * 2).toBeCloseTo(
      strokeWidthPx("marker", "large", basis)
    );
  });

  it("opacity defaults per tool and honors the stamped value", () => {
    expect(readStrokeOpacity({ tool: "marker" })).toBe(DEFAULT_MARKER_OPACITY);
    expect(readStrokeOpacity({ tool: "pen" })).toBe(1);
    expect(readStrokeOpacity({ tool: "marker", opacity: 0.2 })).toBe(0.2);
    expect(readStrokeOpacity({ tool: "pen", opacity: 4 })).toBe(1);
  });
});

describe("coordinates", () => {
  it("round-trips points between normalized and pixels", () => {
    const n = [
      { x: 0.25, y: 0.5 },
      { x: -0.1, y: 1.2 }
    ];
    const px = strokePointsToPx(n, 800, 600);
    expect(px).toEqual([
      { x: 200, y: 300 },
      { x: -80, y: 720 }
    ]);
    expect(strokePointsToNormalized(px, 800, 600)).toEqual(n);
  });

  it("measures bounds, length and distance", () => {
    const b = strokeBoundsN([{ x: 0.2, y: 0.8 }, { x: 0.6, y: 0.1 }]);
    expect(b.x).toBe(0.2);
    expect(b.y).toBe(0.1);
    expect(b.w).toBeCloseTo(0.4);
    expect(b.h).toBeCloseTo(0.7);
    const pts = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 3, y: 10 }
    ];
    expect(polylineLengthPx(pts)).toBe(11);
    expect(distanceToPolylinePx({ x: 5, y: 7 }, pts)).toBe(2);
    expect(distanceToPolylinePx({ x: 1, y: 1 }, [{ x: 1, y: 4 }])).toBe(3);
  });
});

describe("smoothing", () => {
  it("drops collinear points and keeps the ends", () => {
    const simplified = simplifyStrokePoints(line(0, 100, 50, 1), 0.5);
    expect(simplified).toEqual([
      { x: 0, y: 50 },
      { x: 100, y: 50 }
    ]);
  });

  it("keeps a corner", () => {
    const corner = [...line(0, 50, 0, 1), ...line(0, 50, 0, 1).map((p) => ({ x: 50, y: p.x }))];
    const simplified = simplifyStrokePoints(corner, 0.5);
    expect(simplified).toContainEqual({ x: 50, y: 0 });
    expect(simplified[0]).toEqual({ x: 0, y: 0 });
    expect(simplified[simplified.length - 1]).toEqual({ x: 50, y: 50 });
  });

  it("never stores more than the schema allows", () => {
    // A dense zig-zag that no small tolerance can thin.
    const zigzag = Array.from({ length: MAX_STROKE_POINTS * 3 }, (_, i) => ({
      x: i,
      y: i % 2 === 0 ? 0 : 40
    }));
    expect(simplifyStrokePoints(zigzag, 0.1).length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
  });

  it("draws a curve that starts and ends on the gesture", () => {
    const d = smoothStrokePathD([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
      { x: 30, y: 10 }
    ]);
    expect(d.startsWith("M0 0Q10 10 15 5")).toBe(true);
    expect(d.endsWith("L30 10")).toBe(true);
    expect(smoothStrokePathD([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe("M1 2L3 4");
  });
});

describe("spray is deterministic", () => {
  const pts = line(0, 300, 100, 25);

  it("same row in, same dots out", () => {
    expect(sprayDots(pts, 30, 1234)).toEqual(sprayDots(pts, 30, 1234));
  });

  it("a different seed is a different pattern", () => {
    expect(sprayDots(pts, 30, 1234)).not.toEqual(sprayDots(pts, 30, 99));
  });

  it("keeps every dot inside the spray's radius", () => {
    for (const dot of sprayDots(pts, 30, 7)) {
      expect(distanceToPolylinePx(dot, pts)).toBeLessThanOrEqual(15 + 1e-9);
    }
  });

  it("scales with length, and a tap still sprays", () => {
    const short = sprayDots(line(0, 50, 0, 25), 30, 1).length;
    const long = sprayDots(line(0, 500, 0, 25), 30, 1).length;
    expect(long).toBeGreaterThan(short * 5);
    expect(sprayDots([{ x: 10, y: 10 }], 30, 1).length).toBeGreaterThan(0);
  });

  it("is bounded", () => {
    expect(sprayDots(line(0, 100_000, 0, 50), 400, 1).length).toBeLessThanOrEqual(
      MAX_SPRAY_DOTS
    );
  });

  it("keys dots by original segment, so seedOffset reproduces a tail", () => {
    // The dots of segments 4.. of the whole stroke are exactly the dots
    // of a stroke made of those segments with seedOffset 4.
    const whole = sprayDots(pts, 30, 55);
    const tail = sprayDots(pts.slice(4), 30, 55, 4);
    expect(whole.slice(whole.length - tail.length)).toEqual(tail);
  });
});

describe("strokeGeometry is what both surfaces paint", () => {
  const basis = annotationBasisPx(1000, 800);
  const row = {
    tool: "pen" as const,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.2 },
      { x: 0.9, y: 0.1 }
    ],
    thickness: "medium" as const
  };

  it("pen is a round-capped opaque path in canvas pixels", () => {
    const g = strokeGeometry(row, 1000, 800, basis);
    expect(g).toMatchObject({ kind: "path", cap: "round", opacity: 1 });
    if (g.kind !== "path") throw new Error("unreachable");
    expect(g.d.startsWith("M100 80")).toBe(true);
    expect(g.widthPx).toBeCloseTo(annotationStrokeWidthPx("medium", basis));
  });

  it("marker is flat-capped and translucent", () => {
    const g = strokeGeometry({ ...row, tool: "marker" }, 1000, 800, basis);
    expect(g).toMatchObject({ kind: "path", cap: "butt", opacity: DEFAULT_MARKER_OPACITY });
  });

  it("a tap paints its cap", () => {
    expect(strokeGeometry({ ...row, points: [{ x: 0.5, y: 0.5 }] }, 1000, 800, basis)).toMatchObject({
      kind: "dot",
      cx: 500,
      cy: 400,
      square: false
    });
    expect(
      strokeGeometry({ ...row, tool: "marker", points: [{ x: 0.5, y: 0.5 }] }, 1000, 800, basis)
    ).toMatchObject({ kind: "dot", square: true });
  });

  it("spray is a few paths of dots, and the SVG string carries them", () => {
    const g = strokeGeometry({ ...row, tool: "spray", seed: 3 }, 1000, 800, basis);
    expect(g.kind).toBe("spray");
    if (g.kind !== "spray") throw new Error("unreachable");
    expect(g.layers.length).toBeGreaterThan(0);
    expect(g.layers.length).toBeLessThanOrEqual(3);
    const svg = strokeSvgElements(g, "#00ff00");
    expect(svg.match(/<path /g)?.length).toBe(g.layers.length);
    expect(svg).toContain('fill="#00ff00"');
  });

  it("serializes a pen path with its width and caps", () => {
    const g = strokeGeometry(row, 1000, 800, basis);
    const svg = strokeSvgElements(g, "#ff0000");
    expect(svg).toContain('stroke="#ff0000"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('fill="none"');
  });
});

describe("the eraser cuts strokes", () => {
  const stroke = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 }
  ];

  it("leaves a stroke it never touched alone", () => {
    expect(eraseStroke(stroke, [{ x: 50, y: 50 }, { x: 150, y: 50 }], 10)).toBeNull();
  });

  it("removes a stroke it covers entirely", () => {
    expect(eraseStroke(stroke, [{ x: -10, y: 0 }, { x: 210, y: 0 }], 10)).toEqual([]);
  });

  it("splits a stroke in two where it crosses", () => {
    const pieces = eraseStroke(stroke, [{ x: 100, y: -50 }, { x: 100, y: 50 }], 10);
    expect(pieces).not.toBeNull();
    expect(pieces).toHaveLength(2);
    const [left, right] = pieces!;
    // The left run keeps the start vertex and stops short of the cut.
    expect(left!.points[0]).toEqual({ x: 0, y: 0 });
    const leftEnd = left!.points[left!.points.length - 1]!;
    expect(leftEnd.x).toBeGreaterThan(85);
    expect(leftEnd.x).toBeLessThan(90);
    // The right run starts past the cut and keeps the end vertex.
    expect(right!.points[0]!.x).toBeGreaterThan(110);
    expect(right!.points[0]!.x).toBeLessThan(115);
    expect(right!.points[right!.points.length - 1]).toEqual({ x: 200, y: 0 });
    // The right run starts on the second segment of the original.
    expect(left!.seedOffset).toBe(0);
    expect(right!.seedOffset).toBe(1);
  });

  it("keeps the original vertices inside each run", () => {
    const wiggle = [
      { x: 0, y: 0 },
      { x: 20, y: 10 },
      { x: 40, y: 0 },
      { x: 60, y: 10 },
      { x: 80, y: 0 },
      { x: 100, y: 10 }
    ];
    const pieces = eraseStroke(wiggle, [{ x: 50, y: -40 }, { x: 50, y: 40 }], 4);
    expect(pieces).toHaveLength(2);
    expect(pieces![0]!.points).toContainEqual({ x: 20, y: 10 });
    expect(pieces![1]!.points).toContainEqual({ x: 80, y: 0 });
  });

  it("drops crumbs shorter than the minimum", () => {
    const pieces = eraseStroke(stroke, [{ x: 4, y: -50 }, { x: 4, y: 50 }], 3, 5);
    // The 1px stub left of the cut is a crumb; the long right run stays.
    expect(pieces).toHaveLength(1);
    expect(pieces![0]!.points[pieces![0]!.points.length - 1]).toEqual({ x: 200, y: 0 });
  });

  it("an erased spray keeps the dots of its surviving segments", () => {
    const spray = line(0, 400, 0, 20);
    const pieces = eraseStroke(spray, [{ x: 100, y: -50 }, { x: 100, y: 50 }], 15);
    expect(pieces).toHaveLength(2);
    const right = pieces![1]!;
    const before = sprayDots(spray, 30, 77);
    const after = sprayDots(right.points, 30, 77, right.seedOffset);
    // Every segment of the run after its first (partial) one is an
    // original segment, and paints exactly the dots it painted before.
    const fullSegmentsAfter = after.slice(after.length - 200);
    const tailBefore = before.slice(before.length - 200);
    expect(fullSegmentsAfter).toEqual(tailBefore);
  });

  it("erases a single-point stroke only when it covers it", () => {
    expect(eraseStroke([{ x: 5, y: 5 }], [{ x: 6, y: 5 }], 2)).toEqual([]);
    expect(eraseStroke([{ x: 5, y: 5 }], [{ x: 60, y: 5 }], 2)).toBeNull();
  });
});

describe("eraseStrokeOverlay — the row-level cut the editor previews and commits", () => {
  const W = 1000;
  const H = 500;
  const basis = annotationBasisPx(W, H);

  it("cuts a row into normalized pieces on either side of the swipe", () => {
    const row = {
      kind: "stroke" as const,
      tool: "pen" as const,
      points: [
        { x: 0.1, y: 0.5 },
        { x: 0.9, y: 0.5 }
      ],
      color: "auto" as const,
      thickness: "small" as const
    };
    const eraser = eraserPathPx(
      [
        { x: 0.5, y: 0.2 },
        { x: 0.5, y: 0.8 }
      ],
      W,
      H
    );
    const pieces = eraseStrokeOverlay(row, eraser, eraserRadiusPx("small", basis), W, H, basis);
    expect(pieces).not.toBeNull();
    expect(pieces!.length).toBe(2);
    expect(pieces![0]!.points[0]).toEqual({ x: 0.1, y: 0.5 });
    expect(Math.max(...pieces![0]!.points.map((p) => p.x))).toBeLessThan(0.5);
    expect(Math.min(...pieces![1]!.points.map((p) => p.x))).toBeGreaterThan(0.5);
    expect(pieces![1]!.points.at(-1)).toEqual({ x: 0.9, y: 0.5 });
    for (const piece of pieces!) {
      expect(piece.tool).toBe("pen");
      expect(piece.seedOffset).toBeUndefined();
    }
  });

  it("offsets a spray piece's seed by where it starts in the original stroke", () => {
    const row = {
      kind: "stroke" as const,
      tool: "spray" as const,
      points: [
        { x: 0.1, y: 0.5 },
        { x: 0.3, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.7, y: 0.5 },
        { x: 0.9, y: 0.5 }
      ],
      color: "auto" as const,
      seed: 99,
      seedOffset: 4
    };
    // Cut inside the second segment (0.3 → 0.5).
    const eraser = eraserPathPx([{ x: 0.4, y: 0.3 }, { x: 0.4, y: 0.7 }], W, H);
    const pieces = eraseStrokeOverlay(row, eraser, eraserRadiusPx("small", basis), W, H, basis)!;
    expect(pieces.map((p) => p.seedOffset)).toEqual([4, 5]);
    expect(pieces.every((p) => p.seed === 99)).toBe(true);
  });

  it("returns null for a row the eraser never reached", () => {
    const row = {
      kind: "stroke" as const,
      tool: "marker" as const,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.1 }
      ],
      color: "auto" as const
    };
    const eraser = eraserPathPx([{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }], W, H);
    expect(eraseStrokeOverlay(row, eraser, eraserRadiusPx("small", basis), W, H, basis)).toBeNull();
  });
});

describe("eraserPathPx", () => {
  it("drops the samples a straight drag adds, keeping both ends", () => {
    const samples = Array.from({ length: 200 }, (_, i) => ({ x: 0.1 + i * 0.004, y: 0.5 }));
    const path = eraserPathPx(samples, 1000, 500);
    expect(path).toEqual([
      { x: samples[0]!.x * 1000, y: 250 },
      { x: samples[199]!.x * 1000, y: 250 }
    ]);
  });
});
