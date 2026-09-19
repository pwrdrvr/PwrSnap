// The bundled fonts only draw if something asks for them BY THE NAME THEY
// REGISTER. fonts.css imports @fontsource CSS, and each of those files
// declares `@font-face { font-family: '<name>' }`; tokens.css's --font-*
// stacks are what the renderer actually requests. Nothing connected the
// two, and they drifted: @fontsource/geist-sans registers "Geist Sans",
// the stacks asked for "Geist", the woff2 never loaded, and every sans
// glyph in the app shipped in the system UI font. A machine with Geist
// installed system-wide would have masked it completely.
//
// So this suite reads the family names out of the @fontsource CSS that
// fonts.css actually imports — resolved through node_modules, never
// hard-coded — and holds the token stacks to them.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBlock, stripCssComments, tokenValue } from "./css-block";

const LABEL = "font-family-contract";
const STYLES_DIR = join(__dirname, "..");
const RENDERER_SRC = join(STYLES_DIR, "..");
const FONTS_CSS_PATH = join(STYLES_DIR, "fonts.css");
const TOKENS_CSS_PATH = join(STYLES_DIR, "tokens.css");
const FONT_TOKENS = ["font-sans", "font-mono", "font-display"] as const;

const unquote = (family: string): string => family.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Resolve every `@import` in fonts.css exactly as Vite does — through
 *  node_modules from the importing file — and return the family name of
 *  each `@font-face` those files declare. */
function bundledFamilies(): { imports: string[]; families: Set<string> } {
  const fontsCss = stripCssComments(readFileSync(FONTS_CSS_PATH, "utf8"));
  const imports = [...fontsCss.matchAll(/@import\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
  const requireFromFontsCss = createRequire(FONTS_CSS_PATH);
  const families = new Set<string>();
  for (const specifier of imports) {
    const css = stripCssComments(readFileSync(requireFromFontsCss.resolve(specifier), "utf8"));
    for (const face of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const family = (face[1] ?? "").match(/font-family\s*:\s*([^;]+);/)?.[1];
      if (family !== undefined) families.add(unquote(family));
    }
  }
  return { imports, families };
}

function tokenStacks(): Record<(typeof FONT_TOKENS)[number], string[]> {
  const root = extractBlock(stripCssComments(readFileSync(TOKENS_CSS_PATH, "utf8")), ":root", {
    label: LABEL
  });
  const stack = (name: string): string[] => tokenValue(root, name, LABEL).split(",").map(unquote);
  return {
    "font-sans": stack("font-sans"),
    "font-mono": stack("font-mono"),
    "font-display": stack("font-display")
  };
}

describe("bundled @font-face families vs the --font-* token stacks", () => {
  const { imports, families } = bundledFamilies();
  const stacks = tokenStacks();

  it("finds the bundled faces (an empty scan would pass everything below)", () => {
    expect(imports.length).toBeGreaterThan(0);
    expect(families.size).toBeGreaterThan(0);
  });

  it("names every bundled family in some token stack", () => {
    const named = new Set(Object.values(stacks).flat());
    const orphaned = [...families].filter((family) => !named.has(family));
    // An orphaned family is a woff2 we ship and never draw.
    expect(orphaned).toEqual([]);
  });

  it.each(FONT_TOKENS)("--%s leads with a bundled family", (token) => {
    // First, not merely present: a system-installed font named earlier in
    // the stack would win on the machine that has it and hide a miss.
    expect([...families]).toContain(stacks[token][0]);
  });
});

describe("renderer code names Geist only through the tokens", () => {
  // The countdown numeral hard-coded `'Geist'` and missed the bundle the
  // same way the tokens did. Family names live in tokens.css (and the
  // explanatory comment in fonts.css); everything else uses var(--font-*).
  const SCANNED = new Set([".css", ".ts", ".tsx"]);
  const EXEMPT = new Set([TOKENS_CSS_PATH, FONTS_CSS_PATH]);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
      } else if (SCANNED.has(extname(entry.name)) && !EXEMPT.has(path)) {
        files.push(path);
      }
    }
  };
  walk(RENDERER_SRC);

  it("scans the renderer tree", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no quoted Geist family literal outside tokens.css", () => {
    const offenders = files.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/(["'])Geist(?: [A-Za-z]+)?\1/g)].map(
        (m) => `${relative(RENDERER_SRC, path)}: ${m[0]}`
      )
    );
    expect(offenders).toEqual([]);
  });
});
