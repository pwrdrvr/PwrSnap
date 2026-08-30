#!/usr/bin/env node

/**
 * Gate the licenses in THIRD_PARTY_LICENSES against an explicit allowlist.
 *
 * This is the check that `generate-third-party-licenses.mjs` deliberately is
 * not. That script is a transcriber: it asks pnpm what the tree declares and
 * writes it into THIRD_PARTY_LICENSES verbatim, grouping by whatever license
 * string it is handed. It never judges the string. So before this gate existed,
 * a dependency flipping MIT -> GPL-3.0 (or a transitive GPL dep arriving in a
 * Dependabot bump) produced a new "GPL-3.0" section in the notice, and
 * `licenses:check` then PASSED, because the committed file matched the
 * generated one. Green CI, copyleft shipped, nobody told.
 *
 * The only safety net was that a human might notice a new license heading in a
 * PR diff. That is thin for a hand-run generator and worth nothing at all once
 * regeneration is automated on Dependabot branches, which is the point of this
 * gate: make a bad license fail loudly and independently of whether anyone read
 * the diff.
 *
 * ## What is covered, exactly
 *
 * The scope is "the records the notice is built from", because that is the
 * artifact this gate protects. `buildThirdPartyLicenseNotice` assembles those
 * from four sources, and this gate reads three of them:
 *
 * 1. The npm production tree (`pnpm licenses list --prod --no-optional`) — the
 *    surface that moves on its own under Dependabot. Must be permissive.
 * 2. `NOTICE_DEV_DEPENDENCIES` from the `all` report. The generator pulls
 *    Electron in from there because Electron is a devDependency that ships;
 *    reading only the production report would leave the single largest shipped
 *    component ungated. Must be permissive.
 * 3. SHIPPED_PLATFORM_PACKAGES, the hand-maintained native slices, read off
 *    disk because `--no-optional` hides them from surface 1. The only place
 *    weak copyleft is permitted, and only for an entry carrying the `lgpl`
 *    disclosure descriptor that puts its FSF text and written source offer in
 *    the notice.
 *
 * NOT covered, and deliberately so:
 *
 * - **Optional dependencies other than the sharp slices in
 *   SHIPPED_PLATFORM_PACKAGES.** `--no-optional` is what makes the notice
 *   identical on every platform, so the production report cannot enumerate
 *   them. A new optional dependency that ships must be added to
 *   SHIPPED_PLATFORM_PACKAGES to be both disclosed AND gated. Neither this
 *   gate nor the generator can discover one on its own.
 * - **Bundled binaries** (`BUNDLED_FFMPEG`), whose license is a hand-written
 *   constant rather than anything read from the tree. Changing it is already a
 *   deliberate edit to a reviewed file.
 *
 * Strong copyleft (GPL, AGPL) and source-available licenses (BSL, SSPL,
 * Commons Clause) are permitted nowhere. Neither is an unresolvable string like
 * "UNLICENSED" or "SEE LICENSE IN ...", which fails to parse and is reported.
 */

import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";
import {
  NOTICE_PNPM_ARGS,
  SHIPPED_PACKAGE_CODE,
  SHIPPED_PLATFORM_PACKAGES,
  STALE_INSTALL_CODE,
  flattenLicenseReport,
  lgplFamilyOf,
  locateShippedPlatformPackages,
  runPnpmLicenses,
} from "./generate-third-party-licenses.mjs";

/**
 * devDependencies the notice nonetheless covers, because they ship.
 *
 * Mirrors the `record.name === "electron"` special case in
 * buildThirdPartyLicenseNotice. These two lists must stay in step: a name the
 * generator discloses but this set omits is a shipped component with an
 * ungated license, which is the exact hole this gate exists to close.
 */
export const NOTICE_DEV_DEPENDENCIES = new Set(["electron"]);

/**
 * SPDX identifiers that may appear anywhere in the shipped tree.
 *
 * Seeded from what the tree actually declared when this gate was written, plus
 * the permissive ids AGENTS.md names as always-allowed. Those two sets were not
 * the same — BlueOak-1.0.0, OFL-1.1 and Python-2.0 were already in the tree
 * without being on the documented list, which is precisely the drift an
 * unenforced policy accumulates.
 *
 * Adding an id here is a deliberate legal decision. Make it explicitly, in a
 * commit that says why — do not add one to make CI green.
 */
