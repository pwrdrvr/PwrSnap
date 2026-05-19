#!/usr/bin/env node

/**
 * Renderer color-literal lint.
 *
 * Walks every CSS file under `apps/desktop/src/renderer/src/` and
 * asserts that hex / rgb / rgba / hsl / hsla literals only appear
 * inside the allowlisted token-definition blocks (`:root` +
 * `:root[data-theme="..."]` in `tokens.css`). Every other rule must
 * reference colors via `var(--token)` (or `color-mix(in srgb,
 * var(--token) X%, transparent)` for derived alphas).
 *
 * This is the regression-prevention piece for PwrSnap's theming
 * system (PR #58). Without it, the next contributor who adds
 * `color: #abcdef;` somewhere silently breaks light-theme rendering
 * because the literal doesn't flip with `data-theme`.
 *
 * The check is intentionally CSS-only and shape-pure: no parser
 * dependency, no token-name validation, no contrast checking. It
 * only answers one question: "is this literal inside an allowlisted
 * rule?"
 *
 * Adapted from PwrAgent's `scripts/lint-renderer-colors.mjs`
 * (PR #509). PwrAgent has one `app.css`; PwrSnap splits into
 * tokens.css + per-surface stylesheets, so this version walks a
 * list of paths instead of a single file.
 *
 * Wire-up:
 *   - `pnpm lint:colors` runs it standalone.
 *   - `pnpm lint` runs it as part of the lint chain.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const targets = [
  // tokens.css owns the :root + :root[data-theme="light"] blocks,
  // which are allowlisted below. Everything else in here must use
  // var(--token).
  "apps/desktop/src/renderer/src/styles/tokens.css",
  "apps/desktop/src/renderer/src/styles/app.css",
  "apps/desktop/src/renderer/src/styles/library.css",
  "apps/desktop/src/renderer/src/styles/float-over.css",
  "apps/desktop/src/renderer/src/styles/settings.css",
  "apps/desktop/src/renderer/src/styles/documents.css",
  "apps/desktop/src/renderer/src/features/editor/editor.css"
  // Path-excluded:
  //   styles/region.css — the region selector paints a "darkroom"
  //     scrim that intentionally does NOT theme. Every rule sits on
  //     a fixed dark backdrop (the click-traps, the rgba(0,0,0,0.62)
  //     dim, the bright-tangerine selection rects, the keyboard hint
  //     chips). Inverting to white in light theme would break the
  //     selection metaphor. Same exemption category as PwrAgent's
  //     `.context-window-moon` illustration in PR #509.
  //   fonts.css — @font-face declarations only, no color literals
  //     possible.
].map((p) => resolve(repoRoot, p));

// Rules whose bodies are allowed to contain raw color literals — the
// token-definition blocks. Anything else must use `var(--token)`.
//
// Matched against the rule's selector text after whitespace
// normalization. To add a future theme (e.g. high-contrast), drop
// its selector here AND add the corresponding `:root[data-theme=
// "..."]` block in tokens.css.
const ALLOWED_TOP_LEVEL_SELECTORS = new Set([
  ":root",
  ':root[data-theme="light"]',
  ':root[data-theme="dark"]'
]);

// Selector substrings whose rules are allowed to carry raw color
// literals because they're either bespoke illustration assets or
// intentional non-theming surfaces. Use sparingly: prefer adding the
// surface to the regular token system, or path-exclude the whole
// file at the top of this script.
//
// Currently empty — the only "intentional darkroom" surface today is
// the entire region.css file, which is excluded by path above.
const ALLOWED_SELECTOR_SUBSTRINGS = [];

// Color literal patterns. Hex covers #abc / #abcd / #abcdef / #abcdefab.
// Functional-notation covers rgb()/rgba()/hsl()/hsla() — the leading
// keyword is what triggers detection, so `color-mix(in srgb, ...)`
// is NOT matched (the `srgb` inside is bare, no leading `rgb(`).
//
// We deliberately do NOT flag the 147 CSS named colors (red, white,
// etc.) — they're rare enough in this codebase that the marginal
// value isn't worth the false-positive surface from things like
// `font-family: "Helvetica"` (string, stripped) or property values
// that share names (`color-scheme: dark`, etc.).
const COLOR_LITERAL_RE = /(#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\()/g;

runSelfTests();

let totalFindings = 0;
for (const targetPath of targets) {
  const source = readFileSync(targetPath, "utf8");
  // Strip only comments at the source level (strings in selectors
  // like `:root[data-theme="light"]` must survive so the allowlist
  // match works). Strings inside rule bodies are stripped per-body
  // in the scanner — see `collectFindings`.
  const scrubbed = stripComments(source);
  const findings = collectFindings(scrubbed);

  if (findings.length > 0) {
    if (totalFindings === 0) {
      console.error(
        "Raw color literals must live inside :root or :root[data-theme=\"...\"]."
      );
      console.error(
        "Use var(--token), or color-mix(in srgb, var(--token) <pct>%, transparent)"
      );
      console.error("for derived alpha overlays. Define new tokens in :root.");
      console.error("");
    }
    const rel = relative(repoRoot, targetPath);
    for (const f of findings) {
      console.error(`- ${rel}:${f.line} in \`${f.selector} { ... }\`: ${f.literal}`);
    }
    totalFindings += findings.length;
  }
}

if (totalFindings > 0) {
  process.exit(1);
}

console.log("renderer color lint passed");

/**
 * Replace each CSS block comment with same-length whitespace so line
 * numbers in the original source still resolve correctly. Strings are
 * left intact at the source level — the body scanner strips them
 * locally so attribute-selector strings like `data-theme="light"`
 * survive for the allowlist match.
 */
