#!/usr/bin/env node

/**
 * Gate the licenses of everything PwrSnap SHIPS against an explicit allowlist.
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
 * Two surfaces are checked, because they reach the notice by different routes:
 *
 * 1. The npm production dependency tree (`pnpm licenses list --prod`), which is
 *    the surface that changes on its own via Dependabot. Everything here must
 *    evaluate to permissive under ALLOWED_LICENSE_IDS.
 *
 * 2. SHIPPED_PLATFORM_PACKAGES, the hand-maintained list of native slices the
 *    release artifacts bundle. These are excluded from the npm report by
 *    `--no-optional` and read off disk instead, so surface 1 never sees them.
 *    They are the only place weak copyleft is permitted, and only for an entry
 *    that carries the `lgpl` disclosure descriptor that puts its FSF text and
 *    written source offer into the notice.
 *
 * Strong copyleft (GPL, AGPL) and source-available licenses (BSL, SSPL,
 * Commons Clause) are permitted nowhere. Neither is an unresolvable string like
 * "UNLICENSED" or "SEE LICENSE IN ...", which parses as an unknown identifier
 * and therefore fails.
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
 * SPDX identifiers that may appear anywhere in the shipped tree.
 *
 * Seeded from what the tree actually declared when this gate was written, plus
 * the permissive ids CLAUDE.md names as always-allowed. Those two sets were not
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

export class SpdxParseError extends Error {}

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
 * Evaluate an SPDX expression against a predicate over bare identifiers.
 *
 * OR is satisfied by either side and AND by both, per SPDX — which is what
 * makes "(MIT OR WTFPL)" pass without WTFPL being allowlisted (we take the MIT
 * option), while "Apache-2.0 AND LGPL-3.0-or-later" correctly fails a
 * permissive-only predicate (we are bound by both).
 *
 * Anything that does not parse — "SEE LICENSE IN LICENSE.md", a bare
 * "UNLICENSED", a WITH exception — throws, and the caller reports it as a
 * failure. Refusing to guess is the safe direction for a legal gate.
 */
