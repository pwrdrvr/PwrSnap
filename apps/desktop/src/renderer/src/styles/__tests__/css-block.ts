// Shared CSS-as-string helpers for the stylesheet contract suites
// (theme-contract, scrollbar-contract, focus-ring-contract).
//
// Both suites read a stylesheet as text and ask "is this declaration
// inside this block" — a string-match question, not a CSSOM one, which
// is why neither spins up jsdom. They had a copy each of the extractor,
// and the copies had already diverged: one stripped comments first, the
// other did not.
//
// That divergence is not cosmetic. `extractBlock` scans to the FIRST
// `}`, so a comment containing a brace — and stylesheet comments in this
// repo routinely quote CSS, e.g. chat-panel.css explaining
// `::-webkit-scrollbar { display: none }` — truncates the block at the
// comment and silently hides every declaration after it. Stripping first
// is the only correct behavior, so it lives here once.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** Remove `/* … *\/` comments. Prose ABOUT a selector or declaration
 *  must never read as a use of it, and a brace inside a comment must
 *  never terminate a block. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Extract the body of the block matching `selectorPattern` (a regex
 * source — escape what needs it) from already comment-stripped CSS.
 *
 * `expectSingle` guards the ordering trap: a bare `\*` matches both the
 * universal rule and the `*` in `.app-toast-stack > *`, and taking the
 * first match makes the assertion depend on which rule happens to come
 * first in the file. Pass `expectSingle: true` for a pattern that must
 * identify exactly one block, and reordering the stylesheet fails
 * loudly instead of silently retargeting.
 *
 * Throws when the block is missing — an explicit failure mode rather
 * than a silent `undefined`.
 */
export function extractBlock(
  strippedCss: string,
  selectorPattern: string,
  options: { label: string; expectSingle?: boolean }
): string {
  const re = new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`, "g");
  const matches = [...strippedCss.matchAll(re)];
  if (matches.length === 0) {
    throw new Error(`${options.label}: no block found for selector /${selectorPattern}/`);
  }
  if (options.expectSingle === true && matches.length > 1) {
    throw new Error(
      `${options.label}: selector /${selectorPattern}/ matched ${matches.length} blocks; ` +
        "it must identify exactly one — tighten the pattern"
    );
  }
  return matches[0]?.[1] ?? "";
}

/** Pull a single `--name: <value>;` declaration out of a block.
 *  Returns the trimmed value or throws if the token isn't declared. */
export function tokenValue(block: string, name: string, label: string): string {
  const match = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  if (match === null) {
    throw new Error(`${label}: --${name} not declared in this block`);
  }
  return (match[1] ?? "").trim();
}

export type CssFile = [label: string, stripped: string];

/**
 * Path under `root`, as a POSIX-separated label.
 *
 * `join` uses the platform separator, so on Windows the raw slice
 * yields `styles\\app.css` and every forward-slash comparison in a
 * suite silently stops matching — which is exactly how
 * scrollbar-contract landed red on the Windows lane while passing on
 * macOS and Linux.
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

/** Every `.css` file under `root` (the renderer bundle's source tree),
 *  comment-stripped once at collection and labelled with its
 *  `root`-relative path so a failure names the file to open. Shared so
 *  the suites that sweep every stylesheet cannot disagree about which
 *  stylesheets exist. */
export function collectCssFiles(root: string, dir: string = root, out: CssFile[] = []): CssFile[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectCssFiles(root, full, out);
    } else if (entry.endsWith(".css")) {
      out.push([toPosixLabel(full, root), stripCssComments(readFileSync(full, "utf8"))]);
    }
  }
  return out;
}
