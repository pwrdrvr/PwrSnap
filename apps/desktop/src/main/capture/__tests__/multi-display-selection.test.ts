import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  intersectRects,
  mergeSessionPicks,
  planMultiDisplayComposite,
  planSessionCommit,
  sessionPickFromRenderer,
  type CompositeSource,
  type DisplayGeometry,
  type LogicalRect,
  type SessionPick
} from "../multi-display-selection";

// Two side-by-side monitors, the common desk: a 2× laptop panel on the
// left and a 1× external on the right, top edges offset.
const LAPTOP: DisplayGeometry = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  scaleFactor: 2
};
const EXTERNAL: DisplayGeometry = {
  id: 2,
  bounds: { x: 1440, y: -200, width: 1920, height: 1080 },
  scaleFactor: 1
};
const DESK = [LAPTOP, EXTERNAL];

function source(d: DisplayGeometry): CompositeSource {
  return {
    displayId: d.id,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    snapshot: {
      width: Math.round(d.bounds.width * d.scaleFactor),
      height: Math.round(d.bounds.height * d.scaleFactor)
    }
  };
}

function windowPick(id: number, rect: LogicalRect): SessionPick {
  return { key: `w:${id}`, windowId: id, rect };
}

function commitInput(overrides: Partial<Parameters<typeof planSessionCommit>[0]>) {
  return {
    committingDisplayId: LAPTOP.id,
    rect: { x: 10, y: 10, w: 100, h: 100 },
    mergePeers: false,
    localPicks: [],
    peerPicks: new Map<number, SessionPick[]>(),
    pickOrder: [],
    sessionOutputMode: "windows" as const,
    displays: DESK,
    snapshotDisplayIds: new Set(DESK.map((d) => d.id)),
    ...overrides
  };
}

describe("sessionPickFromRenderer", () => {
  it("keys windows by id and display picks by display, in global px", () => {
    expect(sessionPickFromRenderer(42, { x: 5, y: 6, w: 7, h: 8 }, EXTERNAL)).toEqual({
      key: "w:42",
      windowId: 42,
      rect: { x: 1445, y: -194, w: 7, h: 8 }
    });
    expect(sessionPickFromRenderer(-1, { x: 0, y: 0, w: 1920, h: 1080 }, EXTERNAL)).toEqual({
      key: "d:2",
      windowId: null,
      rect: { x: 1440, y: -200, w: 1920, h: 1080 }
    });
  });
});

describe("mergeSessionPicks", () => {
  it("captures a window listed by two displays once, in pick order", () => {
    const straddler = windowPick(7, { x: 1300, y: 100, w: 400, h: 300 });
    const merged = mergeSessionPicks(
      new Map([
        [1, [straddler, windowPick(3, { x: 0, y: 0, w: 50, h: 50 })]],
        [2, [straddler, windowPick(9, { x: 2000, y: 0, w: 50, h: 50 })]]
      ]),
      ["w:9", "w:7"]
    );
    expect(merged.map((p) => p.key)).toEqual(["w:9", "w:7", "w:3"]);
  });

  it("never drops or duplicates a pick (property)", () => {
    const pickArb = fc.record({
      key: fc.constantFrom<string>("w:1", "w:2", "w:3", "d:1", "d:2", "w:4"),
      windowId: fc.constant(null),
      rect: fc.constant({ x: 0, y: 0, w: 1, h: 1 })
    });
    fc.assert(
      fc.property(
        fc.array(fc.array(pickArb, { maxLength: 6 }), { maxLength: 4 }),
        fc.array(fc.constantFrom<string>("w:1", "w:2", "w:3", "d:1", "w:9")),
        (perDisplay, order) => {
          const map = new Map(perDisplay.map((picks, i) => [i, picks]));
          const merged = mergeSessionPicks(map, order);
          const expected = new Set(perDisplay.flat().map((p) => p.key));
          expect(new Set(merged.map((p) => p.key))).toEqual(expected);
          expect(merged).toHaveLength(expected.size);
          // Known keys keep the session's order.
          const known = merged.map((p) => p.key).filter((k) => order.includes(k));
          const firstSeen = order.filter((k, i) => order.indexOf(k) === i && expected.has(k));
          expect(known).toEqual(firstSeen);
        }
      )
    );
  });
});

