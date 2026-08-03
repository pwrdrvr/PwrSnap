// Codex CLI discovery for PwrSnap — a thin host wrapper over
// @pwrdrvr/codex-discovery's generic `discoverCommands` primitive.
//
// Previously this file was a near-verbatim lift of PwrAgnt's discovery. It now
// delegates the candidate-building + selection to the agent-kit package and
// keeps only the PwrSnap-specific bindings the kit doesn't bake in:
//
//   • PWRSNAP_CODEX_COMMAND env-var name (the kit's codex-specific
//     `discoverCodexCommands` hardcodes PWRDRVR_CODEX_COMMAND, so we drive the
//     GENERIC `discoverCommands` with our own env name instead).
//   • PwrSnap's selection/no-throw semantics: `resolveCodexCommand` falls back
//     to the configured command (or `codex`) when discovery finds nothing.
//     Discovery marks old candidates unavailable, and the App Server pool
//     independently guards the exact command before spawning it.
//   • `probeCodexAuth` (a `codex login status` probe) which the kit doesn't
//     surface in this shape.
//   • The `Desktop*` type names + `MINIMUM_CODEX_CLI_VERSION`, kept so
//     desktop-settings-service.ts and its tests import the same names as before.
//
// Looks for the Codex binary in this priority order:
//   1. env override (PWRSNAP_CODEX_COMMAND).
//   2. user-configured path saved in Settings.
//   3. `codex` on $PATH (plus `codex.exe` first on Windows).
//   4. Platform install locations:
//      - macOS: /Applications + ~/Applications ChatGPT.app/Codex.app bundled
//        binaries, explicit Homebrew prefixes, and every installed nvm node
//        version's bin dir — all for GUI-launched sparse PATHs.
//      - Windows: %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe
//        (and the Program Files equivalent).
//
// "$PATH" here is the app's INHERITED PATH only. PwrSnap never spawns the
// user's login shell to hydrate PATH (that resolver was removed 2026-08 —
// see docs/solutions/2026-08-03-e2e-teardown-login-shell-hang.md). A binary
// that lives somewhere launchd's sparse PATH misses must be covered by an
// explicit filesystem candidate above, or pinned in Settings → AI.

import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, readdirSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  compareCodexCliVersions as kitCompareCodexCliVersions,
  discoverCommands,
  pathIsExecutable as kitPathIsExecutable,
  type CommandDiscoveryCandidate,
  type CommandDiscoverySnapshot
} from "@pwrdrvr/codex-discovery";

import { PWRSNAP_CODEX_COMMAND_ENV } from "./env";
import {
  clearCodexCliCompatibilityAlert,
  CodexCliTooOldError,
  reportCodexCliTooOld
} from "./codex-compatibility-alert";

const execFile = promisify(execFileCallback);

/** Minimum Codex CLI version PwrSnap will spawn. The protocol package version
 *  tracks the target CLI release; older binaries cannot consume its tool wire
 *  format. */
export const MINIMUM_CODEX_CLI_VERSION = "0.144.0";

export type DesktopCodexCandidateSource = "env" | "config" | "path" | "application";

export type DesktopCodexDiscoveryCandidate = {
  command: string;
  source: DesktopCodexCandidateSource;
  executable: boolean;
  selected: boolean;
  version?: string | undefined;
  versionFailureReason?: string | undefined;
  failureReason?: string | undefined;
};

export type DesktopCodexDiscoverySnapshot = {
  selectedCommand?: string | undefined;
  selectedSource?: DesktopCodexCandidateSource | undefined;
  candidates: DesktopCodexDiscoveryCandidate[];
  error?: string | undefined;
};

export type CodexAuthProbeStatus = "authenticated" | "unauthenticated" | "failed";

export type CodexAuthProbeResult = {
  status: CodexAuthProbeStatus;
  testedAt: string;
  durationMs: number;
  detail?: string;
  errorMessage?: string;
};

export type ResolvedCodexCommandCandidate = {
  command: string;
  source: DesktopCodexCandidateSource;
  version?: string | undefined;
};

/** Re-exported from the kit so callers (and tests) keep a single import
 *  surface; the kit's comparator is the same algorithm the lift carried. */
export const compareCodexCliVersions = kitCompareCodexCliVersions;

export async function pathIsExecutable(candidate: string): Promise<boolean> {
  return kitPathIsExecutable(candidate);
}

const AUTH_PROBE_TIMEOUT_MS = 2_500;
const AUTH_PROBE_MESSAGE_LIMIT = 240;
const VERSION_PROBE_TIMEOUT_MS = 2_500;

function trimProbeMessage(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, AUTH_PROBE_MESSAGE_LIMIT);
}

function outputFromExecError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  const maybeOutput = error as {
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const stdout = typeof maybeOutput.stdout === "string" ? maybeOutput.stdout : "";
  const stderr = typeof maybeOutput.stderr === "string" ? maybeOutput.stderr : "";
  const message = typeof maybeOutput.message === "string" ? maybeOutput.message : "";
  return `${stdout}\n${stderr}\n${message}`;
}

