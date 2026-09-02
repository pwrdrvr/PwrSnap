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
//   • PwrSnap's pure selection semantics fall back to the configured command
//     (or `codex`) when discovery finds nothing. Discovery lifecycle ownership
//     lives in DesktopSettingsStore.
//     Discovery marks old candidates unavailable, and the App Server pool
//     independently guards the exact command before spawning it.
//   • `probeCodexAuth` (a `codex login status` probe) which the kit doesn't
//     surface in this shape.
//   • The `Desktop*` type names + `MINIMUM_CODEX_CLI_VERSION`, kept so
//     desktop-settings-store.ts and its tests import the same names as before.
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

import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  compareCodexCliVersions as kitCompareCodexCliVersions,
  discoverCommands,
  pathIsExecutable as kitPathIsExecutable,
  type CommandDiscoveryCandidate,
  type CommandDiscoverySnapshot
} from "@pwrdrvr/codex-discovery";

import { PWRSNAP_CODEX_COMMAND_ENV } from "./env";
import { execAgentCommand } from "../ai/agent-command";

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
    const result = await execAgentCommand(command, ["login", "status"], {
      env,
      timeoutMs: AUTH_PROBE_TIMEOUT_MS
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

/** Every installed nvm node version's bin dir, newest first — an
 *  `npm i -g codex` under nvm lands there, which a GUI-launched app's
 *  sparse PATH misses. Pure readdir; no shell is ever spawned. Async so
 *  discovery never does a synchronous directory read on the main thread
 *  (the call chain is already async). */
export async function nvmNodeBinDirs(home: string = os.homedir()): Promise<string[]> {
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    return (await readdir(base, { withFileTypes: true }))
      // `!isFile()`, not `isDirectory()`: filesystems that leave `d_type`
      // unset (SMB/NFS/exFAT — a network $HOME is not exotic) report every
      // entry as UV_DIRENT_UNKNOWN, and `isDirectory()` would then drop all
      // of them and erase every nvm bin dir. This still skips stray files.
      .filter((entry) => !entry.isFile())
      .map((entry) => entry.name)
      .sort(compareNodeVersionsNewestFirst)
      .map((version) => path.join(base, version, "bin"));
  } catch {
    return [];
  }
}

/**
 * Newest-first compare for nvm's `vMAJOR.MINOR.PATCH` directory names.
 * Component-wise numeric, because a plain string sort gets this wrong in two
 * layouts people really have: `v9.x` sorts above `v24.x`, and `v20.9.0`
 * sorts above the newer `v20.10.0`. Picking the wrong dir first means
 * probing a stale `codex` and possibly tripping MINIMUM_CODEX_CLI_VERSION.
 */
function compareNodeVersionsNewestFirst(a: string, b: string): number {
  const left = parseNodeVersionParts(a);
  const right = parseNodeVersionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (right[i] ?? 0) - (left[i] ?? 0);
    if (delta !== 0) return delta;
  }
  // Identical numerics (or two unparseable names) — stable, newest-ish last
  // resort so the order never depends on readdir's arbitrary sequence.
  return b.localeCompare(a);
}

function parseNodeVersionParts(name: string): number[] {
  return name
    .replace(/^v/, "")
    .split(".")
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

async function getCodexAppCandidatePaths(): Promise<string[]> {
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
    ...(await nvmNodeBinDirs()).map((dir) => path.join(dir, "codex"))
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
  const appPaths = await getCodexAppCandidatePaths();
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
 *  that just ran `discoverCodexCommands` (the settings-store snapshot
 *  path) resolve from that result instead of paying a full second
 *  discovery pass and its child spawns. */
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
