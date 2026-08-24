#!/usr/bin/env node
// Walks the packaged app.asar and fails the build if any forbidden file
// pattern slips into the bundle. Mirrors the exclusions in
// electron-builder.yml so a regression is caught loudly even if the YAML is
// edited carelessly.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
// NOTE: this path must stay in the signing tarball's file list in
// .github/workflows/release.yml — that list is an allowlist, not a glob.
import { isCliEntrypoint } from "../../../scripts/lib/cli-entrypoint.mjs";
import {
  inspectSharpNativePackages,
  partitionSharpNativePackages,
  sharpNativePackagesForTarget
} from "./sharp-platform-packages.mjs";

// @electron/asar is declared as a direct devDependency of @pwrsnap/desktop.
// The protected Windows signing job receives a self-contained staged toolchain,
// so package-win.mjs points resolution at that stage without reinstalling.
const asarModuleRoot = process.env.PWRSNAP_ASAR_MODULE_ROOT?.trim();
const require = asarModuleRoot
  ? createRequire(resolve(asarModuleRoot, "package.json"))
  : createRequire(import.meta.url);

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

const macRequiredResources = ["THIRD_PARTY_LICENSES", "CHANGELOG.md", "PwrSnapFFmpeg"];
const windowsRequiredResources = [
  "THIRD_PARTY_LICENSES",
  "CHANGELOG.md",
  "PwrSnapWindowList.exe"
];

// electron-vite emits ESM for the main process and workers while leaving Sharp
// external. Node therefore follows Sharp's `import` export to dist/index.mjs.
// Pin every relative ESM module reachable from that entrypoint in Sharp 0.35.3;
// a Sharp upgrade must deliberately review this runtime contract.
export const sharpEsmRuntimePaths = [
  "dist/index.mjs",
  "dist/constructor.mjs",
  "dist/input.mjs",
  "dist/resize.mjs",
  "dist/composite.mjs",
  "dist/operation.mjs",
  "dist/colour.mjs",
  "dist/channel.mjs",
  "dist/output.mjs",
  "dist/utility.mjs",
  "dist/is.mjs",
  "dist/sharp.mjs",
  "dist/libvips.mjs"
];

const sharedSharpAsarRuntime = [
  ...sharpEsmRuntimePaths.map((runtimePath) => ({
    label: `sharp ESM runtime module ${runtimePath}`,
    path: `/node_modules/sharp/${runtimePath}`
  })),
  {
    label: "sharp package manifest",
    path: "/node_modules/sharp/package.json"
  },
  {
    label: "sharp license",
    path: "/node_modules/sharp/LICENSE"
  },
  {
    label: "@img/colour package manifest",
    path: "/node_modules/@img/colour/package.json"
  },
  {
    label: "@img/colour JavaScript loader",
    path: "/node_modules/@img/colour/index.cjs"
  },
  {
    label: "@img/colour JavaScript implementation",
    path: "/node_modules/@img/colour/color.cjs"
  }
];

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
// file matching `filePattern` against the file names directly
// inside `dir`. Globs aren't used because the
// version-suffixed dylib name (`libvips-cpp.<ver>.dylib`) changes
// across libvips upgrades, and a pattern decouples this
// from the exact version in pnpm-lock.yaml.
const macRequiredUnpackedNative = [
  {
    label: "@img/sharp-darwin-arm64 native binding",
    dir: "app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib",
    filePattern: /\.node$/
  },
  {
    label: "@img/sharp-darwin-x64 native binding",
    dir: "app.asar.unpacked/node_modules/@img/sharp-darwin-x64/lib",
    filePattern: /\.node$/
  },
  {
    label: "@img/sharp-libvips-darwin-arm64 dylib",
    dir: "app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-arm64/lib",
    filePattern: /\.dylib$/
  },
  {
    label: "@img/sharp-libvips-darwin-x64 dylib",
    dir: "app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-x64/lib",
    filePattern: /\.dylib$/
  },
];

