import { describe, expect, it } from "vitest";

import {
  annotationBasisPx,
  annotationStrokeWidthPx
} from "../annotation-scale";
import {
  AIRBRUSH_BANDS,
  DEFAULT_MARKER_OPACITY,
  distanceToPolylinePx,
  eraseStroke,
  eraserRadiusPx,
  polylineLengthPx,
  readStrokeOpacity,
  simplifyStrokePoints,
  smoothStrokePathD,
  smoothStrokeSpanD,
  strokeBoundsN,
  StrokeEraseSession,
  strokeGeometry,
  strokePointsToNormalized,
  strokePointsToPx,
  strokeReachPx,
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

  it("marker and airbrush are wider than the pen at the same preset", () => {
    expect(strokeWidthPx("marker", "small", basis)).toBeGreaterThan(
      strokeWidthPx("pen", "small", basis) * 2
    );
    expect(strokeWidthPx("airbrush", "small", basis)).toBeGreaterThan(
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

  it("spans drawn one after another are the whole path, joint for joint", () => {
    const pts = Array.from({ length: 23 }, (_, i) => ({ x: i * 7.3, y: Math.sin(i) * 40 + 50 }));
    const whole = smoothStrokePathD(pts);
    // Each later span starts with a moveto onto the joint the span
    // before it ended on; without those, the spans ARE the path.
    const spans = [
      smoothStrokeSpanD(pts, pts.length, 1, 8, false),
      smoothStrokeSpanD(pts, pts.length, 9, 16, false),
      smoothStrokeSpanD(pts, pts.length, 17, 21, true)
    ];
    const joined = spans[0] + spans.slice(1).map((d) => d.replace(/^M[^Q]*/, "")).join("");
    expect(joined).toBe(whole);
    // The moveto IS that joint: the previous span's last endpoint.
    const lastEnd = spans[0]!.split(" ").slice(-2).join(" ");
    expect(spans[1]!.startsWith(`M${lastEnd}Q`)).toBe(true);
  });

  it("a span maps normalized points into pixels on the way", () => {
    const n = [
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: 0.4 },
      { x: 0.9, y: 0.2 }
    ];
    expect(smoothStrokeSpanD(n, 3, 1, 1, true, 100, 50)).toBe(
      smoothStrokePathD(n.map((p) => ({ x: p.x * 100, y: p.y * 50 })))
    );
  });
});

describe("the airbrush is bands of one line", () => {
  it("stacks to the ramp: faint at the rim, solid in the core", () => {
    // Composite the bands the way SVG does (source-over, same color):
    // coverage inside band i is what bands 0..i add up to.
    let coverage = 0;
    const atEachEdge: number[] = [];
    for (const band of AIRBRUSH_BANDS) {
      coverage = coverage + band.alpha * (1 - coverage);
      atEachEdge.push(coverage);
    }
    expect(atEachEdge[0]).toBeCloseTo(0.15, 3);
    expect(atEachEdge.at(-1)).toBeCloseTo(1, 3);
    for (let i = 1; i < atEachEdge.length; i += 1) {
      expect(atEachEdge[i]!).toBeGreaterThan(atEachEdge[i - 1]!);
    }
  });

  it("goes widest first, and never wider than the stroke", () => {
    expect(AIRBRUSH_BANDS[0]!.widthFactor).toBe(1);
    for (let i = 1; i < AIRBRUSH_BANDS.length; i += 1) {
      expect(AIRBRUSH_BANDS[i]!.widthFactor).toBeLessThan(AIRBRUSH_BANDS[i - 1]!.widthFactor);
    }
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

  it("airbrush is one centerline per band, and the SVG string carries them all", () => {
    const g = strokeGeometry({ ...row, tool: "airbrush" }, 1000, 800, basis);
    expect(g.kind).toBe("airbrush");
    if (g.kind !== "airbrush") throw new Error("unreachable");
    const full = strokeWidthPx("airbrush", "medium", basis);
    expect(g.bands.map((b) => b.widthPx)).toEqual(
      AIRBRUSH_BANDS.map((b) => b.widthFactor * full)
    );
    expect(g.bands.map((b) => b.opacity)).toEqual(AIRBRUSH_BANDS.map((b) => b.alpha));
    expect(g.opacity).toBe(1);
    const svg = strokeSvgElements(g, "#00ff00");
    expect(svg.match(/<path /g)?.length).toBe(AIRBRUSH_BANDS.length);
    expect(svg.split(`d="${g.d}"`).length - 1).toBe(AIRBRUSH_BANDS.length);
    expect(svg).toContain('stroke="#00ff00"');
    expect(svg).toContain('stroke-linecap="round"');
  });

  it("an airbrush tap is a soft dot, not nothing", () => {
    const g = strokeGeometry(
      { ...row, tool: "airbrush", points: [{ x: 0.5, y: 0.5 }] },
      1000,
      800,
      basis
    );
    expect(g.kind).toBe("airbrush");
    if (g.kind !== "airbrush") throw new Error("unreachable");
    expect(g.d.startsWith("M500 400")).toBe(true);
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
    expect(left![0]).toEqual({ x: 0, y: 0 });
    const leftEnd = left![left!.length - 1]!;
    expect(leftEnd.x).toBeGreaterThan(85);
    expect(leftEnd.x).toBeLessThan(90);
    // The right run starts past the cut and keeps the end vertex.
    expect(right![0]!.x).toBeGreaterThan(110);
    expect(right![0]!.x).toBeLessThan(115);
    expect(right![right!.length - 1]).toEqual({ x: 200, y: 0 });
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
    expect(pieces![0]!).toContainEqual({ x: 20, y: 10 });
    expect(pieces![1]!).toContainEqual({ x: 80, y: 0 });
  });

  it("drops crumbs shorter than the minimum", () => {
    const pieces = eraseStroke(stroke, [{ x: 4, y: -50 }, { x: 4, y: 50 }], 3, 5);
    // The 1px stub left of the cut is a crumb; the long right run stays.
    expect(pieces).toHaveLength(1);
    expect(pieces![0]![pieces![0]!.length - 1]).toEqual({ x: 200, y: 0 });
  });

  it("erases a single-point stroke only when it covers it", () => {
    expect(eraseStroke([{ x: 5, y: 5 }], [{ x: 6, y: 5 }], 2)).toEqual([]);
    expect(eraseStroke([{ x: 5, y: 5 }], [{ x: 60, y: 5 }], 2)).toBeNull();
  });
});

describe("StrokeEraseSession — the cut the editor previews and commits", () => {
  const W = 1000;
  const H = 500;
  const basis = annotationBasisPx(W, H);
  const radius = eraserRadiusPx("small", basis);
  const px = (x: number, y: number): { x: number; y: number } => ({ x: x * W, y: y * H });

  const across = {
    kind: "stroke" as const,
    tool: "pen" as const,
    points: [
      { x: 0.1, y: 0.5 },
      { x: 0.9, y: 0.5 }
    ],
    color: "auto" as const,
    thickness: "small" as const
  };

  it("cuts a row into normalized pieces on either side of the swipe", () => {
    const session = new StrokeEraseSession(radius, W, H, basis);
    expect(session.extend([px(0.5, 0.2), px(0.5, 0.8)], [{ id: "a", data: across }])).toBe(true);
    const [change] = session.changes();
    expect(change!.id).toBe("a");
    const pieces = change!.pieces;
    expect(pieces.length).toBe(2);
    expect(pieces[0]!.points[0]).toEqual({ x: 0.1, y: 0.5 });
    expect(Math.max(...pieces[0]!.points.map((p) => p.x))).toBeLessThan(0.5);
    expect(Math.min(...pieces[1]!.points.map((p) => p.x))).toBeGreaterThan(0.5);
    expect(pieces[1]!.points.at(-1)).toEqual({ x: 0.9, y: 0.5 });
    for (const piece of pieces) {
      expect(piece.tool).toBe("pen");
      expect(piece.color).toBe("auto");
      expect(piece.thickness).toBe("small");
    }
  });

  it("changes nothing for a row the eraser never reached", () => {
    const far = { ...across, tool: "marker" as const, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }] };
    const session = new StrokeEraseSession(radius, W, H, basis);
    expect(session.extend([px(0.8, 0.8), px(0.9, 0.9)], [{ id: "a", data: far }])).toBe(false);
    expect(session.changes()).toEqual([]);
    expect(session.pieces().size).toBe(0);
  });

  it("a drag fed one sample at a time cuts what the whole drag would", () => {
    // A long wavy stroke and a zig-zag scrub across it.
    const wave = {
      ...across,
      points: Array.from({ length: 120 }, (_, i) => ({
        x: 0.05 + (i / 119) * 0.9,
        y: 0.5 + Math.sin(i / 6) * 0.2
      }))
    };
    const scrub = Array.from({ length: 300 }, (_, i) =>
      px(0.2 + (i / 299) * 0.3, i % 40 < 20 ? 0.2 + ((i % 20) / 20) * 0.6 : 0.8 - ((i % 20) / 20) * 0.6)
    );
    const stepwise = new StrokeEraseSession(radius, W, H, basis);
    for (const sample of scrub) stepwise.extend([sample], [{ id: "a", data: wave }]);
    const whole = new StrokeEraseSession(radius, W, H, basis);
    whole.extend(scrub, [{ id: "a", data: wave }]);

    const reach = radius + strokeReachPx(wave, basis);
    const piecesOf = (session: StrokeEraseSession) => session.changes()[0]!.pieces;
    // Every surviving vertex is outside the swept area…
    for (const piece of piecesOf(stepwise)) {
      for (const p of piece.points) {
        expect(distanceToPolylinePx(px(p.x, p.y), scrub)).toBeGreaterThan(reach - 1e-6);
      }
    }
    // …and the two agree on what survives: same runs, ends within one
    // sampling step of each other.
    const a = piecesOf(stepwise);
    const b = piecesOf(whole);
    expect(a.length).toBe(b.length);
    const step = Math.max(0.25, reach / 4);
    for (let i = 0; i < a.length; i += 1) {
      for (const end of [0, -1] as const) {
        const pa = px(a[i]!.points.at(end)!.x, a[i]!.points.at(end)!.y);
        const pb = px(b[i]!.points.at(end)!.x, b[i]!.points.at(end)!.y);
        expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeLessThanOrEqual(step + 1e-3);
      }
    }
  });

  it("keeps a cut stroke's rows, and the map, until a later sample cuts again", () => {
    const other = { ...across, points: [{ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.9 }] };
    const targets = [
      { id: "a", data: across },
      { id: "b", data: other }
    ];
    const session = new StrokeEraseSession(radius, W, H, basis);
    session.extend([px(0.5, 0.3), px(0.5, 0.6)], targets);
    const first = session.pieces();
    const aRows = first.get("a");
    // Moving where nothing is left to cut changes nothing at all.
    expect(session.extend([px(0.5, 0.7)], targets)).toBe(false);
    expect(session.pieces()).toBe(first);
    // Cutting stroke b replaces the map but not a's rows.
    expect(session.extend([px(0.5, 0.95)], targets)).toBe(true);
    expect(session.pieces()).not.toBe(first);
    expect(session.pieces().get("a")).toBe(aRows);
    expect(session.pieces().get("b")).toBeDefined();
  });

  it("re-cuts a row edited mid-drag against the whole drag so far", () => {
    const session = new StrokeEraseSession(radius, W, H, basis);
    session.extend([px(0.5, 0.2), px(0.5, 0.8)], [{ id: "a", data: across }]);
    // The same row, a new object (an undo or a remote edit landed).
    const edited = { ...across, color: "#ff0000" };
    session.extend([px(0.95, 0.95)], [{ id: "a", data: edited }]);
    const [change] = session.changes();
    expect(change!.pieces).toHaveLength(2);
    expect(change!.pieces[0]!.color).toBe("#ff0000");
  });

  it("a release with no new samples re-cuts a row added or edited since the last move", () => {
    const session = new StrokeEraseSession(radius, W, H, basis);
    session.extend([px(0.5, 0.2), px(0.5, 0.8)], [{ id: "a", data: across }]);
    // A row the drag already crossed lands after the final move…
    const late = { ...across, points: [{ x: 0.1, y: 0.6 }, { x: 0.9, y: 0.6 }] };
    // …and `a` was recolored. Syncing with no samples picks up both.
    const edited = { ...across, color: "#00ff00" };
    session.extend([], [
      { id: "a", data: edited },
      { id: "late", data: late }
    ]);
    const changes = new Map(session.changes().map((c) => [c.id, c.pieces]));
    expect(changes.get("a")!.every((piece) => piece.color === "#00ff00")).toBe(true);
    expect(changes.get("late")).toHaveLength(2);
  });

  it("drops a row that left the canvas mid-drag", () => {
    const session = new StrokeEraseSession(radius, W, H, basis);
    session.extend([px(0.5, 0.2), px(0.5, 0.8)], [{ id: "a", data: across }]);
    expect(session.extend([px(0.95, 0.95)], [])).toBe(true);
    expect(session.changes()).toEqual([]);
  });
});