export const ALLOWED_LICENSE_IDS = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  // Permissive, MIT-like with an explicit patent grant. Arrives transitively
  // through the npm tooling packages.
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  // SIL Open Font License, covering the @fontsource/geist-* webfont assets the
  // renderer build emits. Copyleft only in the narrow sense that a derived FONT
  // must stay OFL; it places no condition on software that merely embeds it.
  "OFL-1.1",
  // Permissive, no copyleft clause. Arrives transitively via argparse.
  "Python-2.0",
  "Unlicense",
]);

/**
 * Weak-copyleft ids a SHIPPED_PLATFORM_PACKAGES entry may declare, and only
 * while carrying an `lgpl` descriptor.
 *
 * Keep this in step with WEAK_COPYLEFT_LICENSE_TEXTS in the generator: an id
 * allowed here but absent there would pass the gate and then fail the notice
 * build for want of a canonical FSF text.
 */
export const ALLOWED_PLATFORM_COPYLEFT_IDS = new Set([
  "LGPL-2.1-or-later",
  "LGPL-3.0-or-later",
]);

/**
 * Matches GPL, AGPL and LGPL so a rejected copyleft id gets the "do not
 * allowlist this" steer. `[^A-Za-z]` rather than `\W` because the letter before
 * "GPL" is what distinguishes LGPL/AGPL from a word boundary.
 */
const COPYLEFT_PATTERN = /(^|[^A-Za-z])[AL]?GPL/i;

export class SpdxParseError extends Error {}

/**
 * SPDX short identifiers are case-insensitive, so every comparison folds case.
 * Without this a package declaring the perfectly legal `"license": "mit"` fails
 * the gate with no fix available short of allowlisting a lowercase duplicate.
 */
function foldCase(identifier) {
  return identifier.toLowerCase();
}

const ALLOWED_LICENSE_IDS_FOLDED = new Set(Array.from(ALLOWED_LICENSE_IDS, foldCase));
const ALLOWED_PLATFORM_COPYLEFT_IDS_FOLDED = new Set(
  Array.from(ALLOWED_PLATFORM_COPYLEFT_IDS, foldCase),
);

export function isPermissive(identifier) {
  return ALLOWED_LICENSE_IDS_FOLDED.has(foldCase(identifier));
}

/**
 * Platform slices may additionally declare a weak-copyleft id, so
 * "Apache-2.0 AND LGPL-3.0-or-later" evaluates true for them and only them.
 */
export function isPermissiveOrDisclosedCopyleft(identifier) {
  return isPermissive(identifier) || ALLOWED_PLATFORM_COPYLEFT_IDS_FOLDED.has(foldCase(identifier));
}

/**
 * Split an SPDX expression into identifiers, operators and parens.
 */
