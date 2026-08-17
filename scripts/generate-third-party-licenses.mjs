#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outputPath = join(repoRoot, "THIRD_PARTY_LICENSES");
const desktopFilter = "@pwrsnap/desktop";
const licenseTextsDir = join(scriptDir, "license-texts");

// PwrSnap bundles two weak-copyleft binaries whose licenses require shipping
// the full license text plus a written offer to relink against modified
// versions of the covered library. The npm packages that stand in for these
// binaries do not ship the canonical FSF license text (and the macOS-arm64
// libvips package is not even installed on Linux CI), so we embed the canonical
// FSF texts as committed assets under scripts/license-texts/ and append them in
// a dedicated section below the per-package License Texts. The texts are the
// verbatim FSF distributions of https://www.gnu.org/licenses/lgpl-2.1.txt and
// https://www.gnu.org/licenses/lgpl-3.0.txt.
//
// The macOS arm64 native sharp packages are optional dependencies, so they are
// absent from `pnpm licenses list --no-optional` and absent entirely on Linux
// CI. Their versions are therefore derived from the installed `sharp`
// manifest's own optionalDependencies rather than hardcoded — a hardcoded pin
// silently keeps claiming the old version after a sharp bump, and no platform
// is able to notice. See resolveMacArm64Versions below.
export function buildWeakCopyleftBundledBinaries({ libvipsDarwinArm64 }) {
  return [
  {
    name: "FFmpeg",
    version: "8.1.1",
    declaredLicense: "LGPL-2.1-or-later",
    licenseTextFile: "lgpl-2.1.txt",
    licenseTitle: "GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1",
    summary: [
      "PwrSnap bundles an FFmpeg executable built from the official FFmpeg 8.1.1 source release",
      "(build scripts: https://github.com/pwrdrvr/pwrsnap-ffmpeg-builds), configured without",
      "--enable-gpl, --enable-nonfree,",
      "--enable-libx264, --enable-libx265, --enable-libvidstab, or --enable-libfdk-aac, so the",
      "resulting binary is covered by the GNU Lesser General Public License, version 2.1 or later.",
      "Source: https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz",
      "License guidance: https://ffmpeg.org/legal.html",
    ].join("\n"),
    relinkOffer: [
      "Relinking / source offer: PwrSnap ships the bundled ffmpeg executable as a separate file",
      "(not statically linked into the application), so it may be replaced with a compatible",
      "build. The exact source used, the build scripts, and the verified configure flags live in",
      "https://github.com/pwrdrvr/pwrsnap-ffmpeg-builds, with a timestamped copy of the flags in",
      "this repository at docs/ffmpeg-build-reference.md, alongside the FFmpeg 8.1.1 source",
      "release linked above. PwrDrvr LLC will additionally provide the corresponding source on",
      "written request to support@pwrdrvr.com for at least three years from the date of",
      "distribution.",
    ].join("\n"),
  },
  {
    name: "@img/sharp-libvips-darwin-arm64",
    version: libvipsDarwinArm64,
    declaredLicense: "LGPL-3.0-or-later",
    licenseTextFile: "lgpl-3.0.txt",
    licenseTitle: "GNU LESSER GENERAL PUBLIC LICENSE, Version 3",
    summary: [
      "PwrSnap's macOS arm64 release bundles the prebuilt libvips-cpp dynamic library shipped in",
      "@img/sharp-libvips-darwin-arm64, used by sharp for image processing. libvips-cpp is",
      "distributed under the GNU Lesser General Public License, version 3 or later.",
      "Source: https://github.com/lovell/sharp-libvips",
      "Upstream library: https://github.com/libvips/libvips",
    ].join("\n"),
    relinkOffer: [
      "Relinking / source offer: the libvips library is bundled as a dynamic library (dylib)",
      "loaded at runtime, so it may be replaced with a compatible build of the same major version.",
      "The corresponding source for libvips and its dependencies is published at the URLs above.",
      "PwrDrvr LLC will additionally provide the corresponding source on written request to",
      "support@pwrdrvr.com for at least three years from the date of distribution.",
    ].join("\n"),
  },
  ];
}

