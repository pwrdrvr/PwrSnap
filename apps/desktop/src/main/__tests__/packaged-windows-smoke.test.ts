import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PACKAGED_WINDOWS_SMOKE_ENV,
  PACKAGED_WINDOWS_SMOKE_REQUIRE_FFMPEG_ENV,
  PACKAGED_WINDOWS_SMOKE_REPORT_NAME,
  parseBundledWindowListEvidence,
  packagedRendererProbeSource,
  preflightPackagedWindowsSmokeRequest,
  probeSharpNativeModule,
  resolvePackagedWindowsSmokeConfig,
  runPackagedWindowsSmokeIfRequested,
  waitForPackagedRendererReadiness,
  type PackagedWindowsSmokeDependencies,
  type PackagedWindowsSmokeReport,
  type SharpSmokeEvidence
} from "../packaged-windows-smoke";

const sharpEvidence: SharpSmokeEvidence = {
  format: "png",
  width: 2,
  height: 2,
  channels: 4,
  encodedBytes: 97,
  sharpVersion: "0.35.3",
  vipsVersion: "8.17.3"
};

type TestLayout = {
  smokeRoot: string;
  userData: string;
  dataRoot: string;
  documents: string;
  databasePath: string;
  capturesRoot: string;
  appData: string;
  sessionData: string;
  logs: string;
  crashDumps: string;
  temp: string;
  mainLogPath: string;
  resourcesPath: string;
  reportPath: string;
  env: NodeJS.ProcessEnv;
};

async function makeLayout(): Promise<TestLayout> {
  const smokeRoot = await mkdtemp(join(tmpdir(), "pwrsnap-packaged-smoke-test-"));
  const userData = join(smokeRoot, "user-data");
  const dataRoot = join(smokeRoot, "data-root");
  const documents = join(userData, "Documents");
  const databasePath = join(dataRoot, "pwrsnap.db");
  const capturesRoot = join(dataRoot, "captures");
  const appData = join(smokeRoot, "profile", "AppData", "Roaming");
  const sessionData = join(userData, "session-data");
  const logs = join(appData, "PwrSnap", "logs");
  const crashDumps = join(smokeRoot, "temp", "PwrSnap Crashes");
  const temp = join(smokeRoot, "temp");
  const mainLogPath = join(logs, "main.log");
  const resourcesPath = join(smokeRoot, "install", "resources");
  return {
    smokeRoot,
    userData,
    dataRoot,
    documents,
    databasePath,
    capturesRoot,
    appData,
    sessionData,
    logs,
    crashDumps,
    temp,
    mainLogPath,
    resourcesPath,
    reportPath: join(userData, PACKAGED_WINDOWS_SMOKE_REPORT_NAME),
    env: {
      [PACKAGED_WINDOWS_SMOKE_ENV]: "1",
      [PACKAGED_WINDOWS_SMOKE_REQUIRE_FFMPEG_ENV]: "1",
      PWRSNAP_PACKAGED_WINDOWS_SMOKE_ROOT: smokeRoot,
      PWRSNAP_E2E: "1",
      PWRSNAP_E2E_SKIP_REGION_PREWARM: "1",
      PWRSNAP_USER_DATA: userData,
      PWRSNAP_DATA_ROOT: dataRoot,
      APPDATA: appData,
      LOCALAPPDATA: join(smokeRoot, "profile", "AppData", "Local"),
      USERPROFILE: join(smokeRoot, "profile"),
      HOME: join(smokeRoot, "profile"),
      TEMP: temp,
      TMP: temp
    }
  };
}

function readyRendererResult() {
  return {
    ready: true,
    readyState: "complete",
    stage: "library",
    title: "PwrSnap",
    rootMounted: true,
    libraryMounted: true,
    libraryUiState: "ready",
    libraryUiTotalLive: 0,
    brandVisible: true,
    preloadBridgeReady: true,
    libraryListOk: true,
    rowCount: 0,
    totalLive: 0,
    trashTotal: 0
  };
}

