#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

const EXACT_VERSION_GROUPS = [
  {
    name: "React runtime",
    packages: ["react", "react-dom"],
  },
];

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

function collectDependencySpecifiers(packageJson, names) {
  const sections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  const specifiers = new Map();

  for (const section of sections) {
    const dependencies = packageJson[section];
    if (dependencies === undefined || dependencies === null) continue;
    for (const name of names) {
      if (Object.hasOwn(dependencies, name)) {
        specifiers.set(name, String(dependencies[name]));
      }
    }
  }

  return specifiers;
}

function unquoteYamlKey(rawKey) {
  const key = rawKey.trim();
  if (
    (key.startsWith("'") && key.endsWith("'")) ||
    (key.startsWith('"') && key.endsWith('"'))
  ) {
    return key.slice(1, -1);
  }
  return key;
}

// Exported for the same reason as readImporterDependencyVersions below: the
// fixer must decide "already matches" with the checker's notion of equality,
// or it rewrites pins this file is perfectly happy with.
export function normalizeLockVersion(rawVersion) {
  return rawVersion
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\(.+$/, "");
}

// Exported so scripts/sync-packaged-electron-version.mjs — the fixer for the
// Electron pin this file checks — resolves the version the same way the check
// does. Two readers would eventually disagree about what "resolved" means.
export function readImporterDependencyVersions(lockfileText, importerPath, names) {
  const lines = lockfileText.split(/\r?\n/);
  const importerStart = lines.findIndex((line) => line === `  ${importerPath}:`);
  if (importerStart === -1) return new Map();

  const versions = new Map();
  let activeName = null;
  let inDependencySection = false;

  for (let index = importerStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  \S.*:$/.test(line)) break;

    if (/^    (dependencies|devDependencies|peerDependencies|optionalDependencies):$/.test(line)) {
      inDependencySection = true;
      activeName = null;
      continue;
    }

    if (/^    \S/.test(line)) {
      inDependencySection = false;
      activeName = null;
      continue;
    }

    if (!inDependencySection) continue;

    const dependencyMatch = /^      (.+):$/.exec(line);
    if (dependencyMatch !== null) {
      const name = unquoteYamlKey(dependencyMatch[1]);
      activeName = names.includes(name) ? name : null;
      continue;
    }

    if (activeName === null) continue;

    const versionMatch = /^        version: (.+)$/.exec(line);
    if (versionMatch !== null) {
      versions.set(activeName, normalizeLockVersion(versionMatch[1]));
      activeName = null;
    }
  }

  return versions;
}

function describeMismatch(name, versions) {
  return `${name} versions must match exactly; found ${Array.from(versions.entries())
    .map(([packageName, version]) => `${packageName}@${version}`)
    .join(", ")}`;
}

function checkVersionMap({ source, groupName, versions }) {
  if (versions.size < 2) return [];

  const uniqueVersions = new Set(versions.values());
  if (uniqueVersions.size <= 1) return [];

  return [`${source}: ${describeMismatch(groupName, versions)}`];
}

function checkPackagedElectronVersion(root, lockfileText) {
  const resolvedElectron = readImporterDependencyVersions(
    lockfileText,
    "apps/desktop",
    ["electron"],
  ).get("electron");

  const builderConfigPath = join(root, "apps", "desktop", "electron-builder.yml");
  let builderConfig;
  try {
    builderConfig = readFileSync(builderConfigPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      // No packaged app in this tree (the unit fixtures, a future workspace
      // layout), so there is no pin to check and no lockfile expectation.
      return resolvedElectron === undefined
        ? []
        : ["apps/desktop/electron-builder.yml: missing packaged Electron runtime pin"];
    }
    throw error;
  }

  // Horizontal whitespace only. `\s*` also matches a newline, which read the
  // NEXT line as the pin: `electronVersion:` with nothing after it compared
  // equal to the version on the line below and reported no drift, even though
  // the YAML value is null.
  const match = /^electronVersion:[^\S\r\n]*([^\s#]+)/m.exec(builderConfig);
  if (match === null) {
    return [
      "apps/desktop/electron-builder.yml: missing electronVersion for packaged runtime",
    ];
  }

  // A pin exists but nothing resolved it. Returning [] here is the fail-open
  // shape this repo keeps getting bitten by: a lockfile whose shape the reader
  // above stops understanding (a pnpm format change, a renamed importer) would
  // silently switch the whole Electron check off and let a stale runtime ship.
  if (resolvedElectron === undefined) {
    return [
      "apps/desktop/electron-builder.yml pins an Electron runtime but pnpm-lock.yaml " +
        "resolves no electron for apps/desktop; the lockfile reader may no longer " +
        "understand this lockfile",
    ];
  }

  const packagedElectron = normalizeLockVersion(match[1]);
  if (packagedElectron === resolvedElectron) return [];

  return [
    "Electron runtime versions must match exactly; " +
      `pnpm-lock.yaml resolves electron@${resolvedElectron}, ` +
      `apps/desktop/electron-builder.yml packages electron@${packagedElectron}`,
  ];
}

export function checkDependencyVersionPolicy(root = repoRoot) {
  const failures = [];

  for (const packagePath of walkPackageJsonFiles(root)) {
    // Forward slashes so failure messages are stable across platforms
    // (relative() yields "\"-separated paths on Windows).
    const rel = relative(root, packagePath).split(sep).join("/");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    for (const group of EXACT_VERSION_GROUPS) {
      failures.push(
        ...checkVersionMap({
          source: rel,
          groupName: group.name,
          versions: collectDependencySpecifiers(packageJson, group.packages),
        }),
      );
    }
  }

  const lockfilePath = join(root, "pnpm-lock.yaml");
  let lockfileText;
  try {
    lockfileText = readFileSync(lockfilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return failures.sort((a, b) => a.localeCompare(b));
    throw error;
  }

  for (const group of EXACT_VERSION_GROUPS) {
    failures.push(
      ...checkVersionMap({
        source: "pnpm-lock.yaml importer apps/desktop",
        groupName: group.name,
        versions: readImporterDependencyVersions(
          lockfileText,
          "apps/desktop",
          group.packages,
        ),
      }),
    );
  }

  failures.push(...checkPackagedElectronVersion(root, lockfileText));

  return failures.sort((a, b) => a.localeCompare(b));
}

function runCli() {
  const failures = checkDependencyVersionPolicy();
  if (failures.length > 0) {
    console.error("dependency version policy check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("dependency version policy check passed");
}

// Re-exported so existing importers (and scripts/__tests__) keep one name for
// the guard; the implementation lives in scripts/lib/cli-entrypoint.mjs.
export { isCliEntrypoint };

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
