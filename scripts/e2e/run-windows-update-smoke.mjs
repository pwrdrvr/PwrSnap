import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

export const SMOKE_INPUT_FILE = "smoke-input.json";
export const EXPECTED_WINDOWS_PUBLISHER = "PwrDrvr LLC";
export const INSTALLED_APP_FILE = "PwrSnap.exe";
export const INSTALLED_BUILD_MARKER_FILE =
  "pwrsnap-update-smoke-build.json";

const INPUT_KIND = "pwrsnap-windows-update-smoke-input";
const BUILD_MARKER_KIND = "pwrsnap-windows-update-smoke";
const CONTINUITY_KIND = "pwrsnap-windows-update-smoke-continuity";
const RESULT_KIND = "pwrsnap-windows-update-smoke-result";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LATEST_YML_BYTES = 1024 * 1024;
const MAX_CAPTURED_PROCESS_BYTES = 1024 * 1024;
const SIGNATURE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 3 * 60_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const PROCESS_QUERY_TIMEOUT_MS = 20_000;
const PROCESS_STOP_TIMEOUT_MS = 20_000;
const SAFE_WINDOWS_ENVIRONMENT_KEYS = new Set([
  "CI",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMSPEC",
  "LANG",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TZ",
  "WINDIR"
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, expectedKeys, label) {
  invariant(isPlainObject(value), `${label} must be a JSON object.`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  invariant(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `${label} must contain exactly: ${expected.join(", ")}.`
  );
}

function assertNonEmptyString(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string.`);
  return value;
}

function assertPositiveSafeInteger(value, label) {
  invariant(
    Number.isSafeInteger(value) && value > 0,
    `${label} must be a positive safe integer.`
  );
  return value;
}

function assertPositiveDecimalString(value, label) {
  invariant(
    typeof value === "string" && /^[1-9]\d*$/.test(value),
    `${label} must be a positive canonical decimal string.`
  );
  return value;
}

/**
 * Parse a canonical SemVer string without depending on a transitive package.
 * Numeric values stay as BigInt so comparison cannot lose precision.
 */
export function parseExactSemver(value, label = "version") {
  invariant(typeof value === "string", `${label} must be a string.`);
  invariant(value.length <= 128, `${label} is too long.`);
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value
    );
  invariant(match !== null, `${label} must be an exact canonical SemVer string.`);

  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    invariant(
      !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0"),
      `${label} contains a numeric prerelease identifier with a leading zero.`
    );
  }

  return {
    value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
    build: match[5]?.split(".") ?? []
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareExactSemver(leftValue, rightValue) {
  const left =
    typeof leftValue === "string" ? parseExactSemver(leftValue) : leftValue;
  const right =
    typeof rightValue === "string" ? parseExactSemver(rightValue) : rightValue;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const comparison = compareIdentifier(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function validateAssetDescriptor(value, label) {
  assertExactKeys(value, ["fileName", "sha256", "size"], label);
  const fileName = assertNonEmptyString(value.fileName, `${label}.fileName`);
  invariant(
    fileName === basename(fileName) && SAFE_ASSET_NAME_PATTERN.test(fileName),
    `${label}.fileName must be a safe ASCII basename.`
  );
  invariant(
    typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256),
    `${label}.sha256 must be a lowercase hexadecimal SHA-256 digest.`
  );
  assertPositiveSafeInteger(value.size, `${label}.size`);
  return {
    fileName,
    sha256: value.sha256,
    size: value.size
  };
}

/** Validate and normalize the intentionally narrow signed smoke artifact manifest. */
export function validateSmokeInputManifest(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "sourceVersion",
      "github",
      "baseline",
      "target"
    ],
    "smoke input manifest"
  );
  invariant(value.schemaVersion === 1, "smoke input schemaVersion must be 1.");
  invariant(value.kind === INPUT_KIND, `smoke input kind must be ${INPUT_KIND}.`);

  const source = parseExactSemver(value.sourceVersion, "sourceVersion");
  assertExactKeys(value.github, ["runId", "runAttempt"], "github");
  const github = {
    runId: assertPositiveDecimalString(value.github.runId, "github.runId"),
    runAttempt: assertPositiveDecimalString(
      value.github.runAttempt,
      "github.runAttempt"
    )
  };

  assertExactKeys(value.baseline, ["version", "installer"], "baseline");
  assertExactKeys(
    value.target,
    ["version", "installer", "blockmap", "latestYml"],
    "target"
  );
  const baselineVersion = parseExactSemver(
    value.baseline.version,
    "baseline.version"
  );
  const targetVersion = parseExactSemver(value.target.version, "target.version");
  invariant(
    baselineVersion.prerelease.length > 0 && targetVersion.prerelease.length > 0,
    "baseline.version and target.version must both be prereleases."
  );
  invariant(
    !source.value.includes("update-smoke"),
    "sourceVersion must be the original non-smoke staged version."
  );
  invariant(
    source.major === baselineVersion.major &&
      source.minor === baselineVersion.minor &&
      source.patch === baselineVersion.patch &&
      baselineVersion.major === targetVersion.major &&
      baselineVersion.minor === targetVersion.minor &&
      baselineVersion.patch === targetVersion.patch,
    "sourceVersion, baseline.version, and target.version must share one release core."
  );
  invariant(
    compareExactSemver(targetVersion, baselineVersion) > 0,
    "target.version must be newer than baseline.version."
  );
  const releaseCore = `${source.major}.${source.minor}.${source.patch}`;
  const expectedBaselineVersion = `${releaseCore}-update-smoke.${github.runId}.${github.runAttempt}.1`;
  const expectedTargetVersion = `${releaseCore}-update-smoke.${github.runId}.${github.runAttempt}.2`;
  invariant(
    baselineVersion.value === expectedBaselineVersion,
    `baseline.version must be exactly ${expectedBaselineVersion}.`
  );
  invariant(
    targetVersion.value === expectedTargetVersion,
    `target.version must be exactly ${expectedTargetVersion}.`
  );

  const baselineInstaller = validateAssetDescriptor(
    value.baseline.installer,
    "baseline.installer"
  );
  const targetInstaller = validateAssetDescriptor(
    value.target.installer,
    "target.installer"
  );
  const targetBlockmap = validateAssetDescriptor(
    value.target.blockmap,
    "target.blockmap"
  );
  const targetLatestYml = validateAssetDescriptor(
    value.target.latestYml,
    "target.latestYml"
  );

  const expectedBaselineInstaller = `PwrSnap-${baselineVersion.value}-windows-x64-setup.exe`;
  const expectedTargetInstaller = `PwrSnap-${targetVersion.value}-windows-x64-setup.exe`;
  invariant(
    baselineInstaller.fileName === expectedBaselineInstaller,
    `baseline.installer.fileName must be ${expectedBaselineInstaller}.`
  );
  invariant(
    targetInstaller.fileName === expectedTargetInstaller,
    `target.installer.fileName must be ${expectedTargetInstaller}.`
  );
  invariant(
    targetBlockmap.fileName === `${expectedTargetInstaller}.blockmap`,
    `target.blockmap.fileName must be ${expectedTargetInstaller}.blockmap.`
  );
  invariant(
    targetLatestYml.fileName === "latest.yml",
    "target.latestYml.fileName must be latest.yml."
  );
  invariant(
    new Set([
      baselineInstaller.fileName,
      targetInstaller.fileName,
      targetBlockmap.fileName,
      targetLatestYml.fileName
    ]).size === 4,
    "all smoke input asset names must be distinct."
  );

  return {
    schemaVersion: 1,
    kind: INPUT_KIND,
    sourceVersion: source.value,
    github,
    baseline: {
      version: baselineVersion.value,
      installer: baselineInstaller
    },
    target: {
      version: targetVersion.value,
      installer: targetInstaller,
      blockmap: targetBlockmap,
      latestYml: targetLatestYml
    }
  };
}

function parseYamlScalar(value, label) {
  const trimmed = value.trim();
  invariant(trimmed.length > 0, `${label} must not be empty.`);
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    const parsed = JSON.parse(trimmed);
    invariant(typeof parsed === "string", `${label} must be a string.`);
    return parsed;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  invariant(
    !/[#\r\n]/.test(trimmed),
    `${label} uses unsupported YAML scalar syntax.`
  );
  return trimmed;
}

function exactYamlValues(text, pattern, label) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match) values.push(parseYamlScalar(match[1], label));
  }
  return values;
}

/**
 * Validate electron-builder's generated latest.yml without accepting remote or
 * path-bearing asset URLs. The server then has no route capable of leaving the
 * loopback feed.
 */
export function validateLatestYml(
  text,
  { version, installerFileName, installerSize, installerSha512 }
) {
  invariant(typeof text === "string" && text.length > 0, "latest.yml must be text.");
  invariant(!text.includes("\0"), "latest.yml must not contain NUL bytes.");
  invariant(
    !/(?:https?|file|ftp):\/\//i.test(text),
    "latest.yml must not contain an absolute URL."
  );
  invariant(
    !text.includes("\\") && !/(?:^|[\/])\.\.(?:[\/]|$)/m.test(text),
    "latest.yml must not contain path traversal or Windows path separators."
  );

  const versions = exactYamlValues(text, /^version:\s*(.+?)\s*$/, "version");
  const paths = exactYamlValues(text, /^path:\s*(.+?)\s*$/, "path");
  const urls = exactYamlValues(
    text,
    /^\s+-\s+url:\s*(.+?)\s*$/,
    "files[].url"
  );
  const sha512Values = exactYamlValues(
    text,
    /^\s*sha512:\s*(.+?)\s*$/,
    "sha512"
  );
  const sizes = exactYamlValues(text, /^\s+size:\s*(.+?)\s*$/, "size");

  invariant(
    versions.length === 1 && versions[0] === version,
    "latest.yml must contain exactly the target version."
  );
  invariant(
    paths.length === 1 && paths[0] === installerFileName,
    "latest.yml path must be exactly the target installer basename."
  );
  invariant(
    urls.length === 1 && urls[0] === installerFileName,
    "latest.yml must contain exactly one target installer URL basename."
  );
  invariant(
    sha512Values.length === 2 &&
      sha512Values.every((value) => value === installerSha512),
    "latest.yml SHA-512 values must exactly match the target installer."
  );
  invariant(
    sizes.length === 1 && sizes[0] === String(installerSize),
    "latest.yml size must exactly match the target installer."
  );
  for (const assetName of [...paths, ...urls]) {
    invariant(
      assetName === basename(assetName) && SAFE_ASSET_NAME_PATTERN.test(assetName),
      "latest.yml asset references must be safe ASCII basenames."
    );
  }
  return true;
}

export function validateInstalledBuildMarker(value, expectedVersion) {
  assertExactKeys(value, ["schemaVersion", "kind", "version"], "installed build marker");
  invariant(value.schemaVersion === 1, "installed build marker schemaVersion must be 1.");
  invariant(
    value.kind === BUILD_MARKER_KIND,
    `installed build marker kind must be ${BUILD_MARKER_KIND}.`
  );
  invariant(
    value.version === expectedVersion,
    `installed build marker version must be ${expectedVersion}.`
  );
  return value;
}

export function validateAuthenticodeEvidence(value, expectedPublisher) {
  assertExactKeys(
    value,
    ["status", "subject", "simpleName", "thumbprint"],
    "Authenticode evidence"
  );
  invariant(value.status === "Valid", "Authenticode status must be Valid.");
  invariant(
    value.simpleName === expectedPublisher,
    `Authenticode signer simple name must be exactly ${expectedPublisher}.`
  );
  invariant(
    typeof value.subject === "string" &&
      value.subject
        .split(/\s*,\s*/)
        .some((part) => part === `CN=${expectedPublisher}`),
    `Authenticode subject must contain the exact CN=${expectedPublisher} component.`
  );
  invariant(
    typeof value.thumbprint === "string" && /^[A-F0-9]{40}$/i.test(value.thumbprint),
    "Authenticode signer thumbprint must be a SHA-1 certificate thumbprint."
  );
  return value;
}

export function validateExpectedPublisher(value) {
  invariant(
    value === EXPECTED_WINDOWS_PUBLISHER,
    `--expected-publisher must be exactly ${EXPECTED_WINDOWS_PUBLISHER}.`
  );
  return value;
}

function isIsoTimestamp(value, label) {
  invariant(typeof value === "string", `${label} must be an ISO timestamp string.`);
  const parsed = new Date(value);
  invariant(
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value,
    `${label} must be a canonical ISO timestamp.`
  );
  return parsed;
}

function samePath(left, right, platform = process.platform) {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  return platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

export function validateRuntimeEvidence({
  result,
  continuity,
  manifest,
  runId,
  userDataDir,
  platform = "win32"
}) {
  assertExactKeys(
    continuity,
    [
      "schemaVersion",
      "kind",
      "runId",
      "baselineVersion",
      "targetVersion",
      "userDataDir",
      "nonce",
      "baselinePid",
      "createdAt"
    ],
    "continuity.json"
  );
  invariant(continuity.schemaVersion === 1, "continuity schemaVersion must be 1.");
  invariant(continuity.kind === CONTINUITY_KIND, `continuity kind must be ${CONTINUITY_KIND}.`);
  invariant(continuity.runId === runId, "continuity runId does not match the harness run.");
  invariant(
    continuity.baselineVersion === manifest.baseline.version,
    "continuity baselineVersion does not match the signed baseline."
  );
  invariant(
    continuity.targetVersion === manifest.target.version,
    "continuity targetVersion does not match the signed target."
  );
  invariant(
    typeof continuity.userDataDir === "string" &&
      samePath(continuity.userDataDir, userDataDir, platform),
    "continuity userDataDir is not the isolated harness userData directory."
  );
  invariant(
    typeof continuity.nonce === "string" && UUID_PATTERN.test(continuity.nonce),
    "continuity nonce must be a UUID."
  );
  assertPositiveSafeInteger(continuity.baselinePid, "continuity.baselinePid");
  const createdAt = isIsoTimestamp(continuity.createdAt, "continuity.createdAt");

  assertExactKeys(
    result,
    [
      "schemaVersion",
      "kind",
      "status",
      "runId",
      "baselineVersion",
      "targetVersion",
      "currentVersion",
      "relaunched",
      "sentinel",
      "markerCleared",
      "userDataDir",
      "dbPath",
      "pid",
      "completedAt"
    ],
    "result.json"
  );
  invariant(result.schemaVersion === 1, "result schemaVersion must be 1.");
  invariant(result.kind === RESULT_KIND, `result kind must be ${RESULT_KIND}.`);
  invariant(result.status === "success", "update smoke result status must be success.");
  invariant(result.runId === runId, "result runId does not match the harness run.");
  invariant(
    result.baselineVersion === manifest.baseline.version,
    "result baselineVersion does not match the signed baseline."
  );
  invariant(
    result.targetVersion === manifest.target.version &&
      result.currentVersion === manifest.target.version,
    "result target/current version does not match the signed target."
  );
  invariant(result.relaunched === true, "result must prove a relaunch.");
  invariant(result.markerCleared === true, "result must prove the install marker was cleared.");
  invariant(
    typeof result.userDataDir === "string" &&
      samePath(result.userDataDir, userDataDir, platform),
    "result userDataDir is not the isolated harness userData directory."
  );
  invariant(
    typeof result.dbPath === "string" &&
      samePath(result.dbPath, join(userDataDir, "pwrsnap.db"), platform),
    "result dbPath is not inside the isolated harness userData directory."
  );
  const pid = assertPositiveSafeInteger(result.pid, "result.pid");
  invariant(pid !== continuity.baselinePid, "target PID must differ from the baseline PID.");
  const completedAt = isIsoTimestamp(result.completedAt, "result.completedAt");
  invariant(completedAt >= createdAt, "result completedAt must not precede continuity creation.");

  assertExactKeys(
    result.sentinel,
    ["nonce", "baselinePid", "createdAt"],
    "result.sentinel"
  );
  invariant(
    result.sentinel.nonce === continuity.nonce &&
      result.sentinel.baselinePid === continuity.baselinePid &&
      result.sentinel.createdAt === continuity.createdAt,
    "result sentinel must exactly preserve continuity.json."
  );
  return { result, continuity };
}

export function sanitizedWindowsBaseEnvironment(baseEnvironment) {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    // The GitHub job starts under PowerShell 7, but the signature probes use
    // inbox Windows PowerShell 5.1 (`powershell.exe`). Inheriting pwsh's
    // PSModulePath makes 5.1 discover the incompatible PowerShell 7 copy of
    // Microsoft.PowerShell.Security and fail before Get-AuthenticodeSignature.
    // Leave it unset so each powershell.exe child constructs its own system
    // module path. Neither the installer nor PwrSnap needs this variable.
    if (SAFE_WINDOWS_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  return environment;
}

export function buildIsolatedSmokeEnvironment(baseEnvironment, options) {
  const environment = sanitizedWindowsBaseEnvironment(baseEnvironment);
  return {
    ...environment,
    APPDATA: options.appDataDir,
    LOCALAPPDATA: options.localAppDataDir,
    USERPROFILE: options.userProfileDir,
    HOME: options.userProfileDir,
    PWRSNAP_USER_DATA: options.userDataDir,
    TEMP: options.tempDir,
    TMP: options.tempDir,
    NO_PROXY: "127.0.0.1,localhost",
    NODE_ENV: "production",
    PWRSNAP_UPDATE_SMOKE: "1",
    PWRSNAP_UPDATE_SMOKE_BASELINE_VERSION: options.baselineVersion,
    PWRSNAP_UPDATE_SMOKE_TARGET_VERSION: options.targetVersion,
    PWRSNAP_UPDATE_SMOKE_RUN_ID: options.runId,
    PWRSNAP_UPDATE_SMOKE_FEED_URL: options.feedUrl,
    PWRSNAP_PROCESS_SPLIT: "0"
  };
}

export function parseByteRanges(header, size) {
  invariant(Number.isSafeInteger(size) && size > 0, "range asset size must be positive.");
  if (header === undefined) return null;
  invariant(typeof header === "string", "Range header must be a string.");
  const match = /^bytes=(.+)$/i.exec(header);
  invariant(match !== null, "Only byte ranges are supported.");
  const parts = match[1].split(",");
  invariant(parts.length > 0 && parts.length <= 1024, "Range count is invalid.");

  const ranges = parts.map((part) => {
    const range = /^\s*(\d*)-(\d*)\s*$/.exec(part);
    invariant(range !== null, "Range syntax is invalid.");
    invariant(range[1] !== "" || range[2] !== "", "Range cannot be empty.");
    if (range[1] === "") {
      const suffixLength = Number(range[2]);
      invariant(
        Number.isSafeInteger(suffixLength) && suffixLength > 0,
        "Range suffix length is invalid."
      );
      return {
        start: Math.max(0, size - suffixLength),
        end: size - 1
      };
    }
    const start = Number(range[1]);
    const requestedEnd = range[2] === "" ? size - 1 : Number(range[2]);
    invariant(
      Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd),
      "Range bounds are invalid."
    );
    invariant(start < size && requestedEnd >= start, "Range is unsatisfiable.");
    return { start, end: Math.min(requestedEnd, size - 1) };
  });
  return ranges;
}

function hasTraversalSyntax(rawPath) {
  return (
    rawPath.includes("\\") ||
    /%(?:2e|2f|5c)/i.test(rawPath) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)
  );
}

/** Pure request classifier used by the live loopback server and static tests. */
export function classifyUpdateRequest({
  method,
  rawUrl,
  host,
  expectedHost,
  targetAssetNames,
  latestYmlName = "latest.yml",
  expectedBaselineBlockmapName
}) {
  if (method !== "GET" && method !== "HEAD") {
    return { allowed: false, status: 405, reason: "method-not-allowed" };
  }
  if (host !== expectedHost) {
    return { allowed: false, status: 421, reason: "unexpected-host" };
  }
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) {
    return { allowed: false, status: 400, reason: "invalid-request-target" };
  }
  const queryIndex = rawUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1);
  if (hasTraversalSyntax(rawPath)) {
    return { allowed: false, status: 400, reason: "path-traversal" };
  }

  const assetName = rawPath.slice(1);
  if (assetName === expectedBaselineBlockmapName) {
    if (rawQuery !== "") {
      return { allowed: false, status: 400, reason: "unexpected-query", assetName };
    }
    return {
      allowed: false,
      status: 404,
      reason: "expected-baseline-blockmap-miss",
      assetName
    };
  }
  if (!targetAssetNames.includes(assetName)) {
    return { allowed: false, status: 404, reason: "unexpected-path", assetName };
  }
  if (assetName === latestYmlName) {
    if (rawQuery !== "" && !/^noCache=[0-9a-v]+$/.test(rawQuery)) {
      return { allowed: false, status: 400, reason: "invalid-latest-query", assetName };
    }
  } else if (rawQuery !== "") {
    return { allowed: false, status: 400, reason: "unexpected-query", assetName };
  }
  return { allowed: true, status: 200, reason: "allowed", assetName };
}

function contentTypeForAsset(fileName) {
  if (fileName.endsWith(".yml")) return "application/yaml";
  if (fileName.endsWith(".exe")) {
    return "application/vnd.microsoft.portable-executable";
  }
  return "application/octet-stream";
}

async function writeRange(response, filePath, start, end) {
  const input = createReadStream(filePath, { start, end });
  try {
    for await (const chunk of input) {
      if (!response.write(chunk)) await once(response, "drain");
    }
  } finally {
    input.destroy();
  }
}

function multipartPartHeader(boundary, contentType, range, size) {
  return Buffer.from(
    `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: bytes ${range.start}-${range.end}/${size}\r\n\r\n`,
    "ascii"
  );
}

async function serveAsset(request, response, asset, ranges) {
  const contentType = contentTypeForAsset(asset.fileName);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (ranges === null) {
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", String(asset.size));
    if (request.method === "HEAD") {
      response.end();
      return asset.size;
    }
    await writeRange(response, asset.path, 0, asset.size - 1);
    response.end();
    return asset.size;
  }

  response.statusCode = 206;
  if (ranges.length === 1) {
    const range = ranges[0];
    const length = range.end - range.start + 1;
    response.setHeader("Content-Type", contentType);
    response.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${asset.size}`
    );
    response.setHeader("Content-Length", String(length));
    if (request.method === "HEAD") {
      response.end();
      return length;
    }
    await writeRange(response, asset.path, range.start, range.end);
    response.end();
    return length;
  }

  const boundary = `pwrsnap-${createHash("sha256")
    .update(`${asset.fileName}:${request.headers.range}`)
    .digest("hex")
    .slice(0, 24)}`;
  const parts = ranges.map((range) => ({
    range,
    header: multipartPartHeader(boundary, contentType, range, asset.size)
  }));
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "ascii");
  const contentLength = parts.reduce(
    (total, part) =>
      total + part.header.length + (part.range.end - part.range.start + 1) + 2,
    closing.length - 2
  );
  response.setHeader("Content-Type", `multipart/byteranges; boundary=${boundary}`);
  response.setHeader("Content-Length", String(contentLength));
  if (request.method === "HEAD") {
    response.end();
    return contentLength;
  }
  for (const [index, part] of parts.entries()) {
    response.write(part.header);
    await writeRange(response, asset.path, part.range.start, part.range.end);
    response.write(index === parts.length - 1 ? closing : Buffer.from("\r\n", "ascii"));
  }
  response.end();
  return contentLength;
}

