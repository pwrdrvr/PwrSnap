import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  EXPECTED_WINDOWS_PUBLISHER,
  buildIsolatedSmokeEnvironment,
  classifyUpdateRequest,
  collectBoundedDirectoryInventory,
  compareExactSemver,
  createIsolatedUpdateServer,
  invokePowerShellJson,
  loadSmokeInput,
  parseArguments,
  parseByteRanges,
  runBoundedProcess,
  runWindowsUpdateSmoke,
  validateAuthenticodeEvidence,
  validateLatestYml,
  validateRuntimeEvidence,
  validateSmokeInputManifest,
  validateUpdateServerEvidence,
  validateWindowsVersionEvidence
} from "./run-windows-update-smoke.mjs";

const baselineVersion = "1.1.0-update-smoke.123456.2.1";
const targetVersion = "1.1.0-update-smoke.123456.2.2";
const sourceVersion = "1.1.0-alpha.4";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

function descriptor(fileName, bytes) {
  return { fileName, sha256: sha256(bytes), size: bytes.length };
}

function validManifest(overrides = {}) {
  const baselineName = `PwrSnap-${baselineVersion}-windows-x64-setup.exe`;
  const targetName = `PwrSnap-${targetVersion}-windows-x64-setup.exe`;
  return {
    schemaVersion: 1,
    kind: "pwrsnap-windows-update-smoke-input",
    sourceVersion,
    github: { runId: "123456", runAttempt: "2" },
    baseline: {
      version: baselineVersion,
      installer: {
        fileName: baselineName,
        sha256: "a".repeat(64),
        size: 100
      }
    },
    target: {
      version: targetVersion,
      installer: {
        fileName: targetName,
        sha256: "b".repeat(64),
        size: 200
      },
      blockmap: {
        fileName: `${targetName}.blockmap`,
        sha256: "c".repeat(64),
        size: 30
      },
      latestYml: {
        fileName: "latest.yml",
        sha256: "d".repeat(64),
        size: 40
      }
    },
    ...overrides
  };
}

