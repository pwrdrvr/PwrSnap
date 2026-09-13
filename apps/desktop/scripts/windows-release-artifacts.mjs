import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCliEntrypoint } from "../../../scripts/lib/cli-entrypoint.mjs";

// Windows installers are conventionally named for a human reading a Downloads
// folder — "Claude Setup.exe", "ChatGPT Install.exe" — not for a build system.
// We cannot ship the literal space: GitHub Releases replaces every space in an
// uploaded asset's filename with a period, silently, on upload (gh, the REST
// API and the web UI alike), and renaming the asset afterwards does not put the
// space back. Verified against a draft release on this repository rather than
// taken on faith: `PwrSnap Setup.exe` and `PwrSnap Setup Arm.exe` came back as
// `PwrSnap.Setup.exe` and `PwrSnap.Setup.Arm.exe`, and a PATCH renaming one to
// `PwrSnap Setup.exe` returned `PwrSnap.Setup.exe`. See
// https://github.com/orgs/community/discussions/60449 and
// https://github.com/cli/cli/issues/10585.
//
// So name the local artifact what GitHub will store anyway. A space here would
// leave the build output disagreeing with the published asset — drift that is
// only visible in the release, long after CI has gone green.
//
// These deliberately do not match the macOS aliases (`PwrSnap.dmg`,
// `PwrSnap-arm64.dmg`). Those URLs are already published — pwrsnap.com and
// docs.pwrsnap.com hardcode `PwrSnap.dmg` — and must keep working, and
// converging them would produce `PwrSnap.arm64.dmg`, which is no closer to
// either platform's convention. Each platform keeps its own spelling.
export const WINDOWS_ALIAS_NAMES = {
  x64: "PwrSnap.Setup.exe",
  arm64: "PwrSnap.Setup.Arm.exe",
};

const INSTALLER_SUFFIX = "-setup.exe";

// One definition of the checksum manifest's shape, because both halves live in
// this file: writeWindowsChecksums emits it during packaging and readChecksums
// parses it back when the signing job cuts the aliases. Splitting the two
// across modules lets the format drift with every unit test still green, and
// the reader only fails on the release runner.
const CHECKSUM_SEPARATOR = "  ";
const CHECKSUM_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function installerName(version, arch) {
  return `PwrSnap-${version}-windows-${arch}${INSTALLER_SUFFIX}`;
}

export function windowsInstallerArtifacts(distDir) {
  const artifacts = (existsSync(distDir) ? readdirSync(distDir) : [])
    .filter((entry) => entry.endsWith(INSTALLER_SUFFIX))
    .sort()
    .map((name) => ({ name, path: join(distDir, name) }));
  if (artifacts.length === 0) {
    throw new Error(
      `electron-builder reported success but produced no *${INSTALLER_SUFFIX} in ${distDir}. ` +
        `Check the electron-builder output above (icon conversion, native slices).`,
    );
  }
  return artifacts;
}

export function writeWindowsChecksums(distDir) {
  const lines = windowsInstallerArtifacts(distDir)
    .map(({ name, path }) => `${sha256(readFileSync(path))}${CHECKSUM_SEPARATOR}${name}`)
    .join("\n");
  const checksumPath = join(distDir, "SHA256SUMS");
  writeFileSync(checksumPath, `${lines}\n`);
  return checksumPath;
}

