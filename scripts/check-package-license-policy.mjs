#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_LICENSES = new Map([
  ["package.json", "UNLICENSED"],
  ["apps/desktop/package.json", "UNLICENSED"],
  ["packages/codex-app-server-protocol/package.json", "UNLICENSED"],
  ["packages/shared/package.json", "UNLICENSED"],
  ["packages/pwrsnap/package.json", "MIT"],
]);

const SKIP_DIRS = new Set([
  ".git",
  ".worktrees",
  ".claude",
  ".agents",
  "node_modules",
  "release-stage",
  "dist",
  "out",
  "playwright-report",
  "test-results",
]);

export function* walkPackageJsonFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkPackageJsonFiles(join(dir, entry.name));
    } else if (entry.name === "package.json") {
      yield join(dir, entry.name);
    }
  }
}

export function checkPackageLicensePolicy(root = repoRoot) {
  const failures = [];
  const seen = new Set();

  for (const packagePath of walkPackageJsonFiles(root)) {
    const rel = relative(root, packagePath);
    seen.add(rel);
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const expected = EXPECTED_LICENSES.get(rel);
    if (expected === undefined) {
      failures.push(
        `${rel} is not covered by scripts/check-package-license-policy.mjs; add an explicit expected license`,
      );
      continue;
    }
    if (packageJson.license !== expected) {
      failures.push(
        `${rel} declares license ${JSON.stringify(
          packageJson.license,
        )}; expected ${JSON.stringify(expected)}`,
      );
    }
  }

  for (const expectedPath of EXPECTED_LICENSES.keys()) {
    if (!seen.has(expectedPath)) {
      failures.push(`${expectedPath} is missing; update the package license policy`);
    }
  }

  return failures.sort((a, b) => a.localeCompare(b));
}

function runCli() {
  const failures = checkPackageLicensePolicy();
  if (failures.length > 0) {
    console.error("package license policy check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("package license policy check passed");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
