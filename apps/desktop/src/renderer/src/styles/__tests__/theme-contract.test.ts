// Lock the design-token contract for both themes. Mirrors the
// strategy in PwrAgent's `theme-contract.test.tsx`: pin every
// surface / border / text / accent / button / shadow token in the
// dark `:root` block and the `:root[data-theme="light"]` override,
// so a future accidental edit to tokens.css fails this suite loudly.
//
// Why locking the strings vs. visually inspecting: palette changes
// have shipped twice in this codebase by sed-replace already, and
// both times they re-discovered the same warm-black scrim drift
// (see docs/solutions/ or the brand-palette PR's review thread).
// This test is the cheapest possible guard — diff fails → tests
// fail → reviewer notices.
//
// Reads tokens.css as a string and matches values via regex. We
// deliberately do NOT spin up jsdom + getComputedStyle here:
//   • The file string is the source of truth — applying it through
//     jsdom's CSS engine adds parse risk without buying anything,
//     because tokens.css is plain custom-property declarations.
//   • The lock semantics are "this exact value should be in this
//     exact block," which is a string-match question, not a CSSOM
//     question.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS_PATH = join(__dirname, "..", "tokens.css");
const css = readFileSync(TOKENS_PATH, "utf8");

/** Extract the body (`{ ... }`) of a selector block. Selector is
 *  matched as a regex source (escape what needs it). Throws when
 *  the block is missing — that's an explicit failure mode rather
 *  than a silent `undefined`. */
