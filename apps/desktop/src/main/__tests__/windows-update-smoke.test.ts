import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppUpdateCheckResult } from "@pwrsnap/shared";
import {
  WINDOWS_UPDATE_SMOKE_BUILD_MARKER,
  WINDOWS_UPDATE_SMOKE_CONTINUITY_FILE,
  WINDOWS_UPDATE_SMOKE_RESULT_FILE,
  WINDOWS_UPDATE_SMOKE_STATE_DIR,
  readWindowsUpdateSmokeConfig,
  runWindowsUpdateSmoke,
  type WindowsUpdateSmokeConfig
} from "../windows-update-smoke";

const tempDirs: string[] = [];
const baselineVersion = "1.1.0-update-smoke.42.1";
const targetVersion = "1.1.0-update-smoke.42.2";

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pwrsnap-update-smoke-test-"));
  tempDirs.push(path);
  return path;
}

async function resourcesWithMarker(version = baselineVersion): Promise<string> {
  const resourcesPath = await tempDir();
  await writeFile(
    join(resourcesPath, WINDOWS_UPDATE_SMOKE_BUILD_MARKER),
    JSON.stringify({
      schemaVersion: 1,
      kind: "pwrsnap-windows-update-smoke",
      version
    }),
    "utf8"
  );
  return resourcesPath;
}

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PWRSNAP_UPDATE_SMOKE: "1",
    PWRSNAP_UPDATE_SMOKE_BASELINE_VERSION: baselineVersion,
    PWRSNAP_UPDATE_SMOKE_TARGET_VERSION: targetVersion,
    PWRSNAP_UPDATE_SMOKE_RUN_ID: "gha-42.1",
    PWRSNAP_UPDATE_SMOKE_FEED_URL: "http://127.0.0.1:43123/",
    PWRSNAP_USER_DATA: "D:\\pwrsnap-smoke\\gha-42.1\\user-data",
    PWRSNAP_PROCESS_SPLIT: "0",
    ...overrides
  };
}

function runtimeConfig(userDataDir: string, currentVersion: string): WindowsUpdateSmokeConfig {
  return {
    baselineVersion,
    targetVersion,
    currentVersion,
    feedUrl: "http://127.0.0.1:43123/",
    runId: "gha-42.1",
    userDataDir
  };
}