function responseError(response, status, method) {
  const body = Buffer.from(`${status}\n`, "ascii");
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/plain; charset=us-ascii");
  response.setHeader("Content-Length", String(body.length));
  if (status === 405) response.setHeader("Allow", "GET, HEAD");
  if (method === "HEAD") response.end();
  else response.end(body);
}

/**
 * Start a feed that can only bind to IPv4 loopback and only serves the three
 * signed target assets. Every decision is appended as one NDJSON record.
 */
export async function createIsolatedUpdateServer({
  assets,
  transcriptPath,
  latestYmlName = "latest.yml",
  expectedBaselineBlockmapName
}) {
  invariant(Array.isArray(assets) && assets.length === 3, "server requires exactly three target assets.");
  const assetMap = new Map();
  for (const asset of assets) {
    invariant(
      isPlainObject(asset) &&
        asset.fileName === basename(asset.fileName) &&
        SAFE_ASSET_NAME_PATTERN.test(asset.fileName) &&
        isAbsolute(asset.path) &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0,
      "server asset descriptors are invalid."
    );
    invariant(!assetMap.has(asset.fileName), "server asset names must be unique.");
    assetMap.set(asset.fileName, { ...asset });
  }
  invariant(assetMap.has(latestYmlName), "server assets must include latest.yml.");
  invariant(
    typeof expectedBaselineBlockmapName === "string" &&
      expectedBaselineBlockmapName === basename(expectedBaselineBlockmapName),
    "expected baseline blockmap name must be a basename."
  );

  await mkdir(dirname(transcriptPath), { recursive: true });
  const transcript = await open(transcriptPath, "wx");
  let transcriptTail = Promise.resolve();
  const records = [];
  const record = (entry) => {
    const complete = { timestamp: new Date().toISOString(), ...entry };
    records.push(complete);
    transcriptTail = transcriptTail.then(() =>
      transcript.appendFile(`${JSON.stringify(complete)}\n`, "utf8")
    );
  };

  let expectedHost;
  const targetAssetNames = [...assetMap.keys()];
  const server = createServer((request, response) => {
    const startedAt = Date.now();
    const hostHeaders = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === "host") {
        hostHeaders.push(request.rawHeaders[index + 1]);
      }
    }
    const classification = classifyUpdateRequest({
      method: request.method,
      rawUrl: request.url,
      host: hostHeaders.length === 1 ? hostHeaders[0] : undefined,
      expectedHost,
      targetAssetNames,
      latestYmlName,
      expectedBaselineBlockmapName
    });
    const baseRecord = {
      method: request.method ?? null,
      requestTarget: request.url ?? null,
      host: hostHeaders.length === 1 ? hostHeaders[0] : null,
      remoteAddress: request.socket.remoteAddress ?? null,
      assetName: classification.assetName ?? null,
      reason: classification.reason,
      range: typeof request.headers.range === "string" ? request.headers.range : null
    };

    if (request.socket.remoteAddress !== "127.0.0.1") {
      responseError(response, 403, request.method);
      record({
        ...baseRecord,
        reason: "non-loopback-client",
        status: 403,
        durationMs: Date.now() - startedAt
      });
      return;
    }
    if (!classification.allowed) {
      responseError(response, classification.status, request.method);
      record({
        ...baseRecord,
        status: classification.status,
        durationMs: Date.now() - startedAt
      });
      return;
    }

    const asset = assetMap.get(classification.assetName);
    let ranges;
    try {
      ranges = parseByteRanges(request.headers.range, asset.size);
    } catch (error) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${asset.size}`);
      response.setHeader("Content-Length", "0");
      response.end();
      record({
        ...baseRecord,
        reason: "invalid-range",
        status: 416,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt
      });
      return;
    }

    void serveAsset(request, response, asset, ranges)
      .then((bytes) => {
        record({
          ...baseRecord,
          reason: "served",
          status: response.statusCode,
          bytes,
          durationMs: Date.now() - startedAt
        });
      })
      .catch((error) => {
        if (!response.headersSent) responseError(response, 500, request.method);
        else response.destroy(error instanceof Error ? error : new Error(String(error)));
        record({
          ...baseRecord,
          reason: "serve-error",
          status: response.headersSent ? response.statusCode : 500,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt
        });
      });
  });
  server.on("clientError", (error, socket) => {
    record({
      method: null,
      requestTarget: null,
      host: null,
      remoteAddress: socket.remoteAddress ?? null,
      assetName: null,
      reason: "client-error",
      status: 400,
      error: error.message
    });
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address();
  invariant(
    address !== null && typeof address === "object" && address.address === "127.0.0.1",
    "update server did not bind to IPv4 loopback."
  );
  expectedHost = `127.0.0.1:${address.port}`;
  record({
    method: null,
    requestTarget: null,
    host: expectedHost,
    remoteAddress: "127.0.0.1",
    assetName: null,
    reason: "server-listening",
    status: null
  });

  let closed = false;
  return {
    url: `http://${expectedHost}/`,
    port: address.port,
    snapshot() {
      return records.map((recordValue) => ({ ...recordValue }));
    },
    async flushTranscript() {
      await transcriptTail;
    },
    async close() {
      if (closed) return;
      closed = true;
      const closePromise = new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
      server.closeAllConnections?.();
      await closePromise;
      await transcriptTail;
      await transcript.close();
    }
  };
}

