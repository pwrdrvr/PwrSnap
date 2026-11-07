import { existsSync, readFileSync } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, win32 } from "node:path";
import type {
  AppUpdateCheckResult,
  AppUpdateInstallResult,
  AppUpdateStatus
} from "@pwrsnap/shared";

export const WINDOWS_UPDATE_SMOKE_BUILD_MARKER = "pwrsnap-update-smoke-build.json";
export const WINDOWS_UPDATE_SMOKE_STATE_DIR = "windows-update-smoke";
export const WINDOWS_UPDATE_SMOKE_CONTINUITY_FILE = "continuity.json";
export const WINDOWS_UPDATE_SMOKE_RESULT_FILE = "result.json";
export const WINDOWS_UPDATE_SMOKE_EVENTS_FILE = "events.ndjson";
export const WINDOWS_UPDATE_INSTALL_ATTEMPT_FILE = "pwrsnap-update-install-attempt.json";

const MARKER_KIND = "pwrsnap-windows-update-smoke";
const CONTINUITY_KIND = "pwrsnap-windows-update-smoke-continuity";
const RESULT_KIND = "pwrsnap-windows-update-smoke-result";
const SCHEMA_VERSION = 1;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_STATUS_POLL_MS = 250;
const SMOKE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-update-smoke\.([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/;
const RUN_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const LOOPBACK_FEED_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/;

export type WindowsUpdateSmokeConfig = {
  baselineVersion: string;
  currentVersion: string;
  feedUrl: string;
  runId: string;
  targetVersion: string;
  userDataDir: string;
};

export type WindowsUpdateSmokeContinuity = {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: typeof CONTINUITY_KIND;
  runId: string;
  baselineVersion: string;
  targetVersion: string;
  userDataDir: string;
  nonce: string;
  baselinePid: number;
  createdAt: string;
};

export type WindowsUpdateSmokeSuccessResult = {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: typeof RESULT_KIND;
  status: "success";
  runId: string;
  baselineVersion: string;
  targetVersion: string;
  currentVersion: string;
  relaunched: true;
  sentinel: Pick<WindowsUpdateSmokeContinuity, "nonce" | "baselinePid" | "createdAt">;
  markerCleared: true;
  userDataDir: string;
  dbPath: string;
  pid: number;
  completedAt: string;
};

export type WindowsUpdateSmokeFailureResult = {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: typeof RESULT_KIND;
  status: "failure";
  phase: "bootstrap" | "baseline" | "target";
  runId?: string;
  baselineVersion?: string;
  targetVersion?: string;
  currentVersion?: string;
  userDataDir?: string;
  markerCleared?: boolean;
  pid: number;
  completedAt: string;
  error: string;
};

type WindowsUpdateSmokeLogger = {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
};

export type WindowsUpdateSmokeDependencies = {
  config: WindowsUpdateSmokeConfig;
  checkForUpdates: () => Promise<AppUpdateCheckResult>;
  readUpdateStatus: () => AppUpdateStatus;
  installDownloadedUpdate: () => Promise<AppUpdateInstallResult>;
  exit: (code: number) => void;
  logger: WindowsUpdateSmokeLogger;
  now?: () => Date;
  pid?: number;
  randomNonce?: () => string;
  sleep?: (ms: number) => Promise<void>;
  statusPollMs?: number;
  downloadTimeoutMs?: number;
};

export class WindowsUpdateSmokeConfigError extends Error {
  constructor(message: string) {
    super(`Windows updater smoke configuration rejected: ${message}`);
    this.name = "WindowsUpdateSmokeConfigError";
  }
}

type ParsedSmokeVersion = {
  core: [number, number, number];
  prerelease: Array<string | number>;
};

function parseSmokeVersion(version: string): ParsedSmokeVersion | undefined {
  const match = version.match(SMOKE_VERSION_PATTERN);
  if (match === null) return undefined;
  const [, major, minor, patch, suffix] = match;
  if (major === undefined || minor === undefined || patch === undefined || suffix === undefined) {
    return undefined;
  }
  const core = [Number(major), Number(minor), Number(patch)] as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined;
  const parts = suffix.split(".");
  const prerelease: Array<string | number> = ["update-smoke"];
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      if (part.length > 1 && part.startsWith("0")) return undefined;
      const numeric = Number(part);
      if (!Number.isSafeInteger(numeric)) return undefined;
      prerelease.push(numeric);
    } else {
      prerelease.push(part);
    }
  }
  return {
    core,
    prerelease
  };
}

