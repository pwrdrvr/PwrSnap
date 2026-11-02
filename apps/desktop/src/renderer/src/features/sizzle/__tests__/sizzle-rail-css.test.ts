// Pin how the Sizzle right rail splits its height between the agent chat
// and the clip/scene inspector drawer.
//
// jsdom has no layout, so SizzleApp.test.tsx can check which classes the
// rail carries but never how tall anything ends up. The failure this
// guards only shows up with a real conversation in the chat: the chat
// pane's `flex-basis: auto` resolved to the WHOLE thread's height, and
// flex-shrink divides a shortfall in proportion to base size — so the
// longer the chat, the less of the rail the inspector got. Measured in the
// live app: a 4000 px thread in a 768 px rail left the scene inspector
// 49 px, 20 of them body. Nothing about it is visible in a unit test or in
// a fresh profile with an empty chat.
//
// String-matched like the stylesheet contract suites in styles/__tests__.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBlock, stripCssComments } from "../../../styles/__tests__/css-block";

const css = stripCssComments(readFileSync(join(__dirname, "..", "sizzle.css"), "utf8"));

/** A rule that starts its own line — so `.szl__insp` does not also match
 *  `.szl__insp-body` or a descendant selector ending in it. */
const rule = (selector: string): string =>
  extractBlock(css, `(?:^|\\n)${selector.replace(/[.]/g, "\\.")}`, { label: selector, expectSingle: true });

describe("sizzle rail: chat vs inspector height", () => {
  it("the chat pane's flex-basis is 0, so conversation length is not a claim on the rail", () => {
    const pane = rule(".szl__chat-pane");
    expect(pane).toMatch(/(?:^|\s|;)flex:\s*1\s+1\s+0(?:px)?\s*;/);
    // ...with a floor that keeps the thread bar and composer usable.
    const floor = pane.match(/(?:^|\s|;)min-height:\s*(\d+)px\s*;/);
    expect(floor).not.toBeNull();
    expect(Number(floor![1])).toBeGreaterThanOrEqual(160);
  });

  it("the inspector drawer is content-sized with no percentage cap", () => {
    const host = rule(".szl__inspector-host");
    expect(host).toMatch(/(?:^|\s|;)flex:\s*0\s+1\s+auto\s*;/);
    // A cap would re-create the squeeze from the other side: the chat's
    // floor already bounds the drawer, and past it the body scrolls.
    expect(host).not.toMatch(/max-height/);
  });

  it("with the chat hidden or folded, the inspector fills the rail", () => {
    expect(rule(".szl__chat.is-inspector-only .szl__inspector-host")).toMatch(/(?:^|\s|;)flex:\s*1\s+1\s+auto\s*;/);
    // ...and the section inside it grows with the host, so the footer
    // sits at the rail's bottom edge rather than mid-rail.
    expect(rule(".szl__insp")).toMatch(/(?:^|\s|;)flex:\s*1\s+1\s+auto\s*;/);
  });

  it("the inspector body scrolls, and says so when it is clipped", () => {
    const body = rule(".szl__insp-body");
    expect(body).toMatch(/(?:^|\s|;)overflow:\s*auto\s*;/);
    expect(body).toMatch(/(?:^|\s|;)min-height:\s*0\s*;/);
    // scroll shadows: `local` covers over `scroll` shades
    expect(body).toMatch(/no-repeat local/);
    expect(body).toMatch(/no-repeat scroll/);
  });
});
