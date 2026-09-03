// Shared CSS-as-string helpers for the stylesheet contract suites
// (theme-contract, scrollbar-contract).
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
