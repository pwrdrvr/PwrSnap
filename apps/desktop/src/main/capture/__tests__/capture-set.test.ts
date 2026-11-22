import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { captureSetPicks, planCaptureSet, type CaptureSetPick } from "../capture-set";
import {
  intersectRects,
  planSessionCommit,
  type DisplayGeometry,
  type LogicalRect
} from "../multi-display-selection";

// A 2× laptop panel on the left, a 1× external on the right with its top
// edge 200 pt higher, and a third 1× display stacked below the laptop.
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
const BELOW: DisplayGeometry = {
  id: 3,
  bounds: { x: 0, y: 900, width: 1280, height: 720 },
  scaleFactor: 1
};
const DESK = [LAPTOP, EXTERNAL, BELOW];
const ALL_SNAPSHOTS = new Set(DESK.map((d) => d.id));

function area(r: LogicalRect | null): number {
  return r === null ? 0 : r.w * r.h;
}

function contains(r: LogicalRect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

const rectArb: fc.Arbitrary<LogicalRect> = fc.record({
  x: fc.integer({ min: -400, max: 3600 }),
  y: fc.integer({ min: -400, max: 1800 }),
  w: fc.integer({ min: 1, max: 1600 }),
  h: fc.integer({ min: 1, max: 1000 })
});
const pickArb: fc.Arbitrary<CaptureSetPick> = fc.record({
  rect: rectArb,
  windowId: fc.option(fc.integer({ min: 0, max: 99_999 }), { nil: null })
});
const pointArb = fc.record({
  x: fc.integer({ min: -400, max: 3600 }),
  y: fc.integer({ min: -400, max: 1800 })
});

describe("planCaptureSet", () => {
  it("makes one item per pick, in pick order, each from its own window", () => {
    const items = planCaptureSet({
      picks: [
        { rect: { x: 100, y: 100, w: 800, h: 600 }, windowId: 41 },
        { rect: { x: 2600, y: -100, w: 700, h: 500 }, windowId: 42 }
      ],
      displays: DESK,
      snapshotDisplayIds: ALL_SNAPSHOTS,
      preferDisplayId: LAPTOP.id,
      cursor: null
    });
    expect(items).toEqual([
      {
        pickIndex: 0,
        rect: { x: 100, y: 100, w: 800, h: 600 },
        windowId: 41,
        displayId: LAPTOP.id,
        extraDisplayIds: [],
        cursor: false
      },
      {
        pickIndex: 1,
        rect: { x: 2600, y: -100, w: 700, h: 500 },
        windowId: 42,
        displayId: EXTERNAL.id,
        extraDisplayIds: [],
        cursor: false
      }
    ]);
  });

  it("files a straddling window under the display holding most of it", () => {
    // 1000..1900: 440 pt on the laptop, 460 on the external.
    const [item] = planCaptureSet({
      picks: [{ rect: { x: 1000, y: 100, w: 900, h: 400 }, windowId: 7 }],
      displays: DESK,
      snapshotDisplayIds: ALL_SNAPSHOTS,
      preferDisplayId: LAPTOP.id,
      cursor: null
    });
    expect(item?.displayId).toBe(EXTERNAL.id);
    expect(item?.extraDisplayIds).toEqual([LAPTOP.id]);
  });

  it("gives the cursor to the first pick holding it, never to two", () => {
    // A dialog over its parent: both rects hold the pointer.
    const items = planCaptureSet({
      picks: [
        { rect: { x: 2000, y: 0, w: 300, h: 200 }, windowId: 1 },
        { rect: { x: 100, y: 100, w: 800, h: 600 }, windowId: 2 },
        { rect: { x: 300, y: 300, w: 200, h: 100 }, windowId: 3 }
      ],
      displays: DESK,
      snapshotDisplayIds: ALL_SNAPSHOTS,
      preferDisplayId: LAPTOP.id,
      cursor: { x: 350, y: 350 }
    });
    expect(items.map((i) => i.cursor)).toEqual([false, true, false]);
  });

  it("drops a pick no captured display shows", () => {
    const items = planCaptureSet({
      picks: [
        { rect: { x: 100, y: 100, w: 100, h: 100 }, windowId: 1 },
        { rect: { x: 2000, y: 0, w: 100, h: 100 }, windowId: 2 }
      ],
      displays: DESK,
      // The external's snapshot is gone.
      snapshotDisplayIds: new Set([LAPTOP.id, BELOW.id]),
      preferDisplayId: LAPTOP.id,
      cursor: null
    });
    expect(items.map((i) => i.pickIndex)).toEqual([0]);
  });

  it("plans every pick it can, in order, from exactly the displays it touches (property)", () => {
    fc.assert(
      fc.property(
        fc.array(pickArb, { minLength: 2, maxLength: 8 }),
        fc.subarray(DESK.map((d) => d.id), { minLength: 1 }),
        fc.constantFrom(...DESK.map((d) => d.id)),
        (picks, snapshotIds, prefer) => {
          const snapshots = new Set(snapshotIds);
          const usable = DESK.filter((d) => snapshots.has(d.id));
          const items = planCaptureSet({
            picks,
            displays: DESK,
            snapshotDisplayIds: snapshots,
            preferDisplayId: prefer,
            cursor: null
          });
          // Oracle: a pick is kept iff some snapshotted display overlaps it.
          const expectedIndexes = picks
            .map((p, i) => ({ p, i }))
            .filter(({ p }) =>
              usable.some(
                (d) =>
                  intersectRects(p.rect, {
                    x: d.bounds.x,
                    y: d.bounds.y,
                    w: d.bounds.width,
                    h: d.bounds.height
                  }) !== null
              )
            )
            .map(({ i }) => i);
          expect(items.map((i) => i.pickIndex)).toEqual(expectedIndexes);
          for (const item of items) {
            const pick = picks[item.pickIndex]!;
            expect(item.rect).toEqual(pick.rect);
            expect(item.windowId).toBe(pick.windowId);
            const touched = usable
              .filter(
                (d) =>
                  intersectRects(item.rect, {
                    x: d.bounds.x,
                    y: d.bounds.y,
                    w: d.bounds.width,
                    h: d.bounds.height
                  }) !== null
              )
              .map((d) => d.id);
            // Home + extras are exactly the touched displays, home once.
            expect([item.displayId, ...item.extraDisplayIds].sort()).toEqual([...touched].sort());
            expect(item.extraDisplayIds).not.toContain(item.displayId);
            // Home holds at least as much of the pick as any other display.
            const share = (id: number): number => {
              const d = DESK.find((x) => x.id === id)!;
              return area(
                intersectRects(item.rect, {
                  x: d.bounds.x,
                  y: d.bounds.y,
                  w: d.bounds.width,
                  h: d.bounds.height
                })
              );
            };
            for (const other of item.extraDisplayIds) {
              expect(share(item.displayId)).toBeGreaterThanOrEqual(share(other));
            }
          }
        }
      ),
      { numRuns: 400 }
    );
  });

  it("a set item on one display is planned exactly like a lone pick of it (oracle)", () => {
    // The promise behind "byte-identical to picking that window alone":
    // same home display, no other snapshot, so the handler takes the
    // same single-snapshot crop. Oracle: planSessionCommit for a lone
    // pick committed from that display.
    fc.assert(
      fc.property(fc.array(pickArb, { minLength: 2, maxLength: 6 }), (picks) => {
        const items = planCaptureSet({
          picks,
          displays: DESK,
          snapshotDisplayIds: ALL_SNAPSHOTS,
          preferDisplayId: LAPTOP.id,
          cursor: null
        });
        for (const item of items.filter((i) => i.extraDisplayIds.length === 0)) {
          const lone = planSessionCommit({
            committingDisplayId: item.displayId,
            rect: item.rect,
            mergePeers: false,
            localPicks: [],
            peerPicks: new Map(),
            pickOrder: [],
            sessionOutputMode: "windows",
            displays: DESK,
            snapshotDisplayIds: ALL_SNAPSHOTS
          });
          expect(lone).not.toBeNull();
          expect(lone!.displayId).toBe(item.displayId);
          expect(lone!.extraDisplayIds).toEqual([]);
          expect(lone!.rect).toEqual(item.rect);
        }
      }),
      { numRuns: 400 }
    );
  });

  it("draws the cursor at most once, on the first kept pick that holds it (property)", () => {
    fc.assert(
      fc.property(fc.array(pickArb, { minLength: 2, maxLength: 8 }), pointArb, (picks, cursor) => {
        const items = planCaptureSet({
          picks,
          displays: DESK,
          snapshotDisplayIds: ALL_SNAPSHOTS,
          preferDisplayId: LAPTOP.id,
          cursor
        });
        const withCursor = items.filter((i) => i.cursor);
        expect(withCursor.length).toBeLessThanOrEqual(1);
        const expected = items.find((i) => contains(i.rect, cursor));
        expect(withCursor[0]?.pickIndex).toBe(expected?.pickIndex);
        // No cursor sample → no item draws one.
        const none = planCaptureSet({
          picks,
          displays: DESK,
          snapshotDisplayIds: ALL_SNAPSHOTS,
          preferDisplayId: LAPTOP.id,
          cursor: null
        });
        expect(none.some((i) => i.cursor)).toBe(false);
      }),
      { numRuns: 400 }
    );
  });
});

describe("captureSetPicks", () => {
  it("pairs each extent with its window, and display picks with none", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 20, y: 0, w: 10, h: 10 };
    const c = { x: 40, y: 0, w: 10, h: 10 };
    expect(captureSetPicks([a, b, c], [5, -1, null])).toEqual([
      { rect: a, windowId: 5 },
      { rect: b, windowId: null },
      { rect: c, windowId: null }
    ]);
    // Ids missing altogether: every item resolves its app by rect.
    expect(captureSetPicks([a, b], undefined)).toEqual([
      { rect: a, windowId: null },
      { rect: b, windowId: null }
    ]);
  });
});
