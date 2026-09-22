// Lock the float-over scroll contract: when the post-capture toast has
// more content than its window may show, the MIDDLE scrolls and the
// header and footer stay pinned — and the ceiling it scrolls against is
// never derived from the toast window's own size.
//
// Why this needs a test rather than a code comment:
//
//   • The failure is silent and asymmetric. `.fo` carries
//     `overflow: hidden` and the window is sized from a measurement of
//     it, so content past the ceiling is simply not painted — no
//     scrollbar, no clipping artifact, nothing in a log. The footer is
//     last in the box, so what disappears is exactly the row with
//     Discard / Dismiss / Edit. That shipped: PR #638 bought the video
//     toast back under the ceiling by trimming 100px of chrome, which
//     left ~12px of headroom — a third row of tags, an AppUpdateRow, a
//     short-clip warning or a long Codex error each spends it.
//
//   • `min-height: 0` on `.fo__body` and `flex: none` on the header and
//     footer look like tidying and are load-bearing. A flex item's
//     min-height resolves to its content, so without it the middle
//     refuses to shrink, `.fo` overflows its own max-height, and
//     `overflow-y: auto` never engages; without `flex: none` the header
//     and footer give up their padding first and squash instead.
//
//   • The ceiling is the trap. Reading it off the live window
//     (`100vh`, `window.innerHeight`) looks equivalent and closes a
//     feedback loop: the measured wrapper reports
//     min(natural, current window), main sizes the window to that, and
//     the toast can never grow back — permanently, since a finishing
//     resize is not something a ResizeObserver re-reports. See
//     AGENTS.md §"Tray + float-over popover sizing" and
//     §"Never mix a post-transform rect with a layout measure".
//     Nothing about a viewport-derived cap fails a render test: jsdom
//     has no layout, and in a real window it looks correct until the
//     first time content grows.
//
// Reads the CSS as strings, like the other contract suites here — see
// ./css-block for why comments are stripped before any block lookup.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBlock, stripCssComments } from "./css-block";

const LABEL = "float-over-scroll-cap-contract";
const STYLES_DIR = join(__dirname, "..");
const FLOAT_OVER_FEATURE_DIR = join(__dirname, "..", "..", "features", "float-over");

const css = stripCssComments(readFileSync(join(STYLES_DIR, "float-over.css"), "utf8"));

function block(selectorPattern: string): string {
  return extractBlock(css, selectorPattern, { label: LABEL, expectSingle: true });
}

/**
 * Anything that would make a length a function of the viewport — i.e.
 * of the window main is in the middle of sizing from our own
 * measurement.
 */
const VIEWPORT_DERIVED = /\b\d*\.?\d+(vh|dvh|svh|lvh)\b|innerHeight|clientHeight|100%\s*$/;

describe("float-over scroll cap", () => {
  it("caps .fo at a ceiling published by the host, not at the viewport", () => {
    const fo = block("\\.fo");
    const maxHeight = fo.match(/max-height\s*:\s*([^;]+);/);
    expect(maxHeight, `${LABEL}: .fo must declare a max-height`).not.toBeNull();

    const value = (maxHeight?.[1] ?? "").trim();
    // The host writes --fo-max-h on the wrapper it measures; `none`
    // keeps the design/ reference page (no host) at natural height.
    expect(value).toMatch(/^var\(\s*--fo-max-h\s*,\s*none\s*\)$/);
    expect(value).not.toMatch(VIEWPORT_DERIVED);
  });

  it("keeps .fo a flex column so the middle is what absorbs the cap", () => {
    const fo = block("\\.fo");
    expect(fo).toMatch(/display\s*:\s*flex/);
    expect(fo).toMatch(/flex-direction\s*:\s*column/);
    // The clip that makes the failure invisible, and the reason the
    // measurer lives on a wrapper OUTSIDE this element.
    expect(fo).toMatch(/overflow\s*:\s*hidden/);
  });

  it("makes .fo__body the only scroller, and able to shrink", () => {
    const body = block("\\.fo__body");
    expect(body).toMatch(/overflow-y\s*:\s*auto/);
    // Without this the flex item's auto min-height pins it to its
    // content and the scroller never engages.
    expect(body).toMatch(/min-height\s*:\s*0/);
    expect(body).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(body).not.toMatch(/max-height/);
  });

  it("pins the header and the footer against flex shrink", () => {
    for (const selector of ["\\.fo__hdr", "\\.fo__foot"]) {
      expect(block(selector), `${LABEL}: ${selector} must not shrink`).toMatch(
        /flex\s*:\s*none/
      );
    }
  });

  it("derives the renderer's ceiling from nothing window-sized", () => {
    // The cap is computed in FloatOverHost.tsx from the display work
    // area and the zoom factor, both of which are window-size
    // independent. If a future edit reaches for the viewport instead,
    // the loop above reopens and no render test notices.
    const host = readFileSync(join(FLOAT_OVER_FEATURE_DIR, "FloatOverHost.tsx"), "utf8");
    const code = host
      // Strip block and line comments: this file EXPLAINS why
      // innerHeight is wrong, and prose about it must not read as use.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["innerHeight", "outerHeight", "clientHeight", "100vh"]) {
      expect(code, `${LABEL}: FloatOverHost must not size its cap from ${banned}`).not.toContain(
        banned
      );
    }
    // What it does use instead.
    expect(code).toContain("floatOverMaxContentHeightCss");
    expect(code).toContain("availHeight");
    expect(code).toContain("getZoomFactor");
  });
});
