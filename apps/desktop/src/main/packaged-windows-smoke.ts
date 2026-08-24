import { existsSync, readdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PACKAGED_WINDOWS_SMOKE_ENV = "PWRSNAP_PACKAGED_WINDOWS_SMOKE";
export const PACKAGED_WINDOWS_SMOKE_REPORT_NAME = "packaged-windows-smoke.json";

const DEFAULT_RENDERER_TIMEOUT_MS = 45_000;
const DEFAULT_RENDERER_EXECUTE_TIMEOUT_MS = 10_000;
const DEFAULT_RENDERER_POLL_INTERVAL_MS = 250;
const FAILURE_MESSAGE_LIMIT = 1_000;

type SmokeLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

type SmokeApp = {
  isPackaged: boolean;
  getName(): string;
  getVersion(): string;
  getPath(
    name:
      | "userData"
      | "home"
      | "documents"
      | "appData"
      | "sessionData"
      | "logs"
      | "crashDumps"
      | "temp"
  ): string;
  quit(): void;
};

type SmokeWebContents = {
  isDestroyed(): boolean;
  executeJavaScript(source: string): Promise<unknown>;
};

type SmokeWindow = {
  isDestroyed(): boolean;
  isVisible(): boolean;
  webContents: SmokeWebContents;
};

type SmokeDatabase = {
  pragma(source: string, options: { simple: true }): unknown;
  prepare(source: string): {
    get(): unknown;
    all(): unknown[];
  };
};

export type SharpSmokeEvidence = {
  format: "png";
  width: 2;
  height: 2;
  channels: 4;
  encodedBytes: number;
  sharpVersion: string;
  vipsVersion: string;
};

type SmokePaths = {
  dataRoot: string;
  databasePath: string;
  capturesRoot: string;
  mainLogPath: string | undefined;
};

export type NativeModuleProvenance = {
  resourcesPath: string;
  betterSqlite3PackagePath: string;
  betterSqlite3BindingPath: string;
  sharpPackagePath: string;
  sharpPlatformPackagePath: string;
  sharpBindingPath: string;
  sharpLibvipsDllPaths: string[];
};

export type PackagedWindowsSmokeDependencies = {
  app: SmokeApp;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  electronVersion: string;
  findMainLibraryWindow(): SmokeWindow | null;
  getDatabase(): SmokeDatabase;
  getPaths(): SmokePaths;
  getNativeModuleProvenance(): NativeModuleProvenance;
  logger: SmokeLogger;
  probeSharp?: () => Promise<SharpSmokeEvidence>;
  rendererTimeoutMs?: number;
  rendererExecuteTimeoutMs?: number;
  rendererPollIntervalMs?: number;
};

type ProfileEnvironment = {
  APPDATA: string;
  LOCALAPPDATA: string;
  USERPROFILE: string;
  HOME: string;
  TEMP: string;
  TMP: string;
};

export type PackagedWindowsSmokePreflight = {
  smokeRoot: string;
  expectedUserData: string;
  expectedDataRoot: string;
  profileEnvironment: ProfileEnvironment;
};

export type PackagedWindowsSmokeConfig = {
  smokeRoot: string;
  userData: string;
  dataRoot: string;
  home: string;
  documents: string;
  appData: string;
  sessionData: string;
  logs: string;
  crashDumps: string;
  temp: string;
  databasePath: string;
  capturesRoot: string;
  mainLogPath: string;
  reportPath: string;
  profileEnvironment: ProfileEnvironment;
};

export type RendererSmokeEvidence = {
  readyState: "complete";
  stage: "library";
  title: "PwrSnap";
  rootMounted: true;
  libraryMounted: true;
  libraryUiState: "ready";
  libraryUiTotalLive: 0;
  brandVisible: true;
  preloadBridgeReady: true;
  libraryListOk: true;
  rowCount: 0;
  totalLive: 0;
  trashTotal: 0;
  windowVisible: true;
};

type RendererProbeResult = {
  ready: boolean;
  readyState?: string;
  stage?: string;
  title?: string;
  rootMounted?: boolean;
  libraryMounted?: boolean;
  libraryUiState?: string;
  libraryUiTotalLive?: number;
  brandVisible?: boolean;
  preloadBridgeReady?: boolean;
  libraryListOk?: boolean;
  rowCount?: number;
  totalLive?: number;
  trashTotal?: number;
  reason?: string;
};

export type PackagedWindowsSmokeReport = {
  schemaVersion: 1;
  status: "ready";
  app: {
    name: string;
    version: string;
    electronVersion: string;
    isPackaged: true;
    platform: "win32";
    arch: string;
    execPath: string;
  };
  isolation: PackagedWindowsSmokeConfig & {
    e2e: true;
    regionPrewarmSkipped: true;
  };
  main: {
    bootstrapComplete: true;
  };
  renderer: RendererSmokeEvidence;
  nativeModules: {
    resourcesPath: string;
    betterSqlite3: {
      quickCheck: "ok";
      sqliteVersion: string;
      databasePath: string;
      packagePath: string;
      bindingPath: string;
    };
    sharp: SharpSmokeEvidence & {
      packagePath: string;
      platformPackagePath: string;
      bindingPath: string;
      libvipsDllPaths: string[];
    };
  };
};

type FailedSmokeReport = {
  schemaVersion: 1;
  status: "failed";
  phase: string;
  error: {
    message: string;
  };
};

function samePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US");
}