function compareSmokeVersions(a: ParsedSmokeVersion, b: ParsedSmokeVersion): number {
  for (let index = 0; index < a.core.length; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return delta;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left - right;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left.localeCompare(right);
  }
  return 0;
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new WindowsUpdateSmokeConfigError(`${name} is required`);
  }
  return value;
}

export function isWindowsUpdateSmokeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PWRSNAP_UPDATE_SMOKE !== undefined && env.PWRSNAP_UPDATE_SMOKE !== "";
}

export function isExactWindowsUpdateSmokeFeedUrl(feedUrl: string): boolean {
  const match = feedUrl.match(LOOPBACK_FEED_PATTERN);
  const port = Number(match?.[1] ?? 0);
  return match !== null && port >= 1 && port <= 65_535;
}

/**
 * Read and validate the packaged updater-smoke contract. The environment is
 * intentionally powerless in a normal package: the resource marker must also
 * be present and name the exact running version. Conversely, a malformed
 * opt-in never falls through into normal startup or the production feed.
 */
export function readWindowsUpdateSmokeConfig(input: {
  appVersion: string;
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  resourcesPath: string;
}): WindowsUpdateSmokeConfig | null {
  const env = input.env ?? process.env;
  const markerPath = join(input.resourcesPath, WINDOWS_UPDATE_SMOKE_BUILD_MARKER);
  const markerPresent = existsSync(markerPath);
  if (!isWindowsUpdateSmokeRequested(env)) {
    if (markerPresent) {
      throw new WindowsUpdateSmokeConfigError(
        "a marker-bearing smoke build requires the complete updater-smoke environment"
      );
    }
    return null;
  }
  if (env.PWRSNAP_UPDATE_SMOKE !== "1") {
    throw new WindowsUpdateSmokeConfigError("PWRSNAP_UPDATE_SMOKE must be exactly 1");
  }
  if ((input.platform ?? process.platform) !== "win32") {
    throw new WindowsUpdateSmokeConfigError("the smoke is Windows-only");
  }
  if (!input.isPackaged) {
    throw new WindowsUpdateSmokeConfigError("the smoke requires an installed packaged app");
  }
  if (env.NODE_ENV !== "production") {
    throw new WindowsUpdateSmokeConfigError("NODE_ENV must be production");
  }
  if (env.PWRSNAP_E2E === "1") {
    throw new WindowsUpdateSmokeConfigError("PWRSNAP_E2E cannot be combined with updater smoke");
  }
  if (env.PWRSNAP_PROCESS_SPLIT !== "0") {
    throw new WindowsUpdateSmokeConfigError("PWRSNAP_PROCESS_SPLIT must be exactly 0");
  }
  if (env.PWRSNAP_DATA_ROOT !== undefined && env.PWRSNAP_DATA_ROOT !== "") {
    throw new WindowsUpdateSmokeConfigError("PWRSNAP_DATA_ROOT must not override userData");
  }

  const baselineVersion = requiredEnv(env, "PWRSNAP_UPDATE_SMOKE_BASELINE_VERSION");
  const targetVersion = requiredEnv(env, "PWRSNAP_UPDATE_SMOKE_TARGET_VERSION");
  const runId = requiredEnv(env, "PWRSNAP_UPDATE_SMOKE_RUN_ID");
  const feedUrl = requiredEnv(env, "PWRSNAP_UPDATE_SMOKE_FEED_URL");
  const userDataDir = requiredEnv(env, "PWRSNAP_USER_DATA");

  const baselineParsed = parseSmokeVersion(baselineVersion);
  const targetParsed = parseSmokeVersion(targetVersion);
  if (baselineParsed === undefined || targetParsed === undefined) {
    throw new WindowsUpdateSmokeConfigError(
      "baseline and target must be synthetic x.y.z-update-smoke.* versions"
    );
  }
  if (compareSmokeVersions(targetParsed, baselineParsed) <= 0) {
    throw new WindowsUpdateSmokeConfigError("target version must be newer than baseline");
  }
  if (input.appVersion !== baselineVersion && input.appVersion !== targetVersion) {
    throw new WindowsUpdateSmokeConfigError(
      `running version ${input.appVersion} is neither the expected baseline nor target`
    );
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new WindowsUpdateSmokeConfigError("PWRSNAP_UPDATE_SMOKE_RUN_ID has invalid characters");
  }
  if (!isExactWindowsUpdateSmokeFeedUrl(feedUrl)) {
    throw new WindowsUpdateSmokeConfigError(
      "feed must be exactly http://127.0.0.1:<nonzero-port>/"
    );
  }
  if (
    !win32.isAbsolute(userDataDir) ||
    win32.normalize(userDataDir) === win32.parse(userDataDir).root
  ) {
    throw new WindowsUpdateSmokeConfigError("PWRSNAP_USER_DATA must be an absolute non-root path");
  }

  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (cause) {
    throw new WindowsUpdateSmokeConfigError(
      `signed build marker is missing or unreadable (${cause instanceof Error ? cause.message : String(cause)})`
    );
  }
  if (marker === null || typeof marker !== "object") {
    throw new WindowsUpdateSmokeConfigError("signed build marker is malformed");
  }
  const value = marker as { schemaVersion?: unknown; kind?: unknown; version?: unknown };
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== MARKER_KIND ||
    value.version !== input.appVersion
  ) {
    throw new WindowsUpdateSmokeConfigError(
      "signed build marker does not identify the exact running smoke version"
    );
  }

  return {
    baselineVersion,
    currentVersion: input.appVersion,
    feedUrl,
    runId,
    targetVersion,
    userDataDir
  };
}

