// Lifted from ~/github/PwrAgnt/apps/desktop/src/main/settings/codex-discovery.ts
// — discovery of Codex CLI binaries on the user's machine. Adaptations:
//   • DesktopCodex* type definitions inlined here (PwrAgnt has them in
//     @pwragnt/shared but PwrSnap doesn't share that package — see
//     plan §"Decision 4").
//   • PWRSNAP_CODEX_COMMAND env-var constant replaces PwrAgnt's
//     CODEX_COMMAND_ENV (defined in apps/desktop/src/main/settings/env.ts).
//
// Looks for the Codex binary in this priority order:
//   1. env override (PWRSNAP_CODEX_COMMAND or — for compatibility with
//      Codex Desktop sharing across PwrDrvr products — falls back to
//      whichever the user has set globally).
//   2. user-configured path saved in Settings.
//   3. `codex` on $PATH.
//   4. /Applications/Codex.app/Contents/Resources/codex (Codex Desktop).
//   5. ~/Applications/Codex.app/Contents/Resources/codex (per-user install).
//
// Within auto-discovered (path + application) candidates, sorts by
// reported `--version` so the newest install bubbles to the top.

import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { PWRSNAP_CODEX_COMMAND_ENV } from "./env";

const execFile = promisify(execFileCallback);

/** Minimum Codex CLI version PwrSnap will spawn. Mirrors PwrAgnt's
 *  threshold; older binaries miss protocol features we rely on. */
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

export type ResolvedCodexCommandCandidate = {
  command: string;
  source: DesktopCodexCandidateSource;
  version?: string | undefined;
};

export async function pathIsExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvePathCommand(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  if (command.includes(path.sep)) {
    return command;
  }
  try {
    const result = await execFile("/usr/bin/which", [command], {
      env,
      timeout: 2_000
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readCodexVersion(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<{
  ran: boolean;
  version?: string | undefined;
  failureReason?: string | undefined;
}> {
  try {
    const result = await execFile(command, ["--version"], {
      env,
      timeout: 2_000
    });
    const output = `${result.stdout}\n${result.stderr ?? ""}`;
    const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
    return {
      ran: true,
      version: match?.[1],
      failureReason: match ? undefined : "version_not_reported"
    };
  } catch (error) {
    return {
      ran: false,
      failureReason: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseVersion(value?: string):
  | {
      major: number;
      minor: number;
      patch: number;
      prerelease: string[];
    }
  | undefined {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? []
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) {
        return Math.sign(leftNumber - rightNumber);
      }
      continue;
    }
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    if (leftPart !== rightPart) return leftPart.localeCompare(rightPart);
  }
  return 0;
}

export function compareCodexCliVersions(left?: string, right?: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion && !rightVersion) return 0;
  if (!leftVersion) return -1;
  if (!rightVersion) return 1;

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return Math.sign(leftVersion[key] - rightVersion[key]);
    }
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function getCodexAppCandidatePaths(): string[] {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(os.homedir(), "Applications/Codex.app/Contents/Resources/codex")
  ];
}

async function buildDiscoveryCandidate(
  command: string | undefined,
  source: DesktopCodexCandidateSource,
  env: NodeJS.ProcessEnv
): Promise<DesktopCodexDiscoveryCandidate | undefined> {
  const trimmedCommand = command?.trim();
  if (!trimmedCommand) {
    return undefined;
  }

  const resolvedCommand =
    source === "path" || !trimmedCommand.includes(path.sep)
      ? await resolvePathCommand(trimmedCommand, env)
      : trimmedCommand;
  const accessExecutable = resolvedCommand ? await pathIsExecutable(resolvedCommand) : false;
  const versionResult = resolvedCommand
    ? await readCodexVersion(resolvedCommand, env)
    : { ran: false, failureReason: "not_found" as const };
  const executable = accessExecutable || versionResult.ran;

  return {
    command: resolvedCommand || trimmedCommand,
    source,
    executable,
    selected: false,
    version: versionResult.version,
    versionFailureReason: executable ? versionResult.failureReason : undefined,
    failureReason: executable ? undefined : "not_executable"
  };
}

export async function discoverCodexCommands(params?: {
  configuredCommand?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<DesktopCodexDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const envOverride = env[PWRSNAP_CODEX_COMMAND_ENV]?.trim();
  const configuredCommand = params?.configuredCommand?.trim();

  const fixedCandidates = (
    await Promise.all([
      buildDiscoveryCandidate(envOverride, "env", env),
      buildDiscoveryCandidate(configuredCommand, "config", env)
    ])
  ).filter((candidate): candidate is DesktopCodexDiscoveryCandidate => Boolean(candidate));

  const autoCandidates = (
    await Promise.all([
      buildDiscoveryCandidate("codex", "path", env),
      ...getCodexAppCandidatePaths().map((candidatePath) =>
        buildDiscoveryCandidate(candidatePath, "application", env)
      )
    ])
  )
    .filter((candidate): candidate is DesktopCodexDiscoveryCandidate => Boolean(candidate))
    .filter((candidate) => candidate.executable)
    .sort((left, right) => compareCodexCliVersions(right.version, left.version));

  const candidates = [...fixedCandidates, ...autoCandidates];
  const selected =
    candidates.find((candidate) => candidate.source === "env" && candidate.executable) ??
    candidates.find((candidate) => candidate.source === "config" && candidate.executable) ??
    autoCandidates.find((candidate) => candidate.executable);

  if (selected) {
    selected.selected = true;
  }

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
