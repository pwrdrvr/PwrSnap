// Lock the focus-ring contract: every keyboard focus indicator in the
// renderer is drawn in `--focus-ring`, and no focus rule takes the
// outline away without putting a ring back.
//
// Why this needs a test rather than a code comment:
//
//   • The ring this replaced was drawn in `--accent-border`, a 42%
//     accent overlay that measured about 2.2:1 against the fields it
//     sat on — under WCAG 1.4.11's 3:1. It looked deliberate, it was
//     spelled like a design token, and eleven rules had copied it. A
//     token name is not evidence of contrast; this suite is.
//
//   • `outline: none` inside a focus rule is invisible in review. It is
//     usually harmless (the rule shares a selector list with `:hover`,
//     or it suppresses the mouse-focus ring and a later `:focus-visible`
//     rule restores it), which is exactly why the one that is NOT
//     followed by a ring ships: the keyboard walk that found them read
//     each stop's computed outline, and a reviewer reading CSS does not.
//
// Reads the CSS as strings, like the other contract suites here: "this
// declaration is in a block with this selector" is a string-match
// question, and jsdom resolves no cascade anyway. The collector and the
// comment stripper are shared — see ./css-block. What this suite cannot
// see is paint: a ring clipped by an overflow ancestor, covered by a
// sibling, or faded by opacity. Those need a real browser and were
// measured with one; see AGENTS.md §"Focus rings".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { collectCssFiles, extractBlock, stripCssComments } from "./css-block";

const LABEL = "focus-ring-contract";
const RENDERER_SRC = join(__dirname, "..", "..");
const STYLES_DIR = join(__dirname, "..");

/** Floor, not an exact count — see scrollbar-contract for why. */
const MIN_CSS_FILES = 20;

const cssFiles = collectCssFiles(RENDERER_SRC);
const appCss = stripCssComments(readFileSync(join(STYLES_DIR, "app.css"), "utf8"));

interface Rule {
  /** Comma-split, whitespace-normalized selectors. */
  selectors: string[];
  body: string;
}

/** Innermost `selector { body }` rules in file order. An at-rule
 *  wrapper (`@media … {`) is skipped because `[^{}]+` restarts after
 *  its opening brace, so its inner rules come out with clean selectors. */
function rulesOf(stripped: string): Rule[] {
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter((s) => s.length > 0),
    body: m[2] ?? ""
  }));
}

const isFocusSelector = (selector: string): boolean => /:focus(?:-visible|-within)?\b/.test(selector);
const drawsFocusRing = (body: string): boolean => /var\(--focus-ring\)/.test(body);

/** Focus rings that deliberately use another color. Each entry is a
 *  file + selector + the reason it may. */
const NON_TOKEN_RINGS: ReadonlyArray<{ file: string; selector: string; why: string }> = [
  {
    file: "features/shared/DeleteConfirm.css",
    selector: ".ps-confirm__btn.is-danger:focus-visible",
    why: "the destructive button rings in --danger (5.4:1 dark), so focus on it reads as danger"
  }
];

describe("the CSS collector actually covers the renderer", () => {
  it(`finds at least ${MIN_CSS_FILES} stylesheets`, () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(MIN_CSS_FILES);
  });
});

describe("the global focus-visible default", () => {
  // Zero specificity, so any component rule overrides it without a
  // specificity fight — and a control with no rule of its own still gets
  // the house ring instead of Chromium's `outline: auto`.
  const block = extractBlock(appCss, ":where\\(:focus-visible\\)", {
    label: LABEL,
    expectSingle: true
  });

  it("rings in --focus-ring, 2px, 1px out", () => {
    expect(block).toMatch(/outline:\s*2px solid var\(--focus-ring\)\s*;/);
    expect(block).toMatch(/outline-offset:\s*1px\s*;/);
  });

  it("carries a scroll-margin at least as wide as the ring reaches", () => {
    // A scroller that brings a control into view stops at the control's
    // border box, cutting the 3px (offset + width) ring. 4px clears it.
    const margin = block.match(/scroll-margin:\s*(\d+)px\s*;/);
    expect(margin).not.toBeNull();
    expect(Number(margin?.[1])).toBeGreaterThanOrEqual(4);
  });
});

