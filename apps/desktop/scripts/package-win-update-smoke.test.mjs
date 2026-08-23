import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertTargetLatestYml,
  assertUpdateSmokeCliArgs,
  deriveUpdateSmokeVersions,
  injectUpdateSmokeResource,
  packageWindowsUpdateSmokePair,
  UPDATE_SMOKE_INPUT_KIND,
  UPDATE_SMOKE_KIND,
  UPDATE_SMOKE_MANIFEST_FILE,
  UPDATE_SMOKE_MARKER_FILE,
  updateSmokeMarker
} from "./package-win-update-smoke.mjs";

const tempRoots = [];
const WINDOW_LIST_CONFIG = [
  "win:",
  "  extraResources:",
  '    - from: "build/native/window-list.exe"',
  '      to: "PwrSnapWindowList.exe"',
  "",
  "nsis:",
  '  artifactName: "${productName}-${version}-windows-${arch}-setup.${ext}"',
  ""
].join("\n");

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-update-smoke-package-"));
  tempRoots.push(root);
  return root;
}

function signingEnv(overrides = {}) {
  return {
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "2",
    WIN_AZURE_SIGN_PUBLISHER_NAME: "PwrDrvr LLC",
    WIN_AZURE_SIGN_ENDPOINT: "https://example.test",
    WIN_AZURE_SIGN_ACCOUNT: "account",
    WIN_AZURE_SIGN_PROFILE: "profile",
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "secret",
    ...overrides
  };
}

