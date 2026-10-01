// Lock the narrow-Library stage contract: the floating edit dock stays out
// of the ←/→ columns and inside the stage, its labels go when the stage is
// small, the
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

/** Every `@container psl-stage …` rule, nested blocks and all —
 *  `extractBlock` stops at the first `}`. */
function containerRules(): Array<{ prelude: string; body: string }> {
  const rules: Array<{ prelude: string; body: string }> = [];
  let start = css.indexOf("@container psl-stage");
  while (start >= 0) {
    const open = css.indexOf("{", start);
    let depth = 0;
    let close = -1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) throw new Error(`${LABEL}: unbalanced @container rule`);
    rules.push({ prelude: css.slice(start, open), body: css.slice(open + 1, close) });
    start = css.indexOf("@container psl-stage", close);
  }
  return rules;
}

/** The one container rule whose body holds `marker`. */
function containerRule(marker: RegExp): { prelude: string; body: string } {
  const matches = containerRules().filter((rule) => marker.test(rule.body));
  expect(matches, `${LABEL}: expected one @container psl-stage rule matching ${marker}`).toHaveLength(1);
  return matches[0]!;
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
  const rule = containerRule(/\.psl__et-btn:not\(\.is-armed\)/);

  it("switches on a narrow OR short stage", () => {
    expect(rule.prelude).toMatch(/\(\s*width\s*<\s*\d+px\s*\)\s*or\s*\(\s*height\s*<\s*\d+px\s*\)/);
  });

  it("reserves both ←/→ columns at EVERY stage size, so no number of wrapped rows can cover them", () => {
    // The reserve used to live only in this query, with a height
    // threshold proving two toolbar rows stayed below the buttons. The
    // property bar docked above the toolbar makes the dock tall enough to
    // reach them at any stage size, so the reserve is on the base rule.
    const dock = block("\\}\\s*\\.psl__edit-dock");
    const reserve = dock.match(/max-width\s*:\s*calc\(\s*100%\s*-\s*(\d+)px\s*\)\s*;/);
    expect(reserve, `${LABEL}: the dock must reserve the nav columns`).not.toBeNull();
    expect(Number(reserve?.[1])).toBeGreaterThanOrEqual(
      2 * (NAV_INSET + NAV_SIZE + NAV_RING_AND_GAP)
    );
  });

  it("the dock never outgrows the stage: the property bar gives, the toolbar does not", () => {
    const dock = block("\\}\\s*\\.psl__edit-dock");
    const cap = dock.match(/max-height\s*:\s*calc\(\s*100%\s*-\s*(\d+)px\s*\)\s*;/);
    expect(cap, `${LABEL}: the dock must cap its height to the stage`).not.toBeNull();
    expect(Number(cap?.[1])).toBeGreaterThanOrEqual(px(dock, "bottom"));
    const bar = block("\\}\\s*\\.psl__et-props");
    expect(bar).toMatch(/min-height\s*:\s*0\s*;/);
    expect(bar).toMatch(/overflow-y\s*:\s*auto\s*;/);
    expect(block("\\.psl__edit-dock > \\.psl__edit-toolbar")).toMatch(/flex\s*:\s*none\s*;/);
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

describe("property bar on a narrow stage", () => {
  const rule = containerRule(/\.psl__et-props-body/);

  it("switches on stage width", () => {
    expect(rule.prelude).toMatch(/\(\s*width\s*<\s*\d+px\s*\)/);
  });

  it("is two rows at any width: the header row, then one control strip", () => {
    const bar = extractBlock(rule.body, "\\.psl__et-props", { label: LABEL, expectSingle: true });
    expect(bar).toMatch(/display\s*:\s*grid\s*;/);
    const areas = bar.match(/grid-template-areas\s*:([^;]*);/);
    expect(areas, `${LABEL}: the narrow bar must name its grid areas`).not.toBeNull();
    expect(areas?.[1].match(/"[^"]*"/g)).toHaveLength(2);
  });

  it("the control strip never wraps: it scrolls sideways, inside the bar", () => {
    const strip = extractBlock(rule.body, "\\.psl__et-props-body", {
      label: LABEL,
      expectSingle: true
    });
    expect(strip).toMatch(/flex-wrap\s*:\s*nowrap\s*;/);
    expect(strip).toMatch(/overflow-x\s*:\s*auto\s*;/);
    // A grid item's min-width is its content's by default; without 0 the
    // strip widens the bar to fit every control instead of scrolling.
    expect(strip).toMatch(/min-width\s*:\s*0\s*;/);
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
      "\\}\\s*\\.psl__edit-dock",
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
