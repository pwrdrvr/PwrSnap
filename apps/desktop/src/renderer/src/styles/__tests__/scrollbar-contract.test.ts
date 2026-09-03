// Lock the scrollbar contract: PwrSnap paints thin, themed scrollbars
// on every scroll container, and it does so ONLY through the native
// `scrollbar-width` / `scrollbar-color` properties.
//
// Why this needs a test rather than a code comment:
//
//   • The failure is invisible in the common development configuration.
//     macOS renders OVERLAY scrollbars on a trackpad-only machine, and
//     an overlay bar looks fine at any width because it is translucent
//     and auto-hiding. The chunky bars only appear in CLASSIC mode —
//     a mouse attached under System Settings ▸ Appearance ▸ "Show
//     scroll bars: Automatically based on mouse or trackpad", the
//     "Always" setting, or transiently while another app re-evaluates
//     the scroller style during a screen capture. So a regression here
//     ships green and is reported later, by screenshot, from someone
//     else's desk. That is exactly how it shipped the first time.
//
//   • Adding a `::-webkit-scrollbar` block is the natural-looking way
//     to style a scrollbar, and it is the wrong one. Defining one puts
//     that scroller into Chromium's custom, NON-OVERLAY scrollbar mode:
//     the webkit `width`/`height` beats `scrollbar-width: thin`, the
//     bar stops auto-hiding, and it starts consuming layout width even
//     where an overlay bar would have consumed none. One block is
//     enough to make a single pane disagree with the rest of the app.
//
// PwrAgent carries the same invariant (its `theme-contract.test.tsx`
// guards the sidebar lanes); the two apps are meant to look identical
// here, so this suite mirrors it.
//
// Reads the CSS as strings, like theme-contract.test.ts next door: the
// files ARE the source of truth, and "this declaration is in this
// block" is a string-match question, not a CSSOM one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_SRC = join(__dirname, "..", "..");
const STYLES_DIR = join(__dirname, "..");

/** Every `.css` file the renderer bundle can pull in, relative-path
 *  labelled so a failure names the file to open. */
function collectCssFiles(dir: string, out: Array<[string, string]> = []): Array<[string, string]> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectCssFiles(full, out);
    } else if (entry.endsWith(".css")) {
      out.push([full.slice(RENDERER_SRC.length + 1), readFileSync(full, "utf8")]);
    }
  }
  return out;
}

/** Strip `/* … *\/` comments so prose ABOUT a banned selector doesn't
 *  read as a use of it — the app.css rule explains the ban at length. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extract the body of the first block matching a selector pattern. */
function extractBlock(css: string, selectorPattern: string): string {
  const match = stripComments(css).match(new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`));
  if (match === null) {
    throw new Error(`scrollbar-contract: no block found for selector /${selectorPattern}/`);
  }
  return match[1] ?? "";
}

const cssFiles = collectCssFiles(RENDERER_SRC);
const appCss = readFileSync(join(STYLES_DIR, "app.css"), "utf8");
const tokensCss = readFileSync(join(STYLES_DIR, "tokens.css"), "utf8");

describe("universal scrollbar rule", () => {
  // The universal selector, not `:root`. `scrollbar-color` inherits;
  // `scrollbar-width` does NOT — a `:root` rule would tint every
  // scroller and leave every width at the chunky default.
  const universal = extractBlock(appCss, "(?<![\\w.#\\]:-])\\*");

  it("sets scrollbar-width: thin on `*`", () => {
    expect(universal).toMatch(/scrollbar-width:\s*thin\s*;/);
  });

  it("sets scrollbar-color from the design tokens on `*`", () => {
    expect(universal).toMatch(
      /scrollbar-color:\s*var\(--scrollbar-thumb\)\s+var\(--scrollbar-track\)\s*;/
    );
  });
});

describe("scrollbar tokens", () => {
  // Declared once in the dark `:root` block and derived via color-mix
  // off `--text-primary` / `--text-muted`, both of which the light
  // block overrides — so light theme themes for free and must NOT get
  // a second literal declaration that can drift.
  const root = extractBlock(tokensCss, ":root");

  it.each(["scrollbar-track", "scrollbar-thumb"])("declares --%s in :root", (name) => {
    expect(root).toMatch(new RegExp(`--${name}\\s*:\\s*color-mix\\([^;]+\\);`));
  });

  it("does not redeclare the scrollbar tokens in the light block", () => {
    const light = extractBlock(tokensCss, ':root\\[data-theme="light"\\]');
    expect(light).not.toMatch(/--scrollbar-(track|thumb)\s*:/);
  });
});

describe("no ::-webkit-scrollbar anywhere in the renderer", () => {
  it.each(cssFiles)("%s", (_label, css) => {
    expect(stripComments(css)).not.toMatch(/::-webkit-scrollbar/);
  });
});

describe("every scrollbar-width override is deliberate", () => {
  // `thin` (the default posture) or `none` (a scroller that hides its
  // bar on purpose) are the only two legal values. `auto` would be a
  // per-scroller re-introduction of the chunky bar.
  it.each(cssFiles)("%s", (_label, css) => {
    const values = [...stripComments(css).matchAll(/scrollbar-width:\s*([a-z-]+)/g)].map(
      (m) => m[1]
    );
    for (const value of values) {
      expect(["thin", "none"]).toContain(value);
    }
  });
});
