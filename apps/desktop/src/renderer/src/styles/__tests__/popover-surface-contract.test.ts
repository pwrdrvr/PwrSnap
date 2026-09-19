// Lock the popover surface contract: the post-capture toast (`.fo`) and
// the tray popover (`.ps-tray`) paint an OPAQUE body with no
// backdrop-filter.
//
// Why this needs a test rather than a code comment:
//
//   • Each popover lives in its own `transparent: true` BrowserWindow
//     (the macOS tray sits on native vibrancy instead, but it is
//     transparent on Windows and Linux). A CSS backdrop-filter only
//     samples what the page itself painted — never the other windows
//     behind it — so in these windows the blur is a no-op, and any alpha
//     in the fill lets the desktop show through UNBLURRED and sharp-
//     edged. At 94%, a white window edge behind the toast became a
//     ~#0f0f0f stripe the same tone as our own cards and read as a
//     control inside it.
//
//   • The design reference the recipe came from (design/src/floatover.css,
//     design/src/library.css) still says 94% + blur, and it is preserved
//     verbatim. In that mockup the toast sat over a fake desktop painted
//     in the SAME page, where the blur works — so re-syncing from it looks
//     right there and is wrong here. No visual golden covers either
//     popover, so nothing else would fail.
//
// Reads the CSS as strings, like the other contract suites here — see
// ./css-block for why comments are stripped before any block lookup.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBlock, stripCssComments, tokenValue } from "./css-block";

const LABEL = "popover-surface-contract";
const STYLES_DIR = join(__dirname, "..");

function stylesheet(file: string): string {
  return stripCssComments(readFileSync(join(STYLES_DIR, file), "utf8"));
}

const SURFACES = [
  {
    name: "float-over toast",
    file: "float-over.css",
    // Anchored so `.fo.is-entering` / `.fo__hdr` never match.
    selector: "(?:^|\\})\\s*\\.fo",
    stageOverride: 'body\\[data-stage="float-over"\\]\\s+\\.fo'
  },
  {
    name: "tray popover",
    file: "library.css",
    selector: "(?:^|\\})\\s*\\.ps-tray",
    stageOverride: 'body\\[data-stage="tray"\\]\\s+\\.ps-tray'
  }
] as const;

const TRANSLUCENCY = /(?:^|[\s;])(?:-webkit-)?backdrop-filter\s*:|\bopacity\s*:/;

describe(LABEL, () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      const base = extractBlock(stylesheet(surface.file), surface.selector, {
        label: `${LABEL}: ${surface.name}`,
        expectSingle: true
      });

      it("paints the opaque canvas token, not a color-mix with transparent", () => {
        // Every background declaration, not just the first — a later one
        // in the same block wins the cascade.
        const backgrounds = [
          ...base.matchAll(/(?:^|[\s;])background(?:-color)?\s*:\s*([^;]+);/g)
        ].map((m) => (m[1] ?? "").trim());
        expect(backgrounds).toEqual(["var(--bg-app)"]);
      });

      it("declares no backdrop-filter or opacity on the surface", () => {
        expect(base).not.toMatch(TRANSLUCENCY);
      });

      it("is not made translucent by its per-window stage override", () => {
        const override = extractBlock(stylesheet("app.css"), surface.stageOverride, {
          label: `${LABEL}: ${surface.name} stage override`,
          expectSingle: true
        });
        expect(override).not.toMatch(/(?:^|[\s;])background(?:-color)?\s*:/);
        expect(override).not.toMatch(TRANSLUCENCY);
      });
    });
  }

  it("--bg-app carries no alpha in either theme", () => {
    const tokens = stylesheet("tokens.css");
    for (const [theme, selector] of [
      ["dark", ":root"],
      ["light", ':root\\[data-theme="light"\\]']
    ] as const) {
      const block = extractBlock(tokens, `(?:^|\\})\\s*${selector}`, {
        label: `${LABEL}: ${theme} tokens`,
        expectSingle: true
      });
      expect(tokenValue(block, "bg-app", `${LABEL}: ${theme}`)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