function makeDependencies(
  layout: TestLayout,
  overrides: Partial<PackagedWindowsSmokeDependencies> = {}
): PackagedWindowsSmokeDependencies {
  const executeJavaScript = vi.fn(async () => readyRendererResult());
  return {
    app: {
      isPackaged: true,
      getName: () => "PwrSnap",
      getVersion: () => "1.1.0-alpha.4",
      getPath: (name) => {
        if (name === "userData") return layout.userData;
        if (name === "home") return layout.userData;
        if (name === "documents") return layout.documents;
        if (name === "appData") return layout.appData;
        if (name === "sessionData") return layout.sessionData;
        if (name === "logs") return layout.logs;
        if (name === "crashDumps") return layout.crashDumps;
        return layout.temp;
      },
      quit: vi.fn()
    },
    env: layout.env,
    platform: "win32",
    arch: "x64",
    execPath: join(layout.smokeRoot, "install", "PwrSnap.exe"),
    electronVersion: "41.10.3",
    findMainLibraryWindow: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript
      }
    }),
    getDatabase: () => ({
      pragma: () => "ok",
      prepare: (source) => ({
        get: () => source.includes("sqlite_version") ? { sqliteVersion: "3.51.2" } : undefined,
        all: () => source === "PRAGMA database_list"
          ? [{ name: "main", file: layout.databasePath }]
          : []
      })
    }),
    getPaths: () => ({
      dataRoot: layout.dataRoot,
      databasePath: layout.databasePath,
      capturesRoot: layout.capturesRoot,
      mainLogPath: layout.mainLogPath
    }),
    getNativeModuleProvenance: () => ({
      resourcesPath: layout.resourcesPath,
      betterSqlite3PackagePath: join(
        layout.resourcesPath,
        "app.asar",
        "node_modules",
        "better-sqlite3",
        "package.json"
      ),
      betterSqlite3BindingPath: join(
        layout.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "better-sqlite3",
        "electron-native",
        "better_sqlite3.node"
      ),
      sharpPackagePath: join(
        layout.resourcesPath,
        "app.asar",
        "node_modules",
        "sharp",
        "package.json"
      ),
      sharpPlatformPackagePath: join(
        layout.resourcesPath,
        "app.asar",
        "node_modules",
        "@img",
        "sharp-win32-x64",
        "package.json"
      ),
      sharpBindingPath: join(
        layout.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@img",
        "sharp-win32-x64",
        "lib",
        "sharp-win32-x64.node"
      ),
      sharpLibvipsDllPaths: [
        join(
          layout.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "@img",
          "sharp-win32-x64",
          "lib",
          "libvips-42.dll"
        )
      ]
    }),
    logger: {
      info: vi.fn(),
      error: vi.fn()
    },
    probeSharp: vi.fn(async () => sharpEvidence),
    probeBundledWindowList: vi.fn(async () => ({
      executablePath: join(layout.resourcesPath, "PwrSnapWindowList.exe"),
      jsonEnvelope: true as const,
      ownWindowDetected: true as const,
      windowCount: 1,
      frontmostPid: 123,
      frontmostBundleId: join(layout.smokeRoot, "install", "PwrSnap.exe")
    })),
    probeBundledFfmpeg: vi.fn(async () => ({
      executablePath: join(layout.resourcesPath, "PwrSnapFFmpeg.exe"),
      versionLine: "ffmpeg version 8.1.1-pwrsnap",
      pngDecode: true as const
    })),
    rendererTimeoutMs: 100,
    rendererExecuteTimeoutMs: 50,
    rendererPollIntervalMs: 1,
    ...overrides
  };
}