function pathIsWithin(parent: string, candidate: string, allowEqual = false): boolean {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  if (samePath(parentPath, candidatePath)) return allowEqual;
  const rel = relative(parentPath, candidatePath);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function requireAbsolutePath(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${label} must be set for the packaged Windows smoke`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function requirePathWithin(
  parent: string,
  candidate: string,
  label: string,
  allowEqual = false
): void {
  if (!pathIsWithin(parent, candidate, allowEqual)) {
    throw new Error(`${label} must stay within the isolated smoke root`);
  }
}

export function preflightPackagedWindowsSmokeRequest(
  dependencies: {
    app: Pick<SmokeApp, "isPackaged">;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }
): PackagedWindowsSmokePreflight | null {
  const { app, env, platform } = dependencies;
  if (env[PACKAGED_WINDOWS_SMOKE_ENV] !== "1") return null;

  if (platform !== "win32") {
    throw new Error("packaged Windows smoke was requested on a non-Windows platform");
  }
  if (!app.isPackaged) {
    throw new Error("packaged Windows smoke refuses to run an unpackaged application");
  }
  if (env.PWRSNAP_E2E !== "1") {
    throw new Error("packaged Windows smoke requires PWRSNAP_E2E=1");
  }
  if (env.PWRSNAP_E2E_SKIP_REGION_PREWARM !== "1") {
    throw new Error("packaged Windows smoke requires region pre-warm to be disabled");
  }
  if (env.ELECTRON_RENDERER_URL !== undefined && env.ELECTRON_RENDERER_URL.length > 0) {
    throw new Error("packaged Windows smoke refuses a development renderer URL");
  }

  const smokeRoot = requireAbsolutePath(env.PWRSNAP_PACKAGED_WINDOWS_SMOKE_ROOT, "smoke root");
  const expectedUserData = requireAbsolutePath(env.PWRSNAP_USER_DATA, "PWRSNAP_USER_DATA");
  const expectedDataRoot = requireAbsolutePath(env.PWRSNAP_DATA_ROOT, "PWRSNAP_DATA_ROOT");
  if (samePath(expectedUserData, expectedDataRoot)) {
    throw new Error("packaged Windows smoke requires distinct userData and data roots");
  }
  requirePathWithin(smokeRoot, expectedUserData, "PWRSNAP_USER_DATA");
  requirePathWithin(smokeRoot, expectedDataRoot, "PWRSNAP_DATA_ROOT");

  const profileEnvironment = Object.fromEntries(
    ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"].map((name) => {
      const path = requireAbsolutePath(env[name], name);
      requirePathWithin(smokeRoot, path, name);
      return [name, path];
    })
  ) as ProfileEnvironment;

  return { smokeRoot, expectedUserData, expectedDataRoot, profileEnvironment };
}

export function resolvePackagedWindowsSmokeConfig(
  dependencies: Pick<
    PackagedWindowsSmokeDependencies,
    "app" | "env" | "platform" | "getPaths"
  >
): PackagedWindowsSmokeConfig | null {
  const { app } = dependencies;
  const preflight = preflightPackagedWindowsSmokeRequest(dependencies);
  if (preflight === null) return null;

  const { smokeRoot, expectedUserData, expectedDataRoot, profileEnvironment } = preflight;
  const userData = resolve(app.getPath("userData"));
  const home = resolve(app.getPath("home"));
  const documents = resolve(app.getPath("documents"));
  const appData = resolve(app.getPath("appData"));
  const sessionData = resolve(app.getPath("sessionData"));
  const logs = resolve(app.getPath("logs"));
  const crashDumps = resolve(app.getPath("crashDumps"));
  const temp = resolve(app.getPath("temp"));
  const { dataRoot, databasePath, capturesRoot, mainLogPath } = dependencies.getPaths();
  const resolvedDataRoot = resolve(dataRoot);
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedCapturesRoot = resolve(capturesRoot);
  const resolvedMainLogPath = requireAbsolutePath(mainLogPath, "main log path");

  if (!samePath(userData, expectedUserData)) {
    throw new Error("app userData does not match PWRSNAP_USER_DATA");
  }
  if (!samePath(resolvedDataRoot, expectedDataRoot)) {
    throw new Error("active data root does not match PWRSNAP_DATA_ROOT");
  }
  if (samePath(userData, resolvedDataRoot)) {
    throw new Error("packaged Windows smoke requires distinct userData and data roots");
  }

  requirePathWithin(smokeRoot, userData, "userData");
  requirePathWithin(smokeRoot, resolvedDataRoot, "data root");
  requirePathWithin(userData, home, "Electron home", true);
  requirePathWithin(userData, documents, "Electron documents");
  requirePathWithin(smokeRoot, appData, "Electron appData");
  requirePathWithin(smokeRoot, sessionData, "Electron sessionData");
  requirePathWithin(smokeRoot, logs, "Electron logs");
  requirePathWithin(smokeRoot, crashDumps, "Electron crashDumps");
  requirePathWithin(smokeRoot, temp, "Electron temp");
  requirePathWithin(resolvedDataRoot, resolvedDatabasePath, "database path");
  requirePathWithin(resolvedDataRoot, resolvedCapturesRoot, "captures root");
  requirePathWithin(smokeRoot, resolvedMainLogPath, "main log path");

  const reportPath = join(userData, PACKAGED_WINDOWS_SMOKE_REPORT_NAME);
  requirePathWithin(userData, reportPath, "smoke report");

  return {
    smokeRoot,
    userData,
    dataRoot: resolvedDataRoot,
    home,
    documents,
    appData,
    sessionData,
    logs,
    crashDumps,
    temp,
    databasePath: resolvedDatabasePath,
    capturesRoot: resolvedCapturesRoot,
    mainLogPath: resolvedMainLogPath,
    reportPath,
    profileEnvironment
  };
}

export function packagedRendererProbeSource(): string {
  return String.raw`(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rootMounted = document.querySelector("#root .app-shell") !== null;
    const library = document.querySelector("#root .app-shell .psl");
    const libraryMounted = library !== null;
    const libraryUiState = library?.dataset.libraryReadiness;
    const libraryUiTotalLive = Number(library?.dataset.libraryTotalLive);
    const brand = document.querySelector('svg[aria-label="PwrSnap"]');
    const brandStyle = brand === null ? null : getComputedStyle(brand);
    const brandRect = brand === null ? null : brand.getBoundingClientRect();
    const brandVisible = brand !== null &&
      brandStyle !== null &&
      brandRect !== null &&
      brandStyle.display !== "none" &&
      brandStyle.visibility !== "hidden" &&
      brandStyle.opacity !== "0" &&
      brandRect.width > 0 &&
      brandRect.height > 0;
    const preloadBridgeReady = typeof window.pwrsnapApi?.dispatch === "function";
    const base = {
      readyState: document.readyState,
      stage: document.body.dataset.stage,
      title: document.title,
      rootMounted,
      libraryMounted,
      libraryUiState,
      libraryUiTotalLive,
      brandVisible,
      preloadBridgeReady
    };
    if (
      document.readyState !== "complete" ||
      document.body.dataset.stage !== "library" ||
      document.title !== "PwrSnap" ||
      !rootMounted ||
      !libraryMounted ||
      libraryUiState !== "ready" ||
      libraryUiTotalLive !== 0 ||
      !brandVisible ||
      !preloadBridgeReady
    ) {
      return { ready: false, ...base, reason: "renderer_not_committed" };
    }
    const listResult = await window.pwrsnapApi.dispatch("library:list", {
      limit: 1,
      includeDeleted: true
    });
    if (!listResult.ok) {
      return {
        ready: false,
        ...base,
        libraryListOk: false,
        reason: "library_list_failed:" + listResult.error.code
      };
    }
    const rowCount = listResult.value.rows.length;
    const totalLive = listResult.value.totalLive;
    const trashTotal = listResult.value.trashTotal;
    return {
      ready: rowCount === 0 && totalLive === 0 && trashTotal === 0,
      ...base,
      libraryListOk: true,
      rowCount,
      totalLive,
      trashTotal,
      reason: rowCount === 0 && totalLive === 0 && trashTotal === 0
        ? undefined
        : "isolated_library_not_empty"
    };
  })()`;
}

function rendererEvidenceReady(result: RendererProbeResult): result is RendererProbeResult & {
  readyState: "complete";
  stage: "library";
  title: "PwrSnap";
  rootMounted: true;
  libraryMounted: true;
  libraryUiState: "ready";
  libraryUiTotalLive: 0;
  brandVisible: true;
  preloadBridgeReady: true;
  libraryListOk: true;
  rowCount: 0;
  totalLive: 0;
  trashTotal: 0;
} {
  return (
    result.ready === true &&
    result.readyState === "complete" &&
    result.stage === "library" &&
    result.title === "PwrSnap" &&
    result.rootMounted === true &&
    result.libraryMounted === true &&
    result.libraryUiState === "ready" &&
    result.libraryUiTotalLive === 0 &&
    result.brandVisible === true &&
    result.preloadBridgeReady === true &&
    result.libraryListOk === true &&
    result.rowCount === 0 &&
    result.totalLive === 0 &&
    result.trashTotal === 0
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitForPackagedRendererReadiness(
  window: SmokeWindow,
  options: {
    timeoutMs?: number;
    executeTimeoutMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<RendererSmokeEvidence> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDERER_TIMEOUT_MS;
  const executeTimeoutMs = options.executeTimeoutMs ?? DEFAULT_RENDERER_EXECUTE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_RENDERER_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "renderer probe did not run";

  do {
    if (window.isDestroyed()) throw new Error("Library window was destroyed before readiness");
    if (window.webContents.isDestroyed()) {
      throw new Error("Library renderer was destroyed before readiness");
    }
    if (window.isVisible()) {
      try {
        const result = await withTimeout(
          window.webContents.executeJavaScript(
            packagedRendererProbeSource()
          ) as Promise<RendererProbeResult>,
          executeTimeoutMs,
          "renderer readiness probe"
        );
        lastObservation = JSON.stringify(result).slice(0, FAILURE_MESSAGE_LIMIT);
        if (rendererEvidenceReady(result)) {
          return {
            readyState: result.readyState,
            stage: result.stage,
            title: result.title,
            rootMounted: result.rootMounted,
            libraryMounted: result.libraryMounted,
            libraryUiState: result.libraryUiState,
            libraryUiTotalLive: result.libraryUiTotalLive,
            brandVisible: result.brandVisible,
            preloadBridgeReady: result.preloadBridgeReady,
            libraryListOk: result.libraryListOk,
            rowCount: result.rowCount,
            totalLive: result.totalLive,
            trashTotal: result.trashTotal,
            windowVisible: true
          };
        }
      } catch (cause) {
        lastObservation = cause instanceof Error ? cause.message : String(cause);
      }
    } else {
      lastObservation = "Library window is not visible";
    }
    await sleep(pollIntervalMs);
  } while (Date.now() <= deadline);

  throw new Error(`Library renderer readiness timed out: ${lastObservation}`);
}

export function probeBetterSqlite3(database: SmokeDatabase, expectedDatabasePath: string): {
  quickCheck: "ok";
  sqliteVersion: string;
  databasePath: string;
} {
  const quickCheck = database.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") {
    throw new Error(`SQLite quick_check returned ${String(quickCheck)}`);
  }
  const row = database.prepare("SELECT sqlite_version() AS sqliteVersion").get() as
    | { sqliteVersion?: unknown }
    | undefined;
  if (typeof row?.sqliteVersion !== "string" || row.sqliteVersion.length === 0) {
    throw new Error("SQLite native query did not return sqlite_version()");
  }
  const databases = database.prepare("PRAGMA database_list").all() as Array<{
    name?: unknown;
    file?: unknown;
  }>;
  const mainDatabase = databases.find((entry) => entry.name === "main");
  if (typeof mainDatabase?.file !== "string" || mainDatabase.file.length === 0) {
    throw new Error("SQLite PRAGMA database_list did not identify the main database file");
  }
  const databasePath = resolve(mainDatabase.file);
  if (!samePath(databasePath, expectedDatabasePath)) {
    throw new Error("open SQLite connection does not use the isolated database path");
  }
  return { quickCheck: "ok", sqliteVersion: row.sqliteVersion, databasePath };
}

function physicalUnpackedPath(path: string): string {
  const resolvedPath = resolve(path);
  const asarSegment = `${sep}app.asar${sep}`;
  if (!resolvedPath.includes(asarSegment)) return resolvedPath;
  const unpacked = resolvedPath.replace(asarSegment, `${sep}app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : resolvedPath;
}