function latestYml({ installerName, installerBytes, version = targetVersion }) {
  const digest = sha512(installerBytes);
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${installerName}`,
    `    sha512: ${digest}`,
    `    size: ${installerBytes.length}`,
    `path: ${installerName}`,
    `sha512: ${digest}`,
    "releaseDate: '2026-08-23T12:00:00.000Z'",
    ""
  ].join("\n");
}

async function httpCall(url, { method = "GET", path = "/", headers = {} } = {}) {
  return new Promise((resolveCall, reject) => {
    const call = request(url, { method, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () =>
        resolveCall({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks)
        })
      );
    });
    call.once("error", reject);
    call.end();
  });
}

describe("Windows packaged updater smoke manifest", () => {
  test("accepts only an exact newer synthetic prerelease pair", () => {
    expect(validateSmokeInputManifest(validManifest())).toMatchObject({
      sourceVersion,
      github: { runId: "123456", runAttempt: "2" },
      baseline: { version: baselineVersion },
      target: { version: targetVersion }
    });
    expect(compareExactSemver(targetVersion, baselineVersion)).toBeGreaterThan(0);

    expect(() =>
      validateSmokeInputManifest(
        validManifest({
          sourceVersion,
          target: {
            ...validManifest().target,
            version: baselineVersion,
            installer: {
              ...validManifest().target.installer,
              fileName: `PwrSnap-${baselineVersion}-windows-x64-setup.exe`
            },
            blockmap: {
              ...validManifest().target.blockmap,
              fileName: `PwrSnap-${baselineVersion}-windows-x64-setup.exe.blockmap`
            }
          }
        })
      )
    ).toThrow(/newer than baseline/);

    const wrongDerivedTarget = validManifest();
    wrongDerivedTarget.target.version =
      "1.1.0-update-smoke.123456.2.3";
    wrongDerivedTarget.target.installer.fileName =
      "PwrSnap-1.1.0-update-smoke.123456.2.3-windows-x64-setup.exe";
    wrongDerivedTarget.target.blockmap.fileName =
      `${wrongDerivedTarget.target.installer.fileName}.blockmap`;
    expect(() => validateSmokeInputManifest(wrongDerivedTarget)).toThrow(
      /target\.version must be exactly/
    );

    expect(() =>
      validateSmokeInputManifest(
        validManifest({ sourceVersion: "1.1.0-alpha.update-smoke-source" })
      )
    ).toThrow(/original non-smoke/);

    expect(() =>
      validateSmokeInputManifest(
        validManifest({ sourceVersion: "1.2.0-alpha.1" })
      )
    ).toThrow(/share one release core/);
  });

  test("rejects unsafe names, noncanonical hashes, and numeric GitHub IDs", () => {
    const unsafe = validManifest();
    unsafe.target.installer.fileName = "../target.exe";
    expect(() => validateSmokeInputManifest(unsafe)).toThrow(/safe ASCII basename/);

    const uppercaseHash = validManifest();
    uppercaseHash.target.blockmap.sha256 = "C".repeat(64);
    expect(() => validateSmokeInputManifest(uppercaseHash)).toThrow(/lowercase hexadecimal/);

    const numericId = validManifest();
    numericId.github.runId = 123456;
    expect(() => validateSmokeInputManifest(numericId)).toThrow(/decimal string/);
  });

  test("checks actual sibling asset sizes, SHA-256 values, and latest.yml", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pwrsnap-update-input-"));
    const baselineName = `PwrSnap-${baselineVersion}-windows-x64-setup.exe`;
    const targetName = `PwrSnap-${targetVersion}-windows-x64-setup.exe`;
    const baselineBytes = Buffer.from("signed baseline fixture");
    const targetBytes = Buffer.from("signed target fixture");
    const blockmapBytes = Buffer.from("target blockmap fixture");
    const ymlBytes = Buffer.from(
      latestYml({ installerName: targetName, installerBytes: targetBytes })
    );
    const manifest = {
      schemaVersion: 1,
      kind: "pwrsnap-windows-update-smoke-input",
      sourceVersion,
      github: { runId: "123456", runAttempt: "2" },
      baseline: {
        version: baselineVersion,
        installer: descriptor(baselineName, baselineBytes)
      },
      target: {
        version: targetVersion,
        installer: descriptor(targetName, targetBytes),
        blockmap: descriptor(`${targetName}.blockmap`, blockmapBytes),
        latestYml: descriptor("latest.yml", ymlBytes)
      }
    };

    try {
      await Promise.all([
        writeFile(join(directory, baselineName), baselineBytes),
        writeFile(join(directory, targetName), targetBytes),
        writeFile(join(directory, `${targetName}.blockmap`), blockmapBytes),
        writeFile(join(directory, "latest.yml"), ymlBytes),
        writeFile(
          join(directory, "smoke-input.json"),
          `${JSON.stringify(manifest)}\n`
        )
      ]);
      const loaded = await loadSmokeInput(directory);
      expect(loaded.manifest).toEqual(manifest);
      expect(loaded.assets.targetInstaller.sha512).toBe(sha512(targetBytes));

      await writeFile(join(directory, targetName), Buffer.from("tampered"));
      await expect(loadSmokeInput(directory)).rejects.toThrow(/size does not match|SHA-256/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("latest.yml cannot redirect away from the exact installer basename", () => {
    const installerName = `PwrSnap-${targetVersion}-windows-x64-setup.exe`;
    const bytes = Buffer.from("target");
    const valid = latestYml({ installerName, installerBytes: bytes });
    expect(
      validateLatestYml(valid, {
        version: targetVersion,
        installerFileName: installerName,
        installerSize: bytes.length,
        installerSha512: sha512(bytes)
      })
    ).toBe(true);
    expect(() =>
      validateLatestYml(valid.replace(installerName, "https://github.com/evil.exe"), {
        version: targetVersion,
        installerFileName: installerName,
        installerSize: bytes.length,
        installerSha512: sha512(bytes)
      })
    ).toThrow(/absolute URL/);
  });
});

describe("isolated updater environment", () => {
  test("retains system launch values but strips signing and generic secrets", () => {
    const environment = buildIsolatedSmokeEnvironment(
      {
        Path: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
        NODE_ENV: "development",
        PWRSNAP_E2E: "1",
        PWRSNAP_DATA_ROOT: "C:\\real-data",
        AZURE_CLIENT_SECRET: "azure-secret",
        WIN_AZURE_SIGN_PROFILE: "profile",
        GITHUB_TOKEN: "github-secret",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.invalid",
        DATABASE_PASSWORD: "database-secret",
        KEEP_ME: "yes",
        PWRSNAP_TRACE: "1",
        ELECTRON_RUN_AS_NODE: "1"
      },
      {
        appDataDir: "C:\\isolated\\roaming",
        localAppDataDir: "C:\\isolated\\local",
        userProfileDir: "C:\\isolated\\profile",
        userDataDir: "C:\\isolated\\user-data",
        tempDir: "C:\\isolated\\temp",
        baselineVersion,
        targetVersion,
        runId: "7c8ae64b-e7f2-40c1-9c85-19d2cc127ad6",
        feedUrl: "http://127.0.0.1:49321/"
      }
    );

    expect(environment).toMatchObject({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      NODE_ENV: "production",
      PWRSNAP_UPDATE_SMOKE: "1",
      PWRSNAP_PROCESS_SPLIT: "0",
      PWRSNAP_USER_DATA: "C:\\isolated\\user-data"
    });
    for (const key of [
      "PWRSNAP_E2E",
      "PWRSNAP_DATA_ROOT",
      "AZURE_CLIENT_SECRET",
      "WIN_AZURE_SIGN_PROFILE",
      "GITHUB_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "DATABASE_PASSWORD",
      "KEEP_ME",
      "PWRSNAP_TRACE",
      "ELECTRON_RUN_AS_NODE",
      "PSModulePath"
    ]) {
      expect(environment).not.toHaveProperty(key);
    }
  });

  test.runIf(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true")(
    "loads the Authenticode command under the exact isolated PowerShell host",
    async () => {
      const isolatedRoot = tmpdir();
      const environment = buildIsolatedSmokeEnvironment(process.env, {
        appDataDir: isolatedRoot,
        localAppDataDir: isolatedRoot,
        userProfileDir: isolatedRoot,
        userDataDir: join(isolatedRoot, "pwrsnap-pwsh-probe-user-data"),
        tempDir: isolatedRoot,
        baselineVersion,
        targetVersion,
        runId: "7c8ae64b-e7f2-40c1-9c85-19d2cc127ad6",
        feedUrl: "http://127.0.0.1:49321/"
      });
      const evidence = await invokePowerShellJson({
        script: String.raw`
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:PWRSNAP_PROBE_PATH
[ordered]@{
  status = [string]$signature.Status
  commandSource = [string](Get-Command Get-AuthenticodeSignature).Source
} | ConvertTo-Json -Compress
`,
        environment: {
          ...environment,
          PWRSNAP_PROBE_PATH: process.execPath
        },
        timeoutMs: 30_000
      });

      expect(evidence).toEqual({
        status: expect.any(String),
        commandSource: "Microsoft.PowerShell.Security"
      });
    }
  );
});

describe("strict loopback update server", () => {
  test("allows only target GET/HEAD requests and the exact latest noCache query", () => {
    const common = {
      expectedHost: "127.0.0.1:4567",
      targetAssetNames: ["latest.yml", "target.exe", "target.exe.blockmap"],
      expectedBaselineBlockmapName: "baseline.exe.blockmap"
    };
    expect(
      classifyUpdateRequest({
        ...common,
        method: "GET",
        rawUrl: "/latest.yml?noCache=1j5o3av",
        host: common.expectedHost
      })
    ).toMatchObject({ allowed: true, assetName: "latest.yml" });
    expect(
      classifyUpdateRequest({
        ...common,
        method: "GET",
        rawUrl: "/target.exe?download=1",
        host: common.expectedHost
      })
    ).toMatchObject({ allowed: false, reason: "unexpected-query" });
    expect(
      classifyUpdateRequest({
        ...common,
        method: "GET",
        rawUrl: "/%2e%2e/target.exe",
        host: common.expectedHost
      })
    ).toMatchObject({ allowed: false, reason: "path-traversal" });
    expect(
      classifyUpdateRequest({
        ...common,
        method: "GET",
        rawUrl: "/target.exe",
        host: "localhost:4567"
      })
    ).toMatchObject({ allowed: false, reason: "unexpected-host" });
    expect(
      classifyUpdateRequest({
        ...common,
        method: "GET",
        rawUrl: "/baseline.exe.blockmap",
        host: common.expectedHost
      })
    ).toMatchObject({
      allowed: false,
      status: 404,
      reason: "expected-baseline-blockmap-miss"
    });
    expect(
      classifyUpdateRequest({
        ...common,
        method: "GET",
        rawUrl: "/baseline.exe.blockmap?unexpected=1",
        host: common.expectedHost
      })
    ).toMatchObject({ allowed: false, status: 400, reason: "unexpected-query" });
  });

  test("parses bounded single, suffix, and multi-range requests", () => {
    expect(parseByteRanges("bytes=2-5", 10)).toEqual([{ start: 2, end: 5 }]);
    expect(parseByteRanges("bytes=-3", 10)).toEqual([{ start: 7, end: 9 }]);
    expect(parseByteRanges("bytes=8-, 0-1", 10)).toEqual([
      { start: 8, end: 9 },
      { start: 0, end: 1 }
    ]);
    expect(() => parseByteRanges("bytes=10-12", 10)).toThrow(/unsatisfiable/);
    expect(() => parseByteRanges("items=0-2", 10)).toThrow(/byte ranges/);
  });

  test("serves target ranges, logs the expected old blockmap 404, and rejects bad Host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pwrsnap-feed-server-"));
    const targetInstallerName = `PwrSnap-${targetVersion}-windows-x64-setup.exe`;
    const baselineInstallerName = `PwrSnap-${baselineVersion}-windows-x64-setup.exe`;
    const targetInstaller = Buffer.from("0123456789abcdef");
    const blockmap = Buffer.from("blockmap");
    const yml = Buffer.from("latest");
    const transcriptPath = join(directory, "feed.ndjson");
    await Promise.all([
      writeFile(join(directory, targetInstallerName), targetInstaller),
      writeFile(join(directory, `${targetInstallerName}.blockmap`), blockmap),
      writeFile(join(directory, "latest.yml"), yml)
    ]);

    const server = await createIsolatedUpdateServer({
      assets: [
        {
          fileName: targetInstallerName,
          path: join(directory, targetInstallerName),
          size: targetInstaller.length
        },
        {
          fileName: `${targetInstallerName}.blockmap`,
          path: join(directory, `${targetInstallerName}.blockmap`),
          size: blockmap.length
        },
        { fileName: "latest.yml", path: join(directory, "latest.yml"), size: yml.length }
      ],
      transcriptPath,
      expectedBaselineBlockmapName: `${baselineInstallerName}.blockmap`
    });

    try {
      const latest = await httpCall(server.url, {
        path: "/latest.yml?noCache=1j5o3av"
      });
      expect(latest.status).toBe(200);
      expect(latest.body).toEqual(yml);

      const targetMap = await httpCall(server.url, {
        path: `/${targetInstallerName}.blockmap`
      });
      expect(targetMap.status).toBe(200);
      expect(targetMap.body).toEqual(blockmap);

      const oldMap = await httpCall(server.url, {
        path: `/${baselineInstallerName}.blockmap`
      });
      expect(oldMap.status).toBe(404);

      const range = await httpCall(server.url, {
        path: `/${targetInstallerName}`,
        headers: { Range: "bytes=2-5" }
      });
      expect(range.status).toBe(206);
      expect(range.headers["content-range"]).toBe("bytes 2-5/16");
      expect(range.body.toString()).toBe("2345");

      const multiRange = await httpCall(server.url, {
        path: `/${targetInstallerName}`,
        headers: { Range: "bytes=0-1, 14-15" }
      });
      expect(multiRange.status).toBe(206);
      expect(multiRange.headers["content-type"]).toMatch(/^multipart\/byteranges/);
      expect(multiRange.body.toString("ascii")).toContain("01");
      expect(multiRange.body.toString("ascii")).toContain("ef");

      const badHost = await httpCall(server.url, {
        path: "/latest.yml",
        headers: { Host: "localhost:1" }
      });
      expect(badHost.status).toBe(421);

      await server.flushTranscript();
      const recordsBeforeBadHost = server
        .snapshot()
        .filter((record) => record.reason !== "unexpected-host");
      expect(() =>
        validateUpdateServerEvidence(recordsBeforeBadHost, validManifest())
      ).not.toThrow();
      expect(() =>
        validateUpdateServerEvidence(server.snapshot(), validManifest())
      ).toThrow(/unexpected request/);
    } finally {
      await server.close();
      const transcript = (await readFile(transcriptPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(transcript.some((entry) => entry.reason === "expected-baseline-blockmap-miss")).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("durable result and bounded process validators", () => {
  test("keeps failure inventories bounded and never hashes large payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pwrsnap-inventory-"));
    try {
      await Promise.all([
        writeFile(join(directory, "small.log"), "diagnostic"),
        writeFile(join(directory, "downloaded-installer.exe"), Buffer.alloc(32))
      ]);
      const inventory = await collectBoundedDirectoryInventory(directory, {
        maxEntries: 10,
        maxHashBytes: 16
      });
      expect(inventory.truncated).toBe(false);
      expect(inventory.entries).toContainEqual(
        expect.objectContaining({
          path: "small.log",
          size: 10,
          sha256: sha256(Buffer.from("diagnostic")),
          hashOmitted: null
        })
      );
      expect(inventory.entries).toContainEqual(
        expect.objectContaining({
          path: "downloaded-installer.exe",
          size: 32,
          sha256: null,
          hashOmitted: "size-limit"
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("requires exact continuity, relaunch PID, target version, and data paths", () => {
    const userDataDir = resolve("/isolated/user-data");
    const nonce = "7c8ae64b-e7f2-40c1-9c85-19d2cc127ad6";
    const continuity = {
      schemaVersion: 1,
      kind: "pwrsnap-windows-update-smoke-continuity",
      runId: "run-1",
      baselineVersion,
      targetVersion,
      userDataDir,
      nonce,
      baselinePid: 101,
      createdAt: "2026-08-23T12:00:00.000Z"
    };
    const result = {
      schemaVersion: 1,
      kind: "pwrsnap-windows-update-smoke-result",
      status: "success",
      runId: "run-1",
      baselineVersion,
      targetVersion,
      currentVersion: targetVersion,
      relaunched: true,
      sentinel: {
        nonce,
        baselinePid: 101,
        createdAt: "2026-08-23T12:00:00.000Z"
      },
      markerCleared: true,
      userDataDir,
      dbPath: join(userDataDir, "pwrsnap.db"),
      pid: 202,
      completedAt: "2026-08-23T12:01:00.000Z"
    };
    expect(
      validateRuntimeEvidence({
        result,
        continuity,
        manifest: validManifest(),
        runId: "run-1",
        userDataDir,
        platform: process.platform
      })
    ).toEqual({ result, continuity });

    expect(() =>
      validateRuntimeEvidence({
        result: { ...result, pid: 101 },
        continuity,
        manifest: validManifest(),
        runId: "run-1",
        userDataDir,
        platform: process.platform
      })
    ).toThrow(/differ from the baseline/);
  });

  test("validates Authenticode status and exact publisher common name", () => {
    const evidence = {
      status: "Valid",
      subject: "CN=PwrDrvr LLC, O=PwrDrvr LLC, C=US",
      simpleName: EXPECTED_WINDOWS_PUBLISHER,
      thumbprint: "A".repeat(40)
    };
    expect(
      validateAuthenticodeEvidence(evidence, EXPECTED_WINDOWS_PUBLISHER)
    ).toEqual(evidence);
    expect(() =>
      validateAuthenticodeEvidence(
        { ...evidence, simpleName: "Not PwrDrvr LLC" },
        EXPECTED_WINDOWS_PUBLISHER
      )
    ).toThrow(/exactly PwrDrvr LLC/);
  });

  test("accepts electron-builder's exact FileVersion plus numeric ProductVersion", () => {
    expect(
      validateWindowsVersionEvidence(
        {
          fileVersion: targetVersion,
          productVersion: "1.1.0.0"
        },
        targetVersion
      )
    ).toEqual({
      fileVersion: targetVersion,
      productVersion: "1.1.0.0"
    });
    expect(() =>
      validateWindowsVersionEvidence(
        { fileVersion: baselineVersion, productVersion: "1.1.0.0" },
        targetVersion
      )
    ).toThrow(/FileVersion/);
  });

  test("terminates a child by its exact PID at the time bound", async () => {
    let terminatedPid;
    await expect(
      runBoundedProcess({
        command: process.execPath,
        arguments: [
          "-e",
          "process.stdout.write('before-timeout-out'); process.stderr.write('before-timeout-err'); setInterval(() => {}, 1000)"
        ],
        timeoutMs: 500,
        terminate: async (pid) => {
          terminatedPid = pid;
          process.kill(pid, "SIGKILL");
        }
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/timed out/),
      stdout: "before-timeout-out",
      stderr: "before-timeout-err"
    });
    expect(terminatedPid).toBeTypeOf("number");
    expect(terminatedPid).toBeGreaterThan(0);
  });

  test("parses the workflow CLI without defaults or extra flags", () => {
    const parsed = parseArguments([
      "--input-dir",
      "signed-input",
      "--diagnostics-dir",
      "diagnostics",
      "--expected-publisher",
      "PwrDrvr LLC"
    ]);
    expect(parsed).toEqual({
      inputDirectory: resolve("signed-input"),
      diagnosticsDirectory: resolve("diagnostics"),
      expectedPublisher: "PwrDrvr LLC"
    });
    expect(() => parseArguments(["--input-dir", "signed-input"])).toThrow(
      /Required updater smoke argument/
    );
    expect(() =>
      parseArguments([
        "--input-dir",
        "signed-input",
        "--diagnostics-dir",
        "diagnostics",
        "--expected-publisher",
        "PwrDrvr LLC",
        "--publish",
        "always"
      ])
    ).toThrow(/Unknown updater smoke argument/);
  });

  test("retains harness diagnostics when smoke-input.json is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwrsnap-missing-update-input-"));
    const inputDirectory = join(root, "missing-input");
    const diagnosticsDirectory = join(root, "diagnostics");
    try {
      await expect(
        runWindowsUpdateSmoke({
          inputDirectory,
          diagnosticsDirectory,
          expectedPublisher: EXPECTED_WINDOWS_PUBLISHER,
          platform: "win32",
          baseEnvironment: { RUNNER_TEMP: root }
        })
      ).rejects.toThrow(/smoke-input\.json/);
      const result = JSON.parse(
        await readFile(join(diagnosticsDirectory, "harness-result.json"), "utf8")
      );
      expect(result).toMatchObject({
        status: "failure",
        diagnosticsDirectory
      });
      expect(
        await readFile(join(diagnosticsDirectory, "harness-events.ndjson"), "utf8")
      ).toContain('"phase":"harness:failure"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
