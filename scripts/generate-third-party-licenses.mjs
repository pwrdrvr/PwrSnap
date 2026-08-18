#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outputPath = join(repoRoot, "THIRD_PARTY_LICENSES");
const desktopFilter = "@pwrsnap/desktop";
const licenseTextsDir = join(scriptDir, "license-texts");

// sharp publishes its native code as OS+CPU-specific optional dependencies, so
// `pnpm licenses list --no-optional` never reports them and `--prod` (optional
// included) reports only the *host* slice — two packages on a macOS arm64 dev
// machine, a different two on Linux CI. Neither is the set PwrSnap actually
// ships, and either one alone makes the notice platform-dependent.
//
// So the shipped slices are enumerated here from what the release artifacts
// bundle (electron-builder.yml: a universal macOS dmg/zip and an x64 Windows
// nsis) and read off disk. pnpm-workspace.yaml's `supportedArchitectures`
// materializes all of them on every platform, including Linux CI, so the
// resulting notice is byte-identical everywhere.
//
// Versions, license ids, descriptions and license texts all come from each
// package's own installed metadata — nothing here is hardcoded. A hardcoded
// pin silently keeps claiming the old version after a sharp bump, and no
// platform is able to notice; that is exactly how the notice came to claim
// @img/sharp-darwin-arm64@0.34.5 while 0.35.3 shipped.
//
// There is no `linux:` block in electron-builder.yml — Linux is a build gate
// only, nothing Linux-native is distributed — so no linux slice is listed.

// Both Darwin libvips slices ship the same payload under the same terms; keep
// one descriptor so their relink offers cannot drift apart.
const DARWIN_LIBVIPS_LGPL = {
  library: "libvips-cpp",
  form: "a dynamic library (dylib) loaded at runtime",
  sourceRepo: "https://github.com/lovell/sharp-libvips",
};

// `resolveFrom` names the package whose `node_modules` the slice is resolved
// from AND whose `optionalDependencies` pin its version. This is not always
// `sharp`: sharp never loads the libvips packages — each `@img/sharp-<platform>`
// binding does, pnpm materializes a separate libvips copy under that binding's
// tree, and apps/desktop/scripts/release.mjs copies the binding's pin. Checking
// libvips against sharp's pin would validate a copy the artifact never ships.
// Entries must be ordered so a package's `resolveFrom` appears before it.
export const SHIPPED_PLATFORM_PACKAGES = [
  {
    name: "@img/sharp-darwin-arm64",
    resolveFrom: "sharp",
    shippedIn: "macOS universal build (arm64 slice)",
  },
  {
    name: "@img/sharp-darwin-x64",
    resolveFrom: "sharp",
    shippedIn: "macOS universal build (x64 slice)",
  },
  {
    name: "@img/sharp-libvips-darwin-arm64",
    resolveFrom: "@img/sharp-darwin-arm64",
    shippedIn: "macOS universal build (arm64 slice)",
    lgpl: DARWIN_LIBVIPS_LGPL,
  },
  {
    name: "@img/sharp-libvips-darwin-x64",
    resolveFrom: "@img/sharp-darwin-x64",
    shippedIn: "macOS universal build (x64 slice)",
    lgpl: DARWIN_LIBVIPS_LGPL,
  },
  {
    name: "@img/sharp-win32-x64",
    resolveFrom: "sharp",
    shippedIn: "Windows x64 installer",
    // Unlike the Darwin slices there is no separate @img/sharp-libvips-win32-x64
    // package: this one package carries BOTH the Apache-2.0 sharp binding
    // (lib/sharp-win32-x64-<ver>.node) and the LGPL-3.0 libvips DLLs
    // (lib/libvips-42.dll, lib/libvips-cpp-<ver>.dll), which is why its manifest
    // declares "Apache-2.0 AND LGPL-3.0-or-later".
    //
    // Its bundled LICENSE file contains ONLY the Apache-2.0 text. Publishing
    // that text alone would under-disclose the LGPL component, so this entry
    // also feeds the weak-copyleft section below, and enrichRecord appends a
    // pointer to it after the on-disk Apache text.
    lgpl: {
      library: "libvips and libvips-cpp",
      form: "separate dynamic libraries (DLLs) loaded at runtime",
      sourceRepo: "https://github.com/lovell/sharp-libvips",
    },
  },
];

/**
 * The canonical FSF text that backs each weak-copyleft license id we can ship.
 *
 * Keyed by the LGPL component parsed out of a package's own declared SPDX
 * expression, so the emitted text and title follow the manifest rather than a
 * hand-set constant. A slice that upstream relicenses to a version we have no
 * canonical text for fails loudly instead of publishing the wrong one.
 */
