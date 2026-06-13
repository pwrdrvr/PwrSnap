// Cached login-shell env hydration.
//
// Why this exists: a Finder/Dock-launched bundle inherits launchd's
// minimal PATH, which hides nvm / Homebrew-installed CLIs (codex, ACP
// agent binaries). The original fix called agent-transport's
// `hydrateProcessEnvFromLoginShell` synchronously at the very top of
// bootstrapApp — but that spawns the user's interactive login shell
// with execFileSync, and startup profiling measured it at ~0.9–1.1s of
// main-thread block on every launch, ahead of window creation. It was
// the single largest contributor to time-to-window.
//
// The shape now (VS Code-style resolve-with-cache):
//
//   • Warm launch: decrypt `<userData>/shell-env-cache.bin`
//     (safeStorage; the login-shell env can carry secrets exported in
//     dotfiles, so it never lands on disk in plaintext — same rule as
//     pwrsnap-secrets.bin), merge it into process.env via the
//     package's own merge logic (`resolveShellEnv` injection point),
//     and schedule a background refresh. Cost: ~1ms.
//   • Cold launch (no/invalid cache, or SHELL changed): block
//     synchronously exactly like the original call — one-time cost —
//     then write the cache for next launch.
//   • Background refresh (+5s, off the startup window): re-resolve in
//     a worker thread (never on the main thread — execFileSync there
//     freezes compositing for every window), re-merge into
//     process.env, rewrite the cache. So a PATH change made today is
//     live within seconds, and at worst the first few spawns of this
//     launch see the previous launch's env.
//
// Call order contract: `hydrateLoginShellEnvCached()` must run inside
// app.whenReady() (safeStorage needs the ready app) and BEFORE anything
// spawns a child process by bare command name. Startup spawn sites
// (codex discovery probe, ACP discover/warm-up) all run after it.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import {
  hydrateProcessEnvFromLoginShell,
  resolveInteractiveLoginShellEnv
} from "@pwrdrvr/agent-transport";
import { toAgentKitLogger } from "./ai/agent-kit-bindings";
import { getMainLogger } from "./log";
import { markStartup } from "./startup-profiler";
import { runShellEnvRefreshWorker } from "./workers/shell-env-refresh-worker-client";

const log = getMainLogger("pwrsnap:shell-environment");
const agentKitLogger = toAgentKitLogger("pwrsnap:shell-environment");

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE = "shell-env-cache.bin";
const REFRESH_DELAY_MS = 5_000;

type ShellEnvCache = {
  schemaVersion: number;
  /** $SHELL at capture time — a chsh between launches invalidates. */
  shell: string | null;
  capturedAt: string;
  env: Record<string, string>;
};

function cachePath(): string {
  return join(app.getPath("userData"), CACHE_FILE);
}

// The login shell is spawned with this process's env as its base, so its
// `env` output ECHOES BACK everything we were launched with — including
// our own instance-specific configuration. Caching those and merging
// them into a LATER launch would override that launch's real values
// (observed during the 2026-06 startup-profiling work: a profiling run
// cached PWRSNAP_STARTUP_PROFILE_DIR and poisoned the next run's output
// dir). Filter on write AND on apply: the cache exists to recover the
// shell's PATH-style additions, never to replay app/instance state.
const EXCLUDED_KEY_PATTERN = /^(PWRSNAP_|ELECTRON_|NODE_OPTIONS$|PWD$|OLDPWD$|SHLVL$|_$)/;

function withoutExcludedKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (EXCLUDED_KEY_PATTERN.test(key)) continue;
    filtered[key] = value;
  }
  return filtered;
}

function currentShell(): string | null {
  const shell = process.env.SHELL;
  return typeof shell === "string" && shell.length > 0 ? shell : null;
}

function readCache(): ShellEnvCache | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(safeStorage.decryptString(readFileSync(cachePath())));
  } catch {
    // Missing file is the common case; a corrupt/undecryptable cache is
    // equivalent — fall back to the synchronous resolve, which rewrites it.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const cache = parsed as Partial<ShellEnvCache>;
  if (cache.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  if (typeof cache.env !== "object" || cache.env === null) return null;
  if (cache.shell !== null && typeof cache.shell !== "string") return null;
  if (cache.shell !== currentShell()) return null;
  for (const value of Object.values(cache.env)) {
    if (typeof value !== "string") return null;
  }
  return cache as ShellEnvCache;
}

function writeCache(env: NodeJS.ProcessEnv): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  const cache: ShellEnvCache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    shell: currentShell(),
    capturedAt: new Date().toISOString(),
    env: withoutExcludedKeys(env)
  };
  try {
    // Atomic write (tmp → rename), same rule as the settings substrate.
    const target = cachePath();
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(cache)));
    renameSync(tmp, target);
  } catch (cause) {
    log.warn("shell env cache write failed", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

/** Drop a cache that proved stale/corrupt so the next launch re-resolves. */
function dropCache(): void {
  try {
    unlinkSync(cachePath());
  } catch {
    // already gone
  }
}

function applyEnv(env: NodeJS.ProcessEnv): void {
  // Route through the package's hydrate entrypoint with the resolved
  // env injected, so merge semantics stay identical to the original
  // synchronous call — we only replace WHERE the env comes from.
  // Filter on apply too (not just write) so a cache written by an
  // older build can never override this launch's own configuration.
  hydrateProcessEnvFromLoginShell({
    resolveShellEnv: () => withoutExcludedKeys(env),
    logger: agentKitLogger
  });
}

function scheduleBackgroundRefresh(): void {
  setTimeout(() => {
    void (async () => {
      const fresh = await runShellEnvRefreshWorker();
      if (fresh === null) {
        // Couldn't re-resolve — keep using the cached env this launch,
        // but drop the cache so the next launch takes the sync path
        // rather than trusting a snapshot we can no longer reproduce.
        log.warn("shell env background refresh failed; cache dropped");
        dropCache();
        return;
      }
      applyEnv(fresh);
      writeCache(fresh);
      log.info("shell env refreshed from login shell (background)");
    })();
  }, REFRESH_DELAY_MS).unref();
}

/**
 * Hydrate process.env from the interactive login shell, using the
 * encrypted on-disk cache when available (fast path) and falling back
 * to the original synchronous spawn (first launch / cache miss).
 * Must run inside app.whenReady() and before any bare-command spawn.
 */
export function hydrateLoginShellEnvCached(): void {
  if (process.platform === "win32") return; // hydration is a no-op there
  const cached = readCache();
  if (cached !== null) {
    applyEnv(cached.env);
    markStartup("main: login-shell env hydrated (cache)");
    scheduleBackgroundRefresh();
    return;
  }
  // Cold path — identical cost/behavior to the original blocking call.
  const fresh = resolveInteractiveLoginShellEnv({ logger: agentKitLogger });
  if (fresh === undefined) {
    markStartup("main: login-shell env hydration unavailable");
    return;
  }
  applyEnv(fresh);
  writeCache(fresh);
  markStartup("main: login-shell env hydrated (sync resolve)");
}