export function buildSupplementalMacArm64Records({
  sharpDarwinArm64,
  libvipsDarwinArm64,
}) {
  return [
  {
    name: "FFmpeg",
    version: "8.1.1",
    declaredLicense: "LGPL-2.1-or-later",
    source: "https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz",
    description:
      "Bundled ffmpeg executable built by github.com/pwrdrvr/pwrsnap-ffmpeg-builds without GPL or nonfree configure flags",
    licenseText: [
      "PwrSnap bundles an FFmpeg executable built from the official FFmpeg 8.1.1 source release.",
      "The build repo verifies that the resulting binary configuration does not contain --enable-gpl, --enable-nonfree, --enable-libx264, --enable-libx265, --enable-libvidstab, or --enable-libfdk-aac.",
      "",
      "FFmpeg's source release includes its license texts and states that most files are under the GNU Lesser General Public License version 2.1 or later.",
      "Source: https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz",
      "License guidance: https://ffmpeg.org/legal.html",
      "",
      "The full GNU Lesser General Public License, version 2.1, and the corresponding relinking / source offer are reproduced below under \"Full License Texts — Weak-Copyleft Bundled Binaries\"."
    ].join("\n"),
  },
  {
    name: "@img/sharp-darwin-arm64",
    version: sharpDarwinArm64,
    declaredLicense: "Apache-2.0",
    source: "https://github.com/lovell/sharp",
    description: "Prebuilt sharp for use with macOS 64-bit ARM",
  },
  {
    name: "@img/sharp-libvips-darwin-arm64",
    version: libvipsDarwinArm64,
    declaredLicense: "LGPL-3.0-or-later",
    source: "https://github.com/lovell/sharp-libvips",
    description: "Prebuilt libvips and dependencies for use with sharp on macOS 64-bit ARM",
    licenseText: [
      "PwrSnap's macOS arm64 release bundles the prebuilt libvips-cpp dynamic library from this package.",
      "libvips-cpp is distributed under the GNU Lesser General Public License, version 3 or later.",
      "Source: https://github.com/lovell/sharp-libvips",
      "Upstream library: https://github.com/libvips/libvips",
      "",
      "The full GNU Lesser General Public License, version 3, and the corresponding relinking / source offer are reproduced below under \"Full License Texts — Weak-Copyleft Bundled Binaries\"."
    ].join("\n"),
  },
  ].map((record) => ({ ...record, supplemental: true }));
}

/**
 * Read the macOS arm64 native package versions out of the installed `sharp`
 * manifest. `sharp` is a plain production dependency, so it is materialized on
 * every platform and this resolves identically on macOS and Linux CI — unlike
 * the packages themselves, which only ever install on darwin-arm64.
 */
export function resolveMacArm64Versions(productionRecords) {
  const sharp = productionRecords.find((record) => record.name === "sharp");
  if (sharp === undefined) {
    throw new Error(
      "Cannot resolve macOS arm64 native package versions: no `sharp` record in the production license report.",
    );
  }
  const optional = readPackageJson(sharp.packagePath)?.optionalDependencies ?? {};
  const versions = {
    sharpDarwinArm64: optional["@img/sharp-darwin-arm64"],
    libvipsDarwinArm64: optional["@img/sharp-libvips-darwin-arm64"],
  };
  for (const [key, value] of Object.entries(versions)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Cannot resolve ${key} from sharp@${sharp.version} optionalDependencies. ` +
          "The supplemental macOS arm64 notice entries would silently claim a stale version.",
      );
    }
  }
  return versions;
}

export function runPnpmLicenses(args, options = {}) {
  const result = spawnSync(
    "pnpm",
    ["licenses", "list", "--json", "--filter", desktopFilter, ...args],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      // On Windows `pnpm` is a .CMD shim, and Node refuses to spawn .cmd/.bat
      // without a shell (the CVE-2024-27980 hardening). Without this the call
      // fails with ENOENT, empty stdio, and no diagnostic. Every argument here
      // is a module constant, so there is no untrusted input to quote-inject.
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) {
    // result.error carries the spawn failure (ENOENT, ENOBUFS). Dropping it
    // reduced a Windows spawn failure to a bare "pnpm licenses list failed".
    const details = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    const error = new Error(
      details || `pnpm licenses list exited with status ${result.status}`,
    );
    error.status = result.status ?? 1;
    throw error;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    const error = new Error(
      `pnpm licenses list returned invalid JSON:\n${result.stdout.slice(0, 2000)}`,
    );
    error.cause = cause;
    throw error;
  }
}

export function flattenLicenseReport(report) {
  const records = [];
  for (const [declaredLicense, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const versions = entry.versions?.length ? entry.versions : [""];
      const paths = entry.paths?.length ? entry.paths : [undefined];
      for (let index = 0; index < versions.length; index += 1) {
        records.push({
          name: entry.name,
          version: versions[index] ?? versions[0] ?? "",
          declaredLicense,
          packagePath: paths[index] ?? paths[0],
          homepage: entry.homepage,
          author: entry.author,
          description: entry.description,
        });
      }
    }
  }
  return records;
}

export function normalizeRepository(repository) {
  const raw =
    typeof repository === "string"
      ? repository
      : repository && typeof repository.url === "string"
        ? repository.url
        : undefined;
  if (!raw) return undefined;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/#readme$/i, "");
}

export function normalizeSourceUrl(source) {
  return typeof source === "string" ? source.replace(/#readme$/i, "") : source;
}

export function npmPackageUrl(name) {
  return `https://www.npmjs.com/package/${encodeURIComponent(name).replace(
    "%40",
    "@",
  )}`;
}

export function findLicenseFile(packagePath) {
  if (!packagePath || !existsSync(packagePath)) return undefined;
  const candidates = readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  return candidates[0] ? join(packagePath, candidates[0]) : undefined;
}

export function formatAuthor(author) {
  if (!author) return undefined;
  if (typeof author === "string") return author;
  if (typeof author.name === "string") return author.name;
  return undefined;
}

export function stableRecordKey(record) {
  return `${record.name}@${record.version}`;
}

export function declaredLicenseFallbackText(record, packageJson) {
  if (record.declaredLicense === "MIT") {
    const holder = formatAuthor(packageJson?.author) ?? record.name;
    return `The installed package does not include a separate license file. Its package metadata declares MIT.

MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  }

  return [
    `No license text file was found in the installed package for ${stableRecordKey(
      record,
    )}.`,
    `The package declares license: ${record.declaredLicense}.`,
  ].join("\n");
}

export function normalizeLicenseText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function readCanonicalLicenseText(fileName, baseDir = licenseTextsDir) {
  const path = join(baseDir, fileName);
  if (!existsSync(path)) {
    throw new Error(
      `Canonical license text ${fileName} not found at ${path}. ` +
        "Restore it from the verbatim FSF distribution before generating notices.",
    );
  }
  return normalizeLicenseText(readFileSync(path, "utf8"));
}

export function buildWeakCopyleftSection(binaries, baseDir = licenseTextsDir) {
  if (!binaries.length) return [];
  const lines = [];
  const heading = "Full License Texts — Weak-Copyleft Bundled Binaries";
  lines.push(heading);
  lines.push("-".repeat(heading.length));
  lines.push("");
  lines.push(
    "The bundled binaries below are distributed under weak-copyleft licenses that require the full",
  );
  lines.push(
    "license text and an offer to relink/obtain corresponding source. The verbatim canonical FSF",
  );
  lines.push(
    "license texts follow, sourced from https://www.gnu.org/licenses/ and committed under",
  );
  lines.push("scripts/license-texts/.");
  lines.push("");
  for (const binary of binaries) {
    const binHeading = `${stableRecordKey(binary)} (${binary.declaredLicense})`;
    lines.push(binHeading);
    lines.push("~".repeat(binHeading.length));
    lines.push("");
    lines.push(binary.summary);
    lines.push("");
    lines.push(binary.relinkOffer);
    lines.push("");
    lines.push(`${binary.licenseTitle}:`);
    lines.push("");
    lines.push(readCanonicalLicenseText(binary.licenseTextFile, baseDir));
    lines.push("");
  }
  return lines;
}

export function compareRecords(a, b) {
  return (
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.declaredLicense.localeCompare(b.declaredLicense)
  );
}