describe("every focus outline is drawn in --focus-ring", () => {
  it.each(cssFiles)("%s", (label, stripped) => {
    const offenders: string[] = [];
    for (const rule of rulesOf(stripped)) {
      const focusSelectors = rule.selectors.filter(isFocusSelector);
      if (focusSelectors.length === 0) continue;
      const colored = [...rule.body.matchAll(/(?:^|[;\s])(outline(?:-color)?)\s*:\s*([^;]+)/g)]
        .map((m) => ({ prop: m[1] ?? "", value: (m[2] ?? "").trim() }))
        .filter(({ value }) => !/^(none|0|auto)$/.test(value));
      for (const { prop, value } of colored) {
        if (/var\(--focus-ring\)/.test(value)) continue;
        // A width and/or style with no color (`outline: 2px solid`) names
        // nothing to check. Anything left after stripping those is a
        // color, keyword colors included: matching only var() / # / rgb()
        // would let `outline: 2px solid orange` through.
        const colorPart =
          prop === "outline-color"
            ? value
            : value
                .replace(/\b\d*\.?\d+(?:px|em|rem)?\b/g, "")
                .replace(/\b(?:thin|medium|thick|none|hidden|auto|solid|dashed|dotted|double|groove|ridge|inset|outset)\b/gi, "")
                .trim();
        if (colorPart === "") continue;
        const allowed = focusSelectors.every((sel) =>
          NON_TOKEN_RINGS.some((a) => a.file === label && a.selector === sel)
        );
        if (!allowed) offenders.push(`${focusSelectors.join(", ")} { ${prop}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every allowlisted exception real", () => {
    for (const { file, selector } of NON_TOKEN_RINGS) {
      const entry = cssFiles.find(([label]) => label === file);
      expect(entry, file).toBeDefined();
      const rules = rulesOf(entry?.[1] ?? "");
      expect(rules.some((r) => r.selectors.includes(selector)), `${file} ${selector}`).toBe(true);
    }
  });
});

describe("pseudo-element focus rings are drawn in --focus-ring", () => {
  // Where positioned children would paint over an element's own outline
  // (timeline clips, scene regions) the ring moves to an absolutely
  // positioned ::after. Same token, same contrast bar.
  it.each(cssFiles)("%s", (_label, stripped) => {
    const offenders = rulesOf(stripped)
      .filter((r) => r.selectors.some((s) => /:focus-visible::(after|before)/.test(s)))
      .filter((r) => /(?:^|[;\s])border(?:-color)?\s*:/.test(r.body) && !drawsFocusRing(r.body))
      .map((r) => r.selectors.join(", "));
    expect(offenders).toEqual([]);
  });
});

describe("a focus rule that removes the outline puts a ring back", () => {
  /**
   * For a selector that sets `outline: none | 0`, a replacement ring is
   * any of:
   *   • the same block painting a ring another way (`box-shadow` or
   *     `border` in --focus-ring or --accent: the hollow trim handle);
   *   • a LATER rule for the same selector — or for its `:focus-visible`
   *     form, when this one is a mouse-suppressing `:focus` — drawing
   *     --focus-ring, including via ::after / ::before;
   *   • a rule anywhere in the file that rings a wrapper through
   *     `:has(… <this compound> …)` (borderless fields, the source chip).
   */
  function restored(rules: Rule[], index: number, selector: string): boolean {
    const own = rules[index];
    if (own !== undefined && /(?:box-shadow|border(?:-color)?)\s*:[^;]*var\(--(?:focus-ring|accent)\)/.test(own.body)) {
      return true;
    }
    const visible = selector.replace(/:focus(?![-\w])/g, ":focus-visible");
    const targets = new Set([selector, visible]);
    const later = rules.slice(index + 1);
    if (
      later.some(
        (r) =>
          drawsFocusRing(r.body) &&
          r.selectors.some((s) => targets.has(s.replace(/::(?:after|before)$/, "")))
      )
    ) {
      return true;
    }
    const compound = visible.split(" ").at(-1) ?? visible;
    return rules.some(
      (r) => drawsFocusRing(r.body) && r.selectors.some((s) => s.includes(":has(") && s.includes(compound))
    );
  }

  it.each(cssFiles)("%s", (_label, stripped) => {
    const rules = rulesOf(stripped);
    const offenders: string[] = [];
    rules.forEach((rule, index) => {
      if (!/(?:^|[;\s])outline\s*:\s*(?:none|0)\s*(?:;|$)/.test(rule.body)) return;
      for (const selector of rule.selectors) {
        if (!/:focus(?:-visible)?\b/.test(selector)) continue;
        if (!restored(rules, index, selector)) offenders.push(selector);
      }
    });
    expect(offenders).toEqual([]);
  });
});