export async function probeCodexAuth(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<CodexAuthProbeResult> {
  const startedAt = Date.now();
  const testedAt = new Date().toISOString();
  try {
    const result = await execFile(command, ["login", "status"], {
      env,
      timeout: AUTH_PROBE_TIMEOUT_MS
    });
    const output = trimProbeMessage(`${result.stdout}\n${result.stderr ?? ""}`);
    return {
      status: "authenticated",
      testedAt,
      durationMs: Date.now() - startedAt,
      detail: output.length > 0 ? output : "Logged in"
    };
  } catch (error) {
    const output = trimProbeMessage(outputFromExecError(error));
    const status: CodexAuthProbeStatus = /not\s+logged\s+in|not\s+authenticated|login\s+required/i.test(
      output
    )
      ? "unauthenticated"
      : "failed";
    return {
      status,
      testedAt,
      durationMs: Date.now() - startedAt,
      errorMessage: output.length > 0 ? output : "Codex auth probe failed"
    };
  }
}

function parseCodexVersion(output: string): string | undefined {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match?.[1];
}

export function validateCodexCliVersion(version: string): string | undefined {
  return compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0
    ? "codex_too_old"
    : undefined;
}

function isSpawnNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Guard the exact command the App Server client is about to spawn. Discovery
 *  filters old candidates for Settings, while this check prevents a direct
 *  configured/PATH command from bypassing that UI-level selection. An explicit
 *  path is existence-checked before the spawn so a stale pinned path fails
 *  with a clear "not found" instead of a raw ENOENT. */
export async function assertCodexCliVersion(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const notFoundMessage =
    `Codex CLI not found: ${command}. Install the Codex CLI ` +
    `(Codex Desktop / ChatGPT Desktop or \`brew install codex\`), or pin its ` +
    `full path in Settings → AI.`;
  if (path.isAbsolute(command) && !(await kitPathIsExecutable(command))) {
    throw new Error(notFoundMessage);
  }
  let result: { stdout: string; stderr: string };
  try {
    result = await execFile(command, ["--version"], {
      env,
      timeout: VERSION_PROBE_TIMEOUT_MS
    });
  } catch (cause) {
    if (isSpawnNotFoundError(cause)) throw new Error(notFoundMessage);
    throw cause;
  }
  const output = `${result.stdout}\n${result.stderr ?? ""}`;
  const version = parseCodexVersion(output);
  if (version === undefined) {
    throw new Error(`Codex CLI version banner was not recognized: ${command}`);
  }
  if (validateCodexCliVersion(version) !== undefined) {
    throw new CodexCliTooOldError(
      reportCodexCliTooOld(command, version, MINIMUM_CODEX_CLI_VERSION)
    );
  }
  clearCodexCliCompatibilityAlert();
  return version;
}

/** Every installed nvm node version's bin dir, newest first — an
 *  `npm i -g codex` under nvm lands there, which a GUI-launched app's
 *  sparse PATH misses. Pure readdir; no shell is ever spawned. */
export function nvmNodeBinDirs(home: string = os.homedir()): string[] {
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(base)
      .sort()
      .reverse()
      .map((version) => path.join(base, version, "bin"));
  } catch {
    return [];
  }
}

function getCodexAppCandidatePaths(): string[] {
  if (process.platform === "win32") {
    // OpenAI's Windows installer drops the Codex CLI/Desktop under
    // %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe (per-user); also
    // check the per-machine Program Files location.
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return [
      path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      path.join(programFiles, "OpenAI", "Codex", "bin", "codex.exe")
    ];
  }
  return [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(os.homedir(), "Applications/ChatGPT.app/Contents/Resources/codex"),
    path.join(os.homedir(), "Applications/Codex.app/Contents/Resources/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    ...nvmNodeBinDirs().map((dir) => path.join(dir, "codex"))
  ];
}

/** PATH-lookup candidates for the bare command. Windows needs the `.exe`
 *  form (the kit's PATH probe doesn't apply PATHEXT), so try it first. */
function getCodexPathCandidates(): Array<{
  command: string;
  source: DesktopCodexCandidateSource;
}> {
  if (process.platform === "win32") {
    return [
      { command: "codex.exe", source: "path" },
      { command: "codex", source: "path" }
    ];
  }
  return [{ command: "codex", source: "path" }];
}

// ---- PATH pre-resolution + dedupe (spawn hygiene) --------------------
//
// The kit's `discoverCommands` probes every candidate with `--version`
// BEFORE deduping, so bare `codex` on $PATH and its resolved absolute
// twin (e.g. /opt/homebrew/bin/codex, also listed as an application
// candidate) each cost a child spawn per discovery pass. The right
// long-term home for probe-after-dedupe is @pwrdrvr/codex-discovery
// itself; until the kit grows that, we pre-resolve PATH candidates here
// with pure fs checks — no spawns — and drop duplicate auto-candidates
// before the kit ever sees them. The resolution below mirrors the kit's
// internal `resolvePathCommand` (which it doesn't export).

async function pathEntryExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function readPathEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "win32") {
    return env.PATH;
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return pathKey !== undefined ? env[pathKey] : undefined;
}

