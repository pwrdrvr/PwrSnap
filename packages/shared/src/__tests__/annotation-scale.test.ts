// The annotation ladder's regression suite.
//
// Two halves, doing different jobs:
//
//   1. PROPERTIES — the invariants that must hold for ANY capture
//      shape, expressed over a matrix of realistic dimensions. These
//      are what stop the whole class of bug this module was written
//      for: an annotation that reads smaller than the UI text it is
//      annotating, or a preset ladder with a rung missing.
//
//   2. THE TABLE — a printed size matrix. Deliberately hardcoded, so
//      retuning any constant shows up in review as a diff of actual
//      rendered pixel sizes across the capture shapes users have,
//      rather than as a one-line constant change whose consequences
//      you have to hold in your head. If you change a divisor, run
//      the suite, read the new table, and decide whether every row
//      still looks right.
//
// The dimension matrix is the same one the visual eval harness renders
// (`apps/desktop/scripts/annotation-scale-eval.mjs`) — numbers here,
// pixels there.

import { describe, expect, test } from "vitest";
import {
  ANNOTATION_BASIS_FLOOR_PX,
  ANNOTATION_STROKE_DIVISORS,
  ANNOTATION_TEXT_DIVISORS,
  annotationBasisPx,
  annotationStrokeWidthPx,
  annotationTextSizePx,
  type AnnotationSizePreset
} from "../annotation-scale";

/** Realistic capture shapes, with the UI text height a screenshot of
 *  that kind actually contains. `uiTextPx` is the reference an
 *  annotation has to hold its own against — ~15 px for a 1× capture,
 *  ~30 px for a 2× (Retina) one, because UI text size is a property of
 *  the DISPLAY, not of the crop rectangle. */
const CAPTURES: ReadonlyArray<{
  name: string;
  w: number;
  h: number;
  uiTextPx: number;
}> = [
  // The capture that prompted this work: a Slack notification grab.
  // Short side 207 → a "medium" text used to render at 6.9 px, less
  // than half the 15 px Slack message font beside it.
  { name: "Slack notification strip (1x)", w: 777, h: 207, uiTextPx: 15 },
  { name: "Tiny button crop (1x)", w: 200, h: 80, uiTextPx: 15 },
  { name: "Small dialog crop (2x)", w: 473, h: 178, uiTextPx: 30 },
  { name: "Toolbar strip (2x)", w: 2212, h: 249, uiTextPx: 30 },
  { name: "Tall sidebar (2x)", w: 366, h: 832, uiTextPx: 30 },
  { name: "Phone screenshot (portrait)", w: 1080, h: 2400, uiTextPx: 30 },
  { name: "App window (1x)", w: 1200, h: 800, uiTextPx: 15 },
  { name: "App window (2x)", w: 1876, h: 1410, uiTextPx: 30 },
  { name: "1080p full screen (1x)", w: 1920, h: 1080, uiTextPx: 15 },
  { name: "MacBook full screen (2x)", w: 2880, h: 1800, uiTextPx: 30 },
  { name: "5K full screen (2x)", w: 5120, h: 2880, uiTextPx: 30 }
];

const PRESETS: readonly AnnotationSizePreset[] = [
  "small",
  "medium",
  "large",
  "x-large"
];