export function evaluateSpdxExpression(expression, isAllowed) {
  const tokens = tokenizeSpdxExpression(expression);
  let position = 0;

  const peek = () => tokens[position];
  const isOperator = (token) => token === "OR" || token === "AND";

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
    if (token === ")" || isOperator(token.toUpperCase())) {
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
 * The bare identifiers in an expression that the predicate rejects, for use in
 * the failure message. Reported even for an OR the expression as a whole
 * satisfies is not useful, so callers only ask once evaluation has failed.
 */
export function disallowedIdentifiers(expression, isAllowed) {
  return Array.from(
    new Set(
      tokenizeSpdxExpression(expression).filter(
        (token) =>
          token !== "(" &&
          token !== ")" &&
          token.toUpperCase() !== "OR" &&
          token.toUpperCase() !== "AND" &&
          !isAllowed(token),
      ),
    ),
  );
}

function isPermissive(identifier) {
  return ALLOWED_LICENSE_IDS.has(identifier);
}

/**
 * Platform slices may additionally declare a weak-copyleft id, so
 * "Apache-2.0 AND LGPL-3.0-or-later" evaluates true for them and only them.
 */
function isPermissiveOrDisclosedCopyleft(identifier) {
  return isPermissive(identifier) || ALLOWED_PLATFORM_COPYLEFT_IDS.has(identifier);
}

export function checkNpmDependencyLicenses(report) {
  const failures = [];
  for (const record of flattenLicenseReport(report)) {
    const label = `${record.name}@${record.version || "?"}`;
    let allowed;
    try {
      allowed = evaluateSpdxExpression(record.declaredLicense, isPermissive);
    } catch (error) {
      failures.push(
        `${label} declares ${JSON.stringify(record.declaredLicense)}, which is not a parseable ` +
          `SPDX expression (${error.message}). A dependency whose license cannot be read ` +
          `cannot be shipped.`,
      );
      continue;
    }
    if (allowed) continue;

    const offenders = disallowedIdentifiers(record.declaredLicense, isPermissive);
    const copyleft = offenders.filter((id) => /(^|\W)(A?GPL)/i.test(id));
    failures.push(
      `${label} declares ${JSON.stringify(record.declaredLicense)}; ` +
        `${offenders.join(", ")} ${offenders.length === 1 ? "is" : "are"} not on the ` +
        `allowlist in scripts/check-third-party-license-allowlist.mjs.` +
        (copyleft.length > 0
          ? " This is a copyleft license — do not allowlist it to make CI green; drop or replace" +
            " the dependency, or escalate the licensing decision."
          : ""),
    );
  }
  return failures;
}

export function checkShippedPlatformLicenses(
  records,
  platformPackages = SHIPPED_PLATFORM_PACKAGES,
) {
  const descriptorByName = new Map(
    platformPackages.map((entry) => [entry.name, entry.lgpl !== undefined]),
  );
  const failures = [];

  for (const record of records) {
    const label = `${record.name}@${record.version || "?"}`;
    let allowed;
    try {
      allowed = evaluateSpdxExpression(record.declaredLicense, isPermissiveOrDisclosedCopyleft);
    } catch (error) {
      failures.push(
        `shipped platform package ${label} declares ` +
          `${JSON.stringify(record.declaredLicense)}, which is not a parseable SPDX ` +
          `expression (${error.message}).`,
      );
      continue;
    }
    if (!allowed) {
      const offenders = disallowedIdentifiers(
        record.declaredLicense,
        isPermissiveOrDisclosedCopyleft,
      );
      failures.push(
        `shipped platform package ${label} declares ` +
          `${JSON.stringify(record.declaredLicense)}; ${offenders.join(", ")} ` +
          `${offenders.length === 1 ? "is" : "are"} not permitted in a shipped artifact.`,
      );
      continue;
    }

    // Weak copyleft is conditional on disclosure, not merely on the id. The
    // generator's validatePlatformRecord already refuses an LGPL slice with no
    // `lgpl` descriptor; this catches the same hole from the other side, for a
    // record that never reached that validator.
    if (lgplFamilyOf(record.declaredLicense) !== undefined) {
      const disclosed = descriptorByName.get(record.name);
      if (disclosed !== true) {
        failures.push(
          `shipped platform package ${label} declares a weak-copyleft license ` +
            `(${record.declaredLicense}) but has no \`lgpl\` descriptor in ` +
            `SHIPPED_PLATFORM_PACKAGES, so the notice would ship it with no FSF text and no ` +
            `written source offer.`,
        );
      }
    }
  }

  return failures;
}

export function checkThirdPartyLicenseAllowlist({
  productionReport,
  platformRecords = [],
} = {}) {
  return [
    ...checkNpmDependencyLicenses(productionReport),
    ...checkShippedPlatformLicenses(platformRecords),
  ].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the shipped native slices, or give up quietly.
 *
 * `locateShippedPlatformPackages` reads each slice's installed metadata, so it
 * throws on a drifted install. This gate runs BEFORE the generator, and the
 * generator already reports both of those conditions with a message that points
 * at `pnpm install` rather than at licensing. Re-reporting them here would put
 * a worse diagnostic in front of a better one, so a stale install skips the
 * platform half and lets the generator speak.
 */
function locatePlatformRecordsOrDefer(productionRecords) {
  try {
    return locateShippedPlatformPackages(productionRecords);
  } catch (error) {
    if (error?.code === STALE_INSTALL_CODE || error?.code === SHIPPED_PACKAGE_CODE) {
      return [];
    }
    throw error;
  }
}

function runCli() {
  let failures;
  try {
    const productionReport = runPnpmLicenses(NOTICE_PNPM_ARGS.production);
    failures = checkThirdPartyLicenseAllowlist({
      productionReport,
      platformRecords: locatePlatformRecordsOrDefer(flattenLicenseReport(productionReport)),
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

  console.log("third-party license allowlist check passed");
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
