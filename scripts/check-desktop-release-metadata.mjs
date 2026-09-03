#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackagePath = resolve(repoRoot, "apps/desktop/package.json");
const rootPackagePath = resolve(repoRoot, "package.json");
const electronBuilderPath = resolve(repoRoot, "apps/desktop/electron-builder.yml");
const ciWorkflowPath = resolve(repoRoot, ".github/workflows/ci.yml");
const releaseWorkflowPath = resolve(repoRoot, ".github/workflows/release.yml");
const workflowsReadmePath = resolve(repoRoot, ".github/workflows/README.md");
const windowsPackageScriptPath = resolve(repoRoot, "apps/desktop/scripts/package-win.mjs");
const windowsArchiveScriptPath = resolve(
  repoRoot,
  "scripts/release/archive-windows-signing-input.ps1",
);
const trustedSigningScriptPath = resolve(
  repoRoot,
  "scripts/release/install-trusted-signing.ps1",
);
const changelogPath = resolve(repoRoot, "CHANGELOG.md");

function usage() {
  console.error("Usage: RELEASE_TAG=v1.0.0-alpha.4 pnpm release:check");
  console.error("   or: pnpm release:check --tag v1.0.0-alpha.4");
  console.error("   or: pnpm release:check --tag v1.0.0-alpha.4 --notes-file /tmp/RELEASE_NOTES.md");
}

function parseTagArg(argv) {
  const tagIndex = argv.indexOf("--tag");
  if (tagIndex !== -1) {
    return argv[tagIndex + 1] || "";
  }
  const inline = argv.find((arg) => arg.startsWith("--tag="));
  if (inline) {
    return inline.slice("--tag=".length);
  }
  return process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
}

function parseNotesFileArg(argv) {
  const notesFileIndex = argv.indexOf("--notes-file");
  if (notesFileIndex !== -1) {
    return argv[notesFileIndex + 1] || "";
  }
  const inline = argv.find((arg) => arg.startsWith("--notes-file="));
  if (inline) {
    return inline.slice("--notes-file=".length);
  }
  return undefined;
}

function fail(message) {
  console.error(`release metadata check failed: ${message}`);
  process.exitCode = 1;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractChangelogSection(changelog, version) {
  const headingPattern = new RegExp(`^##\\s+v?${escapeRegex(version)}(?:\\s|$)`);
  const nextHeadingPattern = /^##\s+/;
  const lines = changelog.split(/\r?\n/);
  const section = [];
  let inSection = false;

  for (const line of lines) {
    if (!inSection && headingPattern.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && nextHeadingPattern.test(line)) {
      break;
    }
    if (inSection) {
      section.push(line);
    }
  }

  return section.join("\n").trim();
}

const argv = process.argv.slice(2);
const tag = parseTagArg(argv);
if (!tag) {
  usage();
  fail("no release tag was provided");
  process.exit();
}

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`tag "${tag}" must look like vX.Y.Z or vX.Y.Z-prerelease`);
}

const expectedVersion = tag.slice(1);
const notesFile = parseNotesFileArg(argv);
if (notesFile === "") {
  usage();
  fail("--notes-file requires a path");
}
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
if (desktopPackage.version !== expectedVersion) {
  fail(
    `apps/desktop/package.json version is ${desktopPackage.version}, but release tag ${tag} requires ${expectedVersion}`,
  );
}

// `description` is not inert metadata on Windows. electron-builder writes it
// into the NSIS installer's own FileDescription version string (what SmartScreen
// and the file Properties dialog name the program) and passes it as
// APP_DESCRIPTION to `CreateShortCut`, which becomes the Start Menu / desktop
// .lnk comment — the line Windows 11 renders in the taskbar jump list. v1.1
// shipped "Mac-first agentic screen capture tool" to Windows users that way.
const description = typeof desktopPackage.description === "string" ? desktopPackage.description : "";
if (description.trim() === "") {
  fail("apps/desktop/package.json description must be a non-empty string");
} else if (/\b(?:mac|macos|mac-first|apple|osx|windows|linux)\b/i.test(description)) {
  fail(
    `apps/desktop/package.json description ships to Windows users as the installer FileDescription and the shortcut comment, so it must stay platform-neutral; got ${JSON.stringify(description)}`,
  );
}

const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
if (rootPackage.description !== desktopPackage.description) {
  fail(
    `package.json description ${JSON.stringify(rootPackage.description)} must match apps/desktop/package.json description ${JSON.stringify(description)}`,
  );
}

const electronBuilder = readFileSync(electronBuilderPath, "utf8");
if (!/^\s*releaseType:\s*prerelease\s*$/m.test(electronBuilder)) {
  fail("apps/desktop/electron-builder.yml publish.releaseType must be prerelease");
}

const ciWorkflow = readFileSync(ciWorkflowPath, "utf8");
if (!ciWorkflow.includes("releases/**")) {
  fail('.github/workflows/ci.yml must trigger CI for "releases/**" branches');
}

const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf8");
const workflowsReadme = readFileSync(workflowsReadmePath, "utf8");
const windowsPackageScript = readFileSync(windowsPackageScriptPath, "utf8");
const windowsArchiveScript = readFileSync(windowsArchiveScriptPath, "utf8");
const trustedSigningScript = readFileSync(trustedSigningScriptPath, "utf8");

if (!workflowsReadme.includes("ci:windows-signing")) {
  fail(".github/workflows/README.md must document ci:windows-signing");
}
for (const unexpected of ["ci:windows-package", "\n  windows-package:\n"]) {
  if (ciWorkflow.includes(unexpected)) {
    fail(`.github/workflows/ci.yml must not contain ${JSON.stringify(unexpected)}`);
  }
}