export const WEAK_COPYLEFT_LICENSE_TEXTS = {
  "LGPL-2.1": {
    licenseTextFile: "lgpl-2.1.txt",
    licenseTitle: "GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1",
    shortName: "LGPL-2.1",
    prose: "version 2.1 or later",
  },
  "LGPL-3.0": {
    licenseTextFile: "lgpl-3.0.txt",
    licenseTitle: "GNU LESSER GENERAL PUBLIC LICENSE, Version 3",
    shortName: "LGPL-3.0",
    prose: "version 3 or later",
  },
};

/**
 * Pull the LGPL component out of a declared SPDX expression.
 *
 * Compound expressions are the reason this exists: @img/sharp-win32-x64
 * declares "Apache-2.0 AND LGPL-3.0-or-later" because one package carries both
 * the permissive binding and the copyleft DLLs. Returns the family key into
 * WEAK_COPYLEFT_LICENSE_TEXTS ("LGPL-3.0"), or undefined when the expression
 * names no LGPL component.
 */
export function lgplFamilyOf(declaredLicense) {
  const match = /\bLGPL-(\d+\.\d+)/i.exec(
    typeof declaredLicense === "string" ? declaredLicense : "",
  );
  if (match === null) return undefined;
  return `LGPL-${match[1]}`;
}

/**
 * Resolve a package directory the way Node itself does: walk `node_modules`
 * upward from a starting directory until the package is found.
 *
 * This is deliberately not a hand-built `.pnpm/<name>@<version>` path. pnpm's
 * virtual store places a package's dependencies as *siblings* of the package
 * inside the same `node_modules` (which is why the upward walk finds them), and
 * store directory names additionally grow a peer-dependency hash suffix for
 * some packages. Walking sidesteps both, and keeps working under a hoisted
 * npm/yarn layout too.
 *
 * The walk stops at `boundary` (the repo root) rather than at the filesystem
 * root. Without that bound, a slice missing from the workspace would be
 * silently satisfied by a stray `~/node_modules` or `/node_modules` copy, and
 * that foreign package's LICENSE would be published as PwrSnap's — a wrong
 * notice instead of the loud failure this module promises.
 *
 * `fromDir` is resolved through symlinks first. Under pnpm every dependency
 * directory is a symlink into the store, and walking the *link* path searches
 * the linker's dependency tree instead of the package's own — so starting from
 * sharp's link to @img/sharp-darwin-arm64 would find sharp's libvips copy
 * rather than the one that binding actually resolves at runtime.
 */
export function resolvePackageDirFrom(fromDir, name, boundary = workspaceRootOf(fromDir)) {
  const stopAt = existsSync(boundary) ? realpathSync(resolve(boundary)) : resolve(boundary);
  let dir = existsSync(fromDir) ? realpathSync(resolve(fromDir)) : resolve(fromDir);
  // Refuse to search outside the boundary at all. Bounding only the *upper* end
  // would still let a walk that starts outside the workspace run to the
  // filesystem root and adopt a stray copy.
  if (dir !== stopAt && !dir.startsWith(stopAt + sep)) return undefined;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === stopAt) return undefined;
    const parent = dirname(dir);
    // Belt and braces: stop at the filesystem root so this can never loop.
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The install root that a package directory belongs to: the parent of the
 * outermost `node_modules` segment in its path.
 *
 * This is the natural boundary for the dependency walk. Deriving it from the
 * path rather than hardcoding `repoRoot` keeps the bound correct for any
 * install tree — including the temporary fixtures the tests build outside the
 * repo — while still refusing to escape the workspace in the real one.
 */
export function workspaceRootOf(packageDir) {
  const parts = resolve(packageDir).split(sep);
  const first = parts.indexOf("node_modules");
  if (first <= 0) return resolve(packageDir);
  return parts.slice(0, first).join(sep) || sep;
}

export const SHIPPED_PACKAGE_CODE = "PWRSNAP_SHIPPED_PACKAGE";

/**
 * Errors that are the operator's to fix, not a bug in this script.
 *
 * runCli only formats errors carrying `.status` or `.code`; anything else is
 * rethrown as a raw stack trace, which buries the remediation text. Every
 * throw below therefore carries a code. PR #426 fixed exactly this misdiagnosis
 * for the stale-install path; a bare `throw new Error(...)` here reintroduces it.
 */