function extractBlock(selectorPattern: string): string {
  const re = new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`);
  const match = css.match(re);
  if (match === null) {
    throw new Error(`theme-contract: no block found for selector /${selectorPattern}/`);
  }
  return match[1] ?? "";
}

/** Pull a single `--name: <value>;` declaration out of a block.
 *  Returns the trimmed value or throws if the token isn't defined
 *  in that block. */
function tokenValue(block: string, name: string): string {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
  const match = block.match(re);
  if (match === null) {
    throw new Error(`theme-contract: --${name} not declared in this block`);
  }
  return (match[1] ?? "").trim();
}

describe("dark theme :root tokens", () => {
  const block = extractBlock(":root");

  // Surfaces — pure-black suite system. Drift here = the warm-black
  // re-introduction we just spent a PR removing.
  it.each([
    ["bg-app", "#000000"],
    ["bg-sidebar", "#050505"],
    ["bg-panel", "#0a0a0a"],
    ["bg-panel-elevated", "#101010"],
    ["bg-panel-hover", "#14110d"],
    ["bg-row-active", "#1f1107"],
    ["bg-input", "#080808"],
    ["bg-overlay", "rgba(0, 0, 0, 0.78)"]
  ])("--%s = %s", (name, expected) => {
    expect(tokenValue(block, name)).toBe(expected);
  });

  // Accent — tangerine, matches the PwrAgent suite. The derived
  // alpha overlays (`-soft`, `-tint`, `-border`, `-shadow`) are
  // declared as `color-mix(in srgb, var(--accent) X%, transparent)`
  // so they automatically flip when --accent does — locking them
  // here as strings catches accidental percent drift.
  it.each([
    ["accent", "#ff8a1f"],
    ["accent-strong", "#ffa33d"],
    ["accent-bright", "#ffb35c"],
    ["accent-deep", "#b35f15"],
    ["accent-soft", "color-mix(in srgb, var(--accent) 12%, transparent)"],
    ["accent-tint", "color-mix(in srgb, var(--accent) 6%, transparent)"],
    ["accent-border", "color-mix(in srgb, var(--accent) 42%, transparent)"],
    ["accent-shadow", "color-mix(in srgb, var(--accent) 34%, transparent)"]
  ])("--%s = %s", (name, expected) => {
    expect(tokenValue(block, name)).toBe(expected);
  });

  it.each([
    ["text-primary", "#f7f3eb"],
    ["text-secondary", "#b8b0a5"],
    ["text-muted", "#8c857a"],
    ["button-text-on-accent", "#000000"]
  ])("--%s = %s", (name, expected) => {
    expect(tokenValue(block, name)).toBe(expected);
  });

  it("declares color-scheme: dark", () => {
    expect(block).toMatch(/color-scheme:\s*dark/);
  });
});

describe("light theme :root[data-theme=\"light\"] overrides", () => {
  const block = extractBlock(':root\\[data-theme="light"\\]');

  // Surfaces — warm off-white. Mirrors the PwrAgent light palette.
  it.each([
    ["bg-app", "#ffffff"],
    ["bg-sidebar", "#f7f4ef"],
    ["bg-panel", "#fdfcfa"],
    ["bg-panel-elevated", "#ffffff"],
    ["bg-panel-hover", "#f4f0e8"],
    ["bg-row-active", "#fff5e9"],
    ["bg-input", "#ffffff"],
    ["bg-overlay", "rgba(0, 0, 0, 0.32)"]
  ])("--%s = %s", (name, expected) => {
    expect(tokenValue(block, name)).toBe(expected);
  });

  // Accent — deepened tangerine for WCAG on white. The three
  // overlays (`-soft`, `-tint`, `-border`) inherit from :root because
  // they're declared as `color-mix(... var(--accent) ...)` — var()
  // resolves at use-site, so overriding --accent here is enough.
  // Only `--accent-shadow` re-declares at 28% (vs dark's 34%) for
  // a softer cast on white panels.
  it.each([
    ["accent", "#c45200"],
    ["accent-strong", "#b34a00"],
    ["accent-bright", "#d96d00"],
    ["accent-deep", "#8a3a00"],
    ["accent-shadow", "color-mix(in srgb, var(--accent) 28%, transparent)"]
  ])("--%s = %s", (name, expected) => {
    expect(tokenValue(block, name)).toBe(expected);
  });

  it("inherits --accent-soft / -tint / -border from :root via color-mix", () => {
    // These three are intentionally NOT re-declared in the light
    // block — color-mix re-resolves them against the overridden
    // --accent automatically. Lock the absence so a future edit that
    // adds redundant overrides has to delete them or add them here.
    expect(block).not.toMatch(/--accent-soft\s*:/);
    expect(block).not.toMatch(/--accent-tint\s*:/);
    expect(block).not.toMatch(/--accent-border\s*:/);
  });

  it.each([
    ["text-primary", "#1a1612"],
    ["text-secondary", "#524a40"],
    ["text-muted", "#807870"],
    ["button-text-on-accent", "#ffffff"]
  ])("--%s = %s", (name, expected) => {
    expect(tokenValue(block, name)).toBe(expected);
  });

  it("declares color-scheme: light", () => {
    expect(block).toMatch(/color-scheme:\s*light/);
  });
});

describe("theme contract: WCAG contrast spot-checks", () => {
  // Minimal sRGB → relative luminance + contrast helpers. Kept
  // inline so this test stays a single file with no extra deps.

  function hexToRgb(hex: string): [number, number, number] {
    const normalized = hex.replace("#", "");
    if (normalized.length !== 6) {
      throw new Error(`hexToRgb: expected 6-digit hex, got ${hex}`);
    }
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return [r, g, b];
  }

  function luminanceChannel(c: number): number {
    const sr = c / 255;
    return sr <= 0.03928 ? sr / 12.92 : Math.pow((sr + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance([r, g, b]: [number, number, number]): number {
    return (
      0.2126 * luminanceChannel(r) +
      0.7152 * luminanceChannel(g) +
      0.0722 * luminanceChannel(b)
    );
  }

  function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(hexToRgb(a));
    const lb = relativeLuminance(hexToRgb(b));
    const [light, dark] = la > lb ? [la, lb] : [lb, la];
    return (light + 0.05) / (dark + 0.05);
  }

  describe("dark theme", () => {
    const block = extractBlock(":root");
    const textPrimary = tokenValue(block, "text-primary");
    const bgApp = tokenValue(block, "bg-app");
    const bgPanelElevated = tokenValue(block, "bg-panel-elevated");
    const buttonText = tokenValue(block, "button-text-on-accent");
    const accent = tokenValue(block, "accent");

    it("text-primary on bg-app meets AA (>= 4.5)", () => {
      expect(contrastRatio(textPrimary, bgApp)).toBeGreaterThanOrEqual(4.5);
    });
    it("text-primary on bg-panel-elevated meets AA", () => {
      expect(contrastRatio(textPrimary, bgPanelElevated)).toBeGreaterThanOrEqual(4.5);
    });
    it("button-text-on-accent on accent meets AA", () => {
      expect(contrastRatio(buttonText, accent)).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe("light theme", () => {
    const block = extractBlock(':root\\[data-theme="light"\\]');
    const textPrimary = tokenValue(block, "text-primary");
    const bgApp = tokenValue(block, "bg-app");
    const bgPanel = tokenValue(block, "bg-panel");
    const buttonText = tokenValue(block, "button-text-on-accent");
    const accent = tokenValue(block, "accent");

    it("text-primary on bg-app meets AA", () => {
      expect(contrastRatio(textPrimary, bgApp)).toBeGreaterThanOrEqual(4.5);
    });
    it("text-primary on bg-panel meets AA", () => {
      expect(contrastRatio(textPrimary, bgPanel)).toBeGreaterThanOrEqual(4.5);
    });
    // button-text-on-accent on the deepened light-theme tangerine.
    // 4.5:1 is the AA bar — if a future palette tweak softens the
    // accent past this, the button label becomes unreadable.
    it("button-text-on-accent on accent meets AA", () => {
      expect(contrastRatio(buttonText, accent)).toBeGreaterThanOrEqual(4.5);
    });
  });
});