export function validateUpdateServerEvidence(records, manifest) {
  invariant(Array.isArray(records), "server evidence must be an array.");
  const servedGets = (assetName) =>
    records.filter(
      (record) =>
        record.method === "GET" &&
        record.assetName === assetName &&
        record.reason === "served" &&
        (record.status === 200 || record.status === 206)
    );
  const latestRequests = servedGets(manifest.target.latestYml.fileName);
  invariant(
    latestRequests.some((record) =>
      /^\/latest\.yml\?noCache=[0-9a-v]+$/.test(record.requestTarget)
    ),
    "electron-updater did not fetch target latest.yml with its bounded noCache query."
  );
  invariant(
    servedGets(manifest.target.blockmap.fileName).length > 0,
    "electron-updater did not fetch the target blockmap."
  );
  invariant(
    servedGets(manifest.target.installer.fileName).length > 0,
    "electron-updater did not fetch the target installer."
  );

  const expectedBaselineBlockmap = `${manifest.baseline.installer.fileName}.blockmap`;
  invariant(
    records.some(
      (record) =>
        record.method === "GET" &&
        record.assetName === expectedBaselineBlockmap &&
        record.reason === "expected-baseline-blockmap-miss" &&
        record.status === 404
    ),
    "electron-updater did not receive the expected isolated-feed 404 for the baseline blockmap."
  );
  const violations = records.filter(
    (record) =>
      [
        "unexpected-host",
        "non-loopback-client",
        "path-traversal",
        "unexpected-path",
        "unexpected-query",
        "invalid-latest-query",
        "invalid-request-target",
        "method-not-allowed",
        "invalid-range",
        "serve-error",
        "client-error"
      ].includes(record.reason)
  );
  invariant(
    violations.length === 0,
    `isolated update feed recorded ${violations.length} unexpected request(s).`
  );
  return true;
}