function readChecksums(dist) {
  const entries = new Map();
  for (const line of readFileSync(join(dist, "SHA256SUMS"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = CHECKSUM_LINE.exec(line);
    if (match === null) throw new Error(`Malformed SHA256SUMS line: ${line}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

/**
 * Copy each signed Windows installer to a stable, version-free name beside it,
 * so `releases/latest/download/PwrSnap.Setup.exe` keeps resolving for as long
 * as the product exists. The versioned installer stays exactly where it is:
 * `latest.yml` names it and electron-updater downloads it by that name, so the
 * alias is an additional asset, never a rename.
 *
 * Run this only on an installer whose Authenticode signature has already been
 * verified. The alias is a byte-for-byte copy and inherits whatever it copies,
 * including an unsigned intermediate.
 *
 * The aliases are deliberately absent from `SHA256SUMS` (published as
 * `PwrSnap-windows-SHA256SUMS`): they are the same bytes under a second name,
 * so a second line states no new fact, and a checksum manifest listing one
 * build twice reads like two builds — the reader has no way to tell an alias
 * from a second installer. A reader who hashes the file they downloaded still
 * finds that digest in the manifest, and the versioned name beside it tells
 * them which build they got, which the alias's own name cannot. Each installer
 * is instead checked against its recorded entry before it is copied, so the
 * existing versioned line vouches for the alias as well.
 */
export function writeWindowsReleaseAliases(dist, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || version.includes("windows")) {
    throw new Error(`Invalid Windows release version: ${version}`);
  }

  // Only this version's installers. release.mjs clears dist for macOS but not
  // for Windows, so a repeated local build leaves earlier versions sitting
  // here; they are not ours to alias and must not look like a broken release.
  const present = windowsInstallerArtifacts(dist).map(({ name }) => name);
  const installers = present.filter((name) => name.startsWith(`PwrSnap-${version}-windows-`));
  if (installers.length === 0) {
    throw new Error(`No Windows installer for ${version} in ${dist}; found ${present.join(", ")}`);
  }
  const checksums = readChecksums(dist);

  // Validate every installer before copying any of them, so a release that is
  // wrong in one architecture does not leave a stale alias for another.
  const planned = installers.map((installer) => {
    // An architecture with no agreed alias must fail here rather than publish a
    // release whose stable URL silently points at some other installer.
    const arch = Object.keys(WINDOWS_ALIAS_NAMES).find(
      (candidate) => installer === installerName(version, candidate),
    );
    if (arch === undefined) {
      throw new Error(
        `Unexpected Windows installer ${installer}: no stable alias is defined for it. ` +
          `Expected one of ${Object.keys(WINDOWS_ALIAS_NAMES)
            .map((candidate) => installerName(version, candidate))
            .join(", ")}.`,
      );
    }

    const size = statSync(join(dist, installer)).size;
    const digest = sha256(readFileSync(join(dist, installer)));
    const recorded = checksums.get(installer);
    if (recorded === undefined) throw new Error(`SHA256SUMS has no entry for ${installer}`);
    if (recorded !== digest) {
      throw new Error(`${installer} does not match SHA256SUMS: recorded ${recorded}, got ${digest}`);
    }
    return { installer, alias: WINDOWS_ALIAS_NAMES[arch], arch, sha256: digest, size };
  });

  for (const { installer, alias, size } of planned) {
    copyFileSync(join(dist, installer), join(dist, alias));
    // The installer is ~150 MB, so compare sizes rather than reading it back
    // and hashing it again; copyFileSync raises on a failed or short write.
    const copiedSize = statSync(join(dist, alias)).size;
    if (copiedSize !== size) {
      throw new Error(
        `${alias} is ${copiedSize} bytes but ${installer} is ${size}; the copy did not complete`,
      );
    }
  }
  return planned;
}

// Invoked as a release-workflow step rather than from package-win.mjs: the
// alias must be cut after the signing job has verified Authenticode, which
// happens once packaging has already returned. Takes the release stage, the
// same directory package-win.mjs builds, so the version comes from the packaged
// package.json instead of being restated in workflow YAML.
if (isCliEntrypoint(import.meta.url)) {
  const stage = process.argv[2];
  if (!stage) {
    console.error("usage: windows-release-artifacts.mjs <release-stage-dir>");
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
  const aliases = writeWindowsReleaseAliases(join(stage, "dist"), version);
  for (const { installer, alias } of aliases) {
    console.log(`  ${alias} <- ${installer}`);
  }
  // The workflow step that runs this treats a zero exit as "the alias shipped".
  // Say so explicitly so a future no-op cannot pass for success.
  console.log(`wrote ${aliases.length} stable Windows alias(es)`);
}