function requireInstalledResource(resourcesPath: string, path: string, label: string): string {
  const resolvedPath = resolve(path);
  if (!pathIsWithin(resourcesPath, resolvedPath)) {
    throw new Error(`${label} resolved outside the installed resources directory`);
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`${label} is missing at ${resolvedPath}`);
  }
  return resolvedPath;
}

export function resolvePackagedNativeModuleProvenance(
  resourcesPath: string,
  betterSqlite3Binding: string | undefined
): NativeModuleProvenance {
  const installedResources = resolve(resourcesPath);
  if (betterSqlite3Binding === undefined) {
    throw new Error("better-sqlite3 did not select the Electron-native sidecar");
  }

  const moduleRequire = createRequire(import.meta.url);
  const betterSqlite3PackagePath = requireInstalledResource(
    installedResources,
    moduleRequire.resolve("better-sqlite3/package.json"),
    "better-sqlite3 package"
  );
  const betterSqlite3BindingPath = requireInstalledResource(
    installedResources,
    physicalUnpackedPath(betterSqlite3Binding),
    "better-sqlite3 Electron binding"
  );

  const sharpEntryPath = moduleRequire.resolve("sharp");
  // Sharp's platform packages are optional dependencies nested under Sharp,
  // not dependencies of PwrSnap's main bundle. Resolve from Sharp's own entry
  // so pnpm's deployed/hoisted layout cannot make the smoke look in the wrong
  // node_modules tree.
  const sharpRequire = createRequire(sharpEntryPath);
  const sharpPackagePath = requireInstalledResource(
    installedResources,
    join(dirname(dirname(sharpEntryPath)), "package.json"),
    "Sharp package"
  );
  const sharpPlatformPackagePath = requireInstalledResource(
    installedResources,
    physicalUnpackedPath(sharpRequire.resolve("@img/sharp-win32-x64/package")),
    "Sharp win32-x64 package"
  );
  const sharpPlatformLib = physicalUnpackedPath(join(dirname(sharpPlatformPackagePath), "lib"));
  const platformFiles = readdirSync(sharpPlatformLib).sort();
  const bindingNames = platformFiles.filter((name) => name.endsWith(".node"));
  if (bindingNames.length !== 1) {
    throw new Error(`Sharp win32-x64 package must contain one native binding; found ${bindingNames.length}`);
  }
  const sharpBindingPath = requireInstalledResource(
    installedResources,
    join(sharpPlatformLib, bindingNames[0]!),
    "Sharp win32-x64 binding"
  );
  const sharpLibvipsDllPaths = platformFiles
    .filter((name) => /^libvips.*\.dll$/i.test(name))
    .map((name) =>
      requireInstalledResource(
        installedResources,
        join(sharpPlatformLib, name),
        "Sharp libvips DLL"
      )
    );
  if (sharpLibvipsDllPaths.length === 0) {
    throw new Error("Sharp win32-x64 package does not contain a libvips DLL");
  }

  return {
    resourcesPath: installedResources,
    betterSqlite3PackagePath,
    betterSqlite3BindingPath,
    sharpPackagePath,
    sharpPlatformPackagePath,
    sharpBindingPath,
    sharpLibvipsDllPaths
  };
}