async function readBoundedFile(filePath, maxBytes, label) {
  const metadata = await lstat(filePath);
  invariant(metadata.isFile(), `${label} must be a regular file (symlinks are rejected).`);
  invariant(metadata.size > 0 && metadata.size <= maxBytes, `${label} has an invalid size.`);
  return readFile(filePath);
}

async function readBoundedJson(filePath, maxBytes, label) {
  const bytes = await readBoundedFile(filePath, maxBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function hashRegularFile(filePath, label) {
  const before = await lstat(filePath);
  invariant(before.isFile(), `${label} must be a regular file (symlinks are rejected).`);
  invariant(before.size > 0, `${label} must not be empty.`);
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const input = createReadStream(filePath);
  for await (const chunk of input) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  const after = await lstat(filePath);
  invariant(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs,
    `${label} changed while it was being validated.`
  );
  return {
    size: after.size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64")
  };
}

async function validateManifestAsset(inputDirectory, descriptor, label) {
  const assetPath = join(inputDirectory, descriptor.fileName);
  const digest = await hashRegularFile(assetPath, label);
  invariant(
    digest.size === descriptor.size,
    `${label} size does not match smoke-input.json.`
  );
  invariant(
    digest.sha256 === descriptor.sha256,
    `${label} SHA-256 does not match smoke-input.json.`
  );
  return {
    fileName: descriptor.fileName,
    path: assetPath,
    ...digest
  };
}

export async function loadSmokeInput(inputDirectory) {
  const manifestPath = join(inputDirectory, SMOKE_INPUT_FILE);
  const rawManifest = await readBoundedJson(
    manifestPath,
    MAX_MANIFEST_BYTES,
    SMOKE_INPUT_FILE
  );
  const manifest = validateSmokeInputManifest(rawManifest);
  const baselineInstaller = await validateManifestAsset(
    inputDirectory,
    manifest.baseline.installer,
    "baseline installer"
  );
  const targetInstaller = await validateManifestAsset(
    inputDirectory,
    manifest.target.installer,
    "target installer"
  );
  const targetBlockmap = await validateManifestAsset(
    inputDirectory,
    manifest.target.blockmap,
    "target blockmap"
  );
  const targetLatestYml = await validateManifestAsset(
    inputDirectory,
    manifest.target.latestYml,
    "target latest.yml"
  );
  invariant(
    targetLatestYml.size <= MAX_LATEST_YML_BYTES,
    "target latest.yml exceeds the smoke harness limit."
  );
  const latestYmlText = (
    await readFile(targetLatestYml.path, { encoding: "utf8" })
  ).replace(/^\uFEFF/, "");
  validateLatestYml(latestYmlText, {
    version: manifest.target.version,
    installerFileName: manifest.target.installer.fileName,
    installerSize: manifest.target.installer.size,
    installerSha512: targetInstaller.sha512
  });
  return {
    manifest,
    manifestPath,
    assets: {
      baselineInstaller,
      targetInstaller,
      targetBlockmap,
      targetLatestYml
    }
  };
}

function captureChildStream(stream) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  stream?.on("data", (chunk) => {
    const buffer = Buffer.from(chunk);
    if (bytes < MAX_CAPTURED_PROCESS_BYTES) {
      const remaining = MAX_CAPTURED_PROCESS_BYTES - bytes;
      chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(buffer.length, remaining);
    }
    if (bytes >= MAX_CAPTURED_PROCESS_BYTES && buffer.length > 0) truncated = true;
  });
  return () => {
    const text = Buffer.concat(chunks).toString("utf8");
    return truncated ? `${text}\n[output truncated by PwrSnap smoke harness]\n` : text;
  };
}

async function terminateSingleProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/** Run one child with captured output and a hard wall-clock bound. */
export async function runBoundedProcess({
  command,
  arguments: commandArguments = [],
  cwd,
  environment = process.env,
  timeoutMs,
  windowsHide = true,
  terminate = terminateSingleProcess
}) {
  invariant(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "bounded child timeout must be positive."
  );
  const startedAt = Date.now();
  const child = spawn(command, commandArguments, {
    cwd,
    env: environment,
    windowsHide,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = captureChildStream(child.stdout);
  const stderr = captureChildStream(child.stderr);
  const completion = new Promise((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveCompletion({ code, signal }));
  });
  let timeout;
  const timedOut = new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs);
  });

  let outcome;
  try {
    outcome = await Promise.race([
      completion.then((value) => ({ timeout: false, ...value })),
      timedOut
    ]);
    if (outcome.timeout) {
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        await terminate(child.pid);
      }
      await Promise.race([
        completion.catch(() => undefined),
        new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
      ]);
      const timeoutError = new Error(
        `Bounded child ${command} timed out after ${timeoutMs} ms (PID ${child.pid ?? "unknown"}).`
      );
      timeoutError.stdout = stdout();
      timeoutError.stderr = stderr();
      timeoutError.durationMs = Date.now() - startedAt;
      throw timeoutError;
    }
  } finally {
    clearTimeout(timeout);
  }
  return {
    pid: child.pid,
    code: outcome.code,
    signal: outcome.signal,
    stdout: stdout(),
    stderr: stderr(),
    durationMs: Date.now() - startedAt
  };
}

