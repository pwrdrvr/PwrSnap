// Lock the one number the trim timeline's ruler and its strip must
// agree on.
//
// `VideoTimeline` positions the handles, the scrims, the tooltip AND
// the ticks with the same px↔sec math, against a width measured from
// `.vtl__strip`'s PADDING box (`clientWidth` — see the measure in
// VideoTimeline.tsx for why it is that box and not the rect). The
// handles live INSIDE the strip, so they inherit that origin for free.
// The ticks do not: `.vtl__ticks` is a SIBLING, stretched to the full
// content width of `.vtl`, which is the strip's BORDER box. Its inline
// margin is what pulls it back onto the strip's padding box, so that
// margin has to equal the strip's border width — one number, declared
// in two rules, with nothing but proximity relating them.
//
// Why a test rather than a comment:
//
//   • The two declarations are ~120 lines apart in the stylesheet and
//     read as unrelated. Changing `.vtl__strip`'s border is an ordinary
//     visual tweak; nothing about it suggests you must also touch a
//     margin on a different element.
//
//   • A jsdom render cannot catch it. jsdom resolves no layout, so the
//     ticks and the strip both measure 0 and agree perfectly — the same
//     reason `recording-frame-css-boundary.test.ts` next door reads the
//     shipped CSS as bytes instead of rendering it.
//
//   • The symptom is a sub-pixel-to-2px drift between a ruler and the
//     thing it labels. Nobody files that bug; it just quietly makes the
//     timecodes wrong at the right-hand end.
//
// It compares the two extracted numbers rather than asserting literals,
// so widening the border stays a one-line change — the test then tells
// you the second line it also has to be.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { extractBlock, stripCssComments } from "./css-block";

const LABEL = "video-timeline-contract";
const css = stripCssComments(
  readFileSync(join(__dirname, "..", "video-timeline.css"), "utf8")
);

/** `border: 1px solid var(--x)` → 1. Throws rather than returning a
 *  default: a shorthand this parser stopped understanding must fail the
 *  suite, not silently report a zero-width border that matches a
 *  zero-width margin. */
function borderWidthPx(block: string, label: string): number {
  const match = block.match(/(?:^|[;{]|\s)border\s*:\s*([\d.]+)px\b/);
  if (match === null) {
    throw new Error(`${label}: no \`border: <n>px …\` shorthand in this block`);
  }
  return Number(match[1]);
}

/** `margin: 0 1px` → 1 (the inline half of the two-value shorthand). */
function inlineMarginPx(block: string, label: string): number {
  const match = block.match(/(?:^|[;{]|\s)margin\s*:\s*[\d.]+(?:px)?\s+([\d.]+)px\s*;/);
  if (match === null) {
    throw new Error(`${label}: no two-value \`margin: <block> <inline>px\` in this block`);
  }
  return Number(match[1]);
}

// Anchored to the line start so it takes the BASE rule and not
// `.vtl--compact .vtl__strip`, which also ends in `.vtl__strip`.
const BASE_STRIP = "\\n\\.vtl__strip";

describe("video timeline: the ruler shares the strip's coordinate space", () => {
  test("`.vtl__ticks` inline margin equals `.vtl__strip`'s border width", () => {
    const strip = extractBlock(css, BASE_STRIP, { label: LABEL, expectSingle: true });
    const ticks = extractBlock(css, "\\.vtl__ticks", { label: LABEL, expectSingle: true });

    expect(inlineMarginPx(ticks, LABEL)).toBe(borderWidthPx(strip, LABEL));
  });

  // The base rule is only the whole story while nothing overrides it.
  // The compact variant already re-declares `border-radius` on this
  // element, so a `border` is one plausible line away.
  test("no variant overrides the strip border the ruler is aligned to", () => {
    const compact = extractBlock(css, "\\.vtl--compact \\.vtl__strip", {
      label: LABEL,
      expectSingle: true
    });
    expect(compact).not.toMatch(/(?:^|[;{]|\s)border(?:-inline|-left|-right|-width)?\s*:/);
  });

  // The margin only lands the ticks on the padding box if there is no
  // padding to also account for — and `clientWidth`, which sizes the
  // math, IS the padding box, so padding would shift the handles too
  // while leaving the ticks behind. Catch it here rather than as a
  // mystery drift.
  test("`.vtl__strip` declares no padding, which the tick margin assumes", () => {
    const strip = extractBlock(css, BASE_STRIP, { label: LABEL, expectSingle: true });
    expect(strip).not.toMatch(/(?:^|[;{]|\s)padding(?:-inline|-left|-right)?\s*:/);
  });
});

// The drag tooltip sits in `.vtl__strip-wrap` rather than in the strip
// purely so the strip's `overflow: hidden` cannot clip it — and
// VideoTimeline.tsx converts the tip's `left` out of the strip's padding
// box using `clientLeft` alone. Both facts are assumptions about this
// wrapper, and both fail silently: a clip here puts the tooltip straight
// back where it was, and a border or padding here offsets it by exactly
// the amount nothing measures.
describe("video timeline: the tooltip's wrapper stays transparent", () => {
  const WRAP = "\\.vtl__strip-wrap";

  test("does not clip — that is the entire reason it exists", () => {
    const wrap = extractBlock(css, WRAP, { label: LABEL, expectSingle: true });
    const overflow = wrap.match(/(?:^|[;{]|\s)overflow(?:-x|-y)?\s*:\s*([^;]+)/);
    // Absent is correct (`visible` is the initial value); an explicit
    // `visible` is fine too. Anything else re-clips the tip.
    expect(overflow?.[1]?.trim() ?? "visible").toBe("visible");
  });

  test("contributes no border or padding of its own", () => {
    const wrap = extractBlock(css, WRAP, { label: LABEL, expectSingle: true });
    expect(wrap).not.toMatch(/(?:^|[;{]|\s)border(?:-inline|-left|-right|-width)?\s*:/);
    expect(wrap).not.toMatch(/(?:^|[;{]|\s)padding(?:-inline|-left|-right)?\s*:/);
  });

  test("establishes the containing block the tip is positioned against", () => {
    const wrap = extractBlock(css, WRAP, { label: LABEL, expectSingle: true });
    expect(wrap).toMatch(/(?:^|[;{]|\s)position\s*:\s*relative\s*;/);
  });
});
