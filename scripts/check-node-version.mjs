#!/usr/bin/env node
// Fails `pnpm install` (and `pnpm dev`, through dev.mjs) when the active Node
// does not satisfy `^<.nvmrc>`: the same major, and no older than the pinned
// version. GitHub Actions installs Node with the same caret range, so a
// runner uses the 24.x already in its tool cache instead of downloading the
// exact patch.
//
// This used to demand an exact match, from when better-sqlite3 was compiled
// against the running Node's ABI. Every native addon PwrSnap loads is N-API
// now, so a newer patch or minor of the same major is safe; a different major
// still changes the pnpm store layout CI caches by.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `[major, minor, patch]`, with missing parts as 0 (so `.nvmrc` may pin
 *  `24` or `v24.21`), or null when `version` is not a version. */
function parseVersion(version) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version).trim());
  return match === null ? null : [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
}

/** Whether Node `actual` satisfies `^pinned`. */
export function nodeVersionSatisfies(actual, pinned) {
  const have = parseVersion(actual);
  const want = parseVersion(pinned);
  if (have === null || want === null || have[0] !== want[0]) return false;
  for (let i = 1; i < 3; i += 1) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

export function readPinnedNodeVersion() {
  return readFileSync(resolve(repoRoot, ".nvmrc"), "utf8").trim();
}

function runCli() {
  const expected = readPinnedNodeVersion();
  const actual = process.version;
  const windowsNvmDir = `v${expected.replace(/^v/, "")}`;
  const recoverySteps = process.platform === "win32"
    ? [
        "Run from the repo root in PowerShell:",
        `  nvm install ${expected.replace(/^v/, "")}`,
        `  $env:Path = (Join-Path $env:NVM_HOME "${windowsNvmDir}") + ";" + $env:Path`,
        "  corepack.cmd enable",
        "  pnpm.cmd install"
      ]
    : [
        "Run: source ~/.nvm/nvm.sh && nvm use",
        "Then re-run pnpm install from the repo root."
      ];

  if (!nodeVersionSatisfies(actual, expected)) {
    console.error(
      [
        `[check-node-version] expected Node ^${expected.replace(/^v/, "")} (from .nvmrc), got ${actual}.`,
        ...recoverySteps
      ].join("\n")
    );
    process.exit(1);
  }

  const nvmDir = process.env.NVM_DIR ?? resolve(process.env.HOME ?? "", ".nvm");
  const nvmExists = nvmDir.length > 0 && existsSync(nvmDir);
  const isCi = process.env.CI === "true" || process.env.CI === "1";

  if (process.platform !== "win32" && nvmExists && !isCi) {
    const nodePath = process.execPath;
    const normalizedNvmDir = resolve(nvmDir);
    if (!nodePath.startsWith(`${normalizedNvmDir}/`)) {
      console.error(
        [
          `[check-node-version] Node ${actual} is not running from nvm.`,
          `node path: ${nodePath}`,
          `nvm dir: ${normalizedNvmDir}`,
          ...recoverySteps
        ].join("\n")
      );
      process.exit(1);
    }
  }
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