async function terminateExactProcessTree(pid) {
  const result = await runBoundedProcess({
    command: "taskkill.exe",
    arguments: ["/PID", String(pid), "/T", "/F"],
    environment: sanitizedWindowsBaseEnvironment(process.env),
    timeoutMs: PROCESS_STOP_TIMEOUT_MS,
    terminate: terminateSingleProcess
  });
  // 128 means the process disappeared between enumeration and taskkill.
  invariant(
    result.code === 0 || result.code === 128,
    `taskkill failed for PID ${pid}: ${result.stderr || result.stdout}`
  );
  return result;
}

function withCaseInsensitiveEnvironment(baseEnvironment, additions) {
  const replaced = new Set(Object.keys(additions).map((key) => key.toUpperCase()));
  const result = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (!replaced.has(key.toUpperCase())) result[key] = value;
  }
  return { ...result, ...additions };
}

async function invokePowerShellJson({ script, environment, timeoutMs }) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await runBoundedProcess({
    command: "powershell.exe",
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded
    ],
    environment,
    timeoutMs,
    terminate: terminateExactProcessTree
  });
  invariant(
    result.code === 0 && result.signal === null,
    `PowerShell probe failed: ${result.stderr || result.stdout}`
  );
  const output = result.stdout.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `PowerShell probe did not return JSON: ${error instanceof Error ? error.message : String(error)}; stderr=${result.stderr}`
    );
  }
}

const POWERSHELL_UTF8_PREFIX = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
`;

async function readAuthenticodeEvidence(filePath, expectedPublisher, environment) {
  const script = `${POWERSHELL_UTF8_PREFIX}
$signature = Get-AuthenticodeSignature -LiteralPath $env:PWRSNAP_PROBE_PATH
$certificate = $signature.SignerCertificate
$evidence = [ordered]@{
  status = [string]$signature.Status
  subject = if ($null -eq $certificate) { '' } else { [string]$certificate.Subject }
  simpleName = if ($null -eq $certificate) { '' } else { [string]$certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }
  thumbprint = if ($null -eq $certificate) { '' } else { [string]$certificate.Thumbprint }
}
$evidence | ConvertTo-Json -Compress
`;
  const evidence = await invokePowerShellJson({
    script,
    environment: withCaseInsensitiveEnvironment(
      sanitizedWindowsBaseEnvironment(environment),
      {
        PWRSNAP_PROBE_PATH: filePath
      }
    ),
    timeoutMs: SIGNATURE_TIMEOUT_MS
  });
  return validateAuthenticodeEvidence(evidence, expectedPublisher);
}

export function validateWindowsVersionEvidence(value, expectedVersion) {
  assertExactKeys(value, ["fileVersion", "productVersion"], "Windows version evidence");
  const parsed = parseExactSemver(expectedVersion);
  const expectedCore = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  invariant(
    typeof value.fileVersion === "string" &&
      (value.fileVersion === expectedVersion ||
        value.fileVersion === expectedCore ||
        value.fileVersion.startsWith(`${expectedCore}.`)),
    `installed PE FileVersion must be ${expectedVersion} or use the ${expectedCore} numeric release core.`
  );
  invariant(
    typeof value.productVersion === "string" &&
      (value.productVersion === expectedCore ||
        value.productVersion.startsWith(`${expectedCore}.`)),
    `installed PE ProductVersion must use the ${expectedCore} numeric release core.`
  );
  return value;
}

async function readWindowsVersionEvidence(filePath, expectedVersion, environment) {
  const script = `${POWERSHELL_UTF8_PREFIX}
$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:PWRSNAP_PROBE_PATH)
[ordered]@{
  fileVersion = [string]$version.FileVersion
  productVersion = [string]$version.ProductVersion
} | ConvertTo-Json -Compress
`;
  const evidence = await invokePowerShellJson({
    script,
    environment: withCaseInsensitiveEnvironment(
      sanitizedWindowsBaseEnvironment(environment),
      {
        PWRSNAP_PROBE_PATH: filePath
      }
    ),
    timeoutMs: SIGNATURE_TIMEOUT_MS
  });
  return validateWindowsVersionEvidence(evidence, expectedVersion);
}

async function queryProcessByPid(pid, environment) {
  const script = `${POWERSHELL_UTF8_PREFIX}