export async function probeSharpNativeModule(): Promise<SharpSmokeEvidence> {
  const { default: sharp } = await import("sharp");
  const rgba = Buffer.from([
    255, 138, 31, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    255, 138, 31, 255
  ]);
  const encoded = await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } })
    .png()
    .toBuffer();
  const metadata = await sharp(encoded).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== 2 ||
    metadata.height !== 2 ||
    metadata.channels !== 4
  ) {
    throw new Error(`Sharp PNG round trip returned unexpected metadata: ${JSON.stringify(metadata)}`);
  }
  const sharpVersion = sharp.versions.sharp;
  const vipsVersion = sharp.versions.vips;
  if (sharpVersion.length === 0 || vipsVersion.length === 0 || encoded.length === 0) {
    throw new Error("Sharp native version or encoded PNG evidence is missing");
  }
  return {
    format: "png",
    width: 2,
    height: 2,
    channels: 4,
    encodedBytes: encoded.length,
    sharpVersion,
    vipsVersion
  };
}

async function writeSmokeReport(
  reportPath: string,
  report: PackagedWindowsSmokeReport | FailedSmokeReport
): Promise<void> {
  await mkdir(resolve(reportPath, ".."), { recursive: true });
  const temporaryPath = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporaryPath, reportPath);
}

function failureMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw.slice(0, FAILURE_MESSAGE_LIMIT);
}

/**
 * Run the opt-in readiness handshake after normal bootstrap has completed.
 * Returns true when smoke mode owned the process lifecycle (success or failure).
 */
export async function runPackagedWindowsSmokeIfRequested(
  dependencies: PackagedWindowsSmokeDependencies
): Promise<boolean> {
  if (dependencies.env[PACKAGED_WINDOWS_SMOKE_ENV] !== "1") return false;

  let config: PackagedWindowsSmokeConfig | null = null;
  let phase = "configuration";
  try {
    config = resolvePackagedWindowsSmokeConfig(dependencies);
    if (config === null) return false;

    phase = "native:provenance";
    const provenance = dependencies.getNativeModuleProvenance();

    phase = "native:better-sqlite3";
    const betterSqlite3 = probeBetterSqlite3(
      dependencies.getDatabase(),
      config.databasePath
    );

    phase = "native:sharp";
    const sharp = await (dependencies.probeSharp ?? probeSharpNativeModule)();

    phase = "renderer";
    const window = dependencies.findMainLibraryWindow();
    if (window === null) throw new Error("packaged smoke could not find the Library window");
    const renderer = await waitForPackagedRendererReadiness(window, {
      ...(dependencies.rendererTimeoutMs !== undefined
        ? { timeoutMs: dependencies.rendererTimeoutMs }
        : {}),
      ...(dependencies.rendererExecuteTimeoutMs !== undefined
        ? { executeTimeoutMs: dependencies.rendererExecuteTimeoutMs }
        : {}),
      ...(dependencies.rendererPollIntervalMs !== undefined
        ? { pollIntervalMs: dependencies.rendererPollIntervalMs }
        : {})
    });

    phase = "report";
    const report: PackagedWindowsSmokeReport = {
      schemaVersion: 1,
      status: "ready",
      app: {
        name: dependencies.app.getName(),
        version: dependencies.app.getVersion(),
        electronVersion: dependencies.electronVersion,
        isPackaged: true,
        platform: "win32",
        arch: dependencies.arch,
        execPath: resolve(dependencies.execPath)
      },
      isolation: {
        ...config,
        e2e: true,
        regionPrewarmSkipped: true
      },
      main: {
        bootstrapComplete: true
      },
      renderer,
      nativeModules: {
        resourcesPath: provenance.resourcesPath,
        betterSqlite3: {
          ...betterSqlite3,
          packagePath: provenance.betterSqlite3PackagePath,
          bindingPath: provenance.betterSqlite3BindingPath
        },
        sharp: {
          ...sharp,
          packagePath: provenance.sharpPackagePath,
          platformPackagePath: provenance.sharpPlatformPackagePath,
          bindingPath: provenance.sharpBindingPath,
          libvipsDllPaths: provenance.sharpLibvipsDllPaths
        }
      }
    };
    await writeSmokeReport(config.reportPath, report);
    dependencies.logger.info("packaged Windows smoke ready; quitting cleanly", {
      reportPath: config.reportPath
    });
    dependencies.app.quit();
    return true;
  } catch (cause) {
    const message = failureMessage(cause);
    if (config !== null) {
      try {
        await writeSmokeReport(config.reportPath, {
          schemaVersion: 1,
          status: "failed",
          phase,
          error: { message }
        });
      } catch (reportCause) {
        dependencies.logger.error("packaged Windows smoke failure report could not be written", {
          phase,
          message: failureMessage(reportCause)
        });
      }
    }
    dependencies.logger.error("packaged Windows smoke failed", { phase, message });
    dependencies.app.quit();
    return true;
  }
}