describe("packaged Windows smoke", () => {
  let layout: TestLayout;

  beforeEach(async () => {
    layout = await makeLayout();
  });

  afterEach(async () => {
    await rm(layout.smokeRoot, { recursive: true, force: true });
  });

  test("is dormant unless explicitly requested", () => {
    const dependencies = makeDependencies(layout, {
      env: { ...layout.env, [PACKAGED_WINDOWS_SMOKE_ENV]: undefined }
    });

    expect(resolvePackagedWindowsSmokeConfig(dependencies)).toBeNull();
  });

  test.each([
    {
      name: "an unpackaged executable",
      mutate: (dependencies: PackagedWindowsSmokeDependencies) => {
        dependencies.app.isPackaged = false;
      },
      message: /unpackaged/
    },
    {
      name: "a non-Windows platform",
      mutate: (dependencies: PackagedWindowsSmokeDependencies) => {
        dependencies.platform = "darwin";
      },
      message: /non-Windows/
    },
    {
      name: "missing E2E isolation",
      mutate: (dependencies: PackagedWindowsSmokeDependencies) => {
        dependencies.env = { ...dependencies.env, PWRSNAP_E2E: undefined };
      },
      message: /PWRSNAP_E2E=1/
    },
    {
      name: "an invalid FFmpeg requirement flag",
      mutate: (dependencies: PackagedWindowsSmokeDependencies) => {
        dependencies.env = {
          ...dependencies.env,
          [PACKAGED_WINDOWS_SMOKE_REQUIRE_FFMPEG_ENV]: "true"
        };
      },
      message: /must be unset or exactly 1/
    },
    {
      name: "a data root outside the smoke root",
      mutate: (dependencies: PackagedWindowsSmokeDependencies) => {
        dependencies.env = { ...dependencies.env, PWRSNAP_DATA_ROOT: tmpdir() };
        dependencies.getPaths = () => ({
          dataRoot: tmpdir(),
          databasePath: join(tmpdir(), "pwrsnap.db"),
          capturesRoot: join(tmpdir(), "captures"),
          mainLogPath: join(tmpdir(), "main.log")
        });
      },
      message: /PWRSNAP_DATA_ROOT must stay within/
    },
    {
      name: "a userData mismatch",
      mutate: (dependencies: PackagedWindowsSmokeDependencies) => {
        dependencies.env = {
          ...dependencies.env,
          PWRSNAP_USER_DATA: join(layout.smokeRoot, "different-user-data")
        };
      },
      message: /does not match PWRSNAP_USER_DATA/
    },
    {
      name: "an Electron writable root outside the smoke root",
      mutate: (dependencies: PackagedWindowsSmokeDependencies) => {
        const getPath = dependencies.app.getPath;
        dependencies.app.getPath = (name) =>
          name === "crashDumps" ? join(tmpdir(), "PwrSnap Crashes") : getPath(name);
      },
      message: /Electron crashDumps must stay within/
    },
    {
      name: "a main log outside the smoke root",
      mutate: (dependencies: PackagedWindowsSmokeDependencies) => {
        dependencies.getPaths = () => ({
          dataRoot: layout.dataRoot,
          databasePath: layout.databasePath,
          capturesRoot: layout.capturesRoot,
          mainLogPath: join(tmpdir(), "main.log")
        });
      },
      message: /main log path must stay within/
    }
  ])("fails closed for $name", ({ mutate, message }) => {
    const dependencies = makeDependencies(layout);
    mutate(dependencies);
    expect(() => resolvePackagedWindowsSmokeConfig(dependencies)).toThrow(message);
  });

  test("rejects an unsafe request in the pure preflight before runtime paths are read", () => {
    const dependencies = makeDependencies(layout, {
      env: { ...layout.env, PWRSNAP_DATA_ROOT: tmpdir() },
      getPaths: vi.fn(() => {
        throw new Error("runtime paths must not be read");
      })
    });

    expect(() => preflightPackagedWindowsSmokeRequest(dependencies)).toThrow(
      /PWRSNAP_DATA_ROOT must stay within/
    );
    expect(dependencies.getPaths).not.toHaveBeenCalled();
  });

  test("renderer probe requires React, visible brand, preload, and a fresh library IPC read", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce({
        ready: false,
        readyState: "complete",
        stage: "library",
        rootMounted: true,
        libraryMounted: false,
        reason: "renderer_not_committed"
      })
      .mockResolvedValueOnce(readyRendererResult());
    const window = {
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript
      }
    };

    await expect(
      waitForPackagedRendererReadiness(window, {
        timeoutMs: 100,
        executeTimeoutMs: 50,
        pollIntervalMs: 1
      })
    ).resolves.toEqual({
      readyState: "complete",
      stage: "library",
      title: "PwrSnap",
      rootMounted: true,
      libraryMounted: true,
      libraryUiState: "ready",
      libraryUiTotalLive: 0,
      brandVisible: true,
      preloadBridgeReady: true,
      libraryListOk: true,
      rowCount: 0,
      totalLive: 0,
      trashTotal: 0,
      windowVisible: true
    });

    const source = packagedRendererProbeSource();
    expect(source).toContain('#root .app-shell .psl');
    expect(source).toContain("dataset.libraryReadiness");
    expect(source).toContain('svg[aria-label="PwrSnap"]');
    expect(source).toContain('window.pwrsnapApi.dispatch("library:list"');
    expect(source).toContain("rowCount === 0 && totalLive === 0 && trashTotal === 0");
  });

  test("executes the renderer probe and refuses a mounted Library whose own load failed", async () => {
    const source = packagedRendererProbeSource();
    const library = {
      dataset: { libraryReadiness: "ready", libraryTotalLive: "0" }
    };
    const brand = {
      getBoundingClientRect: () => ({ width: 120, height: 24 })
    };
    const dispatch = vi.fn(async () => ({
      ok: true,
      value: { rows: [], totalLive: 0, trashTotal: 0 }
    }));
    const document = {
      readyState: "complete",
      title: "PwrSnap",
      body: { dataset: { stage: "library" } },
      querySelector: (selector: string) => {
        if (selector === "#root .app-shell") return {};
        if (selector === "#root .app-shell .psl") return library;
        if (selector === 'svg[aria-label="PwrSnap"]') return brand;
        return null;
      }
    };
    const evaluate = new Function(
      "document",
      "window",
      "requestAnimationFrame",
      "getComputedStyle",
      `return ${source};`
    ) as (
      documentArg: unknown,
      windowArg: unknown,
      requestAnimationFrameArg: (callback: () => void) => void,
      getComputedStyleArg: () => Record<string, string>
    ) => Promise<{ ready: boolean; reason?: string }>;
    const runProbe = () =>
      evaluate(
        document,
        { pwrsnapApi: { dispatch } },
        (callback) => callback(),
        () => ({ display: "block", visibility: "visible", opacity: "1" })
      );

    await expect(runProbe()).resolves.toMatchObject({
      ready: true,
      libraryUiState: "ready",
      libraryUiTotalLive: 0
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    library.dataset.libraryReadiness = "error";
    await expect(runProbe()).resolves.toMatchObject({
      ready: false,
      reason: "renderer_not_committed",
      libraryUiState: "error"
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("performs a real Sharp native encode and decode", async () => {
    await expect(probeSharpNativeModule()).resolves.toMatchObject({
      format: "png",
      width: 2,
      height: 2,
      channels: 4
    });
  });

  test("accepts window-list evidence only when the helper finds this installed window", () => {
    const installedExe = join(layout.smokeRoot, "install", "PwrSnap.exe");
    const output = JSON.stringify({
      windows: [
        { pid: 1234, bundleId: installedExe, title: "PwrSnap", bounds: {} }
      ],
      frontmostPid: 1234,
      frontmostBundleId: installedExe
    });

    expect(parseBundledWindowListEvidence(output, installedExe, 1234)).toEqual({
      jsonEnvelope: true,
      ownWindowDetected: true,
      windowCount: 1,
      frontmostPid: 1234,
      frontmostBundleId: installedExe
    });
    expect(() => parseBundledWindowListEvidence(output, installedExe, 9999)).toThrow(
      /did not enumerate the installed PwrSnap window/
    );
  });

  test("resolves Sharp's optional Windows slice from Sharp's package context", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "packaged-windows-smoke.ts"), "utf8");
    expect(source).toContain("const sharpRequire = createRequire(sharpEntryPath)");
    expect(source).toContain('sharpRequire.resolve("@img/sharp-win32-x64/package")');
  });

  test("writes complete causal evidence before requesting a graceful quit", async () => {
    const dependencies = makeDependencies(layout);
    const quit = vi.fn(() => {
      expect(existsSync(layout.reportPath)).toBe(true);
    });
    dependencies.app.quit = quit;

    await expect(runPackagedWindowsSmokeIfRequested(dependencies)).resolves.toBe(true);

    const report = JSON.parse(
      await readFile(layout.reportPath, "utf8")
    ) as PackagedWindowsSmokeReport;
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "ready",
      app: {
        name: "PwrSnap",
        version: "1.1.0-alpha.4",
        electronVersion: "41.10.3",
        isPackaged: true,
        platform: "win32",
        arch: "x64"
      },
      main: { bootstrapComplete: true },
      renderer: {
        readyState: "complete",
        stage: "library",
        title: "PwrSnap",
        rootMounted: true,
        libraryMounted: true,
        libraryUiState: "ready",
        libraryUiTotalLive: 0,
        brandVisible: true,
        preloadBridgeReady: true,
        libraryListOk: true,
        rowCount: 0,
        totalLive: 0,
        trashTotal: 0,
        windowVisible: true
      },
      nativeModules: {
        resourcesPath: layout.resourcesPath,
        betterSqlite3: {
          quickCheck: "ok",
          sqliteVersion: "3.51.2",
          databasePath: layout.databasePath
        },
        sharp: sharpEvidence
      },
      bundledHelpers: {
        windowList: {
          executablePath: join(layout.resourcesPath, "PwrSnapWindowList.exe"),
          jsonEnvelope: true,
          ownWindowDetected: true,
          windowCount: 1
        },
        ffmpeg: {
          required: true,
          executed: true,
          executablePath: join(layout.resourcesPath, "PwrSnapFFmpeg.exe"),
          versionLine: "ffmpeg version 8.1.1-pwrsnap",
          pngDecode: true
        }
      }
    });
    expect(report.isolation).toMatchObject({
      smokeRoot: layout.smokeRoot,
      userData: layout.userData,
      dataRoot: layout.dataRoot,
      databasePath: layout.databasePath,
      capturesRoot: layout.capturesRoot,
      appData: layout.appData,
      sessionData: layout.sessionData,
      logs: layout.logs,
      crashDumps: layout.crashDumps,
      temp: layout.temp,
      mainLogPath: layout.mainLogPath,
      reportPath: layout.reportPath,
      e2e: true,
      regionPrewarmSkipped: true
    });
    expect(dependencies.probeSharp).toHaveBeenCalledTimes(1);
    expect(dependencies.probeBundledWindowList).toHaveBeenCalledTimes(1);
    expect(dependencies.probeBundledFfmpeg).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect((await readdir(layout.userData)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("always exercises window-list but permits preview artifacts without bundled FFmpeg", async () => {
    const probeBundledFfmpeg = vi.fn();
    const dependencies = makeDependencies(layout, {
      env: {
        ...layout.env,
        [PACKAGED_WINDOWS_SMOKE_REQUIRE_FFMPEG_ENV]: undefined
      },
      probeBundledFfmpeg
    });

    await expect(runPackagedWindowsSmokeIfRequested(dependencies)).resolves.toBe(true);

    const report = JSON.parse(
      await readFile(layout.reportPath, "utf8")
    ) as PackagedWindowsSmokeReport;
    expect(report.bundledHelpers.ffmpeg).toEqual({ required: false, executed: false });
    expect(dependencies.probeBundledWindowList).toHaveBeenCalledTimes(1);
    expect(probeBundledFfmpeg).not.toHaveBeenCalled();
  });

  test("records a causal bundled-helper failure phase", async () => {
    const dependencies = makeDependencies(layout, {
      probeBundledFfmpeg: vi.fn(async () => {
        throw new Error("bundled FFmpeg could not decode PNG");
      })
    });

    await expect(runPackagedWindowsSmokeIfRequested(dependencies)).resolves.toBe(true);

    const report = JSON.parse(await readFile(layout.reportPath, "utf8")) as {
      status: string;
      phase: string;
      error: { message: string };
    };
    expect(report).toMatchObject({
      status: "failed",
      phase: "helper:ffmpeg",
      error: { message: "bundled FFmpeg could not decode PNG" }
    });
    expect(dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  test("records a bounded failure and still exits through app.quit", async () => {
    const dependencies = makeDependencies(layout, {
      probeSharp: vi.fn(async () => {
        throw new Error(`missing libvips ${"x".repeat(2_000)}`);
      })
    });

    await expect(runPackagedWindowsSmokeIfRequested(dependencies)).resolves.toBe(true);

    const report = JSON.parse(await readFile(layout.reportPath, "utf8")) as {
      status: string;
      phase: string;
      error: { message: string };
    };
    expect(report.status).toBe("failed");
    expect(report.phase).toBe("native:sharp");
    expect(report.error.message).toContain("missing libvips");
    expect(report.error.message.length).toBeLessThanOrEqual(1_000);
    expect(dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  test("rejects a live SQLite handle opened outside the isolated data root", async () => {
    const dependencies = makeDependencies(layout, {
      getDatabase: () => ({
        pragma: () => "ok",
        prepare: (source) => ({
          get: () => source.includes("sqlite_version")
            ? { sqliteVersion: "3.51.2" }
            : undefined,
          all: () => source === "PRAGMA database_list"
            ? [{ name: "main", file: join(tmpdir(), "pwrsnap.db") }]
            : []
        })
      })
    });

    await expect(runPackagedWindowsSmokeIfRequested(dependencies)).resolves.toBe(true);
    const report = JSON.parse(await readFile(layout.reportPath, "utf8")) as {
      status: string;
      phase: string;
      error: { message: string };
    };
    expect(report).toMatchObject({
      status: "failed",
      phase: "native:better-sqlite3",
      error: { message: expect.stringContaining("does not use the isolated database path") }
    });
    expect(dependencies.app.quit).toHaveBeenCalledTimes(1);
  });
});