describe("planSessionCommit", () => {
  it("leaves a commit that stays on its own display exactly as the renderer sent it", () => {
    const rect = { x: 100, y: 100, w: 600, h: 400 };
    const extents = [
      { x: 100, y: 100, w: 200, h: 400 },
      { x: 500, y: 100, w: 200, h: 200 }
    ];
    expect(
      planSessionCommit(
        commitInput({ rect, extents, outputMode: "rectangle", snappedWindowId: 5 })
      )
    ).toEqual({
      rect,
      extents,
      outputMode: "rectangle",
      snappedWindowId: 5,
      displayId: LAPTOP.id,
      extraDisplayIds: []
    });
  });

  it("asks for the second display's snapshot when a window straddles the seam", () => {
    const plan = planSessionCommit(
      commitInput({ rect: { x: 1200, y: 100, w: 600, h: 400 }, snappedWindowId: 5 })
    );
    expect(plan).toMatchObject({ displayId: LAPTOP.id, extraDisplayIds: [EXTERNAL.id] });
  });

  it("merges the other display's picks and keeps the committing display as home", () => {
    const plan = planSessionCommit(
      commitInput({
        mergePeers: true,
        localPicks: [windowPick(3, { x: 10, y: 10, w: 100, h: 100 })],
        peerPicks: new Map([[EXTERNAL.id, [windowPick(9, { x: 1500, y: -100, w: 1000, h: 800 })]]]),
        pickOrder: ["w:9", "w:3"]
      })
    );
    expect(plan).toEqual({
      rect: { x: 10, y: -100, w: 2490, h: 800 },
      extents: [
        { x: 1500, y: -100, w: 1000, h: 800 },
        { x: 10, y: 10, w: 100, h: 100 }
      ],
      outputMode: "windows",
      snappedWindowId: 9,
      displayId: LAPTOP.id,
      extraDisplayIds: [EXTERNAL.id]
    });
  });

  it("captures two whole displays as one box with both extents", () => {
    const plan = planSessionCommit(
      commitInput({
        mergePeers: true,
        localPicks: [{ key: "d:1", windowId: null, rect: { x: 0, y: 0, w: 1440, h: 900 } }],
        peerPicks: new Map([
          [EXTERNAL.id, [{ key: "d:2", windowId: null, rect: { x: 1440, y: -200, w: 1920, h: 1080 } }]]
        ])
      })
    );
    expect(plan).toMatchObject({
      rect: { x: 0, y: -200, w: 3360, h: 1100 },
      extents: [
        { x: 0, y: 0, w: 1440, h: 900 },
        { x: 1440, y: -200, w: 1920, h: 1080 }
      ]
    });
    expect(plan?.snappedWindowId).toBeUndefined();
  });

  it("re-homes a lone pick made on another display", () => {
    const plan = planSessionCommit(
      commitInput({
        mergePeers: true,
        peerPicks: new Map([[EXTERNAL.id, [windowPick(9, { x: 1500, y: 0, w: 300, h: 300 })]]])
      })
    );
    expect(plan).toEqual({
      rect: { x: 1500, y: 0, w: 300, h: 300 },
      snappedWindowId: 9,
      displayId: EXTERNAL.id,
      extraDisplayIds: []
    });
  });

  it("treats a merge with nothing left as a cancel", () => {
    expect(planSessionCommit(commitInput({ mergePeers: true }))).toBeNull();
  });

  // The rule a cross-display capture must not break: every display the
  // kept pixels touch is in the plan exactly once (home or extra), and no
  // display without a snapshot is asked for.
  it("names every touched display once (property)", () => {
    const rectArb = fc
      .record({
        x: fc.integer({ min: -500, max: 3500 }),
        y: fc.integer({ min: -400, max: 1200 }),
        w: fc.integer({ min: 1, max: 2500 }),
        h: fc.integer({ min: 1, max: 1200 })
      });
    fc.assert(
      fc.property(
        fc.array(rectArb, { minLength: 1, maxLength: 5 }),
        fc.constantFrom<"windows" | "rectangle">("windows", "rectangle"),
        fc.subarray([1, 2]),
        (rects, outputMode, withSnapshots) => {
          const snapshots = new Set<number>([LAPTOP.id, ...withSnapshots]);
          const union = {
            x: Math.min(...rects.map((r) => r.x)),
            y: Math.min(...rects.map((r) => r.y)),
            w: 0,
            h: 0
          };
          union.w = Math.max(...rects.map((r) => r.x + r.w)) - union.x;
          union.h = Math.max(...rects.map((r) => r.y + r.h)) - union.y;
          const plan = planSessionCommit(
            commitInput({
              rect: union,
              ...(rects.length > 1 ? { extents: rects, outputMode } : {}),
              snapshotDisplayIds: snapshots
            })
          )!;
          const kept = rects.length > 1 && outputMode === "windows" ? rects : [union];
          const touched = DESK.filter(
            (d) =>
              snapshots.has(d.id) &&
              kept.some(
                (r) =>
                  intersectRects(r, {
                    x: d.bounds.x,
                    y: d.bounds.y,
                    w: d.bounds.width,
                    h: d.bounds.height
                  }) !== null
              )
          ).map((d) => d.id);
          const named = [plan.displayId, ...plan.extraDisplayIds];
          expect(new Set(named).size).toBe(named.length);
          for (const id of touched) expect(named).toContain(id);
          for (const id of plan.extraDisplayIds) expect(snapshots.has(id)).toBe(true);
          // Nothing moves: a non-merge commit ships the renderer's geometry.
          expect(plan.rect).toEqual(union);
        }
      )
    );
  });
});

