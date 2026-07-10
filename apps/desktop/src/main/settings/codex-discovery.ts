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
//     to the configured command (or `codex`) when discovery finds nothing
//     rather than throwing — the spawn then surfaces a clean ENOENT through the
//     existing codex_unreachable path. (The kit's `resolveCodexCommand` throws
//     `CodexCliNotInstalledError`; PwrSnap's callers never expected a throw.)
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
//        binaries plus explicit Homebrew prefixes for GUI-launched sparse PATHs.
//      - Windows: %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe
//        (and the Program Files equivalent).

import { execFile as execFileCallback } from "node:child_process";
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

const execFile = promisify(execFileCallback);

/** Minimum Codex CLI version PwrSnap will spawn. Mirrors PwrAgnt's
 *  threshold; older binaries miss protocol features we rely on. The
 *  settings-service applies this check; discovery itself does not filter on
 *  it (parity with the prior in-tree behavior). */
export const MINIMUM_CODEX_CLI_VERSION = "0.125.0";

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
    "/usr/local/bin/codex"
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
    autoCandidates: [
      ...getCodexPathCandidates(),
      ...getCodexAppCandidatePaths().map((candidatePath) => ({
        command: candidatePath,
        source: "application" as const
      }))
    ],
    parseVersion: parseCodexVersion,
    compareVersions: kitCompareCodexCliVersions
    // Deliberately NO `validateVersion`: PwrSnap's discovery never filtered
    // candidates on MINIMUM_CODEX_CLI_VERSION — the settings-service applies
    // that check separately so a too-old binary still surfaces in the list
    // with a banner rather than vanishing.
  });

  const candidates = snapshot.candidates.map(toDesktopCandidate);
  const selected = candidates.find((candidate) => candidate.selected);
  return {
    selectedCommand: selected?.command,
    selectedSource: selected?.source,
    candidates
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
  const selected = discovery.candidates.find((candidate) => candidate.selected);

  return selected
    ? {
        command: selected.command,
        source: selected.source,
        version: selected.version
      }
    : {
        command: params.command.trim() || "codex",
        source: "path"
      };
}