function shippedPackageError(lines) {
  const error = new Error(Array.isArray(lines) ? lines.join("\n") : lines);
  error.code = SHIPPED_PACKAGE_CODE;
  return error;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/**
 * Validate a platform record before any of its fields reach shipped legal text.
 *
 * Applies to caller-supplied records too. The deleted validateMacArm64Versions
 * covered the caller path on purpose ("validating only the derived one would
 * leave the `??` ... as a way to inject `undefined` into the notice"), and
 * without this a missing field renders as `@undefined` in the Dependency
 * Summary or a bare `undefined` mid-sentence in the relink offer.
 */
export function validatePlatformRecord(record) {
  const label = record?.name ?? "<unnamed platform record>";
  for (const field of ["name", "version", "declaredLicense", "shippedIn"]) {
    const value = record?.[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw shippedPackageError(
        `Shipped platform record ${label} has no ${field}. The notice would publish ` +
          "`undefined` as shipped legal metadata.",
      );
    }
  }
  if (!EXACT_VERSION.test(record.version)) {
    throw shippedPackageError(
      `Shipped platform record ${label} has version "${record.version}", which is not an exact ` +
        "version. The notice would claim a version that was never distributed.",
    );
  }
  const family = lgplFamilyOf(record.declaredLicense);
  // The copyleft disclosure must follow the declared license, not a hand-set
  // key. Gating only on `lgpl` means dropping or mistyping that key silently
  // ships a copyleft binary with no FSF text and no written source offer.
  if (family !== undefined && record.lgpl === undefined) {
    throw shippedPackageError([
      `${label} declares "${record.declaredLicense}", which contains an LGPL component, but the`,
      "SHIPPED_PLATFORM_PACKAGES entry carries no `lgpl` descriptor.",
      "",
      "Without one it would ship with no canonical license text and no written source offer.",
      "Add `lgpl: { library, form, sourceRepo }` describing the covered library.",
    ]);
  }
  if (family === undefined && record.lgpl !== undefined) {
    throw shippedPackageError(
      `${label} carries an \`lgpl\` descriptor but declares "${record.declaredLicense}", which ` +
        "names no LGPL component. The notice would append an LGPL offer for a package that is " +
        "not under the LGPL.",
    );
  }
  if (family !== undefined && WEAK_COPYLEFT_LICENSE_TEXTS[family] === undefined) {
    throw shippedPackageError(
      `${label} declares ${family}, which has no canonical text committed under ` +
        "scripts/license-texts/. Add the verbatim FSF text and register it in " +
        "WEAK_COPYLEFT_LICENSE_TEXTS before shipping this package.",
    );
  }
  return record;
}

/**
 * Locate the installed shipped platform packages and turn each into an ordinary
 * license record — real path, real version, real license text.
 *
 * Every failure here throws. A missing slice must never degrade into a
 * placeholder record — a silently-absent copyleft package is the failure mode
 * this whole notice exists to prevent.
 */
export function locateShippedPlatformPackages(
  productionRecords,
  shipped = SHIPPED_PLATFORM_PACKAGES,
) {
  const sharpRecords = productionRecords.filter((record) => record.name === "sharp");
  if (sharpRecords.length === 0) {
    throw shippedPackageError(
      "Cannot locate the shipped sharp platform packages: no `sharp` record in the production " +
        "license report.",
    );
  }
  // More than one resolved sharp makes the pick order-dependent, and the wrong
  // pick lands silently in the LGPL relink offer. Distinct *paths* are the
  // hazard, not just distinct versions: two installs of the same version under
  // different peer sets resolve different dependency trees.
  const distinctPaths = [...new Set(sharpRecords.map((record) => record.packagePath))];
  if (distinctPaths.length > 1) {
    const versions = [...new Set(sharpRecords.map((record) => record.version))].sort();
    throw shippedPackageError(
      `Cannot locate the shipped sharp platform packages: ${distinctPaths.length} sharp installs ` +
        `resolved (versions ${versions.join(", ")}). Pin a single sharp so the notice cannot ` +
        "name a version that was never shipped.",
    );
  }
  const sharp = sharpRecords[0];
  if (!sharp.packagePath) {
    throw shippedPackageError(
      "Cannot locate the shipped sharp platform packages: the license report gave no path for " +
        `sharp@${sharp.version}.`,
    );
  }

  // name -> installed directory, so an entry can resolve from its real parent.
  const resolved = new Map([["sharp", sharp.packagePath]]);

  return shipped.map((entry) => {
    const parentName = entry.resolveFrom ?? "sharp";
    const parentPath = resolved.get(parentName);
    if (parentPath === undefined) {
      throw shippedPackageError(
        `SHIPPED_PLATFORM_PACKAGES lists ${entry.name} before its resolveFrom package ` +
          `${parentName}. Reorder the list so each entry's parent appears first.`,
      );
    }
    const packagePath = resolvePackageDirFrom(parentPath, entry.name);
    if (packagePath === undefined) {
      throw shippedPackageError([
        `Shipped platform package ${entry.name} is not installed anywhere reachable from`,
        `${parentPath} (search stopped at the repo root).`,
        "",
        `PwrSnap's release artifacts bundle it (${entry.shippedIn}), so the notice must cover`,
        "it. pnpm-workspace.yaml's `supportedArchitectures` is what materializes every shipped",
        "slice on every platform — check that it still lists the os/cpu this package needs,",
        "then run `pnpm install` and retry.",
        "",
        "Refusing to emit a notice that omits a shipped package.",
      ]);
    }
    resolved.set(entry.name, packagePath);

    const packageJson = readPackageJson(packagePath);
    if (typeof packageJson?.version !== "string" || packageJson.version.length === 0) {
      throw shippedPackageError(
        `Shipped platform package ${entry.name} at ${packagePath} has no version in its manifest.`,
      );
    }
    if (typeof packageJson.license !== "string" || packageJson.license.length === 0) {
      throw shippedPackageError(
        `Shipped platform package ${entry.name}@${packageJson.version} declares no license in its ` +
          "manifest. Refusing to guess one.",
      );
    }
    // apps/desktop/scripts/release.mjs copies these slices into the packaged app
    // by looking up the parent's optionalDependencies pin, so that pin is what
    // actually ships. If the installed copy disagrees, the notice would name a
    // version the artifact does not contain. Only checked when the pin is an
    // exact version — a range legitimately cannot be compared this way.
    const pin = readPackageJson(parentPath)?.optionalDependencies?.[entry.name];
    if (
      typeof pin === "string" &&
      EXACT_VERSION.test(pin.trim()) &&
      pin.trim() !== packageJson.version
    ) {
      throw shippedPackageError(
        `Shipped platform package ${entry.name} resolves to ${packageJson.version} on disk, but ` +
          `${parentName} pins ${pin.trim()}. apps/desktop/scripts/release.mjs ships the pinned ` +
          "version, so the notice would name a version the artifact does not contain. Run " +
          "`pnpm install` and retry.",
      );
    }

    const declaredLicense = packageJson.license;
    const family = lgplFamilyOf(declaredLicense);
    const canonical = family === undefined ? undefined : WEAK_COPYLEFT_LICENSE_TEXTS[family];
    return validatePlatformRecord({
      name: entry.name,
      version: packageJson.version,
      declaredLicense,
      packagePath,
      shippedIn: entry.shippedIn,
      lgpl: entry.lgpl,
      // The on-disk LICENSE of a package with a compound license expression can
      // cover only one component (see @img/sharp-win32-x64 above). Point readers
      // at the section carrying the rest rather than letting the partial text
      // stand alone. The license version comes from the declared expression, so
      // a slice under a different LGPL version cannot be mislabelled here.
      licenseTextSuffix:
        entry.lgpl === undefined || canonical === undefined
          ? undefined
          : [
              "",
              `${entry.name} ships ${entry.lgpl.library} under the GNU Lesser General Public License,`,
              `${canonical.prose}. The full ${canonical.shortName} text and the corresponding relinking /`,
              'written source offer are reproduced below under "Full License Texts — Weak-Copyleft',
              'Bundled Binaries".',
            ].join("\n"),
    });
  });
}

// The bundled FFmpeg executable is not an npm package — CI injects a controlled
// build into build/ffmpeg/ — so its facts are stated here rather than read off
// disk. Kept in ONE place because two independently-maintained copies (the
// dependency record and the weak-copyleft entry) can drift, and a partial edit
// would publish two different versions for one binary in the same notice.
//
// NOTE: this version is not derived from anything — it is a *claim* about a
// constant owned by another repository (FFMPEG_VERSION in
// pwrdrvr/pwrsnap-ffmpeg-builds scripts/lib/config.mjs), which PwrSnap only
// ever sees as a compiled artifact. Bumping the shipped binary REQUIRES editing
// this constant and re-running `pnpm licenses:generate`.
//
// The drift IS detected now, in two places, because a stale value points the
// LGPL-2.1 written source offer at the wrong release tarball:
//
//   1. At PR time, `apps/desktop/scripts/windows-release-config.test.mjs`
//      requires this to equal every FFMPEG_VERSION and FFMPEG_ARTIFACT_NAME in
//      the workflows, the pin tables in three docs, and the committed notice.
//   2. At release time, `scripts/check-bundled-ffmpeg-notice.mjs` reconciles it
//      against the `version` in the manifest.json shipped with the binary being
//      packaged. That one is the only check that crosses the repo boundary.
//
// See docs/ffmpeg-build-reference.md § "Bumping the bundled FFmpeg version".
const BUNDLED_FFMPEG_VERSION = "8.1.1";

export const BUNDLED_FFMPEG = {
  version: BUNDLED_FFMPEG_VERSION,
  declaredLicense: "LGPL-2.1-or-later",
  // Derived: restating the version here is one more copy to forget, and this
  // URL is the address the written source offer resolves to.
  sourceUrl: `https://ffmpeg.org/releases/ffmpeg-${BUNDLED_FFMPEG_VERSION}.tar.xz`,
  buildRepo: "https://github.com/pwrdrvr/pwrsnap-ffmpeg-builds",
  licenseGuidance: "https://ffmpeg.org/legal.html",
  excludedFlags:
    "--enable-gpl, --enable-nonfree, --enable-libx264, --enable-libx265, --enable-libvidstab, or --enable-libfdk-aac",
};

/**
 * The bundled binaries whose licenses require shipping the full license text
 * plus a written offer to relink against a modified version of the covered
 * library.
 *
 * The libvips-carrying sharp slices are passed in from
 * locateShippedPlatformPackages so their versions and license ids track what is
 * installed. None of these packages ship the canonical FSF license text (the
 * libvips slices ship no license file whatsoever), so the verbatim FSF texts
 * are committed under scripts/license-texts/ and appended in a dedicated
 * section below the per-package License Texts. They are the verbatim FSF
 * distributions of https://www.gnu.org/licenses/lgpl-2.1.txt and
 * https://www.gnu.org/licenses/lgpl-3.0.txt.
 */
export function buildWeakCopyleftBundledBinaries(platformRecords = []) {
  const ffmpegCanonical = WEAK_COPYLEFT_LICENSE_TEXTS[lgplFamilyOf(BUNDLED_FFMPEG.declaredLicense)];
  const ffmpeg = {
    name: "FFmpeg",
    version: BUNDLED_FFMPEG.version,
    declaredLicense: BUNDLED_FFMPEG.declaredLicense,
    licenseTextFile: ffmpegCanonical.licenseTextFile,
    licenseTitle: ffmpegCanonical.licenseTitle,
    summary: [
      // Platform-neutral on purpose: the macOS dmg/zip AND the Windows nsis
      // installer both ship this executable (apps/desktop/scripts/package-win.mjs
      // hard-fails a --release build without it). Naming one platform would
      // scope the written source offer away from the other's recipients.
      `PwrSnap bundles an FFmpeg executable built from the official FFmpeg ${BUNDLED_FFMPEG.version}`,
      "source release",
      `(build scripts: ${BUNDLED_FFMPEG.buildRepo}), configured without`,
      `${BUNDLED_FFMPEG.excludedFlags}, so the`,
      "resulting binary is covered by the GNU Lesser General Public License, version 2.1 or later.",
      `Source: ${BUNDLED_FFMPEG.sourceUrl}`,
      `License guidance: ${BUNDLED_FFMPEG.licenseGuidance}`,
    ].join("\n"),
    relinkOffer: [
      "Relinking / source offer: PwrSnap ships the bundled ffmpeg executable as a separate file",
      "(not statically linked into the application), so it may be replaced with a compatible",
      "build. The exact source used, the build scripts, and the verified configure flags live in",
      `${BUNDLED_FFMPEG.buildRepo}, with a timestamped copy of the flags in`,
      `this repository at docs/ffmpeg-build-reference.md, alongside the FFmpeg ${BUNDLED_FFMPEG.version} source`,
      "release linked above. PwrDrvr LLC will additionally provide the corresponding source on",
      "written request to support@pwrdrvr.com for at least three years from the date of",
      "distribution.",
    ].join("\n"),
  };

  const libvipsBinaries = platformRecords
    .filter((record) => record.lgpl !== undefined)
    .map((record) => {
      // Derived from the record's own declared expression rather than stamped,
      // so an upstream relicense cannot leave this section asserting a license
      // the package's manifest contradicts.
      const family = lgplFamilyOf(record.declaredLicense);
      const canonical = family === undefined ? undefined : WEAK_COPYLEFT_LICENSE_TEXTS[family];
      if (canonical === undefined) {
        throw shippedPackageError(
          `${record.name}@${record.version} carries an \`lgpl\` descriptor but its declared ` +
            `license "${record.declaredLicense}" names no LGPL version with a committed ` +
            "canonical text.",
        );
      }
      return {
        name: record.name,
        version: record.version,
        // The LGPL component of the declared expression, not the whole
        // expression: this section speaks only to the copyleft obligation.
        declaredLicense: `${family}-or-later`,
        licenseTextFile: canonical.licenseTextFile,
        licenseTitle: canonical.licenseTitle,
        summary: [
          `PwrSnap's ${record.shippedIn} bundles the prebuilt ${record.lgpl.library} shipped in`,
          `${record.name}, used by sharp for image processing. It is distributed under the GNU`,
          `Lesser General Public License, ${canonical.prose}.`,
          `Source: ${record.lgpl.sourceRepo}`,
          "Upstream library: https://github.com/libvips/libvips",
        ].join("\n"),
        relinkOffer: [
          `Relinking / source offer: the libvips library is bundled as ${record.lgpl.form},`,
          "so it may be replaced with a compatible build of the same major version.",
          "The corresponding source for libvips and its dependencies is published at the URLs above.",
          "PwrDrvr LLC will additionally provide the corresponding source on written request to",
          "support@pwrdrvr.com for at least three years from the date of distribution.",
        ].join("\n"),
      };
    });

  return [ffmpeg, ...libvipsBinaries];
}

/**
 * Bundled binaries that are not npm packages, so there is no installed
 * directory to read. Today this is only the CI-injected FFmpeg executable.
 *
 * Everything else in the notice — including every shipped platform package —
 * is read from disk and is therefore subject to the materialization check.
 */
export function buildBundledBinaryRecords() {
  return [
    {
      name: "FFmpeg",
      version: BUNDLED_FFMPEG.version,
      declaredLicense: BUNDLED_FFMPEG.declaredLicense,
      source: BUNDLED_FFMPEG.sourceUrl,
      bundledBinary: true,
      licenseText: [
        `PwrSnap bundles an FFmpeg executable built from the official FFmpeg ${BUNDLED_FFMPEG.version} source release.`,
        `The build repo verifies that the resulting binary configuration does not contain ${BUNDLED_FFMPEG.excludedFlags}.`,
        "",
        "FFmpeg's source release includes its license texts and states that most files are under the GNU Lesser General Public License version 2.1 or later.",
        `Source: ${BUNDLED_FFMPEG.sourceUrl}`,
        `License guidance: ${BUNDLED_FFMPEG.licenseGuidance}`,
        "",
        "The full GNU Lesser General Public License, version 2.1, and the corresponding relinking / source offer are reproduced below under \"Full License Texts — Weak-Copyleft Bundled Binaries\"."
      ].join("\n"),
    },
  ];
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
      details ||
        // The fallback only fires when error/stderr/stdout are all empty, which
        // per spawnSync semantics means a signal killed the child and `status`
        // is null — so report the signal rather than "status null".
        (result.signal
          ? `pnpm licenses list was killed by ${result.signal}`
          : `pnpm licenses list exited with status ${result.status}`),
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
  // npm's own URLs carry scoped names verbatim: /package/@img/sharp-win32-x64.
  // The previous encodeURIComponent(...).replace("%40", "@") left the slash
  // percent-encoded (@img%2Fsharp-win32-x64), which 404s. Only reachable as the
  // last-resort fallback for a package declaring neither repository nor
  // homepage, but every @img slice is scoped.
  return `https://www.npmjs.com/package/${name}`;
}

export function findLicenseFile(packagePath) {
  if (!packagePath || !existsSync(packagePath)) return undefined;
  const candidates = readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i.test(name))
    // Code-unit order: readdirSync order is filesystem-defined, and localeCompare
    // would reintroduce the environment dependence compareStrings exists to avoid.
    .sort(compareStrings);
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
  // Sorted, like every other list in this notice. Emitting in
  // SHIPPED_PLATFORM_PACKAGES declaration order meant that merely reordering
  // that constant churned bytes here while leaving the sorted sections alone.
  const sorted = binaries.slice().sort(compareRecords);
  for (const binary of sorted) {
    const binHeading = `${stableRecordKey(binary)} (${binary.declaredLicense})`;
    lines.push(binHeading);
    lines.push("~".repeat(binHeading.length));
    lines.push("");
    lines.push(binary.summary);
    lines.push("");
    lines.push(binary.relinkOffer);
    lines.push("");
  }

  // Several shipped slices carry the same covered library under the same
  // license (both Darwin libvips slices plus the Windows one), so the canonical
  // text is emitted once per distinct license with an explicit "Applies to"
  // roster, rather than repeating a multi-thousand-line FSF text per binary.
  const textGroups = new Map();
  for (const binary of sorted) {
    const group = textGroups.get(binary.licenseTextFile) ?? {
      licenseTitle: binary.licenseTitle,
      binaries: [],
    };
    group.binaries.push(binary);
    textGroups.set(binary.licenseTextFile, group);
  }
  for (const [licenseTextFile, group] of textGroups) {
    lines.push(`${group.licenseTitle}:`);
    lines.push("");
    lines.push("Applies to:");
    for (const binary of group.binaries) {
      lines.push(`- ${stableRecordKey(binary)} (${binary.declaredLicense})`);
    }
    lines.push("");
    lines.push(readCanonicalLicenseText(licenseTextFile, baseDir));
    lines.push("");
  }
  return lines;
}