describe("annotationBasisPx", () => {
  test("is the max of its three terms, and each term wins somewhere", () => {
    // Floor branch — a capture too small to scale from.
    expect(annotationBasisPx(200, 80)).toBe(ANNOTATION_BASIS_FLOOR_PX);
    // Short-side branch — anything squarer than ~1.73:1.
    expect(annotationBasisPx(2000, 2000)).toBe(2000);
    expect(annotationBasisPx(1200, 1000)).toBe(1000);
    // Diagonal branch — wide-short and tall-thin captures, where the
    // short side stops describing how big the image reads.
    expect(annotationBasisPx(2212, 249)).toBeCloseTo(
      Math.hypot(2212, 249) / 2,
      5
    );
    expect(annotationBasisPx(1080, 2400)).toBeCloseTo(
      Math.hypot(1080, 2400) / 2,
      5
    );
  });

  test("hands over from short side to diagonal/2 at ~1.73:1 aspect", () => {
    // short = diag/2 exactly when long = sqrt(3) x short. Below that
    // the short side is the larger term; above it the diagonal is.
    const short = 1000;
    const crossover = short * Math.sqrt(3);
    expect(annotationBasisPx(crossover * 0.9, short)).toBeCloseTo(short, 5);
    expect(annotationBasisPx(crossover * 1.1, short)).toBeGreaterThan(short);
  });

  test("is symmetric in width and height", () => {
    for (const { w, h } of CAPTURES) {
      expect(annotationBasisPx(w, h)).toBeCloseTo(annotationBasisPx(h, w), 9);
    }
  });

  test("is monotonic: growing either dimension never shrinks the basis", () => {
    for (const { w, h } of CAPTURES) {
      const base = annotationBasisPx(w, h);
      expect(annotationBasisPx(w * 1.2, h)).toBeGreaterThanOrEqual(base);
      expect(annotationBasisPx(w, h * 1.2)).toBeGreaterThanOrEqual(base);
    }
  });

  test("is continuous across the floor handover (no size cliff)", () => {
    // Two captures a hair apart in dimensions must not produce a
    // visible jump in annotation size.
    const justUnder = annotationBasisPx(1000, ANNOTATION_BASIS_FLOOR_PX - 1);
    const justOver = annotationBasisPx(1000, ANNOTATION_BASIS_FLOOR_PX + 1);
    expect(justOver - justUnder).toBeLessThan(2);
  });

  test("survives degenerate dims without throwing or returning NaN", () => {
    for (const [w, h] of [
      [0, 0],
      [-5, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100]
    ] as const) {
      const basis = annotationBasisPx(w, h);
      expect(Number.isFinite(basis) || basis === Number.POSITIVE_INFINITY).toBe(
        true
      );
      expect(basis).toBeGreaterThanOrEqual(ANNOTATION_BASIS_FLOOR_PX);
    }
  });
});

describe("the ladders", () => {
  test("both ladders are strictly ascending with an even geometric step", () => {
    // The specific defect this pins: the OLD stroke ladder stepped
    // 1.5x / 2.7x / 1.7x on 1080p, because Small and Medium were
    // pinned to an absolute 4px auto-stroke clamp while Large and
    // X-Large escaped through short-side floor fractions.
    for (const divisors of [
      ANNOTATION_STROKE_DIVISORS,
      ANNOTATION_TEXT_DIVISORS
    ]) {
      const steps = PRESETS.slice(1).map(
        (p, i) => divisors[PRESETS[i] as AnnotationSizePreset] / divisors[p]
      );
      for (const step of steps) expect(step).toBeGreaterThan(1.4);
      // Every step within 10% of every other step.
      expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.1);
    }
  });

  test("no capture shape collapses two presets onto one size", () => {
    // Pre-fix, EVERY capture under an 880px short side produced
    // small = 2px and medium = 4px — identical numbers for a 200x80
    // crop and a 1200x800 window alike.
    for (const { name, w, h } of CAPTURES) {
      const basis = annotationBasisPx(w, h);
      for (const kind of ["stroke", "text"] as const) {
        const resolve =
          kind === "stroke" ? annotationStrokeWidthPx : annotationTextSizePx;
        const sizes = PRESETS.map((p) => resolve(p, basis));
        for (let i = 1; i < sizes.length; i += 1) {
          expect(
            (sizes[i] as number) / (sizes[i - 1] as number),
            `${name} ${kind}: ${PRESETS[i - 1]} -> ${PRESETS[i]} must be a visible step`
          ).toBeGreaterThan(1.4);
        }
      }
    }
  });

  test("Medium text always reads at or above the UI text beside it", () => {
    // The reported bug, stated as an invariant. A medium annotation is
    // the default an unconfigured user gets; it must never render
    // smaller than the interface it is pointing at.
    for (const { name, w, h, uiTextPx } of CAPTURES) {
      const medium = annotationTextSizePx("medium", annotationBasisPx(w, h));
      expect(
        medium,
        `${name}: medium text ${medium.toFixed(1)}px vs ${uiTextPx}px UI text`
      ).toBeGreaterThanOrEqual(uiTextPx);
    }
  });

  test("even Small text stays legible next to the UI text", () => {
    // Small is allowed to be smaller than the UI text — that is what
    // makes it Small — but not by so much that it stops reading.
    for (const { name, w, h, uiTextPx } of CAPTURES) {
      const small = annotationTextSizePx("small", annotationBasisPx(w, h));
      expect(
        small / uiTextPx,
        `${name}: small text ${small.toFixed(1)}px vs ${uiTextPx}px UI text`
      ).toBeGreaterThan(0.5);
    }
  });

  test("an X-Large stroke is unmistakably heavier than a Small one", () => {
    for (const { w, h } of CAPTURES) {
      const basis = annotationBasisPx(w, h);
      expect(
        annotationStrokeWidthPx("x-large", basis) /
          annotationStrokeWidthPx("small", basis)
      ).toBeGreaterThan(3);
    }
  });

  test("stroke widths stay proportional to text on the same rung", () => {
    // A Medium arrow next to Medium text should look like the same
    // weight of mark. Ratio is scale-free, so one assertion covers
    // every capture.
    for (const preset of PRESETS) {
      const ratio =
        ANNOTATION_TEXT_DIVISORS[preset] / ANNOTATION_STROKE_DIVISORS[preset];
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(0.4);
    }
  });
});