describe("planMultiDisplayComposite", () => {
  it("stitches a straddling window from both snapshots at the sharper scale", () => {
    const plan = planMultiDisplayComposite({
      rect: { x: 1240, y: 100, w: 400, h: 300 },
      sources: [source(LAPTOP), source(EXTERNAL)]
    })!;
    expect(plan.scale).toBe(2);
    expect(plan.width).toBe(800);
    expect(plan.height).toBe(600);
    expect(plan.layers).toEqual([
      {
        displayId: 1,
        extract: { left: 2480, top: 200, width: 400, height: 600 },
        resize: { width: 400, height: 600 },
        left: 0,
        top: 0
      },
      {
        displayId: 2,
        extract: { left: 0, top: 300, width: 200, height: 300 },
        resize: { width: 400, height: 600 },
        left: 400,
        top: 0
      }
    ]);
    expect(plan.mask).toBeNull();
  });

  it("returns null when the box misses every display", () => {
    expect(
      planMultiDisplayComposite({
        rect: { x: 0, y: 2000, w: 10, h: 10 },
        sources: [source(LAPTOP), source(EXTERNAL)]
      })
    ).toBeNull();
  });

  // Pixel oracle. For every canvas pixel, the logical point it samples
  // says which display (if any) must paint it and whether the mask keeps
  // it. Layers must tile exactly that — no seam between monitors, no
  // overlap, nothing painted where no monitor is — and stay inside both
  // the canvas and their own snapshot.
  it("paints every canvas pixel from the display under it, once (property)", () => {
    const scaleArb = fc.constantFrom(1, 1.25, 1.5, 2);
    const layoutArb = fc.record({
      // Left display at the origin; right display abutting it with a
      // vertical offset, or separated by a gap.
      leftW: fc.integer({ min: 20, max: 80 }),
      leftH: fc.integer({ min: 20, max: 60 }),
      rightW: fc.integer({ min: 20, max: 80 }),
      rightH: fc.integer({ min: 20, max: 60 }),
      gap: fc.constantFrom(0, 0, 7),
      dy: fc.integer({ min: -30, max: 30 }),
      leftScale: scaleArb,
      rightScale: scaleArb
    });
    fc.assert(
      fc.property(
        layoutArb,
        fc.record({
          x: fc.integer({ min: -10, max: 150 }),
          y: fc.integer({ min: -40, max: 80 }),
          w: fc.integer({ min: 1, max: 120 }),
          h: fc.integer({ min: 1, max: 90 })
        }),
        fc.array(
          fc.record({
            x: fc.integer({ min: -10, max: 150 }),
            y: fc.integer({ min: -40, max: 80 }),
            w: fc.integer({ min: 1, max: 60 }),
            h: fc.integer({ min: 1, max: 60 })
          }),
          { maxLength: 3 }
        ),
        (layout, rect, extents) => {
          const displays: DisplayGeometry[] = [
            {
              id: 1,
              bounds: { x: 0, y: 0, width: layout.leftW, height: layout.leftH },
              scaleFactor: layout.leftScale
            },
            {
              id: 2,
              bounds: {
                x: layout.leftW + layout.gap,
                y: layout.dy,
                width: layout.rightW,
                height: layout.rightH
              },
              scaleFactor: layout.rightScale
            }
          ];
          const sources = displays.map(source);
          const plan = planMultiDisplayComposite({
            rect,
            ...(extents.length > 0 ? { extents } : {}),
            sources
          });
          const touches = displays.some(
            (d) =>
              intersectRects(rect, {
                x: d.bounds.x,
                y: d.bounds.y,
                w: d.bounds.width,
                h: d.bounds.height
              }) !== null
          );
          if (plan === null) {
            // Only allowed when there is genuinely nothing to draw.
            const anyExtentKept = extents.some((e) => intersectRects(e, rect) !== null);
            expect(!touches || (extents.length > 0 && !anyExtentKept) || rect.w * Math.max(layout.leftScale, layout.rightScale) < 0.5 || rect.h * Math.max(layout.leftScale, layout.rightScale) < 0.5).toBe(true);
            return;
          }
          const s = plan.scale;
          // Half-open (lo, hi] in logical space matches round-half-up
          // edges on the canvas.
          const inside = (p: number, lo: number, hi: number): boolean => p > lo && p <= hi;
          for (const layer of plan.layers) {
            const src = sources.find((x) => x.displayId === layer.displayId)!;
            expect(layer.left).toBeGreaterThanOrEqual(0);
            expect(layer.top).toBeGreaterThanOrEqual(0);
            expect(layer.left + layer.resize.width).toBeLessThanOrEqual(plan.width);
            expect(layer.top + layer.resize.height).toBeLessThanOrEqual(plan.height);
            expect(layer.extract.left).toBeGreaterThanOrEqual(0);
            expect(layer.extract.top).toBeGreaterThanOrEqual(0);
            expect(layer.extract.left + layer.extract.width).toBeLessThanOrEqual(src.snapshot.width);
            expect(layer.extract.top + layer.extract.height).toBeLessThanOrEqual(src.snapshot.height);
          }
          for (let cy = 0; cy < plan.height; cy += 1) {
            for (let cx = 0; cx < plan.width; cx += 1) {
              const px = (cx + 0.5) / s;
              const py = (cy + 0.5) / s;
              const owner = displays.find(
                (d) =>
                  inside(px, d.bounds.x - rect.x, d.bounds.x + d.bounds.width - rect.x) &&
                  inside(py, d.bounds.y - rect.y, d.bounds.y + d.bounds.height - rect.y)
              );
              const painters = plan.layers.filter(
                (l) =>
                  cx >= l.left &&
                  cx < l.left + l.resize.width &&
                  cy >= l.top &&
                  cy < l.top + l.resize.height
              );
              expect(painters.map((l) => l.displayId)).toEqual(owner === undefined ? [] : [owner.id]);
              if (plan.mask !== null) {
                const masked = plan.mask.some(
                  (m) => cx >= m.left && cx < m.left + m.width && cy >= m.top && cy < m.top + m.height
                );
                const kept = extents.some(
                  (e) =>
                    inside(px, Math.max(e.x, rect.x) - rect.x, Math.min(e.x + e.w, rect.x + rect.w) - rect.x) &&
                    inside(py, Math.max(e.y, rect.y) - rect.y, Math.min(e.y + e.h, rect.y + rect.h) - rect.y)
                );
                expect(masked).toBe(kept);
              }
            }
          }
        }
      ),
      { numRuns: 100 }
    );
    // Every run walks every canvas pixel; under a parallel suite that is
    // a few seconds of honest work, not a hang.
  }, 60_000);
});
