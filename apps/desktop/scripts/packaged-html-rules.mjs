// Content rules for HTML that ships inside app.asar.
//
// The `forbidden` path-pattern table in `verify-asar-contents.mjs` answers
// "may this file be in the bundle at all". These answer "is the content of a
// file that may be in the bundle acceptable", which needs the bytes rather
// than the path. Kept in their own module so the regexes are unit-testable
// without packing an asar.

/**
 * The app's own renderer HTML, as `asar.listPackage` spells it (leading
 * slash; backslashes already normalized away by the caller when the archive
 * was built on Windows).
 *
 * Scoped to `/out/` on purpose. electron-builder ships `out/**` plus the
 * auto-included production `node_modules`, and a dependency that vendors a
 * playground page pointing at a CDN is not this repository's problem: the app
 * never loads it, and failing a release on it would tell the operator to
 * unset a flag that has nothing to do with the file. `/out/` is also never
 * unpacked (`asarUnpack` covers `**\/*.node` and `@img/**` only), which keeps
 * `extractFile` off the `.unpacked` sidecar path that may not be colocated in
 * the staged Windows signing job.
 */
export function isRendererHtmlEntry(entry) {
  return /^\/out\/.*\.html?$/i.test(entry);
}

/**
 * A `<script src>` pointing anywhere outside the asar: absolute http(s) or
 * protocol-relative.
 *
 * The whitespace before `src` is load-bearing. `\bsrc` would also match the
 * hyphenated attributes (`data-src`, `x-src`) that lazy-loaders use as inert
 * placeholders, and flagging one of those would fail a release over markup
 * that loads nothing.
 *
 * The trailing `[^"'\s>]*` carries the rest of the URL into the match. The
 * rule is written against the SHAPE, not against the DevTools flag, so the
 * offender is often not the one the failure message can name — and a snippet
 * that stops at `//` tells an operator the protocol but not the host.
 */
const REMOTE_SCRIPT_PATTERN =
  /<script\b[^>]*\ssrc\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]*/i;

export function findRemoteScript(contents) {
  return REMOTE_SCRIPT_PATTERN.exec(contents)?.[0] ?? null;
}
