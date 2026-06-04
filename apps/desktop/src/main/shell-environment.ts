// Hydrate the main process's environment from an interactive login shell.
//
// A macOS app launched from Finder / Dock / `open` inherits launchd's minimal
// environment — `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`, with none of the
// nvm / Homebrew / asdf additions a user's shell rc sets up. That's why a CLI
// installed via `npm i -g` under nvm (e.g. `qwen`, `gemini`) is invisible to
// the app even though it's on the user's terminal `PATH`: bare-command
// `execFile("qwen", …)` resolves against the impoverished launchd `PATH` and
// fails, while a tool that installs to a fixed absolute path (e.g.
// `~/.grok/bin/grok`) is still found via its hardcoded fallback.
//
// Fix: once, at startup, spawn the user's interactive login shell, capture its
// `env`, and merge it into `process.env`. Every later spawn (ACP agent
// discovery in `@pwrdrvr/agent-acp`, Codex, …) then inherits the real `PATH`.
//
// Mirrors PwrAgnt's `shell-environment.ts` (the discovery code in PwrSnap is a
// mirror of PwrAgnt's), so fixes flow between the two.

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getMainLogger } from "./log";

const shellEnvLog = getMainLogger("pwrsnap:shell-environment");

type ExecFileSyncLike = (
  file: string,
  args: string[],
  options: {
    encoding: BufferEncoding;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
  }
) => string;

type ShellPathOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execFileSync?: ExecFileSyncLike;
  shellCandidates?: string[];
  timeoutMs?: number;
};

type MergeLoginShellEnvOptions = ShellPathOptions & {
  resolveShellEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv | undefined;
};

const ENV_MARKER_START = "__PWRSNAP_ENV_START__";
const ENV_MARKER_END = "__PWRSNAP_ENV_END__";
const DEFAULT_SHELL_PATH_TIMEOUT_MS = 5_000;

/**
 * Mutate `process.env` in place with the interactive login shell's environment
 * so bare-command spawns resolve against the user's real `PATH`. No-op on
 * Windows and when the shell can't be queried. Call once, early, at startup.
 */
export function hydrateProcessEnvFromLoginShell(
  options: MergeLoginShellEnvOptions = {}
): void {
  const merged = mergeLoginShellEnvIntoEnv(process.env, options);
  if (merged !== process.env) {
    Object.assign(process.env, merged);
  }
}

export function mergeLoginShellEnvIntoEnv(
  env: NodeJS.ProcessEnv,
  options: MergeLoginShellEnvOptions = {}
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const shellEnv = options.resolveShellEnv
    ? options.resolveShellEnv(env)
    : resolveInteractiveLoginShellEnv({
        ...options,
        env,
        platform
      });
  if (!shellEnv || Object.keys(shellEnv).length === 0) {
    // Silent hydration failure is a likely root cause when a tool works from a
    // terminal-launched dev build but is invisible to a Finder-launched
    // bundle. Log enough to diagnose without leaking sensitive env values.
    shellEnvLog.warn("login-shell-env-merge-empty", {
      platform,
      shellCandidates: defaultShellCandidates(env),
      parentShell: env.SHELL,
      parentPathLength: env.PATH?.length ?? 0
    });
    return env;
  }
  shellEnvLog.info("login-shell-env-merged", {
    keys: Object.keys(shellEnv).length,
    parentPathLength: env.PATH?.length ?? 0,
    hydratedPathLength: shellEnv.PATH?.length ?? 0,
    hadNvmDir: Boolean(shellEnv.NVM_DIR),
    hadHomebrewPrefix: Boolean(shellEnv.HOMEBREW_PREFIX)
  });
  return {
    ...env,
    ...shellEnv
  };
}

export function resolveInteractiveLoginShellEnv(
  options: ShellPathOptions = {}
): NodeJS.ProcessEnv | undefined {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return undefined;
  }

  const env = options.env ?? process.env;
  const exec: ExecFileSyncLike =
    options.execFileSync ??
    ((file, args, execOptions) => String(execFileSync(file, args, execOptions)));
  const timeout = options.timeoutMs ?? DEFAULT_SHELL_PATH_TIMEOUT_MS;
  const command = [
    `command printf '${ENV_MARKER_START}\\n'`,
    "command env",
    `command printf '${ENV_MARKER_END}\\n'`
  ].join("; ");

  const failures: Array<{ shell: string; message: string }> = [];
  for (const shell of options.shellCandidates ?? defaultShellCandidates(env)) {
    try {
      const output = exec(shell, ["-ilc", command], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout
      });
      const shellEnv = extractMarkedEnv(output);
      if (shellEnv) {
        return shellEnv;
      }
      failures.push({ shell, message: "empty-env-output" });
    } catch (error) {
      failures.push({
        shell,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (failures.length > 0) {
    shellEnvLog.warn("login-shell-env-resolve-failed", {
      attempts: failures.length,
      failures: failures.map((entry) => `${entry.shell}:${entry.message}`).join("; "),
      timeoutMs: timeout
    });
  }
  return undefined;
}

function defaultShellCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.SHELL, readUserShell(), "/bin/zsh", "/bin/bash"];
  return [...new Set(candidates.filter(isUsableShellPath))];
}

function readUserShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function isUsableShellPath(value: string | undefined): value is string {
  if (!value?.trim()) {
    return false;
  }
  return path.isAbsolute(value);
}

function extractMarkedEnv(output: string): NodeJS.ProcessEnv | undefined {
  const start = output.indexOf(ENV_MARKER_START);
  if (start === -1) {
    return undefined;
  }
  const valueStart = start + ENV_MARKER_START.length;
  const end = output.indexOf(ENV_MARKER_END, valueStart);
  if (end === -1) {
    return undefined;
  }
  const env: NodeJS.ProcessEnv = {};
  for (const line of output.slice(valueStart, end).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    env[key] = line.slice(separator + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