/**
 * Code-unit ordering, deliberately NOT String.prototype.localeCompare.
 *
 * localeCompare collates through ICU using the ambient LANG/LC_ALL, so the
 * emitted order — and therefore the file's bytes — varied per machine. Measured
 * on this tree: `--check` passed under LANG=C/en_US.UTF-8 but FAILED under
 * et_EE.UTF-8, cs_CZ.UTF-8 and lt_LT.UTF-8 (Estonian sorts z between s and t,
 * moving `zod`/`zwitch`). A contributor on a non-English locale would see a
 * spurious "notice is out of date", regenerate, and commit a reordered file
 * that then failed for everyone else. Byte-identical output is the whole point
 * of this generator, so ordering must not depend on the environment.
 */
export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareRecords(a, b) {
  return (
    compareStrings(a.name, b.name) ||
    compareStrings(a.version, b.version) ||
    compareStrings(a.declaredLicense, b.declaredLicense)
  );
}

function readPackageJson(packagePath) {
  if (!packagePath) return undefined;
  const packageJsonPath = join(packagePath, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (cause) {
    // A truncated manifest (interrupted `pnpm install`) otherwise threw a bare
    // "SyntaxError: Unexpected end of JSON input" naming neither the package
    // nor the file, which runCli rethrows as a raw stack trace.
    const error = new Error(
      `Could not parse ${packageJsonPath}. node_modules looks corrupt — run \`pnpm install\` and retry.`,
    );
    error.code = STALE_INSTALL_CODE;
    error.cause = cause;
    throw error;
  }
}

export const STALE_INSTALL_CODE = "PWRSNAP_STALE_INSTALL";

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
 *
 * The only exemption is a bundled binary that is not an npm package at all
 * (the CI-injected FFmpeg executable), which has no installed directory to
 * check. Shipped platform packages are NOT exempt: they are read from disk
 * like everything else, so a missing copyleft slice fails here rather than
 * quietly dropping out of the notice.
 */
export function findUnmaterializedRecords(records) {
  return records.filter((record) => {
    if (record.bundledBinary === true) return false;
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
  const baseText = licensePath
    ? normalizeLicenseText(readFileSync(licensePath, "utf8"))
    : typeof record.licenseText === "string"
      ? normalizeLicenseText(record.licenseText)
    : declaredLicenseFallbackText(record, packageJson);
  // A dual-licensed package can ship a license file covering only one half of
  // its declaration (@img/sharp-win32-x64 bundles LGPL-3.0 libvips DLLs but
  // ships only the Apache-2.0 text). The suffix carries the cross-reference so
  // the partial text is never presented as the whole story. It also splits such
  // a package out of the shared-text group, which is correct — its notice
  // genuinely differs from a plain Apache-2.0 package's.
  const licenseText =
    typeof record.licenseTextSuffix === "string"
      ? `${baseText}\n${record.licenseTextSuffix}`
      : baseText;
  return {
    ...record,
    source: normalizeSourceUrl(
      normalizeRepository(packageJson?.repository) ??
      packageJson?.homepage ??
      record.source ??
      record.homepage ??
      npmPackageUrl(record.name),
    ),
    licenseFile:
      (licensePath
        ? relative(record.packagePath, licensePath)
        : typeof record.licenseText === "string"
          ? "bundled binary notice"
        : "package metadata") +
      // The suffix is PwrSnap's own cross-reference, not part of the upstream
      // file. Naming the file alone would attribute those lines to it, and
      // provenance is the entire purpose of this header.
      (typeof record.licenseTextSuffix === "string" ? " + PwrSnap cross-reference" : ""),
    licenseText,
    licenseTextHash: createHash("sha256").update(licenseText).digest("hex"),
  };
}

export function buildThirdPartyLicenseNotice({
  productionReport,
  allReport,
  platformPackageRecords,
  bundledBinaryRecords,
  weakCopyleftBinaries,
  licenseTextsBaseDir = licenseTextsDir,
  productName = "PwrSnap",
  packageFilter = desktopFilter,
}) {
  const productionRecords = flattenLicenseReport(productionReport);
  const allRecords = flattenLicenseReport(allReport);
  const recordsByKey = new Map();

  for (const record of productionRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }
  for (const record of allRecords) {
    if (record.name === "electron") {
      recordsByKey.set(stableRecordKey(record), record);
    }
  }

  // Assert BEFORE locating the platform packages. Locating them reads sharp's
  // installed directory, and sharp is one of the likelier packages to be
  // unmaterialized (its store dir embeds a peer hash, so even a @types/node
  // bump relocates it). Locating first meant a drifted install reported
  // "@img/sharp-darwin-arm64 is not installed" — pointing at
  // supportedArchitectures instead of at `pnpm install`, which is the
  // misdiagnosis this guard exists to prevent.
  assertPackagesMaterialized(Array.from(recordsByKey.values()));

  // Read off disk unless the caller pins them. These are ordinary records with
  // real paths, so enrichRecord picks up each package's own version, repository
  // URL and license text — nothing about them is hardcoded here.
  // Caller-supplied records go through the same validation as located ones —
  // validating only the derived path would leave this parameter as a way to
  // inject `undefined` into shipped legal text.
  const resolvedPlatformRecords =
    platformPackageRecords?.map(validatePlatformRecord) ??
    locateShippedPlatformPackages(productionRecords);
  for (const record of resolvedPlatformRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }

  const resolvedBundledBinaryRecords = (
    bundledBinaryRecords ?? buildBundledBinaryRecords()
  ).map((record) =>
    // Stamp the exemption here rather than only in the factory, so a
    // caller-supplied record is not mistaken for a drifted install.
    record.bundledBinary === true ? record : { ...record, bundledBinary: true },
  );
  for (const record of resolvedBundledBinaryRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }

  const resolvedWeakCopyleftBinaries =
    weakCopyleftBinaries ?? buildWeakCopyleftBundledBinaries(resolvedPlatformRecords);

  // Re-assert now that platform and bundled-binary records are in the map. The
  // first call above deliberately runs earlier so a drifted `sharp` is reported
  // as a stale install; this one is what actually covers the records merged
  // since. Without it the guard never saw them at all, and a caller-supplied
  // platformPackageRecords entry with a dead path silently produced
  // "No license text file was found..." placeholder text standing in for a live
  // copyleft slice's license.
  assertPackagesMaterialized(Array.from(recordsByKey.values()));

  const records = Array.from(recordsByKey.values()).sort(compareRecords).map(enrichRecord);

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
  if (resolvedPlatformRecords.length > 0) {
    lines.push(
      "PwrSnap's release artifacts also bundle sharp's platform-specific native runtime packages. sharp publishes these as OS+CPU-specific optional dependencies, so a production dependency listing either hides them entirely or reports only the slice matching the machine that ran the listing. They are therefore enumerated from what the release artifacts actually bundle and read from their own installed metadata, which keeps this notice identical on every platform including Linux CI:",
    );
    for (const record of resolvedPlatformRecords.slice().sort(compareRecords)) {
      lines.push(
        `- ${stableRecordKey(record)} (${record.declaredLicense}) — ${record.shippedIn}`,
      );
    }
  }
  if (resolvedWeakCopyleftBinaries.length > 0) {
    lines.push(
      `PwrSnap ships ${resolvedWeakCopyleftBinaries.length} weak-copyleft bundled binaries — ` +
        `${resolvedWeakCopyleftBinaries
          .map((binary) => `${stableRecordKey(binary)} (${binary.declaredLicense})`)
          .join(", ")}. ` +
        "Their full canonical FSF license texts and the corresponding relinking / written source offers are reproduced in the \"Full License Texts — Weak-Copyleft Bundled Binaries\" section at the end of this notice.",
    );
  }
  lines.push("");
  lines.push("Dependency Summary");
  lines.push("------------------");
  lines.push("");

  for (const [declaredLicense, group] of Array.from(recordsByLicense.entries()).sort(
    ([a], [b]) => compareStrings(a, b),
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

/**
 * The pnpm invocations behind the notice.
 *
 * `--no-optional` is the determinism mechanism, not an optimization: with
 * optional dependencies included, `pnpm licenses list` reports only the HOST's
 * platform slice, so the notice would differ between a macOS dev machine and
 * Linux CI. The shipped slices are enumerated explicitly instead (see
 * SHIPPED_PLATFORM_PACKAGES). Exported so a test can assert the flags rather
 * than only the prose that claims them.
 */
export const NOTICE_PNPM_ARGS = {
  production: ["--prod", "--no-optional"],
  all: ["--no-optional"],
};

export function generateNotice(runner = runPnpmLicenses) {
  return buildThirdPartyLicenseNotice({
    productionReport: runner(NOTICE_PNPM_ARGS.production),
    allReport: runner(NOTICE_PNPM_ARGS.all),
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
    if (error && (error.code === STALE_INSTALL_CODE || error.code === SHIPPED_PACKAGE_CODE)) {
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
  // `--no-optional` to match generateNotice(). Without it this counted the
  // HOST's optional slice, so the one number the operator sees differed between
  // macOS and Linux CI for a notice whose whole premise is being identical on
  // both. Counted from the already-generated text so a spawn failure here
  // cannot report failure for a file that was written correctly.
  const count = (output.match(/^- \S+@\S* \| /gm) ?? []).length;
  console.log(
    `wrote ${relative(repoRoot, outputPath)} (${count} dependency records incl. Electron, shipped platform packages and bundled binaries)`,
  );
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
