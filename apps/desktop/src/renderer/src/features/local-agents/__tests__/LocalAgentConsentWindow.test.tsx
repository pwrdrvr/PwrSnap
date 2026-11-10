// @vitest-environment jsdom

// The consent window has no title bar of its own, and its body scrolls. On
// macOS the traffic lights and on Windows the `titleBarOverlay` are drawn by
// the OS straight onto whatever is under them, so without an opaque strip of
// ours the heading scrolled up UNDER the stoplights and read through them.
// The strip used to be Linux-only (it was added to carry the caption buttons),
// which left the two platforms the OS draws on with nothing covering it.
//
// Rule: every platform gets the strip; only Linux gets buttons in it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { extractBlock, stripCssComments } from "../../../styles/__tests__/css-block";
import { LocalAgentConsentWindow } from "../LocalAgentConsentWindow";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  delete (window as { pwrsnapApi?: unknown }).pwrsnapApi;
});

async function renderFor(platform: string | undefined): Promise<HTMLDivElement> {
  window.pwrsnapApi = {
    platform,
    // Never resolves: this suite is about the chrome, not the prompt.
    dispatch: () => new Promise(() => undefined),
    on: () => () => undefined
  } as never;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<LocalAgentConsentWindow />));
  return container;
}

describe("local-agent consent window chrome", () => {
  test.each(["darwin", "win32", "linux", undefined])(
    "paints an opaque title strip on %s so scrolled content cannot run under the OS chrome",
    async (platform) => {
      const el = await renderFor(platform);
      const strip = el.querySelector(".ps-consent-chrome");
      expect(strip).not.toBeNull();
      // The strip comes before the scrolling column, so it is never inside it.
      expect(strip?.nextElementSibling?.classList.contains("local-agent-consent")).toBe(true);
    }
  );

  test.each([
    ["darwin", false],
    ["win32", false],
    ["linux", true],
    [undefined, false]
  ] as const)("caption buttons on %s: %s", async (platform, expected) => {
    const el = await renderFor(platform);
    expect(el.querySelector(".ps-consent-chrome .ps-wincontrols") !== null).toBe(expected);
  });
});

describe("local-agent consent strip CSS", () => {
  const css = stripCssComments(
    readFileSync(join(__dirname, "..", "..", "..", "styles", "local-agent-consent.css"), "utf8")
  );
  const strip = extractBlock(css, "\\.ps-consent-chrome", {
    label: "consent strip",
    expectSingle: true
  });
  const stripHeight = Number(/(?:^|[\s;])height:\s*(\d+)px/.exec(strip)?.[1]);

  test("stays put, covers what scrolls under it, and drags the window", () => {
    expect(strip).toMatch(/position:\s*fixed/);
    expect(strip).toMatch(/top:\s*0/);
    expect(strip).toMatch(/background:\s*var\(--bg-app\)/);
    expect(strip).toMatch(/-webkit-app-region:\s*drag/);
    expect(strip).toMatch(/z-index:\s*\d+/);
    expect(stripHeight).toBeGreaterThan(0);
  });

  test("every column rule, media queries included, reserves the strip's height at the top", () => {
    // The window's minimum width (520) is inside the narrow media query, so a
    // smaller padding there parks the brand under the strip before any scroll.
    const blocks = [...css.matchAll(/(?<![\w-])\.local-agent-consent\s*\{([^}]*)\}/g)].map(
      (m) => m[1] ?? ""
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const longhand = /padding-top:\s*(\d+)px/.exec(block)?.[1];
      const shorthand = /padding:\s*(\d+)px/.exec(block)?.[1];
      const top = longhand ?? shorthand;
      if (top === undefined) continue;
      expect(Number(top), block.trim()).toBeGreaterThanOrEqual(stripHeight);
    }
  });
});
