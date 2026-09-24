// Pin how the Sizzle editor gives way on a short (and narrow) window.
//
// At the minimum window (880×560) with the chat open, the editor head, reel
// player, timeline and footer measure ~540px against a 508px pane. Before
// this was pinned the scene list got 28px (or nothing), no scene control
// could be seen whole, and tabbing into one scrolled `.szl__main` — an
// `overflow: hidden` box — 77px, lifting the editor head out of view where a
// mouse user could not scroll it back.
//
// jsdom has no layout, so none of that can be observed from a render test.
// The fix is a handful of declarations whose job is only visible at one
// window size; this suite keeps each of them from being "tidied" away.
// String-matched like the stylesheet contract suites in styles/__tests__.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBlock, stripCssComments } from "../../../styles/__tests__/css-block";

const sizzleCss = stripCssComments(readFileSync(join(__dirname, "..", "sizzle.css"), "utf8"));
const timelineCss = stripCssComments(readFileSync(join(__dirname, "..", "timeline", "timeline.css"), "utf8"));

/** A rule that starts its own line — so `.szl__scene` does not also match
 *  `.szl__scene-row` or a descendant selector ending in it. */
const rule = (css: string, selector: string): string =>
  extractBlock(css, `(?:^|\\n)${selector.replace(/[.()]/g, "\\$&")}`, { label: selector, expectSingle: true });

const decl = (block: string, property: string): string | null => {
  const match = block.match(new RegExp(`(?:^|\\s|;)${property}:\\s*([^;]+);`));
  return match === null ? null : (match[1] ?? "").trim();
};

/** The body of the scene list's container query, braces and all. Matched on
 *  its own because `extractBlock` stops at the first `}`, which in a nested
 *  block is the end of the first inner rule. */
function narrowCardQuery(): string {
  const match = sizzleCss.match(/@container\s+szl-scenes\s*\([^)]*\)\s*\{([\s\S]*?\})\s*\}/);
  if (match === null) throw new Error("no @container szl-scenes block");
  return match[1] ?? "";
}

/** The middle (thumbnail) track of a `28px <thumb> 1fr` template. */
function thumbTrack(template: string | null): string {
  const tracks = (template ?? "").split(/\s+/);
  expect(tracks).toHaveLength(3);
  return tracks[1] ?? "";
}

describe("sizzle editor on a short window", () => {
  it("the main pane clips instead of hiding, so focus cannot scroll it", () => {
    const main = rule(sizzleCss, ".szl__main");
    // `hidden` is still a scroll container that focus and scrollIntoView can
    // move; `clip` is not a scroll container at all.
    expect(decl(main, "overflow")).toBe("clip");
    // A clipped grid item's automatic minimum is its content height, so the
    // `1fr` row would grow to fit a tall editor without this.
    expect(decl(main, "min-height")).toBe("0");
  });

  it("the editor column is the scroller that gives way", () => {
    const editor = rule(sizzleCss, ".szl__editor");
    expect(decl(editor, "overflow-y")).toBe("auto");
    // `hidden` on x would let focus shift the column sideways with no way
    // back: the same trap as the main pane, turned 90 degrees.
    expect(decl(editor, "overflow-x")).toBeNull();
    expect(decl(editor, "overflow")).toBeNull();
    expect(decl(editor, "min-height")).toBe("0");
  });

  it("the scene list keeps a floor of one card, then scrolls itself", () => {
    const scenes = rule(sizzleCss, ".szl__scenes");
    expect(decl(scenes, "flex")).toBe("1");
    expect(decl(scenes, "overflow-y")).toBe("auto");
    // The tallest card at the narrowest editor (171px) plus the list's
    // padding. A floor of 0 is the original bug.
    const floor = decl(scenes, "min-height")?.match(/^(\d+)px$/);
    expect(floor).toBeTruthy();
    expect(Number(floor![1])).toBeGreaterThanOrEqual(171 + 2 * 14);
  });

  it("a control focused into view stops the list's own padding from the edge", () => {
    const scenes = rule(sizzleCss, ".szl__scenes");
    const paddingBlock = decl(scenes, "padding")?.split(/\s+/)[0];
    expect(paddingBlock).toBe("14px");
    expect(decl(scenes, "scroll-padding-block")).toBe(paddingBlock);
  });
});

describe("simple scene card on a narrow editor", () => {
  it("the scene list is the query container, by name", () => {
    // The chat beside the editor is 320–720px wide or closed, so the card
    // must key off the list's width, never the window's.
    expect(decl(rule(sizzleCss, ".szl__scenes"), "container")).toBe("szl-scenes / inline-size");
  });

  it("the thumbnail is exactly as wide as its column, wide and narrow", () => {
    // The first cut of the narrow layout shrank the column to 96px and left
    // the thumbnail at 180px: a container query adds no specificity, the
    // base rule came later in the file, and the thumbnail painted over the
    // narration. Tie the two numbers together in both layouts.
    const baseColumn = thumbTrack(decl(rule(sizzleCss, ".szl__scene"), "grid-template-columns"));
    // Two top-level `.szl__scene-thumb` rules exist (size, then the
    // positioning context for the video badges); exactly one sizes it.
    const baseWidths = [...sizzleCss.matchAll(/(?:^|\n)\.szl__scene-thumb\s*\{([\s\S]*?)\}/g)]
      .map((m) => decl(m[1] ?? "", "width"))
      .filter((w) => w !== null);
    expect(baseWidths).toEqual([baseColumn]);

    const body = narrowCardQuery();
    const narrowCard = extractBlock(body, "\\.szl__scene:not\\(\\.szl__scene--sequence\\)", {
      label: "narrow card",
      expectSingle: true
    });
    const narrowColumn = thumbTrack(decl(narrowCard, "grid-template-columns"));
    // Not a bare `.szl__scene-thumb`: that selector ties with the base rule
    // and loses to it on source order.
    const narrowThumb = extractBlock(body, "\\.szl__scene \\.szl__scene-thumb", {
      label: "narrow thumb",
      expectSingle: true
    });
    expect(decl(narrowThumb, "width")).toBe(narrowColumn);
    expect(Number.parseFloat(narrowColumn)).toBeLessThan(Number.parseFloat(baseColumn));
  });

  it("the narrow layout never reaches the sequence card, which has no thumbnail", () => {
    const body = narrowCardQuery();
    expect(body).not.toMatch(/(?:^|\n)\s*\.szl__scene\s*\{/);
  });

  it("the simple card's action row wraps instead of running off the card", () => {
    const row = rule(sizzleCss, ".szl__scene:not(.szl__scene--sequence) .szl__scene-row");
    expect(decl(row, "flex-wrap")).toBe("wrap");
    // Not every row: a wrapping sequence row strands "+ Clip" on its own line.
    expect(decl(rule(sizzleCss, ".szl__scene-row"), "flex-wrap")).toBeNull();
  });
});

describe("timeline bar on a narrow editor", () => {
  it("the meta text truncates rather than running out of a narrow column", () => {
    const meta = rule(timelineCss, ".szt__meta");
    expect(decl(meta, "min-width")).toBe("0");
    expect(decl(meta, "text-overflow")).toBe("ellipsis");
    // Clip on x only: at `line-height: 1` a hidden box also cuts descenders.
    expect(decl(meta, "overflow-x")).toBe("clip");
    expect(decl(meta, "overflow")).toBeNull();
  });
});
