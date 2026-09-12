// Executable policy for the two CSS facts that survived the chip's split
// from one <button> into a group of sibling controls, neither of which a
// render test can see.
//
// jsdom resolves no cascade and computes no specificity, so every
// renderer test passes whether the chip draws one focus ring or two, and
// whether the toggle's hit area covers the group or only its own text.
// So the check is on the bytes, the way
// `recording-frame-css-boundary.test.ts` reads the shipped stylesheet and
// `local-agent-minting-boundary.test.ts` greps the production sources.
//
// Both facts were established by measurement in Chromium with
// SourceChip.css and region.css live together; see the commit that
// introduced them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    // Strip comments so prose about `outline` never trips a scan.
    .replace(/\/\*[\s\S]*?\*\//g, "");

const chipCss = read("../SourceChip.css");
const regionCss = read("../../../styles/region.css");

/** Every rule block, as `{ selector, body }`. */
function rules(source: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push({ selector: match[1]?.trim() ?? "", body: match[2] ?? "" });
  }
  return out;
}

function ruleFor(source: string, selector: string): { selector: string; body: string } {
  const found = rules(source).find((rule) =>
    rule.selector.split(",").some((part) => part.trim() === selector)
  );
  if (found === undefined) throw new Error(`no rule for ${selector}`);
  return found;
}

/**
 * `[classes, elements]` for a compound selector — enough to compare two
 * selectors that carry no id. Pseudo-CLASSES count as classes,
 * pseudo-ELEMENTS as elements, and combinators contribute nothing.
 */
function specificity(selector: string): [number, number] {
  const flattened = selector.replace(/:has\(([^)]*)\)/g, " $1 ");
  const classes = (flattened.match(/\.[A-Za-z_-][\w-]*/g) ?? []).length
    + (flattened.match(/(?<!:):[A-Za-z-]+(?:\([^)]*\))?/g) ?? []).length;
  const elements = (flattened.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length
    + (flattened.match(/::[A-Za-z-]+/g) ?? []).length;
  return [classes, elements];
}

/** True when `a` outranks `b` — classes first, then elements. */
function outranks(a: string, b: string): boolean {
  const [ac, ae] = specificity(a);
  const [bc, be] = specificity(b);
  return ac !== bc ? ac > bc : ae > be;
}

describe("SourceChip.css", () => {
  // The comparison below is only as good as this helper, and a helper
  // that silently reads every selector as (0,0) would make the whole
  // file pass while the rings stayed broken.
  test("the specificity helper agrees with the three selectors in play", () => {
    expect(specificity(".region-hud button:focus-visible")).toEqual([2, 1]);
    expect(specificity(".ps-chip .ps-chip__body:focus-visible")).toEqual([3, 0]);
    expect(specificity(".ps-chip:has(> .ps-chip__body:focus-visible)")).toEqual([3, 0]);
    expect(specificity(".ps-chip__body:focus-visible")).toEqual([2, 0]);
    expect(specificity(".ps-chip__body::after")).toEqual([1, 1]);
    // The one that matters: the bare form loses to the HUD rule.
    expect(outranks(".ps-chip__body:focus-visible", ".region-hud button:focus-visible")).toBe(false);
    expect(outranks(".ps-chip .ps-chip__body:focus-visible", ".region-hud button:focus-visible")).toBe(true);
  });

  // region.css's HUD ring used to land on the chip itself, because the
  // chip WAS the button. It now also matches `.ps-chip__body`, so without
  // a suppression rule that OUTRANKS it the group ringed in `--accent`
  // while the body ringed in `--accent-border` inside it — two concentric
  // rings, two colors, on one chip. A bare `.ps-chip__body:focus-visible`
  // does not outrank it and changes nothing, which is exactly the shape of
  // mistake this test exists to catch.
  test("the toggle's own focus ring is suppressed, and by a selector that wins", () => {
    const hudRing = ruleFor(regionCss, ".region-hud button:focus-visible");
    expect(hudRing.body).toContain("outline:");

    const suppressor = rules(chipCss).find(
      (rule) =>
        rule.selector.includes(".ps-chip__body:focus-visible") &&
        /outline\s*:\s*none/.test(rule.body)
    );
    expect(suppressor, "no rule zeroes the toggle's own focus ring").toBeDefined();
    expect(
      outranks(suppressor!.selector, hudRing.selector),
      `${suppressor!.selector} must outrank ${hudRing.selector}`
    ).toBe(true);

    // And the ring the user actually sees is still drawn, on the group.
    const groupRing = rules(chipCss).find((rule) =>
      rule.selector.includes(".ps-chip:has(> .ps-chip__body:focus-visible)")
    );
    expect(groupRing?.body).toMatch(/outline\s*:\s*2px solid var\(--accent\)/);
    expect(outranks(groupRing!.selector, hudRing.selector)).toBe(true);
  });

  // Before the split the chip WAS the button, so its padding and its
  // trailing <kbd> toggled too. The overlay is what gives that back, and
  // `border-radius: inherit` is what keeps it off the ~1px each corner
  // rounds away.
  test("the toggle's hit area is stretched over the whole group", () => {
    const overlay = ruleFor(chipCss, ".ps-chip__body::after");
    expect(overlay.body).toMatch(/position\s*:\s*absolute/);
    expect(overlay.body).toMatch(/inset\s*:\s*0/);
    expect(overlay.body).toMatch(/border-radius\s*:\s*inherit/);
    // Only works against a positioned ancestor, and only if the border
    // sits inside the declared height.
    const chip = ruleFor(chipCss, ".ps-chip");
    expect(chip.body).toMatch(/position\s*:\s*relative/);
    expect(chip.body).toMatch(/box-sizing\s*:\s*border-box/);
    // The two action buttons have to stay above it, or they are
    // unclickable — the whole point of the split.
    for (const selector of [".ps-chip__act", ".ps-chip__devices"]) {
      expect(ruleFor(chipCss, selector).body).toMatch(/position\s*:\s*relative/);
    }
  });
});