function dependencies(config: WindowsUpdateSmokeConfig) {
  const checkForUpdates = vi.fn<() => Promise<AppUpdateCheckResult>>();
  checkForUpdates.mockResolvedValue({ status: "downloaded", version: targetVersion });
  return {
    config,
    checkForUpdates,
    readUpdateStatus: vi.fn(() => ({
      status: "downloaded" as const,
      version: targetVersion
    })),
    installDownloadedUpdate: vi.fn(async () => ({ status: "restarting" as const })),
    exit: vi.fn(),
    logger: { info: vi.fn(), error: vi.fn() },
    now: () => new Date("2026-08-23T12:00:00.000Z"),
    pid: config.currentVersion === baselineVersion ? 101 : 202,
    randomNonce: () => "continuity-nonce",
    sleep: vi.fn(async () => undefined),
    statusPollMs: 0,
    downloadTimeoutMs: 100
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("readWindowsUpdateSmokeConfig", () => {
  test("leaves an ordinary unmarked build unchanged when smoke is not requested", async () => {
    expect(
      readWindowsUpdateSmokeConfig({
        appVersion: "1.1.0-alpha.4",
        env: {},
        isPackaged: true,
        platform: "win32",
        resourcesPath: await tempDir()
      })
    ).toBeNull();
  });

  test("fails closed when a marker-bearing build is launched without smoke env", async () => {
    const resourcesPath = await resourcesWithMarker();
    expect(() =>
      readWindowsUpdateSmokeConfig({
        appVersion: baselineVersion,
        env: {},
        isPackaged: true,
        platform: "win32",
        resourcesPath
      })
    ).toThrow(/marker-bearing smoke build requires/);
  });

  test("fails closed when smoke env is applied to an unmarked normal build", async () => {
    const resourcesPath = await tempDir();
    expect(() =>
      readWindowsUpdateSmokeConfig({
        appVersion: baselineVersion,
        env: validEnv(),
        isPackaged: true,
        platform: "win32",
        resourcesPath
      })
    ).toThrow(/signed build marker is missing/);
  });

  test("accepts only a packaged Windows marker for the exact running version", async () => {
    const resourcesPath = await resourcesWithMarker();
    expect(
      readWindowsUpdateSmokeConfig({
        appVersion: baselineVersion,
        env: validEnv(),
        isPackaged: true,
        platform: "win32",
        resourcesPath
      })
    ).toMatchObject({
      baselineVersion,
      currentVersion: baselineVersion,
      targetVersion,
      feedUrl: "http://127.0.0.1:43123/"
    });
  });

  test.each([
    "https://127.0.0.1:43123/",
    "http://localhost:43123/",
    "http://[::1]:43123/",
    "http://127.0.0.1/",
    "http://127.0.0.1:0/",
    "http://127.0.0.1:65536/",
    "http://127.0.0.1:43123/feed/",
    "http://127.0.0.1:43123/?token=no",
    "http://user:pass@127.0.0.1:43123/",
    "http://127.0.0.1:43123/#feed"
  ])("rejects non-canonical or credential-bearing feed %s", async (feedUrl) => {
    const resourcesPath = await resourcesWithMarker();
    expect(() =>
      readWindowsUpdateSmokeConfig({
        appVersion: baselineVersion,
        env: validEnv({ PWRSNAP_UPDATE_SMOKE_FEED_URL: feedUrl }),
        isPackaged: true,
        platform: "win32",
        resourcesPath
      })
    ).toThrow(/feed must be exactly/);
  });

  test("rejects dev, E2E, process-split, and non-isolated roots", async () => {
    const resourcesPath = await resourcesWithMarker();
    for (const env of [
      validEnv({ NODE_ENV: "development" }),
      validEnv({ PWRSNAP_E2E: "1" }),
      validEnv({ PWRSNAP_PROCESS_SPLIT: "1" }),
      validEnv({ PWRSNAP_DATA_ROOT: "D:\\not-user-data" }),
      validEnv({ PWRSNAP_USER_DATA: "D:\\" })
    ]) {
      expect(() =>
        readWindowsUpdateSmokeConfig({
          appVersion: baselineVersion,
          env,
          isPackaged: true,
          platform: "win32",
          resourcesPath
        })
      ).toThrow(/Windows updater smoke configuration rejected/);
    }
  });

  test.each([
    "01.1.0-update-smoke.42.1",
    "9007199254740992.1.0-update-smoke.42.1",
    "1.1.0-update-smoke.9007199254740992.1"
  ])("rejects non-canonical or unsafe SemVer identifiers in %s", async (version) => {
    const resourcesPath = await resourcesWithMarker(version);
    expect(() =>
      readWindowsUpdateSmokeConfig({
        appVersion: version,
        env: validEnv({ PWRSNAP_UPDATE_SMOKE_BASELINE_VERSION: version }),
        isPackaged: true,
        platform: "win32",
        resourcesPath
      })
    ).toThrow(/synthetic x\.y\.z-update-smoke/);
  });
});

describe("runWindowsUpdateSmoke", () => {
  test("writes a baseline sentinel and requests only the downloaded target install", async () => {
    const userDataDir = await tempDir();
    await writeFile(join(userDataDir, "pwrsnap.db"), "db", "utf8");
    const deps = dependencies(runtimeConfig(userDataDir, baselineVersion));

    await runWindowsUpdateSmoke(deps);

    expect(deps.checkForUpdates).toHaveBeenCalledOnce();
    expect(deps.installDownloadedUpdate).toHaveBeenCalledOnce();
    expect(deps.exit).not.toHaveBeenCalled();
    const continuity = JSON.parse(
      await readFile(
        join(userDataDir, WINDOWS_UPDATE_SMOKE_STATE_DIR, WINDOWS_UPDATE_SMOKE_CONTINUITY_FILE),
        "utf8"
      )
    );
    expect(continuity).toMatchObject({
      schemaVersion: 1,
      kind: "pwrsnap-windows-update-smoke-continuity",
      runId: "gha-42.1",
      baselineVersion,
      targetVersion,
      userDataDir,
      nonce: "continuity-nonce",
      baselinePid: 101
    });
  });

  test("target relaunch proves version, userData, DB, sentinel, and cleared attempt marker", async () => {
    const userDataDir = await tempDir();
    await writeFile(join(userDataDir, "pwrsnap.db"), "db", "utf8");
    const baseline = dependencies(runtimeConfig(userDataDir, baselineVersion));
    await runWindowsUpdateSmoke(baseline);

    const target = dependencies(runtimeConfig(userDataDir, targetVersion));
    await runWindowsUpdateSmoke(target);

    expect(target.checkForUpdates).not.toHaveBeenCalled();
    expect(target.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(target.exit).toHaveBeenCalledWith(0);
    const result = JSON.parse(
      await readFile(
        join(userDataDir, WINDOWS_UPDATE_SMOKE_STATE_DIR, WINDOWS_UPDATE_SMOKE_RESULT_FILE),
        "utf8"
      )
    );
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "pwrsnap-windows-update-smoke-result",
      status: "success",
      runId: "gha-42.1",
      baselineVersion,
      targetVersion,
      currentVersion: targetVersion,
      relaunched: true,
      markerCleared: true,
      userDataDir,
      pid: 202,
      sentinel: {
        nonce: "continuity-nonce",
        baselinePid: 101
      }
    });
  });

  test("unexpected feed selection writes a durable failure and exits nonzero", async () => {
    const userDataDir = await tempDir();
    await writeFile(join(userDataDir, "pwrsnap.db"), "db", "utf8");
    const deps = dependencies(runtimeConfig(userDataDir, baselineVersion));
    deps.checkForUpdates.mockResolvedValue({ status: "available", version: "9.9.9" });

    await runWindowsUpdateSmoke(deps);

    expect(deps.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(1);
    const result = JSON.parse(
      await readFile(
        join(userDataDir, WINDOWS_UPDATE_SMOKE_STATE_DIR, WINDOWS_UPDATE_SMOKE_RESULT_FILE),
        "utf8"
      )
    );
    expect(result).toMatchObject({
      status: "failure",
      phase: "baseline",
      currentVersion: baselineVersion
    });
    expect(result.error).toMatch(/did not select exact target/);
  });

  test("target refuses success while the install-attempt marker remains", async () => {
    const userDataDir = await tempDir();
    await writeFile(join(userDataDir, "pwrsnap.db"), "db", "utf8");
    await runWindowsUpdateSmoke(dependencies(runtimeConfig(userDataDir, baselineVersion)));
    await writeFile(join(userDataDir, "pwrsnap-update-install-attempt.json"), "{}", "utf8");
    const target = dependencies(runtimeConfig(userDataDir, targetVersion));

    await runWindowsUpdateSmoke(target);

    expect(target.exit).toHaveBeenCalledWith(1);
    const result = JSON.parse(
      await readFile(
        join(userDataDir, WINDOWS_UPDATE_SMOKE_STATE_DIR, WINDOWS_UPDATE_SMOKE_RESULT_FILE),
        "utf8"
      )
    );
    expect(result).toMatchObject({ status: "failure", phase: "target", markerCleared: false });
  });
});
