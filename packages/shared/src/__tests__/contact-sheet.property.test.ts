// Property tests for the contact sheet layout. The rules a sheet must keep
// whatever the cart holds: every image gets exactly one tile, inside its own
// cell, inside the sheet, never overlapping another, at its own aspect ratio,
// never upscaled past its pixels, in cart order, and the sheet never exceeds
// the width asked for or the size caps.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  CONTACT_SHEET_AUTO_ASPECT,
  CONTACT_SHEET_MAX_COLUMNS,
  CONTACT_SHEET_MAX_HEIGHT,
  CONTACT_SHEET_MAX_PIXELS,
  CONTACT_SHEET_WIDTHS,
  contactSheetGap,
  planContactSheet,
  resolveContactSheetColumns,
  type ContactSheetColumns,
  type ContactSheetSpacing
} from "../contact-sheet";

const imageArb = fc.record({
  width: fc.integer({ min: 1, max: 8000 }),
  height: fc.integer({ min: 1, max: 8000 })
});
const columnsArb: fc.Arbitrary<ContactSheetColumns> = fc.oneof(
  fc.constant("auto" as const),
  fc.integer({ min: 1, max: CONTACT_SHEET_MAX_COLUMNS })
);
const spacingArb = fc.constantFrom<ContactSheetSpacing>("none", "tight", "roomy");
const widthArb = fc.oneof(
  fc.constantFrom(...Object.values(CONTACT_SHEET_WIDTHS)),
  fc.integer({ min: 8, max: 6000 })
);

const planArb = fc.record({
  images: fc.array(imageArb, { minLength: 1, maxLength: 200 }),
  widthPx: widthArb,
  columns: columnsArb,
  spacing: spacingArb
});

