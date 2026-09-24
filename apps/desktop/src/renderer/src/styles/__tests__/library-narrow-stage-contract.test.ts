// Lock the narrow-Library stage contract: the floating edit toolbar goes
// icon-only and stays out of the ←/→ columns when the stage is small, the
// collapsed nav leaves the Tab order, and a popped rail stacks above the
// center pane's floating chrome.
//
// Why this needs a test rather than a code comment:
//
//   • Every failure here is silent. `.psl__stage-wrap` is
//     `overflow: hidden`, so a toolbar taller than the stage is simply not
//     painted past the edge — no scrollbar, nothing in a log. That
//     shipped: in Reel at the 480×480 minimum window the toolbar wrapped
//     to 196×330 inside a 220×249 stage, the grip, Pointer and Arrow were
//     clipped off the top, and it painted over both ←/→ buttons.
//
//   • jsdom has no layout, so no render test can see any of it. The
//     numbers below are what the layout depends on; the thresholds are
//     derived from them rather than restated, so moving the nav buttons
//     or growing the tool buttons fails here instead of in a user's
//     window. Measure changes in a real browser against the built CSS.
//
// Reads the CSS as strings, like the other contract suites here — see
// ./css-block for why comments are stripped before any block lookup.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBlock, stripCssComments } from "./css-block";

const LABEL = "library-narrow-stage-contract";
const css = stripCssComments(readFileSync(join(__dirname, "..", "library.css"), "utf8"));

function block(selectorPattern: string): string {
  return extractBlock(css, selectorPattern, { label: LABEL, expectSingle: true });
}

