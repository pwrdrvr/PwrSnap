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

    // And the ring the user actually sees is still drawn, on the group,
    // in the house focus token (focus-ring-contract.test.ts).
    const groupRing = rules(chipCss).find((rule) =>
      rule.selector.includes(".ps-chip:has(> .ps-chip__body:focus-visible)")
    );
    expect(groupRing?.body).toMatch(/outline\s*:\s*2px solid var\(--focus-ring\)/);
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

  // The selector HUD's chips are fixed-width boxes. A device name is the
  // one thing in them whose length nobody controls, and a box that grew
  // with it moved every control on the bar each time a device changed.
  // jsdom lays nothing out, so the widths and the ellipsis are pinned on
  // the stylesheet itself.
  test("every orb and slate cell has a fixed width, and its caption ellipsizes", () => {
    const widths: [string, string][] = [
      [".ps-chip.ps-chip--orb", "92px"],
      ['.ps-chip.ps-chip--orb[data-source="systemAudio"]', "56px"],
      ['.ps-chip.ps-chip--orb[data-source="cursor"]', "56px"],
      ['.ps-chip.ps-chip--cell[data-source="microphone"]', "172px"],
      ['.ps-chip.ps-chip--cell[data-source="systemAudio"]', "96px"],
      ['.ps-chip.ps-chip--cell[data-source="camera"]', "188px"],
      ['.ps-chip.ps-chip--cell[data-source="cursor"]', "102px"]
    ];
    for (const [selector, width] of widths) {
      expect(ruleFor(chipCss, selector).body, selector).toMatch(new RegExp(`(?:^|[;\\s])width\\s*:\\s*${width}`));
    }
    for (const selector of [".ps-chip--orb > .ps-chip__cap", ".ps-chip--cell > .ps-chip__cap"]) {
      const body = ruleFor(chipCss, selector).body;
      expect(body, selector).toMatch(/overflow\s*:\s*hidden/);
      expect(body, selector).toMatch(/text-overflow\s*:\s*ellipsis/);
      expect(body, selector).toMatch(/white-space\s*:\s*nowrap/);
    }
    // A grid column's floor is its content's min-content unless it says
    // otherwise, and the cell's name column must be able to shrink.
    expect(ruleFor(chipCss, ".ps-chip.ps-chip--cell").body).toMatch(
      /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/
    );
    expect(ruleFor(chipCss, ".ps-chip--cell > .ps-chip__cap").body).toMatch(/min-width\s*:\s*0/);
  });

  // The device popovers (and the camera's error line) anchor to the HUD
  // and open ABOVE it. A clipping HUD swallowed them whole: the
  // Clapperboard first shipped with `overflow: hidden` for its rounded
  // stripe, and its microphone picker opened invisibly.
  test("the HUD the popovers anchor to does not clip them", () => {
    expect(ruleFor(regionCss, ".region-hud").body).toMatch(/position\s*:\s*relative/);
    for (const selector of [".region-hud", ".region-hud--shutter", ".region-hud--clapperboard"]) {
      expect(ruleFor(regionCss, selector).body, selector).not.toMatch(/overflow\s*:/);
    }
    expect(ruleFor(regionCss, ".region-hud .mic-chip").body).toMatch(/position\s*:\s*static/);
  });
});

