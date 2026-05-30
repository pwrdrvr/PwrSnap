#!/usr/bin/env node
// Walks the packaged app.asar and fails the build if any forbidden file
// pattern slips into the bundle. Mirrors the exclusions in
// electron-builder.yml so a regression is caught loudly even if the YAML is
// edited carelessly.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// @electron/asar is declared as a direct devDependency of @pwrsnap/desktop.
// pnpm's isolated layout doesn't hoist transitive deps reliably, so we own it
// directly to guarantee resolution from this script's location.
const require = createRequire(import.meta.url);

// Each rule: [label, regex]. Anything matching → fail.
const forbidden = [
  ["TypeScript source", /\.tsx?$/],
  ["TypeScript declaration", /\.d\.ts$/],
  ["Sourcemap", /\.map$/],
  ["tsconfig", /(^|\/)tsconfig.*\.json$/],
  ["Test file", /\.(test|spec)\.[cm]?[jt]sx?$/],
  ["__tests__ dir", /\/__tests__\//],
  ["e2e dir", /\/e2e\//],
  ["Markdown", /\.mdx?$/],
  ["docs dir", /\/docs\//],
  ["Env example", /\/\.env(\.|$)/],
  ["Workspace src/ leak", /\/node_modules\/@pwrsnap\/[^/]+\/src\//],
  ["Workspace AGENTS.md", /\/node_modules\/@pwrsnap\/[^/]+\/AGENTS\.md$/],
  ["Screenshot", /\.(png|jpg|jpeg|gif|tiff|psd|sketch|fig)$/i],
  ["Playwright config", /playwright\.config\./],
  ["Project plan/brainstorm", /\/(plans|brainstorms|design)\//],
];

const allowedForbiddenEntries = [/^\/out\/main\/prompts\/[^/]+\.md$/];

const requiredResources = ["THIRD_PARTY_LICENSES", "CHANGELOG.md", "PwrSnapFFmpeg"];

// Universal-build invariants for unpacked native dependencies.
// Each entry: a glob-like path expectation under
// `Contents/Resources/app.asar.unpacked/` that MUST exist for the
// produced .app to launch on the indicated arch. Beta.3 shipped
// without any of the @img entries — every install crashed on
// startup with "Could not load the sharp module using the
// darwin-arm64 runtime" — so this list is now load-bearing release
// metadata, not an optional check.
//
// `dir` checks the directory exists and contains at least one
// file matching `mustContain` (a substring test against the file
// names directly inside `dir`). Globs aren't used because the
// version-suffixed dylib name (`libvips-cpp.<ver>.dylib`) changes
// across libvips upgrades, and a substring match decouples this
// from the exact version in pnpm-lock.yaml.
const requiredUnpackedNative = [
  {
    label: "@img/sharp-darwin-arm64 native binding",
    dir: "app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib",
    mustContain: ".node"
  },
  {
    label: "@img/sharp-darwin-x64 native binding",
    dir: "app.asar.unpacked/node_modules/@img/sharp-darwin-x64/lib",
    mustContain: ".node"
  },
  {
    label: "@img/sharp-libvips-darwin-arm64 dylib",
    dir: "app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-arm64/lib",
    mustContain: ".dylib"
  },
  {
    label: "@img/sharp-libvips-darwin-x64 dylib",
    dir: "app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-x64/lib",
    mustContain: ".dylib"
  },
];

export function findForbiddenAsarEntries(listing) {
  const violations = [];
  for (const entry of listing) {
    if (allowedForbiddenEntries.some((pattern) => pattern.test(entry))) continue;
    for (const [label, pattern] of forbidden) {
      if (pattern.test(entry)) {
        violations.push({ label, entry });
        break;
      }
    }
  }
  return violations;
}

export function findMissingPackagedResources(appPath) {
  const resourcesPath = resolve(appPath, "Contents/Resources");
  return requiredResources.filter((file) => !existsSync(resolve(resourcesPath, file)));
}

export function findMissingUnpackedNative(appPath) {
  const resourcesPath = resolve(appPath, "Contents/Resources");
  const missing = [];
  for (const { label, dir, mustContain } of requiredUnpackedNative) {
    const absolute = resolve(resourcesPath, dir);
    if (!existsSync(absolute)) {
      missing.push({ label, reason: `directory missing: ${dir}` });
      continue;
    }
    let entries;
    try {
      entries = readdirSync(absolute);
    } catch (error) {
      missing.push({
        label,
        reason: `unreadable directory ${dir}: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }
    if (!entries.some((name) => name.includes(mustContain))) {
      missing.push({
        label,
        reason: `${dir} contains no entry matching "${mustContain}" (saw: ${entries.join(", ") || "<empty>"})`
      });
    }
  }
  return missing;
}

function formatForbiddenViolations(violations) {
  const lines = [];
  lines.push(`\nverify-asar-contents: ${violations.length} forbidden file(s) in app.asar\n`);
  const grouped = new Map();
  for (const { label, entry } of violations) {
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(entry);
  }
  for (const [label, entries] of grouped) {
    lines.push(`  [${label}] ${entries.length} match(es):`);
    for (const e of entries.slice(0, 5)) lines.push(`    ${e}`);
    if (entries.length > 5) lines.push(`    ... and ${entries.length - 5} more`);
  }
  lines.push(`\nUpdate apps/desktop/electron-builder.yml \`files:\` exclusions to drop these.`);
  return lines.join("\n");
}

export function verifyAsarListing(listing) {
  const violations = findForbiddenAsarEntries(listing);
  if (violations.length === 0) return;
  throw new Error(formatForbiddenViolations(violations));
}

export function verifyPackagedResources(appPath) {
  const missingResources = findMissingPackagedResources(appPath);
  if (missingResources.length === 0) return;
  throw new Error(
    `verify-asar-contents: missing packaged resource(s): ${missingResources.join(", ")}`,
  );
}

export function verifyUnpackedNative(appPath) {
  const missing = findMissingUnpackedNative(appPath);
  if (missing.length === 0) return;
  const lines = [
    `verify-asar-contents: ${missing.length} unpacked-native expectation(s) failed`,
    ""
  ];
  for (const { label, reason } of missing) {
    lines.push(`  - ${label}: ${reason}`);
  }
  lines.push(
    "",
    "If sharp packages are missing: pnpm deploy is dropping platform-specific",
    "optionalDependencies — see release.mjs step 5b for the workaround. If",
    "the .dylib is missing despite the package being present, the asarUnpack",
    "rule for @img/** is gone from electron-builder.yml."
  );
  throw new Error(lines.join("\n"));
}

export function runCli(args = process.argv.slice(2)) {
  const appPath = args[0] ?? resolve("release-stage/dist/mac-universal/PwrSnap.app");
  const asarPath = resolve(appPath, "Contents/Resources/app.asar");
  if (!existsSync(asarPath)) {
    console.error(`verify-asar-contents: app.asar not found at ${asarPath}`);
    process.exit(1);
  }

  const asar = require("@electron/asar");
  const listing = asar.listPackage(asarPath, { isPack: false });

  try {
    verifyAsarListing(listing);
    verifyPackagedResources(appPath);
    verifyUnpackedNative(appPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(`verify-asar-contents: OK (${listing.length} entries, no forbidden patterns)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