function px(body: string, property: string): number {
  const match = body.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px\\s*;`));
  if (match === null) throw new Error(`${LABEL}: no px ${property} in block`);
  return Number(match[1]);
}

function zIndex(body: string): number {
  const match = body.match(/z-index\s*:\s*(-?\d+)\s*;/);
  if (match === null) throw new Error(`${LABEL}: no z-index in block`);
  return Number(match[1]);
}

/** The body of the one `@container psl-stage …` rule, nested blocks and
 *  all — `extractBlock` stops at the first `}`. */
function containerRule(): { prelude: string; body: string } {
  const start = css.indexOf("@container psl-stage");
  expect(start, `${LABEL}: no @container psl-stage rule`).toBeGreaterThanOrEqual(0);
  expect(css.indexOf("@container psl-stage", start + 1), `${LABEL}: expected one rule`).toBe(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      return { prelude: css.slice(start, open), body: css.slice(open + 1, i) };
    }
  }
  throw new Error(`${LABEL}: unbalanced @container rule`);
}

// The nav buttons' geometry, read from the stylesheet itself.
const nav = block("\\.psl__stage-nav");
const NAV_SIZE = px(nav, "width");
const NAV_INSET = px(block("\\.psl__stage-nav\\.is-prev"), "left");
// Default focus ring (outline) width + a hairline of air.
const NAV_RING_AND_GAP = 2;

describe("the stage is the edit toolbar's query container", () => {
  it("declares a named SIZE container on the base .psl__stage-wrap rule", () => {
    // `\}` anchors the standalone rule, not `.psl__focus, .psl__stage-wrap`
    // or `.psl__reel-mode .psl__stage-wrap`.
    const wrap = block("\\}\\s*\\.psl__stage-wrap");
    // SIZE, not inline-size: Reel under its filmstrip is 249px tall at
    // the 480px minimum window height however wide the stage is.
    expect(wrap).toMatch(/container\s*:\s*psl-stage\s*\/\s*size\s*;/);
  });

  it("the ←/→ buttons Prev and Next are mirror images", () => {
    expect(px(block("\\.psl__stage-nav\\.is-next"), "right")).toBe(NAV_INSET);
  });
});

describe("compact edit toolbar", () => {
  const rule = containerRule();

  it("switches on a narrow OR short stage", () => {
    expect(rule.prelude).toMatch(/\(\s*width\s*<\s*\d+px\s*\)\s*or\s*\(\s*height\s*<\s*\d+px\s*\)/);
  });

  it("the height threshold keeps two labelled rows clear of the ←/→ buttons", () => {
    // Above the threshold the toolbar keeps its labels and is at most two
    // rows (the width threshold sees to that). It is bottom-anchored, and
    // the nav buttons are centred, so it clears them only when
    //   H − bottom − toolbarH ≥ H/2 + navSize/2 + ring
    const toolbar = block("\\}\\s*\\.psl__edit-toolbar");
    const button = block("\\}\\s*\\.psl__et-btn");
    const twoRows =
      2 * px(button, "height") +
      px(toolbar, "row-gap") +
      2 * px(toolbar, "padding") +
      2; /* 1px border, top and bottom */
    const minHeight = 2 * (px(toolbar, "bottom") + twoRows + NAV_SIZE / 2 + NAV_RING_AND_GAP);
    const threshold = Number(rule.prelude.match(/height\s*<\s*(\d+)px/)?.[1]);
    expect(threshold).toBeGreaterThanOrEqual(minHeight);
  });

  it("reserves both ←/→ columns so no number of wrapped rows can cover them", () => {
    const compactToolbar = extractBlock(rule.body, "^\\s*\\.psl__edit-toolbar", {
      label: LABEL,
      expectSingle: true
    });
    const reserve = compactToolbar.match(/max-width\s*:\s*calc\(\s*100%\s*-\s*(\d+)px\s*\)\s*;/);
    expect(reserve, `${LABEL}: compact toolbar must reserve the nav columns`).not.toBeNull();
    expect(Number(reserve?.[1])).toBeGreaterThanOrEqual(
      2 * (NAV_INSET + NAV_SIZE + NAV_RING_AND_GAP)
    );
  });

  it("hides labels visually, never from the accessible name, and never the armed Reset", () => {
    const hide = extractBlock(rule.body, "\\.psl__et-btn:not\\(\\.is-armed\\)\\s*>\\s*span", {
      label: LABEL,
      expectSingle: true
    });
    // `display: none` / `visibility: hidden` would drop "Pointer V" from
    // the button's accessible name; the armed Reset's "Confirm? · N" is
    // the second half of a destructive two-click confirm.
    expect(hide).not.toMatch(/display\s*:\s*none/);
    expect(hide).not.toMatch(/visibility\s*:\s*hidden/);
    expect(hide).toMatch(/clip-path\s*:\s*inset\(50%\)/);
  });
});

describe("collapsed left nav", () => {
  it("leaves the Tab order once it has slid off-canvas, and returns on peek", () => {
    const collapsed = block(
      '\\.psl\\[data-left="collapsed"\\] \\.psl__left,\\s*\\.psl\\[data-left="peek"\\] \\.psl__left'
    );
    expect(collapsed).toMatch(/visibility\s*:\s*hidden/);
    // The visibility step is delayed by the slide's own duration, so the
    // panel is hidden only after it has finished moving out.
    const slide = collapsed.match(/transform\s+(\d+)ms/);
    expect(slide).not.toBeNull();
    expect(collapsed).toMatch(new RegExp(`visibility\\s+0s\\s+linear\\s+${slide?.[1]}ms`));

    const peek = block('\\}\\s*\\.psl\\[data-left="peek"\\] \\.psl__left');
    expect(peek).toMatch(/visibility\s*:\s*visible/);
    expect(peek).toMatch(/visibility\s+0s\s+linear\s+0s/);
  });
});

describe("popped rail stacking", () => {
  it("stacks above the center pane's floating chrome and below the left-nav peek", () => {
    // Only while popped: a lift on the idle 38px icon bar would cover the
    // edit toolbar's style popover where it clamps into the rail column.
    const rail = block(
      '\\.psl\\[data-right="collapsed"\\] \\.psl__right:has\\(\\.rab__panel-wrap\\)'
    );
    expect(rail).toMatch(/position\s*:\s*relative/);
    const railZ = zIndex(rail);
    // `\}` anchors each to its standalone base rule. The palette also has a
    // `.psl__main:has(... :focus-visible) > .psl__grid-copy-palette` rule
    // (the focus-ring pass, #645), which a bare pattern matches too.
    for (const chrome of [
      "\\}\\s*\\.psl__edit-toolbar",
      "\\}\\s*\\.psl__grid-copy-palette",
      "\\.psl__stage-nav",
      "\\.psl__focus-close"
    ]) {
      expect(railZ, chrome).toBeGreaterThan(zIndex(block(chrome)));
    }
    const peekZ = zIndex(
      block('\\.psl\\[data-left="collapsed"\\] \\.psl__left,\\s*\\.psl\\[data-left="peek"\\] \\.psl__left')
    );
    expect(railZ).toBeLessThan(peekZ);
  });
});