export function tokenizeSpdxExpression(expression) {
  return expression
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * True for a token that is punctuation or an operator rather than a license id.
 *
 * Shared by the parser and by disallowedIdentifiers so the two cannot disagree
 * about what counts as an identifier — a disagreement would print an operator
 * in a failure message as though it were a rejected license.
 */
export function isStructuralToken(token) {
  const upper = token.toUpperCase();
  return token === "(" || token === ")" || upper === "OR" || upper === "AND";
}

/**
 * Evaluate an SPDX expression against a predicate over bare identifiers.
 *
 * OR is satisfied by either side and AND by both, per SPDX — which is what
 * makes "(MIT OR WTFPL)" pass without WTFPL being allowlisted (we take the MIT
 * option), while "Apache-2.0 AND LGPL-3.0-or-later" correctly fails a
 * permissive-only predicate (we are bound by both). AND binds tighter than OR.
 *
 * Anything that does not parse — "SEE LICENSE IN LICENSE.md", a bare
 * "UNLICENSED", a WITH exception — throws, and the caller reports it as a
 * failure. Refusing to guess is the safe direction for a legal gate.
 */
export function evaluateSpdxExpression(expression, isAllowed) {
  const tokens = tokenizeSpdxExpression(expression);
  let position = 0;

  const peek = () => tokens[position];

  const parseExpression = () => {
    let value = parseTerm();
    while (peek()?.toUpperCase() === "OR") {
      position += 1;
      // Parse before combining: `||` short-circuits, and a skipped parse would
      // leave the cursor mid-expression and mis-report the trailing-token check.
      const right = parseTerm();
      value = value || right;
    }
    return value;
  };

  const parseTerm = () => {
    let value = parseFactor();
    while (peek()?.toUpperCase() === "AND") {
      position += 1;
      const right = parseFactor();
      value = value && right;
    }
    return value;
  };

  const parseFactor = () => {
    const token = tokens[position];
    if (token === undefined) {
      throw new SpdxParseError(`unexpected end of expression in ${JSON.stringify(expression)}`);
    }
    if (token === "(") {
      position += 1;
      const value = parseExpression();
      if (tokens[position] !== ")") {
        throw new SpdxParseError(`unbalanced parentheses in ${JSON.stringify(expression)}`);
      }
      position += 1;
      return value;
    }
    if (isStructuralToken(token)) {
      throw new SpdxParseError(
        `unexpected ${JSON.stringify(token)} in ${JSON.stringify(expression)}`,
      );
    }
    position += 1;
    return isAllowed(token);
  };

  const value = parseExpression();
  if (position !== tokens.length) {
    throw new SpdxParseError(
      `trailing ${JSON.stringify(tokens[position])} in ${JSON.stringify(expression)}`,
    );
  }
  return value;
}

/**
 * The bare identifiers in an expression that the predicate rejects.
 *
 * Only meaningful once evaluation has already failed: in a satisfied OR the
 * rejected half is irrelevant, so naming it would misdirect the reader.
 */
export function disallowedIdentifiers(expression, isAllowed) {
  return Array.from(
    new Set(
      tokenizeSpdxExpression(expression).filter(
        (token) => !isStructuralToken(token) && !isAllowed(token),
      ),
    ),
  );
}

/**
 * Check one set of records against one predicate.
 *
 * Both surfaces share this because they previously did not: the copy that
 * handled npm dependencies grew the copyleft steer and the platform copy did
 * not, so an identical failure got different guidance depending on which list
 * the package came from.
 *
 * `subject` prefixes the label ("" for an npm dep, "shipped platform package "
 * for a slice) and `remedy` closes the message.
 */
function checkRecords(records, { isAllowed, subject = "", remedy }) {
  const failures = [];

  for (const record of records) {
    const label = `${subject}${record.name}@${record.version || "?"}`;
    let allowed;
    try {
      allowed = evaluateSpdxExpression(record.declaredLicense, isAllowed);
    } catch (error) {
      failures.push(
        `${label} declares ${JSON.stringify(record.declaredLicense)}, which is not a parseable ` +
          `SPDX expression (${error.message}). A dependency whose license cannot be read ` +
          `cannot be shipped.`,
      );
      continue;
    }
    if (allowed) continue;

    const offenders = disallowedIdentifiers(record.declaredLicense, isAllowed);
    const isCopyleft = offenders.some((id) => COPYLEFT_PATTERN.test(id));
    failures.push(
      `${label} declares ${JSON.stringify(record.declaredLicense)}; ` +
        `${offenders.join(", ")} ${offenders.length === 1 ? "is" : "are"} ${remedy}` +
        (isCopyleft
          ? " This is a copyleft license — do not allowlist it to make CI green; drop or replace" +
            " the dependency, or escalate the licensing decision."
          : ""),
    );
  }

  return failures;
}

export function checkNpmDependencyLicenses(records) {
  return checkRecords(records, {
    isAllowed: isPermissive,
    remedy: "not on the allowlist in scripts/check-third-party-license-allowlist.mjs.",
  });
}

/**
 * The devDependencies the notice discloses because they ship — Electron today.
 *
 * Filtered from the `all` report by the same rule the generator merges them in
 * with, so the gate's coverage tracks the notice's contents.
 */
export function checkNoticeDevDependencyLicenses(allRecords) {
  return checkNpmDependencyLicenses(
    allRecords.filter((record) => NOTICE_DEV_DEPENDENCIES.has(record.name)),
  );
}

export function checkShippedPlatformLicenses(
  records,
  platformPackages = SHIPPED_PLATFORM_PACKAGES,
) {
  const carriesDescriptor = new Map(
    platformPackages.map((entry) => [entry.name, entry.lgpl !== undefined]),
  );

  const failures = checkRecords(records, {
    isAllowed: isPermissiveOrDisclosedCopyleft,
    subject: "shipped platform package ",
    remedy: "not permitted in a shipped artifact.",
  });

  // Weak copyleft is conditional on disclosure, not merely on the id. The
  // generator's validatePlatformRecord already refuses an LGPL slice with no
  // `lgpl` descriptor; this catches the same hole from the other side, for a
  // record that never reached that validator.
  for (const record of records) {
    if (lgplFamilyOf(record.declaredLicense) === undefined) continue;
    if (carriesDescriptor.get(record.name) === true) continue;
    failures.push(
      `shipped platform package ${record.name}@${record.version || "?"} declares a ` +
        `weak-copyleft license (${record.declaredLicense}) but has no \`lgpl\` descriptor in ` +
        `SHIPPED_PLATFORM_PACKAGES, so the notice would ship it with no FSF text and no ` +
        `written source offer.`,
    );
  }

  return failures;
}

export function checkThirdPartyLicenseAllowlist({
  productionRecords = [],
  allRecords = [],
  platformRecords = [],
} = {}) {
  return [
    ...checkNpmDependencyLicenses(productionRecords),
    ...checkNoticeDevDependencyLicenses(allRecords),
    ...checkShippedPlatformLicenses(platformRecords),
  ].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the shipped native slices, or report that we could not.
 *
 * `locateShippedPlatformPackages` reads each slice's installed metadata, so it
 * throws on a drifted install. This gate runs BEFORE the generator, and the
 * generator already reports both of those conditions with a message that points
 * at `pnpm install` rather than at licensing. Re-reporting them here would put
 * a worse diagnostic in front of a better one, so a stale install skips the
 * platform half and lets the generator speak.
 *
 * Returns `{ records, deferred }` rather than a bare array so the caller can
 * say which surfaces actually ran. Reporting an unqualified "passed" for a
 * check that silently skipped half its scope is how a gate stops being one.
 */
export function locatePlatformRecordsOrDefer(
  productionRecords,
  locate = locateShippedPlatformPackages,
) {
  try {
    return { records: locate(productionRecords), deferred: false };
  } catch (error) {
    if (error?.code === STALE_INSTALL_CODE || error?.code === SHIPPED_PACKAGE_CODE) {
      return { records: [], deferred: true };
    }
    throw error;
  }
}

function runCli() {
  let failures;
  let deferred;
  try {
    // Two reports for the same reason the generator takes two: the production
    // tree, plus the `all` tree that Electron (a devDependency that ships) is
    // only visible in.
    const productionRecords = flattenLicenseReport(runPnpmLicenses(NOTICE_PNPM_ARGS.production));
    const allRecords = flattenLicenseReport(runPnpmLicenses(NOTICE_PNPM_ARGS.all));
    const platform = locatePlatformRecordsOrDefer(productionRecords);
    deferred = platform.deferred;
    failures = checkThirdPartyLicenseAllowlist({
      productionRecords,
      allRecords,
      platformRecords: platform.records,
    });
  } catch (error) {
    if (error && typeof error.status === "number") {
      process.stderr.write(error.message);
      process.exit(error.status);
    }
    throw error;
  }

  if (failures.length > 0) {
    console.error("third-party license allowlist check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    deferred
      ? "third-party license allowlist check passed for npm dependencies; skipped the shipped " +
          "platform slices because they are not installed (the notice check reports why)"
      : "third-party license allowlist check passed",
  );
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