function windowsRequiredUnpackedRuntime(arch) {
  const packageName = sharpNativePackagesForTarget({ platform: "win32", arch })[0];
  const packageDir = `app.asar.unpacked/node_modules/@img/${packageName}`;
  return [
    {
      label: `@img/${packageName} JavaScript loader`,
      dir: packageDir,
      filePattern: /^index\.cjs$/
    },
    {
      label: `@img/${packageName} manifest`,
      dir: packageDir,
      filePattern: /^package\.json$/
    },
    {
      label: `@img/${packageName} license`,
      dir: packageDir,
      filePattern: /^LICENSE$/
    },
    {
      label: `@img/${packageName} native binding`,
      dir: `${packageDir}/lib`,
      filePattern: new RegExp(`^sharp-win32-${arch}-.+\\.node$`)
    },
    {
      label: `@img/${packageName} libvips runtime`,
      dir: `${packageDir}/lib`,
      filePattern: /^libvips-42\.dll$/
    },
    {
      label: `@img/${packageName} libvips C++ runtime`,
      dir: `${packageDir}/lib`,
      filePattern: /^libvips-cpp-.+\.dll$/
    },
    {
      label: "@img/colour JavaScript runtime",
      dir: "app.asar.unpacked/node_modules/@img/colour",
      filePattern: /^index\.cjs$/
    },
    {
      label: "better-sqlite3 Electron sidecar",
      dir: "app.asar.unpacked/node_modules/better-sqlite3/electron-native",
      filePattern: /^better_sqlite3\.node$/
    }
  ];
}

function packagedPlatform(appPath) {
  return appPath.endsWith(".app") ? "darwin" : "win32";
}

function resourcesPath(appPath, platform = packagedPlatform(appPath)) {
  return platform === "darwin"
    ? resolve(appPath, "Contents/Resources")
    : resolve(appPath, "resources");
}

function requiredResourcesFor(platform) {
  const required = platform === "darwin"
    ? macRequiredResources
    : windowsRequiredResources;
  if (platform === "win32" && process.env.PWRSNAP_REQUIRE_FFMPEG === "1") {
    return [...required, "PwrSnapFFmpeg.exe"];
  }
  return required;
}

function requiredUnpackedNativeFor(platform, arch = "x64") {
  return platform === "darwin"
    ? macRequiredUnpackedNative
    : windowsRequiredUnpackedRuntime(arch);
}

function normalizedAsarEntries(listing) {
  return listing.map((entry) => entry.replaceAll("\\", "/"));
}

function windowsSharpAsarRuntime(arch) {
  const packageName = sharpNativePackagesForTarget({ platform: "win32", arch })[0];
  const root = `/node_modules/@img/${packageName}`;
  return [
    ...sharedSharpAsarRuntime,
    { label: `@img/${packageName} JavaScript loader`, path: `${root}/index.cjs` },
    { label: `@img/${packageName} manifest`, path: `${root}/package.json` },
    { label: `@img/${packageName} license`, path: `${root}/LICENSE` }
  ];
}

export function findMissingSharpAsarRuntime(listing, platform, arch = "x64") {
  const entries = new Set(normalizedAsarEntries(listing));
  const required = platform === "win32"
    ? windowsSharpAsarRuntime(arch)
    : sharedSharpAsarRuntime;
  return required.filter(({ path }) => !entries.has(path));
}

function imgPackageNamesFromAsar(listing) {
  const packages = new Set();
  for (const entry of normalizedAsarEntries(listing)) {
    const match = /(?:^|\/)node_modules\/@img\/([^/]+)(?:\/|$)/.exec(entry);
    if (match) packages.add(match[1]);
  }
  return [...packages];
}

export function findForeignSharpAsarPackages(listing, platform, arch = "x64") {
  if (platform !== "win32") return [];
  return partitionSharpNativePackages(imgPackageNamesFromAsar(listing), {
    platform,
    arch
  }).removed;
}

export function findForbiddenAsarEntries(listing) {
  const violations = [];
  for (const entry of listing) {
    // @electron/asar uses backslashes when the archive was built on Windows,
    // while these packaging rules are written with POSIX-style paths.
    const normalizedEntry = entry.replaceAll("\\", "/");
    if (allowedForbiddenEntries.some((pattern) => pattern.test(normalizedEntry))) continue;
    for (const [label, pattern] of forbidden) {
      if (pattern.test(normalizedEntry)) {
        violations.push({ label, entry });
        break;
      }
    }
  }
  return violations;
}

export function findMissingPackagedResources(appPath, platform = packagedPlatform(appPath)) {
  const root = resourcesPath(appPath, platform);
  return requiredResourcesFor(platform).filter((file) => !existsSync(resolve(root, file)));
}

