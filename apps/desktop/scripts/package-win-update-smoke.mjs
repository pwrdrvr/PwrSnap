#!/usr/bin/env node
/**
 * Build a signed baseline -> target pair for the isolated Windows updater
 * smoke. Both packages come from the same prepared release-stage; only their
 * synthetic SemVer and the inert build marker differ. Nothing from this path
 * is publishable: package-win.mjs is always invoked with --publish=never and
 * writes only beneath release-stage/update-smoke-input/.work.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "../../../scripts/lib/cli-entrypoint.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");

export const UPDATE_SMOKE_MARKER_FILE = "pwrsnap-update-smoke-build.json";
export const UPDATE_SMOKE_MANIFEST_FILE = "smoke-input.json";
export const UPDATE_SMOKE_KIND = "pwrsnap-windows-update-smoke";
export const UPDATE_SMOKE_INPUT_KIND = "pwrsnap-windows-update-smoke-input";

const PACKAGE_FLAGS = ["--sign-stage-only", "--require-signing"];
const WINDOW_LIST_RESOURCE =
  '    - from: "build/native/window-list.exe"\n' +
  '      to: "PwrSnapWindowList.exe"\n';
const UPDATE_SMOKE_RESOURCE =
  '    - from: "build/update-smoke/pwrsnap-update-smoke-build.json"\n' +
  '      to: "pwrsnap-update-smoke-build.json"\n';
const REQUIRED_SIGNING_ENV = [
  "WIN_AZURE_SIGN_PUBLISHER_NAME",
  "WIN_AZURE_SIGN_ENDPOINT",
  "WIN_AZURE_SIGN_ACCOUNT",
  "WIN_AZURE_SIGN_PROFILE",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET"
];

export function assertUpdateSmokeCliArgs(args) {
  if (
    args.length !== PACKAGE_FLAGS.length ||
    PACKAGE_FLAGS.some((flag) => !args.includes(flag))
  ) {
    throw new Error(
      "Windows updater-smoke packaging requires exactly " +
        "--sign-stage-only --require-signing. Publish, release, and prepare modes are forbidden."
    );
  }
}

function githubNumericIdentifier(name, value) {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${name} must be a positive decimal GitHub Actions identifier`);
  }
  return normalized;
}

export function deriveUpdateSmokeVersions(sourceVersion, runId, runAttempt) {
  const version = sourceVersion?.trim();
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version ?? ""
  );
  if (!match || version.includes("update-smoke")) {
    throw new Error(`staged package version is not a valid non-smoke SemVer: ${sourceVersion}`);
  }

  const normalizedRunId = githubNumericIdentifier("GITHUB_RUN_ID", runId);
  const normalizedRunAttempt = githubNumericIdentifier(
    "GITHUB_RUN_ATTEMPT",
    runAttempt
  );
  const core = `${match[1]}.${match[2]}.${match[3]}`;
  const prefix = `${core}-update-smoke.${normalizedRunId}.${normalizedRunAttempt}`;
  return {
    sourceVersion: version,
    runId: normalizedRunId,
    runAttempt: normalizedRunAttempt,
    baselineVersion: `${prefix}.1`,
    targetVersion: `${prefix}.2`
  };
}

export function updateSmokeMarker(version) {
  return {
    schemaVersion: 1,
    kind: UPDATE_SMOKE_KIND,
    version
  };
}

export function injectUpdateSmokeResource(configText) {
  const normalized = configText.replace(/\r\n/g, "\n");
  if (normalized.includes(UPDATE_SMOKE_MARKER_FILE)) {
    throw new Error("staged electron-builder config already contains the updater-smoke marker");
  }
  if (!normalized.includes(WINDOW_LIST_RESOURCE)) {
    throw new Error("electron-builder.yml win.extraResources window-list marker not found");
  }
  return normalized.replace(
    WINDOW_LIST_RESOURCE,
    WINDOW_LIST_RESOURCE + UPDATE_SMOKE_RESOURCE
  );
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function assertTargetLatestYml(text, { version, installerFileName }) {
  const versionMatch = /^version:\s*(.*?)\s*$/m.exec(text);
  const urlMatch = /^\s*-\s+url:\s*(.*?)\s*$/m.exec(text);
  const pathMatch = /^path:\s*(.*?)\s*$/m.exec(text);
  if (!versionMatch || yamlScalar(versionMatch[1]) !== version) {
    throw new Error(`latest.yml does not declare target version ${version}`);
  }
  if (!urlMatch || yamlScalar(urlMatch[1]) !== installerFileName) {
    throw new Error(`latest.yml does not reference target URL ${installerFileName}`);
  }
  if (!pathMatch || yamlScalar(pathMatch[1]) !== installerFileName) {
    throw new Error(`latest.yml does not reference target path ${installerFileName}`);
  }
}

function assertSigningEnvironment(env) {
  const missing = REQUIRED_SIGNING_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `signed Windows updater-smoke input is missing protected signing values: ${missing.join(", ")}`
    );
  }
}

function fileRecord(path) {
  return {
    fileName: basename(path),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    size: statSync(path).size
  };
}

function expectSingleInstaller(outputDir, version) {
  const installers = readdirSync(outputDir)
    .filter((name) => name.endsWith("-setup.exe"))
    .sort();
  const expected = `PwrSnap-${version}-windows-x64-setup.exe`;
  if (installers.length !== 1 || installers[0] !== expected) {
    throw new Error(
      `expected only ${expected} under ${outputDir}; found ${installers.join(", ") || "none"}`
    );
  }
  return join(outputDir, expected);
}

function copyRequired(source, destination) {
  if (!existsSync(source)) {
    throw new Error(`required updater-smoke artifact is missing: ${source}`);
  }
  cpSync(source, destination);
  return destination;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function defaultRunPackage({ packageWinScript, outputDir, env }) {
  const result = spawnSync(process.execPath, [packageWinScript, ...PACKAGE_FLAGS], {
    cwd: desktopRoot,
    env: {
      ...env,
      // Defense in depth: the child already receives --publish=never, and it
      // also receives no GitHub publication credential even if one happened
      // to be present in the protected job environment.
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      PWRSNAP_WINDOWS_PACKAGE_OUTPUT_DIR: outputDir
    },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`signed Windows package build failed with exit code ${result.status ?? 1}`);
  }
}

function snapshot(path) {
  return existsSync(path) ? { existed: true, contents: readFileSync(path) } : { existed: false };
}

function restore(path, saved) {
  if (saved.existed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, saved.contents);
  } else {
    rmSync(path, { force: true });
  }
}

export function packageWindowsUpdateSmokePair({
  stageDir = join(desktopRoot, "release-stage"),
  packageWinScript = join(scriptDir, "package-win.mjs"),
  env = process.env,
  runPackage = defaultRunPackage
} = {}) {
  assertSigningEnvironment(env);

  const packagePath = join(stageDir, "package.json");
  const configPath = join(stageDir, "electron-builder.yml");
  const markerPath = join(
    stageDir,
    "build",
    "update-smoke",
    UPDATE_SMOKE_MARKER_FILE
  );
  for (const path of [packagePath, configPath, packageWinScript]) {
    if (!existsSync(path)) {
      throw new Error(`prepared signing input is missing: ${path}`);
    }
  }

  const packageSnapshot = snapshot(packagePath);
  const configSnapshot = snapshot(configPath);
  const markerSnapshot = snapshot(markerPath);
  const markerDirExisted = existsSync(dirname(markerPath));
  const sourcePackage = JSON.parse(packageSnapshot.contents.toString("utf8"));
  const versions = deriveUpdateSmokeVersions(
    sourcePackage.version,
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT
  );
  const outputRoot = join(stageDir, "update-smoke-input");
  const workRoot = join(outputRoot, ".work");

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  let completed = false;

  try {
    writeFileSync(
      configPath,
      injectUpdateSmokeResource(configSnapshot.contents.toString("utf8"))
    );

    const packaged = {};
    for (const [role, version] of [
      ["baseline", versions.baselineVersion],
      ["target", versions.targetVersion]
    ]) {
      const outputDir = join(workRoot, role);
      rmSync(outputDir, { recursive: true, force: true });
      mkdirSync(outputDir, { recursive: true });
      writeJson(packagePath, { ...sourcePackage, version });
      mkdirSync(dirname(markerPath), { recursive: true });
      writeJson(markerPath, updateSmokeMarker(version));

      runPackage({
        role,
        version,
        packageWinScript,
        outputDir,
        flags: [...PACKAGE_FLAGS],
        env
      });

      const installer = expectSingleInstaller(outputDir, version);
      const copiedInstaller = copyRequired(
        installer,
        join(outputRoot, basename(installer))
      );
      packaged[role] = { version, installer: copiedInstaller };

      if (role === "target") {
        const blockmap = copyRequired(
          `${installer}.blockmap`,
          join(outputRoot, `${basename(installer)}.blockmap`)
        );
        const latestYml = copyRequired(
          join(outputDir, "latest.yml"),
          join(outputRoot, "latest.yml")
        );
        assertTargetLatestYml(readFileSync(latestYml, "utf8"), {
          version,
          installerFileName: basename(installer)
        });
        packaged.target.blockmap = blockmap;
        packaged.target.latestYml = latestYml;
      }
    }

    rmSync(workRoot, { recursive: true, force: true });
    const manifest = {
      schemaVersion: 1,
      kind: UPDATE_SMOKE_INPUT_KIND,
      sourceVersion: versions.sourceVersion,
      github: {
        runId: versions.runId,
        runAttempt: versions.runAttempt
      },
      baseline: {
        version: packaged.baseline.version,
        installer: fileRecord(packaged.baseline.installer)
      },
      target: {
        version: packaged.target.version,
        installer: fileRecord(packaged.target.installer),
        blockmap: fileRecord(packaged.target.blockmap),
        latestYml: fileRecord(packaged.target.latestYml)
      }
    };
    const manifestTemp = join(outputRoot, `${UPDATE_SMOKE_MANIFEST_FILE}.tmp`);
    writeJson(manifestTemp, manifest);
    renameSync(manifestTemp, join(outputRoot, UPDATE_SMOKE_MANIFEST_FILE));

    const finalFiles = readdirSync(outputRoot).sort();
    const expectedFiles = [
      manifest.baseline.installer.fileName,
      manifest.target.blockmap.fileName,
      manifest.target.installer.fileName,
      manifest.target.latestYml.fileName,
      UPDATE_SMOKE_MANIFEST_FILE
    ].sort();
    if (JSON.stringify(finalFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(
        `updater-smoke input contains unexpected files: ${finalFiles.join(", ")}`
      );
    }
    completed = true;
    return manifest;
  } finally {
    restore(packagePath, packageSnapshot);
    restore(configPath, configSnapshot);
    restore(markerPath, markerSnapshot);
    if (!markerDirExisted) {
      rmSync(dirname(markerPath), { recursive: true, force: true });
    }
    if (completed) {
      rmSync(workRoot, { recursive: true, force: true });
    } else {
      // A partial pair has no safe consumer. Remove it so a later artifact
      // upload cannot mistake a lone signed baseline for complete smoke input.
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }
}

export function main({
  args = process.argv.slice(2),
  platform = process.platform,
  env = process.env
} = {}) {
  assertUpdateSmokeCliArgs(args);
  if (platform !== "win32") {
    throw new Error("signed Windows updater-smoke packaging must run on Windows");
  }
  const manifest = packageWindowsUpdateSmokePair({ env });
  console.log(
    `\n✓ signed updater-smoke pair: ${manifest.baseline.version} -> ${manifest.target.version}`
  );
  console.log(`  input: ${join(desktopRoot, "release-stage", "update-smoke-input")}`);
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
