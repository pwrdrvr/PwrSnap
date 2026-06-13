// login-shell PATH resolution (login-shell-path.ts).
//
// The contract under test: resolve the user's interactive login-shell
// PATH off-thread (the worker hands back ONLY a PATH string), union it
// with the launch PATH, cache it in-process, and expose it via an async
// getter that returns instantly once resolved. No on-disk cache, no
// whole-env replay.

import { delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveLoginShellPath = vi.fn();
vi.mock("../workers/shell-env-refresh-worker-client", () => ({
  resolveLoginShellPath: (...args: unknown[]): unknown => resolveLoginShellPath(...args)
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
    resolveLoginShellPath.mockReset();
    process.env = { ...SAVED_ENV };
    loginShellPath.__resetForTests();
  });

  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    process.env = { ...SAVED_ENV };
  });

  it("unions the login-shell PATH with the launch PATH, shell entries first, de-duped", async () => {
    process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
    resolveLoginShellPath.mockResolvedValue(["/opt/homebrew/bin", "/usr/bin"].join(delimiter));

    const resolved = await loginShellPath.value();

    expect(resolved).toBe(["/opt/homebrew/bin", "/usr/bin", "/bin"].join(delimiter));
    // process.env.PATH is updated so inherited-env spawns benefit.
    expect(process.env.PATH).toBe(resolved);
  });

  it("resolves once and serves the cache on subsequent calls", async () => {
    resolveLoginShellPath.mockResolvedValue("/a");

    await loginShellPath.value();
    await loginShellPath.value();

    expect(resolveLoginShellPath).toHaveBeenCalledTimes(1);
  });

  it("touches ONLY process.env.PATH — no other env key changes", async () => {
    process.env.PATH = "/bin";
    process.env.UNRELATED = "keep-me";
    const before = { ...process.env };
    resolveLoginShellPath.mockResolvedValue("/x");

    await loginShellPath.value();

    const changedKeys = Object.keys(process.env).filter(
      (k) => process.env[k] !== before[k]
    );
    expect(changedKeys).toEqual(["PATH"]);
    expect(process.env.UNRELATED).toBe("keep-me");
  });

  it("falls back to the launch PATH when the worker returns null", async () => {
    process.env.PATH = "/launch/bin";
    resolveLoginShellPath.mockResolvedValue(null);

    expect(await loginShellPath.value()).toBe("/launch/bin");
  });

  it("falls back to the launch PATH when the worker throws", async () => {
    process.env.PATH = "/launch/bin";
    resolveLoginShellPath.mockRejectedValue(new Error("boom"));

    expect(await loginShellPath.value()).toBe("/launch/bin");
  });

  it("is a no-op on win32 — never spawns the shell", async () => {
    setPlatform("win32");
    process.env.PATH = "C:\\Windows;C:\\Windows\\System32";

    const resolved = await loginShellPath.value();

    expect(resolveLoginShellPath).not.toHaveBeenCalled();
    expect(resolved).toBe("C:\\Windows;C:\\Windows\\System32");
  });

  it("prewarm() kicks off resolution without the caller awaiting", async () => {
    let release: (path: string) => void = () => undefined;
    resolveLoginShellPath.mockReturnValue(
      new Promise<string>((r) => {
        release = r;
      })
    );

    loginShellPath.prewarm();
    expect(resolveLoginShellPath).toHaveBeenCalledTimes(1);

    release("/warm/bin");
    expect(await loginShellPath.value()).toContain("/warm/bin");
    // prewarm + value share one in-flight resolve — no second spawn.
    expect(resolveLoginShellPath).toHaveBeenCalledTimes(1);
  });

  it("prewarm() is a no-op on win32", () => {
    setPlatform("win32");
    loginShellPath.prewarm();
    expect(resolveLoginShellPath).not.toHaveBeenCalled();
  });
});