export function stripComments(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out.push(blank(text.slice(i, stop)));
      i = stop;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

/** Per-body string strip. Used when scanning a rule's body for color
 *  literals — prevents hex inside data-URLs (e.g.
 *  `url("data:...%23ff0000")`) from being treated as a violation. */
function stripStrings(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = findStringClose(text, i + 1, c);
      out.push(blank(text.slice(i, close)));
      i = close;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

function findStringClose(text, start, quote) {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === "\n") return i;
    i += 1;
  }
  return text.length;
}

function blank(slice) {
  return slice.replace(/[^\n]/g, " ");
}

/**
 * Walk the CSS, tracking the rule-nesting stack and the start of the
 * current segment (selector or rule body). For every literal found in
 * a rule body, check whether the rule's selector is allowlisted; if
 * not, record a finding.
 */
export function collectFindings(text) {
  const findings = [];
  const stack = [];
  let segmentStart = 0;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{") {
      const selector = normalizeSelector(text.slice(segmentStart, i));
      stack.push(selector);
      segmentStart = i + 1;
    } else if (c === "}") {
      const body = text.slice(segmentStart, i);
      const selector = stack[stack.length - 1] ?? "";
      // Only check rules whose body directly contains declarations.
      // Attributes a literal to the *innermost* rule containing it,
      // which is the semantically correct owner.
      if (!isAllowed(selector)) {
        for (const hit of findLiterals(body, segmentStart)) {
          findings.push({ selector, line: hit.line, literal: hit.text });
        }
      }
      stack.pop();
      segmentStart = i + 1;
    }
  }

  return findings;

  function findLiterals(body, bodyStartIndex) {
    const scannable = stripStrings(body);
    const out = [];
    COLOR_LITERAL_RE.lastIndex = 0;
    let m;
    while ((m = COLOR_LITERAL_RE.exec(scannable)) !== null) {
      const absoluteIndex = bodyStartIndex + m.index;
      out.push({ text: m[0], line: lineNumberAt(absoluteIndex) });
    }
    return out;
  }

  function lineNumberAt(position) {
    let line = 1;
    for (let j = 0; j < position; j += 1) {
      if (text[j] === "\n") line += 1;
    }
    return line;
  }
}

function normalizeSelector(raw) {
  return raw.trim().replace(/\s+/g, " ");
}

function isAllowed(selector) {
  if (ALLOWED_TOP_LEVEL_SELECTORS.has(selector)) return true;
  for (const substring of ALLOWED_SELECTOR_SUBSTRINGS) {
    if (selector.includes(substring)) return true;
  }
  return false;
}

function runSelfTests() {
  function findings(css) {
    return collectFindings(stripComments(css));
  }

  if (findings(":root { --bg: #000000; }").length !== 0) {
    throw new Error("self-test: :root literal was incorrectly flagged");
  }

  if (findings(':root[data-theme="light"] { --bg: #ffffff; }').length !== 0) {
    throw new Error("self-test: light-theme literal was incorrectly flagged");
  }

  const componentHex = findings(".thread-row { color: #ff0000; }");
  if (componentHex.length !== 1 || componentHex[0].literal !== "#ff0000") {
    throw new Error("self-test: failed to flag raw hex in component rule");
  }

  const componentRgba = findings(
    ".thread-row { background: rgba(255, 0, 0, 0.5); }"
  );
  if (componentRgba.length !== 1) {
    throw new Error("self-test: failed to flag rgba in component rule");
  }

  const colorMix = findings(
    ".x { background: color-mix(in srgb, var(--accent) 50%, transparent); }"
  );
  if (colorMix.length !== 0) {
    throw new Error("self-test: color-mix(var(...)) incorrectly flagged");
  }

  const commented = findings(".x { /* old: #ff0000 */ color: var(--bg); }");
  if (commented.length !== 0) {
    throw new Error("self-test: literal inside comment incorrectly flagged");
  }

  const stringed = findings(
    ".x { background: url('data:image/svg+xml,%23ff0000'); }"
  );
  if (stringed.length !== 0) {
    throw new Error("self-test: literal inside string incorrectly flagged");
  }

  const nested = findings(
    "@media (max-width: 760px) { .x { color: #abc; } }"
  );
  if (nested.length !== 1 || nested[0].selector !== ".x") {
    throw new Error("self-test: nested-rule literal mis-attributed");
  }

  const lineCheck = findings("/* a */\n.x { color: #f00; }");
  if (lineCheck.length !== 1 || lineCheck[0].line !== 2) {
    throw new Error(
      `self-test: line number drifted under comment stripping (got ${lineCheck[0]?.line})`
    );
  }

  // Substring allowlist still works when entries get added in the
  // future. Verify with a synthetic substring rather than testing on
  // the live (currently empty) allowlist.
  const originalSubstrings = ALLOWED_SELECTOR_SUBSTRINGS.slice();
  try {
    ALLOWED_SELECTOR_SUBSTRINGS.push(".synthetic-illustration");
    const exempt = findings(
      ".synthetic-illustration__disc { background: #abc; }"
    );
    if (exempt.length !== 0) {
      throw new Error(
        "self-test: substring-allowlisted selector incorrectly flagged"
      );
    }
  } finally {
    ALLOWED_SELECTOR_SUBSTRINGS.length = 0;
    ALLOWED_SELECTOR_SUBSTRINGS.push(...originalSubstrings);
  }
}