function normalizePathEntry(entry: string): string {
  const trimmed = entry.trim();
  const quoted = trimmed.match(/^"(.+)"$/);
  return quoted?.[1] ?? trimmed;
}

/** Windows resolves bare commands through PATHEXT; everywhere else the
 *  bare name is the only spelling. Mirrors the kit's probe order. */
function buildPathCommandNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  const rawExtensions = env.PATHEXT?.trim() || ".COM;.EXE;.BAT;.CMD";
  const extensions = rawExtensions
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
  const commandExtension = path.win32.extname(command).toLowerCase();
  if (
    commandExtension !== "" &&
    extensions.some((extension) => extension.toLowerCase() === commandExtension)
  ) {
    return [command];
  }
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

async function resolveCommandFromPath(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  if (commandHasPathSeparator(command)) {
    return command;
  }
  const pathValue = readPathEnv(env);
  if (pathValue === undefined || pathValue.trim() === "") {
    return undefined;
  }
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  const joinPath = process.platform === "win32" ? path.win32.join : path.join;
  const commandNames = buildPathCommandNames(command, env);
  for (const directory of pathValue.split(delimiter).map(normalizePathEntry).filter(Boolean)) {
    for (const commandName of commandNames) {
      const candidate = joinPath(directory, commandName);
      if (await pathEntryExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Auto-candidates with PATH hits pre-resolved to absolute paths and
 *  deduped, so the kit probes each distinct binary once. Exported for
 *  unit tests. */
export async function buildCodexAutoCandidates(env: NodeJS.ProcessEnv): Promise<
  Array<{ command: string; source: DesktopCodexCandidateSource }>
> {
  const appPaths = getCodexAppCandidatePaths();
  const appPathSet = new Set(appPaths);
  const seen = new Set<string>();
  const out: Array<{ command: string; source: DesktopCodexCandidateSource }> = [];
  for (const { command } of getCodexPathCandidates()) {
    const resolved = await resolveCommandFromPath(command, env);
    if (resolved === undefined) {
      // Not resolvable via pure fs checks — keep the bare command so the
      // kit's own probe stays the arbiter (execFile consults PATH too).
      if (!seen.has(command)) {
        seen.add(command);
        out.push({ command, source: "path" });
      }
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    // A PATH hit that IS a known install location keeps the
    // "application" label the kit's post-probe merge used to pick when
    // the two candidates collapsed into one.
    out.push({ command: resolved, source: appPathSet.has(resolved) ? "application" : "path" });
  }
  for (const appPath of appPaths) {
    if (seen.has(appPath)) continue;
    seen.add(appPath);
    out.push({ command: appPath, source: "application" });
  }
  return out;
}

function toDesktopCandidate(
  candidate: CommandDiscoveryCandidate<DesktopCodexCandidateSource>
): DesktopCodexDiscoveryCandidate {
  return {
    command: candidate.command,
    source: candidate.source,
    executable: candidate.executable,
    selected: candidate.selected,
    version: candidate.version,
    versionFailureReason: candidate.versionFailureReason,
    failureReason: candidate.failureReason
  };
}

export async function discoverCodexCommands(params?: {
  configuredCommand?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<DesktopCodexDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const envOverride = env[PWRSNAP_CODEX_COMMAND_ENV]?.trim();
  const configuredCommand = params?.configuredCommand?.trim();

  const snapshot: CommandDiscoverySnapshot<DesktopCodexCandidateSource> = await discoverCommands({
    env,
    fixedCandidates: [
      { command: envOverride, source: "env" },
      { command: configuredCommand, source: "config" }
    ],
    autoCandidates: await buildCodexAutoCandidates(env),
    parseVersion: parseCodexVersion,
    compareVersions: kitCompareCodexCliVersions,
    validateVersion: validateCodexCliVersion
  });

  const candidates = snapshot.candidates.map(toDesktopCandidate);
  const selected = candidates.find((candidate) => candidate.selected);
  return {
    selectedCommand: selected?.command,
    selectedSource: selected?.source,
    candidates
  };
}

/** Pure selection over an already-computed discovery snapshot. Callers
 *  that just ran `discoverCodexCommands` (the settings-service snapshot
 *  path) resolve from that result instead of paying a full second
 *  discovery pass — and its child spawns — via `resolveCodexCommand`. */
export function selectResolvedCodexCommand(
  discovery: DesktopCodexDiscoverySnapshot,
  fallbackCommand: string
): ResolvedCodexCommandCandidate {
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  if (selected !== undefined) {
    return {
      command: selected.command,
      source: selected.source,
      version: selected.version
    };
  }
  return {
    command: fallbackCommand.trim() || "codex",
    source: "path"
  };
}

export async function resolveCodexCommand(params: {
  command: string;
  env: NodeJS.ProcessEnv;
}): Promise<ResolvedCodexCommandCandidate> {
  const configuredCommand =
    params.command.trim() && params.command.trim() !== "codex" ? params.command.trim() : undefined;
  const discovery = await discoverCodexCommands({
    configuredCommand,
    env: params.env
  });
  return selectResolvedCodexCommand(discovery, params.command);
}
