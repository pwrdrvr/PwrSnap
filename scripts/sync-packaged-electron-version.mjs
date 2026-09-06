#!/usr/bin/env node

// Rewrite `electronVersion:` in apps/desktop/electron-builder.yml to whatever
// pnpm-lock.yaml resolves for apps/desktop's `electron` dependency.
//
// WHY THIS EXISTS
//
// check-dependency-version-policy.mjs requires the packaged Electron runtime to
// match the resolved one EXACTLY, because electron-builder downloads the
// runtime it is told to and would otherwise ship a binary nothing was built or
// tested against. Dependabot only edits apps/desktop/package.json and
// pnpm-lock.yaml, so every Electron bump arrives with `Lint` and
// `Windows (lint + build + test)` red on that one line — twice hand-fixed so
// far (443e1507, 615475d3) before this script existed.
//
// This is the FIXER for that check; the two must read the lockfile the same
// way or they can disagree about what "resolved" means, which is why the
// reader is imported from the checker rather than reimplemented here.
// .github/workflows/dependabot-licenses.yml runs it on Dependabot branches.
//
// The rewrite is deliberately surgical: it replaces one line, in place, and
// leaves every other byte of the file alone. electron-builder.yml carries
// load-bearing comments (the afterPack rationale, the asarUnpack sharp/libvips
// notes) and is read by three other regex parsers — release.mjs,
// package-win.mjs, and the policy check itself — so round-tripping it through
// a YAML serializer would be a much bigger change than the one line asks for.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";
import { readImporterDependencyVersions } from "./check-dependency-version-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BUILDER_CONFIG_REL = "apps/desktop/electron-builder.yml";

// Matches the whole `electronVersion:` line so a duplicate key is detectable;
// the value is parsed separately. `[^\S\r\n]` is "horizontal whitespace" — \s
// would swallow the newline and let the value be picked up off the next line.
const ELECTRON_VERSION_LINE = /^electronVersion:[^\r\n]*$/gm;
const ELECTRON_VERSION_VALUE = /^electronVersion:([^\S\r\n]*)([^\s#]+)([^\r\n]*)$/;

// The lockfile is machine-written, but this script writes its output into a
// config that a signed release build consumes, so refuse anything that is not
// a plain semver rather than pasting it through.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Rewrite the packaged Electron runtime pin from the lockfile.
 *
 * Returns `{ changed, from, to }`. Throws when the inputs are not shaped the
 * way both this script and the policy check assume — an ambiguous file is a
 * failure, never a silent no-op, because a no-op here reads as "already
 * current" to the caller.
 */
export function syncPackagedElectronVersion(root = repoRoot) {
  const lockfilePath = join(root, "pnpm-lock.yaml");
  let lockfileText;
  try {
    lockfileText = readFileSync(lockfilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("pnpm-lock.yaml not found; cannot resolve the Electron runtime.");
    }
    throw error;
  }

  const resolvedElectron = readImporterDependencyVersions(lockfileText, "apps/desktop", [
    "electron",
  ]).get("electron");
  if (resolvedElectron === undefined) {
    throw new Error("pnpm-lock.yaml does not resolve an electron version for apps/desktop.");
  }
  if (!SEMVER.test(resolvedElectron)) {
    throw new Error(
      `pnpm-lock.yaml resolves electron@${resolvedElectron}, which is not a plain version; ` +
        "refusing to write it into " + BUILDER_CONFIG_REL + ".",
    );
  }

  const builderConfigPath = join(root, ...BUILDER_CONFIG_REL.split("/"));
  let builderConfig;
  try {
    builderConfig = readFileSync(builderConfigPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${BUILDER_CONFIG_REL} not found.`);
    }
    throw error;
  }

  const lines = [...builderConfig.matchAll(ELECTRON_VERSION_LINE)];
  if (lines.length === 0) {
    throw new Error(`${BUILDER_CONFIG_REL} has no electronVersion line to sync.`);
  }
  if (lines.length > 1) {
    throw new Error(
      `${BUILDER_CONFIG_REL} declares electronVersion ${lines.length} times; refusing to guess ` +
        "which one packages the runtime.",
    );
  }

  const [line] = lines;
  const parsed = ELECTRON_VERSION_VALUE.exec(line[0]);
  if (parsed === null) {
    throw new Error(`${BUILDER_CONFIG_REL} has an unreadable electronVersion value: ${line[0]}`);
  }

  const [, spacing, packagedElectron, trailing] = parsed;
  if (packagedElectron === resolvedElectron) {
    return { changed: false, from: packagedElectron, to: resolvedElectron };
  }

  // Splice the one line back by index so indentation, trailing comments, line
  // endings, and every other byte survive untouched.
  const rewritten =
    builderConfig.slice(0, line.index) +
    `electronVersion:${spacing}${resolvedElectron}${trailing}` +
    builderConfig.slice(line.index + line[0].length);
  writeFileSync(builderConfigPath, rewritten);

  return { changed: true, from: packagedElectron, to: resolvedElectron };
}

function runCli() {
  let result;
  try {
    result = syncPackagedElectronVersion();
  } catch (error) {
    console.error(`packaged Electron runtime sync failed: ${error.message}`);
    process.exit(1);
  }

  if (result.changed) {
    console.log(
      `${BUILDER_CONFIG_REL}: packaged Electron runtime ${result.from} -> ${result.to}`,
    );
  } else {
    console.log(
      `${BUILDER_CONFIG_REL}: packaged Electron runtime already matches electron@${result.to}`,
    );
  }
}

export { isCliEntrypoint };

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