export function windowsUpdateSmokeStatePaths(userDataDir: string): {
  stateDir: string;
  continuityFile: string;
  resultFile: string;
  eventsFile: string;
  installAttemptFile: string;
  dbPath: string;
} {
  const stateDir = join(userDataDir, WINDOWS_UPDATE_SMOKE_STATE_DIR);
  return {
    stateDir,
    continuityFile: join(stateDir, WINDOWS_UPDATE_SMOKE_CONTINUITY_FILE),
    resultFile: join(stateDir, WINDOWS_UPDATE_SMOKE_RESULT_FILE),
    eventsFile: join(stateDir, WINDOWS_UPDATE_SMOKE_EVENTS_FILE),
    installAttemptFile: join(userDataDir, WINDOWS_UPDATE_INSTALL_ATTEMPT_FILE),
    dbPath: join(userDataDir, "pwrsnap.db")
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${path.split(/[\\/]/).pop() ?? "state"}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function appendSmokeEvent(
  config: Pick<WindowsUpdateSmokeConfig, "userDataDir" | "runId" | "currentVersion">,
  event: string,
  data: Record<string, unknown> = {},
  now: () => Date = () => new Date(),
  pid = process.pid
): Promise<void> {
  const { stateDir, eventsFile } = windowsUpdateSmokeStatePaths(config.userDataDir);
  await mkdir(stateDir, { recursive: true });
  await appendFile(
    eventsFile,
    `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      at: now().toISOString(),
      event,
      runId: config.runId,
      version: config.currentVersion,
      pid,
      ...data
    })}\n`,
    "utf8"
  );
}

function parseContinuity(raw: string): WindowsUpdateSmokeContinuity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const value = parsed as Partial<WindowsUpdateSmokeContinuity>;
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== CONTINUITY_KIND ||
    typeof value.runId !== "string" ||
    typeof value.baselineVersion !== "string" ||
    typeof value.targetVersion !== "string" ||
    typeof value.userDataDir !== "string" ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    typeof value.baselinePid !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  return value as WindowsUpdateSmokeContinuity;
}

function smokePhase(config: WindowsUpdateSmokeConfig): "baseline" | "target" {
  return config.currentVersion === config.baselineVersion ? "baseline" : "target";
}

async function waitForExactDownloadedUpdate(
  dependencies: WindowsUpdateSmokeDependencies
): Promise<void> {
  const {
    config,
    readUpdateStatus,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    statusPollMs = DEFAULT_STATUS_POLL_MS,
    downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS
  } = dependencies;
  const deadline = Date.now() + downloadTimeoutMs;
  while (Date.now() <= deadline) {
    const status = readUpdateStatus();
    if (
      (status.status === "available" ||
        status.status === "downloading" ||
        status.status === "downloaded" ||
        status.status === "install-failed") &&
      status.version !== config.targetVersion
    ) {
      throw new Error(
        `updater reported unexpected version ${status.version}; expected ${config.targetVersion}`
      );
    }
    if (status.status === "downloaded") return;
    if (status.status === "error") {
      throw new Error(`updater failed: ${status.message}`);
    }
    if (status.status === "install-failed") {
      throw new Error(
        `a prior install attempt for ${status.version} did not reach its expected version`
      );
    }
    await sleep(statusPollMs);
  }
  throw new Error(`timed out waiting for exact target ${config.targetVersion} to download`);
}

async function runBaseline(dependencies: WindowsUpdateSmokeDependencies): Promise<void> {
  const {
    config,
    checkForUpdates,
    installDownloadedUpdate,
    logger,
    now = () => new Date(),
    pid = process.pid,
    randomNonce = randomUUID
  } = dependencies;
  const paths = windowsUpdateSmokeStatePaths(config.userDataDir);
  await mkdir(paths.stateDir, { recursive: true });
  await Promise.all([
    rm(paths.resultFile, { force: true }),
    rm(paths.continuityFile, { force: true }),
    rm(paths.eventsFile, { force: true })
  ]);
  if (!(await pathExists(paths.dbPath))) {
    throw new Error(`isolated database was not created at ${paths.dbPath}`);
  }
  const continuity: WindowsUpdateSmokeContinuity = {
    schemaVersion: SCHEMA_VERSION,
    kind: CONTINUITY_KIND,
    runId: config.runId,
    baselineVersion: config.baselineVersion,
    targetVersion: config.targetVersion,
    userDataDir: config.userDataDir,
    nonce: randomNonce(),
    baselinePid: pid,
    createdAt: now().toISOString()
  };
  await writeJsonAtomic(paths.continuityFile, continuity);
  await appendSmokeEvent(config, "baseline-ready", { sentinelNonce: continuity.nonce }, now, pid);
  logger.info("Windows updater smoke baseline initialized", {
    runId: config.runId,
    baselineVersion: config.baselineVersion,
    targetVersion: config.targetVersion,
    feedUrl: config.feedUrl,
    userDataDir: config.userDataDir
  });

  const check = await checkForUpdates();
  if (
    (check.status !== "available" && check.status !== "downloaded") ||
    check.version !== config.targetVersion
  ) {
    throw new Error(
      check.status === "error"
        ? `update check failed: ${check.message}`
        : `update check did not select exact target ${config.targetVersion} (${JSON.stringify(check)})`
    );
  }
  await appendSmokeEvent(config, "target-selected", { checkStatus: check.status }, now, pid);
  if (check.status !== "downloaded") {
    await waitForExactDownloadedUpdate(dependencies);
  }
  await appendSmokeEvent(config, "target-downloaded", {}, now, pid);
  // Persist the last baseline-side breadcrumb before quitAndInstall. The
  // updater can begin terminating this process synchronously, so no evidence
  // written after that call is relied upon.
  await appendSmokeEvent(config, "install-invoking", {}, now, pid);
  const install = await installDownloadedUpdate();
  if (install.status !== "restarting") {
    throw new Error(
      install.status === "error"
        ? `update install request failed: ${install.message}`
        : `update install request returned ${JSON.stringify(install)}`
    );
  }
  logger.info("Windows updater smoke requested signed target install", {
    runId: config.runId,
    targetVersion: config.targetVersion
  });
  // quitAndInstall owns termination and relaunch. A forced app.exit here would
  // race the NSIS updater before it has assumed control of the process.
}

async function runTarget(dependencies: WindowsUpdateSmokeDependencies): Promise<void> {
  const { config, exit, logger, now = () => new Date(), pid = process.pid } = dependencies;
  const paths = windowsUpdateSmokeStatePaths(config.userDataDir);
  const continuity = parseContinuity(await readFile(paths.continuityFile, "utf8"));
  if (continuity === undefined) {
    throw new Error("baseline continuity sentinel is missing or malformed");
  }
  if (
    continuity.runId !== config.runId ||
    continuity.baselineVersion !== config.baselineVersion ||
    continuity.targetVersion !== config.targetVersion ||
    continuity.userDataDir !== config.userDataDir
  ) {
    throw new Error("baseline continuity sentinel does not match this isolated smoke run");
  }
  if (!(await pathExists(paths.dbPath))) {
    throw new Error(`isolated database did not survive relaunch at ${paths.dbPath}`);
  }
  const markerCleared = !(await pathExists(paths.installAttemptFile));
  if (!markerCleared) {
    throw new Error(
      `install-attempt marker still exists after target relaunch (${paths.installAttemptFile})`
    );
  }
  const result: WindowsUpdateSmokeSuccessResult = {
    schemaVersion: SCHEMA_VERSION,
    kind: RESULT_KIND,
    status: "success",
    runId: config.runId,
    baselineVersion: config.baselineVersion,
    targetVersion: config.targetVersion,
    currentVersion: config.currentVersion,
    relaunched: true,
    sentinel: {
      nonce: continuity.nonce,
      baselinePid: continuity.baselinePid,
      createdAt: continuity.createdAt
    },
    markerCleared: true,
    userDataDir: config.userDataDir,
    dbPath: paths.dbPath,
    pid,
    completedAt: now().toISOString()
  };
  await appendSmokeEvent(config, "target-continuity-verified", {
    baselinePid: continuity.baselinePid,
    sentinelNonce: continuity.nonce
  }, now, pid);
  await writeJsonAtomic(paths.resultFile, result);
  logger.info("Windows updater smoke completed", result);
  exit(0);
}

async function writeFailureResult(input: {
  config: WindowsUpdateSmokeConfig;
  cause: unknown;
  now?: () => Date;
  pid?: number;
}): Promise<WindowsUpdateSmokeFailureResult> {
  const { config, cause, now = () => new Date(), pid = process.pid } = input;
  const paths = windowsUpdateSmokeStatePaths(config.userDataDir);
  const phase = smokePhase(config);
  const failure: WindowsUpdateSmokeFailureResult = {
    schemaVersion: SCHEMA_VERSION,
    kind: RESULT_KIND,
    status: "failure",
    phase,
    runId: config.runId,
    baselineVersion: config.baselineVersion,
    targetVersion: config.targetVersion,
    currentVersion: config.currentVersion,
    userDataDir: config.userDataDir,
    markerCleared: !(await pathExists(paths.installAttemptFile)),
    pid,
    completedAt: now().toISOString(),
    error: cause instanceof Error ? cause.message : String(cause)
  };
  await appendSmokeEvent(config, "failure", { phase, error: failure.error }, now, pid).catch(
    () => undefined
  );
  await writeJsonAtomic(paths.resultFile, failure);
  return failure;
}

export async function runWindowsUpdateSmoke(
  dependencies: WindowsUpdateSmokeDependencies
): Promise<void> {
  try {
    if (dependencies.config.currentVersion === dependencies.config.baselineVersion) {
      await runBaseline(dependencies);
      return;
    }
    await runTarget(dependencies);
  } catch (cause) {
    let failure: WindowsUpdateSmokeFailureResult | undefined;
    try {
      failure = await writeFailureResult({
        config: dependencies.config,
        cause,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.pid === undefined ? {} : { pid: dependencies.pid })
      });
    } catch (writeCause) {
      dependencies.logger.error("Windows updater smoke failed and result persistence failed", {
        error: cause instanceof Error ? cause.message : String(cause),
        resultWriteError:
          writeCause instanceof Error ? writeCause.message : String(writeCause)
      });
    }
    dependencies.logger.error("Windows updater smoke failed", {
      ...(failure ?? {}),
      error: cause instanceof Error ? cause.message : String(cause)
    });
    dependencies.exit(1);
  }
}

