#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function normalizeLockVersion(rawVersion) {
  return rawVersion
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\(.+$/, "");
}

function readImporterDependencyVersions(lockfileText, importerPath, names) {
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

export function checkDependencyVersionPolicy(root = repoRoot) {
  const failures = [];

  for (const packagePath of walkPackageJsonFiles(root)) {
    const rel = relative(root, packagePath);
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

export function isCliEntrypoint(metaUrl, argvPath = process.argv[1]) {
  if (argvPath === undefined) return false;
  return fileURLToPath(metaUrl) === resolve(argvPath);
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