describe("size matrix (hardcoded — re-read this table when retuning)", () => {
  // Each row: [capture, basis, textS/M/L/XL, strokeS/M/L/XL] in pixels,
  // rounded to 0.1. Regenerate with the printed table below.
  const EXPECTED: ReadonlyArray<readonly [string, number, number[], number[]]> = [
    ["Slack notification strip (1x)", 900, [18, 30, 50, 81.8], [5.6, 8.6, 13.2, 20.5]],
    ["Tiny button crop (1x)", 900, [18, 30, 50, 81.8], [5.6, 8.6, 13.2, 20.5]],
    ["Small dialog crop (2x)", 900, [18, 30, 50, 81.8], [5.6, 8.6, 13.2, 20.5]],
    ["Toolbar strip (2x)", 1113, [22.3, 37.1, 61.8, 101.2], [7, 10.6, 16.4, 25.3]],
    ["Tall sidebar (2x)", 900, [18, 30, 50, 81.8], [5.6, 8.6, 13.2, 20.5]],
    ["Phone screenshot (portrait)", 1315.9, [26.3, 43.9, 73.1, 119.6], [8.2, 12.5, 19.4, 29.9]],
    ["App window (1x)", 900, [18, 30, 50, 81.8], [5.6, 8.6, 13.2, 20.5]],
    ["App window (2x)", 1410, [28.2, 47, 78.3, 128.2], [8.8, 13.4, 20.7, 32]],
    ["1080p full screen (1x)", 1101.5, [22, 36.7, 61.2, 100.1], [6.9, 10.5, 16.2, 25]],
    ["MacBook full screen (2x)", 1800, [36, 60, 100, 163.6], [11.3, 17.1, 26.5, 40.9]],
    ["5K full screen (2x)", 2937.2, [58.7, 97.9, 163.2, 267], [18.4, 28, 43.2, 66.8]]
  ];

  const round = (n: number): number => Math.round(n * 10) / 10;

  test("matches the recorded matrix", () => {
    const rows = CAPTURES.map(({ name, w, h }) => {
      const basis = annotationBasisPx(w, h);
      return [
        name,
        round(basis),
        PRESETS.map((p) => round(annotationTextSizePx(p, basis))),
        PRESETS.map((p) => round(annotationStrokeWidthPx(p, basis)))
      ] as const;
    });
    expect(rows).toEqual(EXPECTED);
  });

  test("prints the matrix (read it on failure, or with --reporter=verbose)", () => {
    const lines = CAPTURES.map(({ name, w, h, uiTextPx }) => {
      const basis = annotationBasisPx(w, h);
      const text = PRESETS.map((p) =>
        round(annotationTextSizePx(p, basis)).toFixed(1).padStart(6)
      ).join("");
      const stroke = PRESETS.map((p) =>
        round(annotationStrokeWidthPx(p, basis)).toFixed(1).padStart(6)
      ).join("");
      return `${name.padEnd(30)}${`${w}x${h}`.padEnd(11)}ui=${String(uiTextPx).padStart(2)}  basis=${round(basis).toFixed(0).padStart(5)}  text:${text}  stroke:${stroke}`;
    });
    // packages/shared compiles with `"types": []` (no Node, no DOM), so
    // `console` isn't a declared global here — reach it the same way
    // `readOverlayThickness` does.
    const con = (globalThis as { console?: { log(msg: string): void } }).console;
    con?.log(
      [
        "",
        `${"capture".padEnd(30)}${"dims".padEnd(11)}       ${"".padEnd(13)}   S     M     L    XL`,
        ...lines,
        ""
      ].join("\n")
    );
    expect(lines.length).toBe(CAPTURES.length);
  });
});
