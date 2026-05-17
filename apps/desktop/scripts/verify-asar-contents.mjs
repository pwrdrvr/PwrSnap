#!/usr/bin/env node
// Walks the packaged app.asar and fails the build if any forbidden file
// pattern slips into the bundle. Mirrors the exclusions in
// electron-builder.yml so a regression is caught loudly even if the YAML is
// edited carelessly.

import { existsSync } from "node:fs";
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

const requiredResources = ["THIRD_PARTY_LICENSES", "CHANGELOG.md"];

export function findForbiddenAsarEntries(listing) {
  const violations = [];
  for (const entry of listing) {
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(`verify-asar-contents: OK (${listing.length} entries, no forbidden patterns)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
