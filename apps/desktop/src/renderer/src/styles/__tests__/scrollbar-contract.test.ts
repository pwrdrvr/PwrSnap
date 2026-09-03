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
// block" is a string-match question, not a CSSOM one. The extractor
// itself is shared with that suite — see ./css-block.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBlock, stripCssComments } from "./css-block";

const LABEL = "scrollbar-contract";
const RENDERER_SRC = join(__dirname, "..", "..");
const STYLES_DIR = join(__dirname, "..");
// …/apps/desktop/src/renderer/src → repo root is five levels up.
const REPO_ROOT = join(RENDERER_SRC, "..", "..", "..", "..", "..");

/** Feature areas that own stylesheets today. Named explicitly so a
 *  directory MOVE — the one way the collector can go partially blind
 *  while every assertion below still passes — fails loudly instead. */
const REQUIRED_CSS_AREAS = ["styles/", "features/"];
/** Floor, not an exact count: adding a stylesheet must not need a test
 *  edit, but losing most of them must not pass silently. */
const MIN_CSS_FILES = 20;

type CssFile = [label: string, stripped: string];

/**
 * Path under `RENDERER_SRC`, as a POSIX-separated label.
 *
 * `join` uses the platform separator, so on Windows the raw slice
 * yields `styles\\app.css` and every forward-slash comparison in this
 * file silently stops matching — which is exactly how this suite
 * landed red on the Windows lane while passing on macOS and Linux.
 *
 * Split out as a pure function ON PURPOSE: the obvious guard, asserting
 * that the collected labels contain no backslash, is VACUOUS on macOS
 * and Linux, so it can only fail on the one lane that already caught
 * the bug. Testing the function with a Windows-shaped input instead
 * makes the regression catchable on every platform.
 *
 * `separator` is injectable for that test; it defaults to the running
 * platform's.
 */
export function toPosixLabel(fullPath: string, root: string, separator: string = sep): string {
  return fullPath.slice(root.length + 1).split(separator).join("/");
}

/** Every `.css` file the renderer bundle can pull in, comment-stripped
 *  once at collection and relative-path labelled so a failure names the
 *  file to open. */
function collectCssFiles(dir: string, out: CssFile[] = []): CssFile[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectCssFiles(full, out);
    } else if (entry.endsWith(".css")) {
      out.push([toPosixLabel(full, RENDERER_SRC), stripCssComments(readFileSync(full, "utf8"))]);
    }
  }
  return out;
}

const cssFiles = collectCssFiles(RENDERER_SRC);
const appCss = stripCssComments(readFileSync(join(STYLES_DIR, "app.css"), "utf8"));
const tokensCss = stripCssComments(readFileSync(join(STYLES_DIR, "tokens.css"), "utf8"));

describe("the CSS collector actually covers the renderer", () => {
  // Without this, a stylesheet directory moved out from under
  // RENDERER_SRC narrows the ban below to whatever is left, with the
  // suite still green — the exact regression this file exists to catch.
  // (A fully empty collection is caught by Vitest itself, which errors
  // on an `it.each([])`; a PARTIAL miss is what needs asserting.)
  it(`finds at least ${MIN_CSS_FILES} stylesheets`, () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(MIN_CSS_FILES);
  });

  it.each(REQUIRED_CSS_AREAS)("covers %s", (area) => {
    expect(cssFiles.some(([label]) => label.startsWith(area))).toBe(true);
  });

  // Every other assertion in this file compares labels against
  // forward-slash literals, so the normalization is load-bearing on
  // Windows. Driven with an explicit `\\` separator rather than the
  // platform's, because asserting on the REAL labels would pass
  // vacuously here and fail only on the Windows lane.
  it("labels paths POSIX-style regardless of the platform separator", () => {
    expect(toPosixLabel("C:\\r\\styles\\app.css", "C:\\r", "\\")).toBe("styles/app.css");
    expect(toPosixLabel("/r/features/shared/chat/x.css", "/r", "/")).toBe(
      "features/shared/chat/x.css"
    );
  });
});

describe("universal scrollbar rule", () => {
  // The universal selector, not `:root`. `scrollbar-color` inherits;
  // `scrollbar-width` does NOT — a `:root` rule would tint every
  // scroller and leave every width at the chunky default.
  //
  // Anchored to a `*` that STARTS a selector line, because a bare `\*`
  // also matches `.app-toast-stack > *` further down the file; matching
  // both and taking the first would make this assertion depend on rule
  // order. `expectSingle` makes that ambiguity throw rather than pick.
  const universal = extractBlock(appCss, "(?<=\\n)\\*", {
    label: LABEL,
    expectSingle: true
  });

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
  const root = extractBlock(tokensCss, ":root", { label: LABEL, expectSingle: true });

  it.each(["scrollbar-track", "scrollbar-thumb"])("declares --%s in :root", (name) => {
    expect(root).toMatch(new RegExp(`--${name}\\s*:\\s*color-mix\\([^;]+\\);`));
  });

  it("does not redeclare the scrollbar tokens in the light block", () => {
    const light = extractBlock(tokensCss, ':root\\[data-theme="light"\\]', { label: LABEL });
    expect(light).not.toMatch(/--scrollbar-(track|thumb)\s*:/);
  });

  it("is mirrored into the design-system palette", () => {
    // CLAUDE.md: "PwrSnap mirrors its `:root` palette in
    // design/ds/colors_and_type.css and tokens.css." That file is a
    // live mirror, not a frozen handoff — it already tracks the shadow
    // and surface tokens — so a new palette token belongs in both.
    const mirror = readFileSync(
      join(REPO_ROOT, "design", "ds", "colors_and_type.css"),
      "utf8"
    );
    expect(mirror).toMatch(/--scrollbar-track\s*:/);
    expect(mirror).toMatch(/--scrollbar-thumb\s*:/);
  });
});

describe("no ::-webkit-scrollbar anywhere in the renderer", () => {
  it.each(cssFiles)("%s", (_label, stripped) => {
    expect(stripped).not.toMatch(/::-webkit-scrollbar/);
  });
});

describe("every scrollbar-width declaration is deliberate", () => {
  // `thin` (the universal default) or `none` (a scroller that hides its
  // bar on purpose) are the only two legal values. `auto` would be a
  // per-scroller re-introduction of the chunky bar.
  it.each(cssFiles)("%s", (_label, stripped) => {
    const values = [...stripped.matchAll(/scrollbar-width:\s*([a-z-]+)/g)].map((m) => m[1]);
    for (const value of values) {
      expect(["thin", "none"]).toContain(value);
    }
  });

  it("declares thin exactly once — on the universal rule", () => {
    // A per-scroller `scrollbar-width: thin` is dead weight now that
    // `*` carries it, and worse than dead: it reads as a deliberate
    // opt-in, which invites deleting the universal rule on the belief
    // that each scroller already opts in for itself.
    const thinDeclarations = cssFiles.flatMap(([label, stripped]) =>
      [...stripped.matchAll(/scrollbar-width:\s*thin/g)].map(() => label)
    );
    expect(thinDeclarations).toEqual(["styles/app.css"]);
  });
});