function readPackageJson(packagePath) {
  if (!packagePath) return undefined;
  const packageJsonPath = join(packagePath, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

/**
 * Records whose package directory is not actually present on disk.
 *
 * `pnpm licenses list` reports paths derived from the lockfile. When
 * node_modules has drifted from the lockfile — the usual cause is switching
 * branches across a dependency bump without reinstalling — those paths do not
 * exist. Without this guard, enrichRecord silently substitutes the pnpm-
 * reported homepage for the manifest `repository` URL and a synthetic
 * boilerplate license body for the package's real license text, producing a
 * plausible-looking but wrong notice. See docs/third-party-license-notices.md
 * § "How the check can fail open".
 */
export const STALE_INSTALL_CODE = "PWRSNAP_STALE_INSTALL";

export function findUnmaterializedRecords(records) {
  return records.filter((record) => {
    if (record.supplemental === true) return false;
    if (!record.packagePath) return true;
    return !existsSync(join(record.packagePath, "package.json"));
  });
}

export function assertPackagesMaterialized(records) {
  const missing = findUnmaterializedRecords(records);
  if (missing.length === 0) return;
  const listed = missing
    .slice(0, 20)
    .map((record) => `  - ${stableRecordKey(record)} (${record.packagePath ?? "no path reported"})`);
  const overflow =
    missing.length > listed.length ? [`  ... and ${missing.length - listed.length} more`] : [];
  const error = new Error(
    [
      `${missing.length} package(s) in the license report are not installed on disk:`,
      ...listed,
      ...overflow,
      "",
      "node_modules is out of sync with pnpm-lock.yaml, so the generated notice would",
      "silently replace real upstream license texts with generated placeholders.",
      "",
      "Run `pnpm install` and retry. Do NOT run `pnpm licenses:generate` to resolve",
      "this — that would commit the degraded notice.",
    ].join("\n"),
  );
  error.code = STALE_INSTALL_CODE;
  throw error;
}

function enrichRecord(record) {
  const packageJson = readPackageJson(record.packagePath);
  const licensePath = findLicenseFile(record.packagePath);
  const licenseText = licensePath
    ? normalizeLicenseText(readFileSync(licensePath, "utf8"))
    : typeof record.licenseText === "string"
      ? normalizeLicenseText(record.licenseText)
    : declaredLicenseFallbackText(record, packageJson);
  return {
    ...record,
    source: normalizeSourceUrl(
      normalizeRepository(packageJson?.repository) ??
      packageJson?.homepage ??
      record.source ??
      record.homepage ??
      npmPackageUrl(record.name),
    ),
    licenseFile: licensePath
      ? relative(record.packagePath, licensePath)
      : typeof record.licenseText === "string"
        ? "supplemental notice"
      : "package metadata",
    licenseText,
    licenseTextHash: createHash("sha256").update(licenseText).digest("hex"),
  };
}

export function buildThirdPartyLicenseNotice({
  productionReport,
  allReport,
  macArm64Versions,
  supplementalRecords,
  weakCopyleftBinaries,
  licenseTextsBaseDir = licenseTextsDir,
  productName = "PwrSnap",
  packageFilter = desktopFilter,
}) {
  const productionRecords = flattenLicenseReport(productionReport);
  const allRecords = flattenLicenseReport(allReport);
  // Resolved from the installed sharp manifest unless the caller pins them.
  // Only computed when actually needed, so callers that pass both collections
  // explicitly (the unit tests) do not require sharp to be installed.
  const resolveVersions = () => macArm64Versions ?? resolveMacArm64Versions(productionRecords);
  const resolvedSupplementalRecords =
    supplementalRecords ?? buildSupplementalMacArm64Records(resolveVersions());
  const resolvedWeakCopyleftBinaries =
    weakCopyleftBinaries ?? buildWeakCopyleftBundledBinaries(resolveVersions());
  const recordsByKey = new Map();

  for (const record of productionRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }
  for (const record of allRecords) {
    if (record.name === "electron") {
      recordsByKey.set(stableRecordKey(record), record);
    }
  }
  for (const record of resolvedSupplementalRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }

  const selectedRecords = Array.from(recordsByKey.values()).sort(compareRecords);
  // Fail before enriching: enrichRecord's fallbacks are silent, so an install
  // that has drifted from the lockfile must be rejected here, not papered over.
  assertPackagesMaterialized(selectedRecords);
  const records = selectedRecords.map(enrichRecord);

  const recordsByLicense = new Map();
  for (const record of records) {
    const group = recordsByLicense.get(record.declaredLicense) ?? [];
    group.push(record);
    recordsByLicense.set(record.declaredLicense, group);
  }

  const textGroups = new Map();
  for (const record of records) {
    const group = textGroups.get(record.licenseTextHash) ?? {
      declaredLicenses: new Set(),
      records: [],
      text: record.licenseText,
      representative: record,
    };
    group.declaredLicenses.add(record.declaredLicense);
    group.records.push(record);
    textGroups.set(record.licenseTextHash, group);
  }

  const lines = [];
  lines.push(`${productName} Third-Party Licenses`);
  lines.push("=".repeat(`${productName} Third-Party Licenses`.length));
  lines.push("");
  lines.push("Generated by scripts/generate-third-party-licenses.mjs.");
  lines.push("Do not edit this file manually; run `pnpm licenses:generate`.");
  lines.push("");
  lines.push("Scope");
  lines.push("-----");
  lines.push("");
  lines.push(
    `This notice covers npm production dependencies for ${packageFilter} plus the Electron runtime package.`,
  );
  lines.push(
    "Electron includes Chromium and Node.js runtime components. PwrSnap includes Electron's MIT runtime license here; Chromium's generated credits are maintained upstream by Chromium/Electron and are intentionally not appended to this text notice because Electron's generated LICENSES.chromium.html is large for the pinned runtime.",
  );
  lines.push(
    "For Chromium runtime credits, see https://source.chromium.org/chromium and Electron's packaged LICENSES.chromium.html in the corresponding Electron release.",
  );
  lines.push(
    "Codex App Server Rust dependency disclosures are maintained by the Codex distribution; PwrSnap invokes a local Codex App Server and does not vendor those Rust crates into this npm notice.",
  );
  lines.push("");
  lines.push("Bundled Asset Notes");
  lines.push("-------------------");
  lines.push("");
  lines.push(
    "The renderer build emits Geist Sans and Geist Mono webfont assets from @fontsource/geist-sans and @fontsource/geist-mono. Those packages are listed below under OFL-1.1, and their SIL Open Font License text is included in the License Texts section.",
  );
  lines.push(
    "Build-time-only assets that are rendered into images, such as the DMG background image, do not distribute the font software itself and are not listed separately here.",
  );
  lines.push(
    "PwrSnap's macOS arm64 release also bundles sharp's native optional runtime packages for macOS: @img/sharp-darwin-arm64 and @img/sharp-libvips-darwin-arm64. They are listed below explicitly so this notice remains deterministic when checked on Linux CI.",
  );
  lines.push(
    "PwrSnap ships two weak-copyleft bundled binaries — the FFmpeg executable (LGPL-2.1-or-later) and libvips-cpp via @img/sharp-libvips-darwin-arm64 (LGPL-3.0-or-later). Their full canonical FSF license texts and the corresponding relinking / written source offers are reproduced in the \"Full License Texts — Weak-Copyleft Bundled Binaries\" section at the end of this notice.",
  );
  lines.push("");
  lines.push("Dependency Summary");
  lines.push("------------------");
  lines.push("");

  for (const [declaredLicense, group] of Array.from(recordsByLicense.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    lines.push(`${declaredLicense}`);
    lines.push("~".repeat(declaredLicense.length));
    for (const record of group.sort(compareRecords)) {
      lines.push(`- ${stableRecordKey(record)} | ${record.source}`);
    }
    lines.push("");
  }

  lines.push("License Texts");
  lines.push("-------------");
  lines.push("");

  const sortedTextGroups = Array.from(textGroups.values()).sort((a, b) => {
    const aFirst = a.records.slice().sort(compareRecords)[0];
    const bFirst = b.records.slice().sort(compareRecords)[0];
    return compareRecords(aFirst, bFirst);
  });

  for (const group of sortedTextGroups) {
    const appliesTo = group.records.slice().sort(compareRecords);
    const licenses = Array.from(group.declaredLicenses).sort().join(", ");
    const heading = `${stableRecordKey(group.representative)} (${licenses})`;
    lines.push(heading);
    lines.push("-".repeat(heading.length));
    lines.push("");
    lines.push("Applies to:");
    for (const record of appliesTo) {
      lines.push(`- ${stableRecordKey(record)} (${record.declaredLicense})`);
    }
    lines.push("");
    lines.push(
      `Representative file: ${stableRecordKey(group.representative)}/${group.representative.licenseFile}`,
    );
    lines.push("");
    lines.push(group.text);
    lines.push("");
  }

  lines.push(...buildWeakCopyleftSection(resolvedWeakCopyleftBinaries, licenseTextsBaseDir));

  return `${lines.join("\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`;
}

export function generateNotice() {
  return buildThirdPartyLicenseNotice({
    productionReport: runPnpmLicenses(["--prod", "--no-optional"]),
    allReport: runPnpmLicenses(["--no-optional"]),
  });
}

function runCli() {
  const check = process.argv.includes("--check");
  let output;
  try {
    output = generateNotice();
  } catch (error) {
    if (error && typeof error.status === "number") {
      process.stderr.write(error.message);
      process.exit(error.status);
    }
    if (error && error.code === STALE_INSTALL_CODE) {
      // Expected operator error, not a bug — report it without a stack trace,
      // and never let it be mistaken for "the committed notice is stale".
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  if (check) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (current !== output) {
      console.error(
        "THIRD_PARTY_LICENSES is out of date. Run `pnpm licenses:generate` and commit the result.",
      );
      process.exit(1);
    }
    console.log("third-party license notice check passed");
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output);
  const count = flattenLicenseReport(runPnpmLicenses(["--prod"])).length;
  console.log(`wrote ${relative(repoRoot, outputPath)} (${count} production package records plus Electron)`);
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