for (const expected of [
  "  linux-build:",
  "  windows-prepare:",
  "  windows-sign:",
  "  publish-release-assets:",
  "environment: windows-signing",
  "windows-release-signing-input",
  "scripts/release/install-trusted-signing.ps1",
  "--sign-stage-only --release --require-signing",
  "vars.WIN_AZURE_SIGN_PUBLISHER_NAME",
  "vars.WIN_AZURE_SIGN_ENDPOINT",
  "vars.WIN_AZURE_SIGN_ACCOUNT",
  "vars.WIN_AZURE_SIGN_PROFILE",
  "secrets.AZURE_TENANT_ID",
  "secrets.AZURE_CLIENT_ID",
  "secrets.AZURE_CLIENT_SECRET",
  "- linux-build",
  "- sign",
  "- windows-sign",
  "gh release create",
  "--verify-tag",
  "pull_request:",
  "ci:windows-signing",
  "github.event.pull_request.head.repo.full_name == github.repository",
  "Get-AuthenticodeSignature",
  "windows-signed-installer-pr",
  "if: ${{ github.event_name != 'pull_request' }}",
  "find mac-dist/dist mac-dist/build/ffmpeg-source",
  '"${mac_assets[@]}"',
  '"${windows_assets[@]}"',
  // Both stable-name aliases back a releases/latest/download/<name> URL the
  // websites can hardcode. Each is produced in its platform's protected
  // signing job and must survive into the release, or a published download
  // button silently 404s.
  "Prepare stable-name DMG alias",
  "Prepare stable-name Windows installer alias",
  "mac-dist/dist/PwrSnap.dmg",
  "windows-dist/PwrSnap-windows-x64-setup.exe",
]) {
  if (!releaseWorkflow.includes(expected)) {
    fail(`.github/workflows/release.yml must contain ${JSON.stringify(expected)}`);
  }
}
if (releaseWorkflow.includes("pull_request_target")) {
  fail('.github/workflows/release.yml must not contain "pull_request_target"');
}
if (releaseWorkflow.includes("mac-dist/*")) {
  fail('.github/workflows/release.yml must not pass mac-dist directories to publication');
}
const protectedWindowsJob = releaseWorkflow
  .split("\n  windows-sign:\n")[1]
  ?.split("\n  publish-release-assets:\n")[0];
if (!protectedWindowsJob) {
  fail(".github/workflows/release.yml protected Windows job is missing");
} else {
  for (const unexpected of ["actions/checkout", "pnpm install", "npm install"]) {
    if (protectedWindowsJob.includes(unexpected)) {
      fail(
        `.github/workflows/release.yml protected Windows job must not contain ${JSON.stringify(unexpected)}`,
      );
    }
  }
}
for (const unexpected of [
  "WINDOWS_UNSIGNED_RELEASE",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
]) {
  if (releaseWorkflow.includes(unexpected)) {
    fail(`.github/workflows/release.yml must not contain ${JSON.stringify(unexpected)}`);
  }
}

for (const expected of [
  "resolveWindowsAzureSigning",
  "--config.node-linker=hoisted",
  "--config.win.azureSignOptions.publisherName",
  "PWRSNAP_ASAR_MODULE_ROOT",
  "writeWindowsChecksums",
]) {
  if (!windowsPackageScript.includes(expected)) {
    fail(`apps/desktop/scripts/package-win.mjs must contain ${JSON.stringify(expected)}`);
  }
}
for (const expected of [
  "apps/desktop/release-stage/node_modules/.pnpm/node_modules",
  "apps/desktop/release-stage",
  "apps/desktop/scripts/package-win.mjs",
  "scripts/release/install-trusted-signing.ps1",
  // The signing job has no checkout, so anything it runs — and anything those
  // scripts import — must be archived. verify-asar-contents.mjs imports
  // cli-entrypoint.mjs; omitting it is an ERR_MODULE_NOT_FOUND after signing.
  "scripts/lib/cli-entrypoint.mjs",
  "scripts/check-bundled-ffmpeg-notice.mjs",
  "tar.exe -czf",
]) {
  if (!windowsArchiveScript.includes(expected)) {
    fail(`${windowsArchiveScriptPath} must contain ${JSON.stringify(expected)}`);
  }
}
for (const expected of [
  "Install-Module",
  "-Name TrustedSigning",
  "-MinimumVersion 0.5.0",
  "Get-Command Invoke-TrustedSigning",
  "-NoProfile -NonInteractive -Command",
]) {
  if (!trustedSigningScript.includes(expected)) {
    fail(`${trustedSigningScriptPath} must contain ${JSON.stringify(expected)}`);
  }
}

let changelog = "";
try {
  changelog = readFileSync(changelogPath, "utf8");
} catch (error) {
  if (error && error.code === "ENOENT") {
    fail("CHANGELOG.md is missing");
  } else {
    throw error;
  }
}

const headingPattern = new RegExp(`^##\\s+v?${escapeRegex(expectedVersion)}(?:\\s|$)`, "m");
if (!headingPattern.test(changelog)) {
  fail(`CHANGELOG.md must contain a second-level heading for ${tag}`);
}

const releaseNotes = extractChangelogSection(changelog, expectedVersion);
if (releaseNotes.length === 0) {
  fail(`CHANGELOG.md section for ${tag} must contain release notes`);
}

if (process.exitCode) {
  process.exit();
}

if (notesFile) {
  writeFileSync(notesFile, `${releaseNotes}\n`);
  console.log(`release metadata check passed for ${tag}; wrote notes to ${notesFile}`);
} else {
  console.log(`release metadata check passed for ${tag}`);
}