describe("planContactSheet", () => {
  test("every image gets one tile, inside its cell and the sheet, in cart order, with no overlap", () => {
    fc.assert(
      fc.property(planArb, (args) => {
        const plan = planContactSheet(args);
        expect(plan.tiles).toHaveLength(args.images.length);
        expect(plan.columns).toBeGreaterThanOrEqual(1);
        expect(plan.columns).toBeLessThanOrEqual(Math.min(args.images.length, CONTACT_SHEET_MAX_COLUMNS));
        expect(plan.rows).toBe(Math.ceil(args.images.length / plan.columns));
        for (const [index, tile] of plan.tiles.entries()) {
          const col = index % plan.columns;
          const row = Math.floor(index / plan.columns);
          const cellX = plan.padding + col * (plan.cellWidth + plan.gap);
          const cellY = plan.padding + row * (plan.cellHeight + plan.gap);
          expect(tile.width).toBeGreaterThanOrEqual(1);
          expect(tile.height).toBeGreaterThanOrEqual(1);
          expect(tile.x).toBeGreaterThanOrEqual(cellX);
          expect(tile.y).toBeGreaterThanOrEqual(cellY);
          expect(tile.x + tile.width).toBeLessThanOrEqual(cellX + plan.cellWidth);
          expect(tile.y + tile.height).toBeLessThanOrEqual(cellY + plan.cellHeight);
          expect(tile.x + tile.width).toBeLessThanOrEqual(plan.width);
          expect(tile.y + tile.height).toBeLessThanOrEqual(plan.height);
        }
        // Cells are disjoint and each tile is inside its own cell, so tiles
        // cannot overlap; check it directly anyway on small carts.
        if (plan.tiles.length <= 30) {
          for (let a = 0; a < plan.tiles.length; a++) {
            for (let b = a + 1; b < plan.tiles.length; b++) {
              const ta = plan.tiles[a]!;
              const tb = plan.tiles[b]!;
              const overlap =
                ta.x < tb.x + tb.width && tb.x < ta.x + ta.width && ta.y < tb.y + tb.height && tb.y < ta.y + ta.height;
              expect(overlap).toBe(false);
            }
          }
        }
      }),
      { numRuns: 300 }
    );
  });

  test("never wider than asked for, and within the height and pixel caps", () => {
    fc.assert(
      fc.property(planArb, (args) => {
        const plan = planContactSheet(args);
        expect(plan.width).toBeLessThanOrEqual(Math.max(plan.columns, args.widthPx));
        expect(plan.height).toBeLessThanOrEqual(CONTACT_SHEET_MAX_HEIGHT);
        expect(plan.width * plan.height).toBeLessThanOrEqual(CONTACT_SHEET_MAX_PIXELS);
      }),
      { numRuns: 300 }
    );
  });

  test("a tile keeps its image's aspect ratio (to the pixel) and is never upscaled", () => {
    fc.assert(
      fc.property(planArb, (args) => {
        const plan = planContactSheet(args);
        for (const [index, tile] of plan.tiles.entries()) {
          const image = args.images[index]!;
          expect(tile.width).toBeLessThanOrEqual(image.width);
          expect(tile.height).toBeLessThanOrEqual(image.height);
          // Rounding one side to a whole pixel moves the other by < 1 px of
          // the true contain size (plus the 1 px floor).
          const scale = Math.min(plan.cellWidth / image.width, plan.cellHeight / image.height, 1);
          expect(Math.abs(tile.width - image.width * scale)).toBeLessThanOrEqual(1);
          expect(Math.abs(tile.height - image.height * scale)).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 300 }
    );
  });

  test("unless the caps bound, a cell is the column's share of the request or the widest image", () => {
    fc.assert(
      fc.property(planArb, (args) => {
        const plan = planContactSheet(args);
        if (plan.scaledDown) return;
        const width = Math.max(plan.columns, args.widthPx);
        const gap = contactSheetGap(width, args.spacing);
        const share = Math.floor((width - 2 * gap - (plan.columns - 1) * gap) / plan.columns);
        const widest = Math.max(...args.images.map((image) => image.width));
        expect(plan.cellWidth).toBe(Math.max(1, Math.min(widest, share)));
      }),
      { numRuns: 300 }
    );
  });

  test("a sheet past the height cap is narrowed and says so", () => {
    // 200 tall phone shots in 2 columns cannot fit 16384 px at 2400 wide.
    const plan = planContactSheet({
      images: Array.from({ length: 200 }, () => ({ width: 1170, height: 2532 })),
      widthPx: 2400,
      columns: 2,
      spacing: "tight"
    });
    expect(plan.scaledDown).toBe(true);
    expect(plan.height).toBeLessThanOrEqual(CONTACT_SHEET_MAX_HEIGHT);
    expect(plan.width).toBeLessThan(2400);
  });

  test("small snaps are not floated in oversized cells", () => {
    const plan = planContactSheet({
      images: [
        { width: 300, height: 200 },
        { width: 400, height: 300 }
      ],
      widthPx: 3600,
      columns: "auto",
      spacing: "none"
    });
    expect(plan.cellWidth).toBe(400);
    expect(plan.width).toBe(800);
  });

  test("auto columns pick the count whose grid is closest to 3:2 (brute-force oracle)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.double({ min: 0.05, max: 20, noNaN: true }),
        (n, aspect) => {
          const chosen = resolveContactSheetColumns("auto", n, aspect);
          const distance = (cols: number): number =>
            Math.abs(Math.log((cols * aspect) / Math.ceil(n / cols) / CONTACT_SHEET_AUTO_ASPECT));
          for (let cols = 1; cols <= Math.min(n, CONTACT_SHEET_MAX_COLUMNS); cols++) {
            expect(distance(chosen)).toBeLessThanOrEqual(distance(cols) + 1e-9);
          }
        }
      )
    );
  });

  test("explicit columns are honored up to the image count", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 8 }), (n, cols) => {
        expect(resolveContactSheetColumns(cols, n, 1.5)).toBe(Math.min(n, cols));
      })
    );
  });

  test("auto columns land the sheet near 3:2 for same-shape screenshots", () => {
    // 12 16:10 screenshots: 3 × 4 is 1.2:1 and 4 × 3 is 2.13:1, so 3 columns.
    const plan = planContactSheet({
      images: Array.from({ length: 12 }, () => ({ width: 1600, height: 1000 })),
      widthPx: 2400,
      columns: "auto",
      spacing: "tight"
    });
    expect(plan.columns).toBe(3);
    expect(plan.rows).toBe(4);
  });

  test("an empty cart has no sheet", () => {
    expect(() =>
      planContactSheet({ images: [], widthPx: 2400, columns: "auto", spacing: "tight" })
    ).toThrow();
  });
});