$targetPid = [int]$env:PWRSNAP_PROBE_PID
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid"
if ($null -eq $process) {
  ConvertTo-Json -InputObject $null -Compress
} else {
  [ordered]@{
    pid = [int]$process.ProcessId
    executablePath = [string]$process.ExecutablePath
  } | ConvertTo-Json -Compress
}
`;
  return invokePowerShellJson({
    script,
    environment: withCaseInsensitiveEnvironment(
      sanitizedWindowsBaseEnvironment(environment),
      {
        PWRSNAP_PROBE_PID: String(pid)
      }
    ),
    timeoutMs: PROCESS_QUERY_TIMEOUT_MS
  });
}

async function waitForExactProcessPath(pid, expectedPath, environment, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastEvidence = null;
  while (Date.now() < deadline) {
    lastEvidence = await queryProcessByPid(pid, environment);
    if (
      lastEvidence !== null &&
      lastEvidence.pid === pid &&
      typeof lastEvidence.executablePath === "string" &&
      samePath(lastEvidence.executablePath, expectedPath, "win32")
    ) {
      return lastEvidence;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `PID ${pid} was not observed at the exact installed executable path ${expectedPath}; last evidence=${JSON.stringify(lastEvidence)}.`
  );
}

async function enumerateProcessesBelowRoot(rootPath, environment) {
  const script = `${POWERSHELL_UTF8_PREFIX}
$root = [System.IO.Path]::GetFullPath($env:PWRSNAP_PROCESS_ROOT).TrimEnd('\\')
$rootPrefix = $root + '\\'
$matches = @(
  Get-CimInstance Win32_Process | ForEach-Object {
    $candidate = [string]$_.ExecutablePath
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      $full = [System.IO.Path]::GetFullPath($candidate)
      if ($full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        [ordered]@{ pid = [int]$_.ProcessId; executablePath = $full }
      }
    }
  }
)
ConvertTo-Json -InputObject @($matches) -Compress
`;
  const evidence = await invokePowerShellJson({
    script,
    environment: withCaseInsensitiveEnvironment(
      sanitizedWindowsBaseEnvironment(environment),
      {
        PWRSNAP_PROCESS_ROOT: rootPath
      }
    ),
    timeoutMs: PROCESS_QUERY_TIMEOUT_MS
  });
  invariant(Array.isArray(evidence), "process enumeration must return an array.");
  return evidence.map((item) => {
    assertExactKeys(item, ["pid", "executablePath"], "process evidence");
    assertPositiveSafeInteger(item.pid, "process evidence pid");
    invariant(
      typeof item.executablePath === "string" &&
        pathIsWithin(rootPath, item.executablePath, "win32"),
      "process enumeration returned a path outside the exact install root."
    );
    return item;
  });
}

async function cleanupInstalledProcessTrees(installDirectory, environment) {
  const killed = [];
  for (let pass = 0; pass < 3; pass += 1) {
    const processes = await enumerateProcessesBelowRoot(installDirectory, environment);
    if (processes.length === 0) return killed;
    for (const processEvidence of processes) {
      const result = await terminateExactProcessTree(processEvidence.pid);
      killed.push({ ...processEvidence, taskkillCode: result.code });
    }
  }
  const remaining = await enumerateProcessesBelowRoot(installDirectory, environment);
  invariant(
    remaining.length === 0,
    `processes remain under the isolated install root: ${JSON.stringify(remaining)}`
  );
  return killed;
}

async function writeAtomicJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporaryPath, filePath);
}

async function createEventRecorder(filePath) {
  const handle = await open(filePath, "wx");
  let tail = Promise.resolve();
  return {
    record(phase, details = {}) {
      const event = {
        timestamp: new Date().toISOString(),
        phase,
        ...details
      };
      tail = tail.then(() => handle.appendFile(`${JSON.stringify(event)}\n`, "utf8"));
      return tail;
    },
    async close() {
      await tail;
      await handle.close();
    }
  };
}

async function installBaseline({ installerPath, installDirectory, environment, diagnosticsDirectory }) {
  await mkdir(dirname(installDirectory), { recursive: true });
  let result;
  try {
    result = await runBoundedProcess({
      command: installerPath,
      // NSIS requires /D to be the final argument and in /D=<path> form.
      arguments: ["/S", `/D=${installDirectory}`],
      environment,
      timeoutMs: INSTALL_TIMEOUT_MS,
      terminate: terminateExactProcessTree
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await Promise.all([
      writeFile(
        join(diagnosticsDirectory, "baseline-installer.stdout.log"),
        typeof error?.stdout === "string" ? error.stdout : "",
        "utf8"
      ),
      writeFile(
        join(diagnosticsDirectory, "baseline-installer.stderr.log"),
        `${typeof error?.stderr === "string" ? error.stderr : ""}\n${message}\n`,
        "utf8"
      )
    ]);
    throw error;
  }
  await Promise.all([
    writeFile(join(diagnosticsDirectory, "baseline-installer.stdout.log"), result.stdout, "utf8"),
    writeFile(join(diagnosticsDirectory, "baseline-installer.stderr.log"), result.stderr, "utf8")
  ]);
  invariant(
    result.code === 0 && result.signal === null,
    `baseline installer failed with code ${result.code}, signal ${result.signal}: ${result.stderr}`
  );
  return result;
}

async function launchInstalledApplication({
  executablePath,
  installDirectory,
  environment,
  diagnosticsDirectory
}) {
  const stdoutHandle = await open(
    join(diagnosticsDirectory, "baseline-app.stdout.log"),
    "wx"
  );
  const stderrHandle = await open(
    join(diagnosticsDirectory, "baseline-app.stderr.log"),
    "wx"
  );
  let child;
  let launchTimeout;
  try {
    child = spawn(executablePath, [], {
      cwd: installDirectory,
      env: environment,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd]
    });
    const spawned = once(child, "spawn");
    await Promise.race([
      spawned,
      new Promise((_, reject) =>
        (launchTimeout = setTimeout(
          () => reject(new Error("installed PwrSnap launch timed out.")),
          15_000
        ))
      )
    ]);
  } catch (error) {
    if (child?.pid) await terminateExactProcessTree(child.pid).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(launchTimeout);
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  }
  invariant(Number.isSafeInteger(child.pid) && child.pid > 0, "installed PwrSnap did not have a PID.");
  child.unref();
  return child.pid;
}

async function waitForRuntimeResult(resultPath, timeoutMs = UPDATE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await readBoundedJson(
        resultPath,
        MAX_MANIFEST_BYTES,
        "update smoke result"
      );
      if (result?.kind === RESULT_KIND && result?.status === "failure") {
        throw new Error(
          `packaged update smoke reported failure in ${String(result.phase ?? "unknown phase")}: ${String(result.error ?? "unknown error")}`
        );
      }
      return result;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${resultPath}.`);
}

async function assertRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  invariant(metadata.isFile(), `${label} must be a regular file.`);
  return metadata;
}