export function findMissingUnpackedNative(
  appPath,
  platform = packagedPlatform(appPath),
  arch = "x64"
) {
  const root = resourcesPath(appPath, platform);
  const missing = [];
  for (const { label, dir, filePattern } of requiredUnpackedNativeFor(platform, arch)) {
    const absolute = resolve(root, dir);
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
    if (!entries.some((name) => filePattern.test(name))) {
      missing.push({
        label,
        reason: `${dir} contains no entry matching ${String(filePattern)} (saw: ${entries.join(", ") || "<empty>"})`
      });
    }
  }
  return missing;
}

export function findForeignUnpackedNative(
  appPath,
  platform = packagedPlatform(appPath),
  arch = "x64"
) {
  if (platform !== "win32") return [];
  const nodeModulesDir = resolve(
    resourcesPath(appPath, platform),
    "app.asar.unpacked/node_modules"
  );
  return inspectSharpNativePackages({
    nodeModulesDir,
    platform,
    arch
  }).removed;
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

export function verifySharpAsarRuntime(listing, platform, arch = "x64") {
  const missing = findMissingSharpAsarRuntime(listing, platform, arch);
  const foreign = findForeignSharpAsarPackages(listing, platform, arch);
  if (missing.length === 0 && foreign.length === 0) return;

  const lines = ["verify-asar-contents: Sharp runtime layout is invalid", ""];
  for (const { label, path } of missing) {
    lines.push(`  - missing ${label}: ${path}`);
  }
  if (foreign.length > 0) {
    lines.push(
      `  - foreign Sharp native slice(s): ${foreign.map((name) => `@img/${name}`).join(", ")}`
    );
  }
  throw new Error(lines.join("\n"));
}

export function verifyPackagedResources(appPath, platform = packagedPlatform(appPath)) {
  const missingResources = findMissingPackagedResources(appPath, platform);
  if (missingResources.length === 0) return;
  throw new Error(
    `verify-asar-contents: missing packaged resource(s): ${missingResources.join(", ")}`,
  );
}

export function verifyUnpackedNative(
  appPath,
  platform = packagedPlatform(appPath),
  arch = "x64"
) {
  const missing = findMissingUnpackedNative(appPath, platform, arch);
  const foreign = findForeignUnpackedNative(appPath, platform, arch);
  if (missing.length === 0 && foreign.length === 0) return;
  const lines = [
    `verify-asar-contents: ${missing.length + foreign.length} unpacked-runtime expectation(s) failed`,
    ""
  ];
  for (const { label, reason } of missing) {
    lines.push(`  - ${label}: ${reason}`);
  }
  if (foreign.length > 0) {
    lines.push(
      `  - foreign Sharp native slice(s): ${foreign.map((name) => `@img/${name}`).join(", ")}`
    );
  }
  lines.push(
    "",
    "If sharp packages are missing: pnpm deploy is dropping platform-specific",
    "optionalDependencies — see the release packager's injection step. If",
    "foreign Windows slices are present, the staged Sharp pruning step did",
    "not run. If a native library is missing despite its package being present,",
    "the asarUnpack",
    "rule for @img/** is gone from electron-builder.yml."
  );
  throw new Error(lines.join("\n"));
}

export function runCli(args = process.argv.slice(2)) {
  const appPath = args[0] ?? resolve("release-stage/dist/mac-universal/PwrSnap.app");
  const platform = packagedPlatform(appPath);
  const arch = platform === "win32"
    ? process.env.PWRSNAP_TARGET_ARCH?.trim() || "x64"
    : "x64";
  const asarPath = join(resourcesPath(appPath, platform), "app.asar");
  if (!existsSync(asarPath)) {
    console.error(`verify-asar-contents: app.asar not found at ${asarPath}`);
    process.exit(1);
  }

  const asar = require("@electron/asar");
  const listing = asar.listPackage(asarPath, { isPack: false });

  try {
    verifyAsarListing(listing);
    verifySharpAsarRuntime(listing, platform, arch);
    verifyPackagedResources(appPath, platform);
    verifyUnpackedNative(appPath, platform, arch);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(`verify-asar-contents: OK (${listing.length} entries, no forbidden patterns)`);
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
