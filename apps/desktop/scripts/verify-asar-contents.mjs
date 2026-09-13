#!/usr/bin/env node
// Walks the packaged app.asar and fails the build if any forbidden file
// pattern slips into the bundle. Mirrors the exclusions in
// electron-builder.yml so a regression is caught loudly even if the YAML is
// edited carelessly.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
// NOTE: this path must stay in the signing tarball's file list in
// .github/workflows/release.yml — that list is an allowlist, not a glob.
import { isCliEntrypoint } from "../../../scripts/lib/cli-entrypoint.mjs";
import {
  inspectSharpNativePackages,
  partitionSharpNativePackages,
  sharpNativePackagesForTarget
} from "./sharp-platform-packages.mjs";
import { findRemoteScript, isRendererHtmlEntry } from "./packaged-html-rules.mjs";

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
  "PwrSnapWindowList.exe",
  "PwrSnapScreenSnapshot.exe"
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
    ? macRequiredUnpackedNative.filter((entry) => arch !== "arm64" || !entry.dir.includes("-x64/"))
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
  if (platform !== "win32" && !(platform === "darwin" && arch === "arm64")) return [];
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
  if (platform !== "win32" && !(platform === "darwin" && arch === "arm64")) return [];
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

/**
 * A packaged renderer must load every script from inside the asar. The one
 * thing that has ever wanted to break that rule is the opt-in React DevTools
 * bridge (`PWRSNAP_REACT_DEVTOOLS`), which injects
 * `<script src="http://localhost:8097">` as the first head script at Vite
 * config time. That is a build-time decision, so nothing at app runtime can
 * undo it — this is where it gets caught. The rule is written against the
 * shape, not against the flag, so any remote script trips it.
 *
 * `readEntry` is injected so this is testable without packing an asar, and
 * so the caller owns the `@electron/asar` handle. An entry it cannot read is
 * reported rather than skipped: this is a check whose whole job is to stop
 * something shipping, so "could not look" has to be as loud as "looked and
 * found it". (`@electron/asar`'s `readFileSync` does resolve unpacked files
 * out of the `.unpacked` sidecar, so the throwing cases are directories,
 * links, and real I/O errors — exactly the ones that must not pass quietly.)
 *
 * A listing that matches NOTHING is reported too, via `scanned`. A gate that
 * inspects zero files and prints OK is indistinguishable from one that
 * inspected the renderer and cleared it — and it stays that way, silently,
 * for every release after the one where `out/` stopped holding the HTML.
 */
export function findPackagedHtmlIssues(listing, readEntry) {
  const remoteScripts = [];
  const unreadable = [];
  const matched = normalizedAsarEntries(listing).filter(isRendererHtmlEntry);
  for (const entry of matched) {
    let contents;
    try {
      contents = readEntry(entry);
    } catch (error) {
      unreadable.push({
        entry,
        reason: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    const snippet = findRemoteScript(contents);
    if (snippet !== null) remoteScripts.push({ entry, snippet });
  }
  return { remoteScripts, unreadable, scanned: matched.length };
}

/**
 * Turn a POSIX-normalized listing entry back into the form
 * `@electron/asar` resolves. It looks a node up by splitting on `path.sep`,
 * so on Windows a forward-slash path resolves to nothing and EVERY html
 * entry would report as unreadable — a release that fails for the wrong
 * reason. Exported so that branch is testable from a POSIX host, where
 * `sep` is `/` and the conversion is otherwise a no-op.
 */
export function asarLookupPath(entry, pathSep = sep) {
  return entry.replace(/^\//, "").replaceAll("/", pathSep);
}

export function verifyPackagedHtml(listing, readEntry) {
  const { remoteScripts, unreadable, scanned } = findPackagedHtmlIssues(
    listing,
    readEntry
  );
  if (scanned === 0) {
    throw new Error(
      [
        "verify-asar-contents: no packaged renderer HTML to inspect",
        "",
        "  expected at least one /out/**/*.html entry in app.asar",
        "",
        "The remote-script scan matched nothing, so it cleared nothing. Either",
        "the renderer HTML is missing from the bundle or it no longer lands",
        "under /out/ — update isRendererHtmlEntry in packaged-html-rules.mjs",
        "to match wherever electron-builder now puts it."
      ].join("\n")
    );
  }
  if (remoteScripts.length === 0 && unreadable.length === 0) return;

  const lines = [];
  if (remoteScripts.length > 0) {
    lines.push(
      `verify-asar-contents: ${remoteScripts.length} packaged HTML file(s) load a remote script`,
      ""
    );
    for (const { entry, snippet } of remoteScripts) {
      lines.push(`  ${entry}`, `    ${snippet}`);
    }
    lines.push(
      "",
      "Build without PWRSNAP_REACT_DEVTOOLS set. That bridge is for local",
      "profiling builds only and must never reach a packaged app."
    );
  }
  if (unreadable.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `verify-asar-contents: ${unreadable.length} packaged HTML file(s) could not be read`,
      ""
    );
    for (const { entry, reason } of unreadable) {
      lines.push(`  ${entry}`, `    ${reason}`);
    }
    lines.push(
      "",
      "These were not inspected for remote scripts, so the bundle is not cleared.",
      "A renderer HTML entry should be a readable, packed file."
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
    "foreign native slices are present, the staged Sharp pruning step did",
    "not run. If a native library is missing despite its package being present,",
    "the asarUnpack",
    "rule for @img/** is gone from electron-builder.yml."
  );
  throw new Error(lines.join("\n"));
}

export function runCli(args = process.argv.slice(2)) {
  const appPath = args[0] ?? resolve("release-stage/dist/mac-universal/PwrSnap.app");
  const platform = packagedPlatform(appPath);
  const arch = process.env.PWRSNAP_TARGET_ARCH?.trim() || (platform === "darwin" ? "universal" : "x64");
  if (platform === "darwin" && !["universal", "arm64"].includes(arch)) throw new Error(`Unsupported macOS target: ${arch}`);
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
    verifyPackagedHtml(listing, (entry) =>
      asar.extractFile(asarPath, asarLookupPath(entry)).toString("utf8")
    );
    verifyPackagedResources(appPath, platform);
    verifyUnpackedNative(appPath, platform, arch);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(
    `verify-asar-contents: OK (${listing.length} entries, no forbidden patterns, no remote scripts)`
  );
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