async function assertPathAbsent(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must be absent: ${filePath}`);
}

export async function collectBoundedDirectoryInventory(
  rootDirectory,
  { maxEntries = 5_000, maxHashBytes = 1024 * 1024 } = {}
) {
  const entries = [];
  const pending = [{ absolutePath: rootDirectory, relativePath: "" }];
  let truncated = false;
  while (pending.length > 0) {
    const current = pending.shift();
    let children;
    try {
      children = await readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      entries.push({
        path: current.relativePath || ".",
        type: "unreadable-directory",
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        pending.length = 0;
        break;
      }
      const absolutePath = join(current.absolutePath, child.name);
      const relativePath = current.relativePath
        ? join(current.relativePath, child.name)
        : child.name;
      if (child.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink-not-followed" });
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        pending.push({ absolutePath, relativePath });
        continue;
      }
      if (!child.isFile()) {
        entries.push({ path: relativePath, type: "other" });
        continue;
      }
      try {
        const metadata = await stat(absolutePath);
        const entry = {
          path: relativePath,
          type: "file",
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
          sha256: null,
          hashOmitted: metadata.size > maxHashBytes ? "size-limit" : null
        };
        if (metadata.size <= maxHashBytes) {
          entry.sha256 = createHash("sha256")
            .update(await readFile(absolutePath))
            .digest("hex");
        }
        entries.push(entry);
      } catch (error) {
        entries.push({
          path: relativePath,
          type: "unreadable-file",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    rootDirectory,
    maxEntries,
    maxHashBytes,
    truncated,
    entries
  };
}

async function bestEffort(label, operation) {
  try {
    return { status: "ok", value: await operation() };
  } catch (error) {
    return {
      status: "error",
      label,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null
    };
  }
}

async function collectBestEffortInstalledEvidence({
  executablePath,
  installDirectory,
  manifest,
  expectedPublisher,
  environment
}) {
  const marker = await bestEffort("installed build marker", async () => {
    const markerPath = join(
      installDirectory,
      "resources",
      INSTALLED_BUILD_MARKER_FILE
    );
    return {
      path: markerPath,
      value: await readBoundedJson(
        markerPath,
        MAX_MANIFEST_BYTES,
        "installed smoke build marker"
      )
    };
  });
  const markerVersion =
    marker.status === "ok" &&
    marker.value.value?.kind === BUILD_MARKER_KIND &&
    [manifest.baseline.version, manifest.target.version].includes(
      marker.value.value.version
    )
      ? marker.value.value.version
      : undefined;
  return {
    executablePath,
    marker,
    signature: await bestEffort("installed Authenticode", () =>
      readAuthenticodeEvidence(executablePath, expectedPublisher, environment)
    ),
    windowsVersion:
      markerVersion === undefined
        ? {
            status: "error",
            label: "installed Windows version",
            error: "no valid baseline/target marker version was available"
          }
        : await bestEffort("installed Windows version", () =>
            readWindowsVersionEvidence(
              executablePath,
              markerVersion,
              environment
            )
          ),
    executableDigest: await bestEffort("installed executable digest", () =>
      hashRegularFile(executablePath, "installed PwrSnap executable")
    )
  };
}

async function readInstalledMarker(installDirectory, expectedVersion) {
  const markerPath = join(
    installDirectory,
    "resources",
    INSTALLED_BUILD_MARKER_FILE
  );
  const marker = await readBoundedJson(
    markerPath,
    MAX_MANIFEST_BYTES,
    "installed smoke build marker"
  );
  return {
    path: markerPath,
    value: validateInstalledBuildMarker(marker, expectedVersion)
  };
}

export function pathIsWithin(parentPath, candidatePath, platform = process.platform) {
  const parent = resolve(parentPath);
  const candidate = resolve(candidatePath);
  const normalizedParent = platform === "win32" ? parent.toLowerCase() : parent;
  const normalizedCandidate = platform === "win32" ? candidate.toLowerCase() : candidate;
  const difference = relative(normalizedParent, normalizedCandidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

export function assertNonOverlappingDirectories(inputDirectory, diagnosticsDirectory) {
  invariant(
    !pathIsWithin(inputDirectory, diagnosticsDirectory) &&
      !pathIsWithin(diagnosticsDirectory, inputDirectory),
    "input and diagnostics directories must not overlap."
  );
}

export function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set([
    "--input-dir",
    "--diagnostics-dir",
    "--expected-publisher"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    invariant(allowed.has(argument), `Unknown updater smoke argument: ${argument}`);
    invariant(!values.has(argument), `Duplicate updater smoke argument: ${argument}`);
    const value = argv[index + 1];
    invariant(value !== undefined && !value.startsWith("--"), `Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  for (const argument of allowed) {
    invariant(values.has(argument), `Required updater smoke argument is missing: ${argument}.`);
  }
  return {
    inputDirectory: resolve(values.get("--input-dir")),
    diagnosticsDirectory: resolve(values.get("--diagnostics-dir")),
    expectedPublisher: values.get("--expected-publisher")
  };
}

async function inspectInstalledApplication({
  executablePath,
  installDirectory,
  expectedVersion,
  expectedPublisher,
  environment
}) {
  await assertRegularFile(executablePath, "installed PwrSnap executable");
  const [signature, windowsVersion, marker, executableDigest] = await Promise.all([
    readAuthenticodeEvidence(executablePath, expectedPublisher, environment),
    readWindowsVersionEvidence(executablePath, expectedVersion, environment),
    readInstalledMarker(installDirectory, expectedVersion),
    hashRegularFile(executablePath, "installed PwrSnap executable")
  ]);
  return { signature, windowsVersion, marker, executableDigest };
}