/** Best-effort durable diagnostic for failures that happen before a complete
 * config can be trusted. It writes only when the env supplied an absolute,
 * non-root Windows userData path; otherwise the caller must rely on logs. */
export async function writeWindowsUpdateSmokeBootstrapFailure(input: {
  cause: unknown;
  env?: NodeJS.ProcessEnv;
  appVersion?: string;
  pid?: number;
  now?: () => Date;
}): Promise<void> {
  const env = input.env ?? process.env;
  const userDataDir = env.PWRSNAP_USER_DATA;
  if (
    userDataDir === undefined ||
    !win32.isAbsolute(userDataDir) ||
    win32.normalize(userDataDir) === win32.parse(userDataDir).root
  ) {
    return;
  }
  const failure: WindowsUpdateSmokeFailureResult = {
    schemaVersion: SCHEMA_VERSION,
    kind: RESULT_KIND,
    status: "failure",
    phase: "bootstrap",
    ...(env.PWRSNAP_UPDATE_SMOKE_RUN_ID
      ? { runId: env.PWRSNAP_UPDATE_SMOKE_RUN_ID }
      : {}),
    ...(env.PWRSNAP_UPDATE_SMOKE_BASELINE_VERSION
      ? { baselineVersion: env.PWRSNAP_UPDATE_SMOKE_BASELINE_VERSION }
      : {}),
    ...(env.PWRSNAP_UPDATE_SMOKE_TARGET_VERSION
      ? { targetVersion: env.PWRSNAP_UPDATE_SMOKE_TARGET_VERSION }
      : {}),
    ...(input.appVersion ? { currentVersion: input.appVersion } : {}),
    userDataDir,
    pid: input.pid ?? process.pid,
    completedAt: (input.now ?? (() => new Date()))().toISOString(),
    error: input.cause instanceof Error ? input.cause.message : String(input.cause)
  };
  await writeJsonAtomic(windowsUpdateSmokeStatePaths(userDataDir).resultFile, failure);
}
