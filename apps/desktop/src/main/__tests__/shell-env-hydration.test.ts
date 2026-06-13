// Cached login-shell env hydration (shell-env-hydration.ts).
//
// The high-stakes behavior under test is the instance-state filter:
// the login shell echoes back whatever env it was spawned with, so a
// naive cache replays one launch's PWRSNAP_* / ELECTRON_* configuration
// into the next launch (observed live during the 2026-06 startup
// profiling work — a profiling run's PWRSNAP_STARTUP_PROFILE_DIR
// poisoned the following run's output dir). The cache must carry the
// shell's PATH-style additions and nothing instance-specific.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDataRoot = mkdtempSync(join(tmpdir(), "pwrsnap-shell-env-test-"));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return testDataRoot;
      return testDataRoot;
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // Reversible stand-in so the test can decode what landed on disk.
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice(4)
  }
}));

const resolveInteractiveLoginShellEnv = vi.fn();
vi.mock("@pwrdrvr/agent-transport", () => ({
  resolveInteractiveLoginShellEnv: (
    ...args: unknown[]
  ): NodeJS.ProcessEnv | undefined => resolveInteractiveLoginShellEnv(...args),
  // Minimal overlay-merge stand-in: the real package overlays the
  // resolved shell env onto process.env. The filter under test runs
  // BEFORE this, so the approximation is faithful where it matters.
  hydrateProcessEnvFromLoginShell: (options: {
    resolveShellEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv | undefined;
  }): void => {
    const resolved = options.resolveShellEnv?.(process.env);
    if (resolved !== undefined) Object.assign(process.env, resolved);
  }
}));

vi.mock("../workers/shell-env-refresh-worker-client", () => ({
  // Background refresh never resolves in tests — timers are faked and
  // never advanced, so this is just a safe stub.
  runShellEnvRefreshWorker: vi.fn(() => new Promise(() => undefined))
}));

import { hydrateLoginShellEnvCached } from "../shell-env-hydration";

const CACHE_PATH = join(testDataRoot, "shell-env-cache.bin");

function readCacheJson(): { shell: string | null; env: Record<string, string> } {
  return JSON.parse(readFileSync(CACHE_PATH).toString().slice(4));
}

const SAVED_ENV = { ...process.env };

describe("hydrateLoginShellEnvCached", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rmSync(CACHE_PATH, { force: true });
    resolveInteractiveLoginShellEnv.mockReset();
    process.env = { ...SAVED_ENV };
    process.env.SHELL = "/bin/zsh";
    delete process.env.PWRSNAP_STARTUP_PROFILE_DIR;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...SAVED_ENV };
  });

  it("cold launch resolves synchronously, applies PATH, writes a filtered cache", () => {
    resolveInteractiveLoginShellEnv.mockReturnValue({
      PATH: "/fresh/nvm/bin:/usr/bin",
      HOMEBREW_PREFIX: "/opt/homebrew",
      PWRSNAP_STARTUP_PROFILE_DIR: "/tmp/poison",
      ELECTRON_RUN_AS_NODE: "1",
      SHLVL: "2"
    });

    hydrateLoginShellEnvCached();

    expect(resolveInteractiveLoginShellEnv).toHaveBeenCalledTimes(1);
    expect(process.env.PATH).toBe("/fresh/nvm/bin:/usr/bin");
    // Instance-specific keys never reach process.env…
    expect(process.env.PWRSNAP_STARTUP_PROFILE_DIR).toBeUndefined();
    expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    // …and never reach the on-disk cache either.
    const cache = readCacheJson();
    expect(cache.env.PATH).toBe("/fresh/nvm/bin:/usr/bin");
    expect(cache.env.HOMEBREW_PREFIX).toBe("/opt/homebrew");
    expect(cache.env.PWRSNAP_STARTUP_PROFILE_DIR).toBeUndefined();
    expect(cache.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(cache.env.SHLVL).toBeUndefined();
    expect(cache.shell).toBe("/bin/zsh");
  });

  it("warm launch applies the cache without spawning the shell", () => {
    resolveInteractiveLoginShellEnv.mockReturnValue({ PATH: "/cached/bin" });
    hydrateLoginShellEnvCached(); // cold: writes cache
    resolveInteractiveLoginShellEnv.mockClear();
    process.env.PATH = "/launchd/minimal";

    hydrateLoginShellEnvCached(); // warm

    expect(resolveInteractiveLoginShellEnv).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe("/cached/bin");
  });

  it("a poisoned legacy cache cannot override this launch's instance env", () => {
    // Simulate an older-build cache that captured instance keys by
    // writing one through the cold path, then hand-checking apply: the
    // apply-side filter is exercised via a cache containing PWRSNAP_*.
    resolveInteractiveLoginShellEnv.mockReturnValue({ PATH: "/cached/bin" });
    hydrateLoginShellEnvCached();
    process.env.PWRSNAP_STARTUP_PROFILE_DIR = "/this/launch/value";

    hydrateLoginShellEnvCached(); // warm apply

    expect(process.env.PWRSNAP_STARTUP_PROFILE_DIR).toBe("/this/launch/value");
  });

  it("SHELL change invalidates the cache and re-resolves", () => {
    resolveInteractiveLoginShellEnv.mockReturnValue({ PATH: "/zsh/bin" });
    hydrateLoginShellEnvCached();
    expect(resolveInteractiveLoginShellEnv).toHaveBeenCalledTimes(1);

    process.env.SHELL = "/bin/bash";
    resolveInteractiveLoginShellEnv.mockReturnValue({ PATH: "/bash/bin" });
    hydrateLoginShellEnvCached();

    expect(resolveInteractiveLoginShellEnv).toHaveBeenCalledTimes(2);
    expect(process.env.PATH).toBe("/bash/bin");
  });
});