/** Execute the packaged signed updater smoke. This function is Windows-only. */
export async function runWindowsUpdateSmoke({
  inputDirectory,
  diagnosticsDirectory,
  expectedPublisher,
  platform = process.platform,
  baseEnvironment = process.env
}) {
  invariant(platform === "win32", "The packaged updater smoke can only run on Windows.");
  validateExpectedPublisher(expectedPublisher);
  assertNonOverlappingDirectories(inputDirectory, diagnosticsDirectory);
  await mkdir(diagnosticsDirectory, { recursive: true });

  const events = await createEventRecorder(
    join(diagnosticsDirectory, "harness-events.ndjson")
  );
  let server;
  let environment;
  let installDirectory;
  let installedExecutable;
  let localAppDataDirectory;
  let manifest;
  let primaryError;
  let cleanupError;
  let summary;
  let feedRecords = [];
  let cleanupEvidence = [];
  const diagnosticErrors = [];
  const startedAt = new Date().toISOString();

  try {
    await events.record("validate-input:start");
    await assertRegularFile(join(inputDirectory, SMOKE_INPUT_FILE), SMOKE_INPUT_FILE);
    const input = await loadSmokeInput(inputDirectory);
    ({ manifest } = input);
    const { assets } = input;
    await writeAtomicJson(
      join(diagnosticsDirectory, "validated-smoke-input.json"),
      manifest
    );
    await writeFile(
      join(diagnosticsDirectory, "served-latest.yml"),
      await readFile(assets.targetLatestYml.path)
    );
    await events.record("validate-input:complete", {
      baselineVersion: manifest.baseline.version,
      targetVersion: manifest.target.version
    });

    const workDirectory = await mkdtemp(
      join(resolve(baseEnvironment.RUNNER_TEMP || tmpdir()), "pwrsnap-update-smoke-")
    );
    const userDataDirectory = join(diagnosticsDirectory, "user-data");
    const appDataDirectory = join(diagnosticsDirectory, "appdata-roaming");
    localAppDataDirectory = join(workDirectory, "local-appdata");
    const userProfileDirectory = join(workDirectory, "user-profile");
    const tempDirectory = join(workDirectory, "temp");
    installDirectory = join(workDirectory, "install", "PwrSnap");
    const runId = randomUUID();
    await Promise.all(
      [
        userDataDirectory,
        appDataDirectory,
        localAppDataDirectory,
        userProfileDirectory,
        tempDirectory
      ].map((directory) => mkdir(directory, { recursive: true }))
    );
    await events.record("isolation:ready", {
      runId,
      workDirectory,
      userDataDirectory,
      installDirectory
    });

    const inputSignatures = {
      baselineInstaller: await readAuthenticodeEvidence(
        assets.baselineInstaller.path,
        expectedPublisher,
        baseEnvironment
      ),
      targetInstaller: await readAuthenticodeEvidence(
        assets.targetInstaller.path,
        expectedPublisher,
        baseEnvironment
      )
    };
    await writeAtomicJson(
      join(diagnosticsDirectory, "input-authenticode.json"),
      inputSignatures
    );
    await events.record("input-signatures:valid");

    server = await createIsolatedUpdateServer({
      assets: [
        {
          fileName: assets.targetLatestYml.fileName,
          path: assets.targetLatestYml.path,
          size: assets.targetLatestYml.size
        },
        {
          fileName: assets.targetInstaller.fileName,
          path: assets.targetInstaller.path,
          size: assets.targetInstaller.size
        },
        {
          fileName: assets.targetBlockmap.fileName,
          path: assets.targetBlockmap.path,
          size: assets.targetBlockmap.size
        }
      ],
      transcriptPath: join(diagnosticsDirectory, "feed-requests.ndjson"),
      latestYmlName: manifest.target.latestYml.fileName,
      expectedBaselineBlockmapName: `${manifest.baseline.installer.fileName}.blockmap`
    });
    invariant(
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(server.url),
      "isolated feed URL must be an ephemeral IPv4 loopback URL."
    );
    environment = buildIsolatedSmokeEnvironment(baseEnvironment, {
      appDataDir: appDataDirectory,
      localAppDataDir: localAppDataDirectory,
      userProfileDir: userProfileDirectory,
      userDataDir: userDataDirectory,
      tempDir: tempDirectory,
      baselineVersion: manifest.baseline.version,
      targetVersion: manifest.target.version,
      runId,
      feedUrl: server.url
    });
    await events.record("feed:listening", { feedUrl: server.url });

    await events.record("baseline-install:start");
    await installBaseline({
      installerPath: assets.baselineInstaller.path,
      installDirectory,
      environment,
      diagnosticsDirectory
    });
    installedExecutable = join(installDirectory, INSTALLED_APP_FILE);
    const baselineInspection = await inspectInstalledApplication({
      executablePath: installedExecutable,
      installDirectory,
      expectedVersion: manifest.baseline.version,
      expectedPublisher,
      environment
    });
    await writeAtomicJson(
      join(diagnosticsDirectory, "installed-baseline-evidence.json"),
      baselineInspection
    );
    await events.record("baseline-install:valid");

    const baselinePid = await launchInstalledApplication({
      executablePath: installedExecutable,
      installDirectory,
      environment,
      diagnosticsDirectory
    });
    const baselineProcess = await waitForExactProcessPath(
      baselinePid,
      installedExecutable,
      environment
    );
    await events.record("baseline-launch:valid", baselineProcess);

    const stateDirectory = join(userDataDirectory, "windows-update-smoke");
    const resultPath = join(stateDirectory, "result.json");
    const continuityPath = join(stateDirectory, "continuity.json");
    const result = await waitForRuntimeResult(resultPath);
    const continuity = await readBoundedJson(
      continuityPath,
      MAX_MANIFEST_BYTES,
      "update smoke continuity"
    );
    validateRuntimeEvidence({
      result,
      continuity,
      manifest,
      runId,
      userDataDir: userDataDirectory,
      platform: "win32",
      baselinePid
    });
    invariant(
      continuity.baselinePid === baselinePid,
      "runtime continuity PID must exactly equal the process launched by the harness."
    );
    await assertRegularFile(result.dbPath, "continuity database");
    await assertPathAbsent(
      join(userDataDirectory, "pwrsnap-update-install-attempt.json"),
      "electron-updater install-attempt marker"
    );
    await events.record("runtime-result:valid", {
      baselinePid,
      targetPid: result.pid,
      currentVersion: result.currentVersion
    });

    await server.flushTranscript();
    feedRecords = server.snapshot();
    validateUpdateServerEvidence(feedRecords, manifest);
    await events.record("feed-evidence:valid");

    const targetInspection = await inspectInstalledApplication({
      executablePath: installedExecutable,
      installDirectory,
      expectedVersion: manifest.target.version,
      expectedPublisher,
      environment
    });
    invariant(
      targetInspection.executableDigest.sha256 !==
        baselineInspection.executableDigest.sha256,
      "installed executable did not change across the update."
    );
    await writeAtomicJson(
      join(diagnosticsDirectory, "installed-target-evidence.json"),
      targetInspection
    );
    await events.record("installed-target:valid");

    summary = {
      schemaVersion: 1,
      kind: "pwrsnap-windows-update-smoke-harness-result",
      status: "success",
      startedAt,
      completedAt: new Date().toISOString(),
      runId,
      github: manifest.github,
      baselineVersion: manifest.baseline.version,
      targetVersion: manifest.target.version,
      workDirectory,
      diagnosticsDirectory,
      userDataDirectory,
      installDirectory,
      baselinePid,
      targetPid: result.pid
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    await events.record("harness:failure", {
      error: primaryError.message,
      stack: primaryError.stack ?? null
    });
  } finally {
    let processesBeforeCleanup = {
      status: "unavailable",
      reason: "install environment was not initialized"
    };
    let processesAfterCleanup = processesBeforeCleanup;
    if (installDirectory && environment) {
      processesBeforeCleanup = await bestEffort(
        "process inventory before cleanup",
        () => enumerateProcessesBelowRoot(installDirectory, environment)
      );
      try {
        cleanupEvidence = await cleanupInstalledProcessTrees(
          installDirectory,
          environment
        );
        await events.record("cleanup:complete", {
          killedProcessCount: cleanupEvidence.length,
          processes: cleanupEvidence
        });
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
        await events.record("cleanup:failure", {
          error: cleanupError.message,
          stack: cleanupError.stack ?? null
        });
      }
      processesAfterCleanup = await bestEffort(
        "process inventory after cleanup",
        () => enumerateProcessesBelowRoot(installDirectory, environment)
      );
    }
    if (server) {
      try {
        feedRecords = server.snapshot();
        await server.close();
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new Error(String(error));
      }
    }

    const writeDiagnostic = async (fileName, operation) => {
      try {
        await writeAtomicJson(join(diagnosticsDirectory, fileName), await operation());
      } catch (error) {
        const diagnosticError = {
          fileName,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack ?? null : null
        };
        diagnosticErrors.push(diagnosticError);
        await events.record("diagnostics:failure", diagnosticError).catch(() => undefined);
      }
    };
    await writeDiagnostic("process-inventory.json", async () => ({
      schemaVersion: 1,
      installDirectory: installDirectory ?? null,
      beforeCleanup: processesBeforeCleanup,
      killed: cleanupEvidence,
      afterCleanup: processesAfterCleanup
    }));
    await writeDiagnostic("localappdata-inventory.json", async () =>
      localAppDataDirectory
        ? collectBoundedDirectoryInventory(localAppDataDirectory)
        : {
            schemaVersion: 1,
            rootDirectory: null,
            unavailable: "LOCALAPPDATA isolation was not initialized"
          }
    );
    await writeDiagnostic("install-inventory.json", async () =>
      installDirectory
        ? collectBoundedDirectoryInventory(installDirectory)
        : {
            schemaVersion: 1,
            rootDirectory: null,
            unavailable: "install root was not initialized"
          }
    );
    await writeDiagnostic("installed-final-best-effort.json", async () =>
      installedExecutable && installDirectory && manifest && environment
        ? collectBestEffortInstalledEvidence({
            executablePath: installedExecutable,
            installDirectory,
            manifest,
            expectedPublisher,
            environment
          })
        : {
            schemaVersion: 1,
            executablePath: installedExecutable ?? null,
            unavailable: "installed app evidence prerequisites were not initialized"
          }
    );
  }

  const diagnosticsError =
    diagnosticErrors.length === 0
      ? undefined
      : new Error(
          `required updater-smoke diagnostic collection failed for: ${diagnosticErrors
            .map((error) => error.fileName)
            .join(", ")}`
        );
  const finalError = primaryError ?? cleanupError ?? diagnosticsError;
  const finalSummary = finalError
    ? {
        schemaVersion: 1,
        kind: "pwrsnap-windows-update-smoke-harness-result",
        status: "failure",
        startedAt,
        completedAt: new Date().toISOString(),
        diagnosticsDirectory,
        installDirectory: installDirectory ?? null,
        error: finalError.message,
        stack: finalError.stack ?? null,
        cleanupError: cleanupError?.message ?? null,
        feedRecordCount: feedRecords.length,
        killedProcessCount: cleanupEvidence.length,
        diagnosticErrors
      }
    : {
        ...summary,
        killedProcessCount: cleanupEvidence.length,
        feedRecordCount: feedRecords.length,
        diagnosticErrors
      };
  await writeAtomicJson(
    join(diagnosticsDirectory, "harness-result.json"),
    finalSummary
  );
  await events.close();
  if (finalError) throw finalError;
  return finalSummary;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await runWindowsUpdateSmoke(options);
  process.stdout.write(
    `PwrSnap packaged Windows update smoke passed: ${result.baselineVersion} -> ${result.targetVersion}\nDiagnostics: ${result.diagnosticsDirectory}\n`
  );
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(
      `PwrSnap packaged Windows update smoke failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