function stagedFixture({ markerContents } = {}) {
  const root = tempRoot();
  const stageDir = join(root, "release-stage");
  const packageWinScript = join(root, "package-win.mjs");
  const markerPath = join(
    stageDir,
    "build",
    "update-smoke",
    UPDATE_SMOKE_MARKER_FILE
  );
  mkdirSync(join(stageDir, "build", "native"), { recursive: true });
  writeFileSync(
    join(stageDir, "package.json"),
    `${JSON.stringify({ name: "@pwrsnap/desktop", version: "1.1.0-alpha.4" }, null, 2)}\n`
  );
  writeFileSync(join(stageDir, "electron-builder.yml"), WINDOW_LIST_CONFIG);
  writeFileSync(packageWinScript, "// test package-win placeholder\n");
  if (markerContents !== undefined) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, markerContents);
  }
  return { root, stageDir, packageWinScript, markerPath };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("signed Windows updater-smoke package pair", () => {
  test("accepts only the signed stage-only, never-publish CLI", () => {
    expect(() =>
      assertUpdateSmokeCliArgs(["--sign-stage-only", "--require-signing"])
    ).not.toThrow();
    expect(() => assertUpdateSmokeCliArgs([])).toThrow(/requires exactly/);
    expect(() =>
      assertUpdateSmokeCliArgs([
        "--sign-stage-only",
        "--require-signing",
        "--publish"
      ])
    ).toThrow(/Publish, release, and prepare modes are forbidden/);
    expect(() =>
      assertUpdateSmokeCliArgs(["--sign-stage-only", "--release"])
    ).toThrow(/requires exactly/);
  });

  test("derives deterministic, strictly increasing synthetic prereleases", () => {
    expect(deriveUpdateSmokeVersions("1.1.0-alpha.4", "123456789", "2")).toEqual({
      sourceVersion: "1.1.0-alpha.4",
      runId: "123456789",
      runAttempt: "2",
      baselineVersion: "1.1.0-update-smoke.123456789.2.1",
      targetVersion: "1.1.0-update-smoke.123456789.2.2"
    });
    expect(() => deriveUpdateSmokeVersions("1.1.0", "", "2")).toThrow(
      /GITHUB_RUN_ID/
    );
    expect(() => deriveUpdateSmokeVersions("1.1.0", "123", "0")).toThrow(
      /GITHUB_RUN_ATTEMPT/
    );
    expect(() =>
      deriveUpdateSmokeVersions("1.1.0-update-smoke.1.1.1", "123", "1")
    ).toThrow(/non-smoke SemVer/);
  });

  test("injects the exact inert resource marker contract once", () => {
    const version = "1.1.0-update-smoke.123.1.1";
    expect(updateSmokeMarker(version)).toEqual({
      schemaVersion: 1,
      kind: UPDATE_SMOKE_KIND,
      version
    });
    const config = injectUpdateSmokeResource(WINDOW_LIST_CONFIG);
    expect(config).toContain(
      '    - from: "build/update-smoke/pwrsnap-update-smoke-build.json"\n' +
        '      to: "pwrsnap-update-smoke-build.json"\n'
    );
    expect(() => injectUpdateSmokeResource(config)).toThrow(/already contains/);
  });

  test("requires latest.yml to name the exact target version and installer", () => {
    const version = "1.1.0-update-smoke.123.1.2";
    const installerFileName = `PwrSnap-${version}-windows-x64-setup.exe`;
    const valid = [
      `version: ${version}`,
      "files:",
      `  - url: ${installerFileName}`,
      "    sha512: fake",
      `path: ${installerFileName}`,
      "sha512: fake",
      ""
    ].join("\n");
    expect(() =>
      assertTargetLatestYml(valid, { version, installerFileName })
    ).not.toThrow();
    expect(() =>
      assertTargetLatestYml(valid.replace(installerFileName, "wrong.exe"), {
        version,
        installerFileName
      })
    ).toThrow(/target URL/);
  });

  test("builds the flat five-file input and restores staged metadata", () => {
    const { stageDir, packageWinScript, markerPath } = stagedFixture();
    const packagePath = join(stageDir, "package.json");
    const configPath = join(stageDir, "electron-builder.yml");
    const originalPackage = readFileSync(packagePath);
    const originalConfig = readFileSync(configPath);
    const calls = [];

    const manifest = packageWindowsUpdateSmokePair({
      stageDir,
      packageWinScript,
      env: signingEnv(),
      runPackage: ({ role, version, outputDir, flags }) => {
        calls.push({ role, version, flags });
        expect(JSON.parse(readFileSync(packagePath, "utf8")).version).toBe(version);
        expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({
          schemaVersion: 1,
          kind: UPDATE_SMOKE_KIND,
          version
        });
        expect(readFileSync(configPath, "utf8")).toContain(UPDATE_SMOKE_MARKER_FILE);

        const installerFileName = `PwrSnap-${version}-windows-x64-setup.exe`;
        writeFileSync(join(outputDir, installerFileName), `${role}-installer`);
        writeFileSync(join(outputDir, `${installerFileName}.blockmap`), `${role}-blockmap`);
        writeFileSync(
          join(outputDir, "latest.yml"),
          [
            `version: ${version}`,
            "files:",
            `  - url: ${installerFileName}`,
            "    sha512: fake",
            `path: ${installerFileName}`,
            "sha512: fake",
            ""
          ].join("\n")
        );
      }
    });

    expect(calls).toEqual([
      {
        role: "baseline",
        version: "1.1.0-update-smoke.123456789.2.1",
        flags: ["--sign-stage-only", "--require-signing"]
      },
      {
        role: "target",
        version: "1.1.0-update-smoke.123456789.2.2",
        flags: ["--sign-stage-only", "--require-signing"]
      }
    ]);
    expect(manifest.kind).toBe(UPDATE_SMOKE_INPUT_KIND);
    const outputRoot = join(stageDir, "update-smoke-input");
    const finalFiles = readdirSync(outputRoot).sort();
    expect(finalFiles).toEqual(
      [
        manifest.baseline.installer.fileName,
        manifest.target.installer.fileName,
        manifest.target.blockmap.fileName,
        "latest.yml",
        UPDATE_SMOKE_MANIFEST_FILE
      ].sort()
    );
    expect(manifest.baseline.installer.sha256).toBe(
      sha256(join(outputRoot, manifest.baseline.installer.fileName))
    );
    expect(manifest.target.latestYml).toEqual({
      fileName: "latest.yml",
      sha256: sha256(join(outputRoot, "latest.yml")),
      size: readFileSync(join(outputRoot, "latest.yml")).length
    });
    expect(JSON.parse(readFileSync(join(outputRoot, UPDATE_SMOKE_MANIFEST_FILE), "utf8"))).toEqual(
      manifest
    );
    expect(readFileSync(packagePath)).toEqual(originalPackage);
    expect(readFileSync(configPath)).toEqual(originalConfig);
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(dirname(markerPath))).toBe(false);
  });

  test("restores package, config, and a pre-existing marker after failure", () => {
    const previousMarker = '{"preexisting":true}\n';
    const { stageDir, packageWinScript, markerPath } = stagedFixture({
      markerContents: previousMarker
    });
    const packagePath = join(stageDir, "package.json");
    const configPath = join(stageDir, "electron-builder.yml");
    const originalPackage = readFileSync(packagePath);
    const originalConfig = readFileSync(configPath);
    const runPackage = vi.fn(() => {
      throw new Error("simulated signing failure");
    });

    expect(() =>
      packageWindowsUpdateSmokePair({
        stageDir,
        packageWinScript,
        env: signingEnv(),
        runPackage
      })
    ).toThrow(/simulated signing failure/);
    expect(runPackage).toHaveBeenCalledTimes(1);
    expect(readFileSync(packagePath)).toEqual(originalPackage);
    expect(readFileSync(configPath)).toEqual(originalConfig);
    expect(readFileSync(markerPath, "utf8")).toBe(previousMarker);
    expect(existsSync(join(stageDir, "update-smoke-input"))).toBe(false);
  });

  test("fails before mutation when protected signing configuration is absent", () => {
    const { stageDir, packageWinScript } = stagedFixture();
    const packagePath = join(stageDir, "package.json");
    const originalPackage = readFileSync(packagePath);

    expect(() =>
      packageWindowsUpdateSmokePair({
        stageDir,
        packageWinScript,
        env: signingEnv({ AZURE_CLIENT_SECRET: "" }),
        runPackage: vi.fn()
      })
    ).toThrow(/AZURE_CLIENT_SECRET/);
    expect(readFileSync(packagePath)).toEqual(originalPackage);
  });

  test("package-win confines its internal output seam away from real release dist", () => {
    const packageWin = readFileSync(resolve(import.meta.dirname, "package-win.mjs"), "utf8");
    expect(packageWin).toContain(
      'const updateSmokeWorkRoot = join(stageDir, "update-smoke-input", ".work");'
    );
    expect(packageWin).toContain(
      "PWRSNAP_WINDOWS_PACKAGE_OUTPUT_DIR is restricted to --sign-stage-only"
    );
    expect(packageWin).toContain("--publish=never");
    expect(packageWin).toContain("--config.directories.output=${packageDistDir}");
  });
});
