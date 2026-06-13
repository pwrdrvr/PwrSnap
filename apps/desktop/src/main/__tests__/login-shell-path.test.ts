// login-shell PATH resolution (login-shell-path.ts).
//
// The contract under test: resolve the user's interactive login-shell
// PATH off-thread, carry ONLY `PATH` (never the rest of the shell env),
// union it with the launch PATH, cache it in-process, and expose it via
// an async getter that returns instantly once resolved. No on-disk
// cache, no whole-env replay.

import { delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runShellEnvRefreshWorker = vi.fn();
vi.mock("../workers/shell-env-refresh-worker-client", () => ({
  runShellEnvRefreshWorker: (...args: unknown[]): unknown => runShellEnvRefreshWorker(...args)
}));

import { loginShellPath } from "../login-shell-path";

const SAVED_ENV = { ...process.env };
const REAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("loginShellPath", () => {
  beforeEach(() => {
    setPlatform("darwin");
    runShellEnvRefreshWorker.mockReset();
    process.env = { ...SAVED_ENV };
    loginShellPath.__resetForTests();
  });

  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    process.env = { ...SAVED_ENV };
  });

  it("unions the login-shell PATH with the launch PATH, shell entries first, de-duped", async () => {
    process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
    runShellEnvRefreshWorker.mockResolvedValue({
      PATH: ["/opt/homebrew/bin", "/usr/bin"].join(delimiter)
    });

    const resolved = await loginShellPath.value();

    expect(resolved).toBe(["/opt/homebrew/bin", "/usr/bin", "/bin"].join(delimiter));
    // process.env.PATH is updated so inherited-env spawns benefit.
    expect(process.env.PATH).toBe(resolved);
  });

  it("resolves once and serves the cache on subsequent calls", async () => {
    runShellEnvRefreshWorker.mockResolvedValue({ PATH: "/a" });

    await loginShellPath.value();
    await loginShellPath.value();

    expect(runShellEnvRefreshWorker).toHaveBeenCalledTimes(1);
  });

  it("carries ONLY PATH — other shell env vars never reach process.env", async () => {
    process.env.PATH = "/bin";
    delete process.env.SECRET_FROM_SHELL;
    runShellEnvRefreshWorker.mockResolvedValue({
      PATH: "/x",
      SECRET_FROM_SHELL: "leak",
      HOME: "/somewhere/else"
    });

    await loginShellPath.value();

    expect(process.env.SECRET_FROM_SHELL).toBeUndefined();
    expect(process.env.HOME).toBe(SAVED_ENV.HOME);
  });

  it("falls back to the launch PATH when the worker returns null", async () => {
    process.env.PATH = "/launch/bin";
    runShellEnvRefreshWorker.mockResolvedValue(null);

    expect(await loginShellPath.value()).toBe("/launch/bin");
  });

  it("falls back to the launch PATH when the worker throws", async () => {
    process.env.PATH = "/launch/bin";
    runShellEnvRefreshWorker.mockRejectedValue(new Error("boom"));

    expect(await loginShellPath.value()).toBe("/launch/bin");
  });

  it("is a no-op on win32 — never spawns the shell", async () => {
    setPlatform("win32");
    process.env.PATH = "C:\\Windows;C:\\Windows\\System32";

    const resolved = await loginShellPath.value();

    expect(runShellEnvRefreshWorker).not.toHaveBeenCalled();
    expect(resolved).toBe("C:\\Windows;C:\\Windows\\System32");
  });

  it("prewarm() kicks off resolution without the caller awaiting", async () => {
    let release: (env: NodeJS.ProcessEnv) => void = () => undefined;
    runShellEnvRefreshWorker.mockReturnValue(
      new Promise<NodeJS.ProcessEnv>((r) => {
        release = r;
      })
    );

    loginShellPath.prewarm();
    expect(runShellEnvRefreshWorker).toHaveBeenCalledTimes(1);

    release({ PATH: "/warm/bin" });
    expect(await loginShellPath.value()).toContain("/warm/bin");
    // prewarm + value share one in-flight resolve — no second spawn.
    expect(runShellEnvRefreshWorker).toHaveBeenCalledTimes(1);
  });

  it("prewarm() is a no-op on win32", () => {
    setPlatform("win32");
    loginShellPath.prewarm();
    expect(runShellEnvRefreshWorker).not.toHaveBeenCalled();
  });
});
