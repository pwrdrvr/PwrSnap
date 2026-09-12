import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  applyDarwinKeychainStartupPolicy,
  MOCK_KEYCHAIN_SWITCH
} from "../darwin-keychain-startup-policy";

describe("macOS keychain startup policy", () => {
  test("swaps in the mock keychain for an E2E run on darwin", () => {
    const appendSwitch = vi.fn();

    const applied = applyDarwinKeychainStartupPolicy(
      { appendSwitch },
      { platform: "darwin", isE2E: true }
    );

    expect(applied).toBe(true);
    expect(appendSwitch).toHaveBeenCalledOnce();
    expect(appendSwitch).toHaveBeenCalledWith("use-mock-keychain");
    // Chromium's own spelling — `os_crypt::switches::kUseMockKeychain`.
    // A typo here is silent: an unknown switch changes nothing and the run
    // quietly goes on using the developer's real login keychain.
    expect(MOCK_KEYCHAIN_SWITCH).toBe("use-mock-keychain");
  });

  test("leaves a normal dev or production run on the real keychain", () => {
    // Load-bearing: `app.setName("PwrSnap")` is unconditional, so a dev run
    // shares userData -- and `pwrsnap-secrets.bin` -- with the installed app.
    // On a mock keychain it could neither read the user's real secrets nor
    // write ones that survive the process.
    const appendSwitch = vi.fn();

    const applied = applyDarwinKeychainStartupPolicy(
      { appendSwitch },
      { platform: "darwin", isE2E: false }
    );

    expect(applied).toBe(false);
    expect(appendSwitch).not.toHaveBeenCalled();
  });

  test.each(["win32", "linux"] as const)(
    "appends nothing on %s, where the switch does not exist",
    (platform) => {
      const appendSwitch = vi.fn();

      const applied = applyDarwinKeychainStartupPolicy(
        { appendSwitch },
        { platform, isE2E: true }
      );

      expect(applied).toBe(false);
      expect(appendSwitch).not.toHaveBeenCalled();
    }
  );
});

describe("macOS keychain startup policy wiring", () => {
  const mainSource = readFileSync(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "utf8"
  );

  test("is applied inside the darwin branch and before app.whenReady", () => {
    const darwinBranchIndex = mainSource.indexOf('if (process.platform === "darwin")');
    const policyIndex = mainSource.indexOf("applyDarwinKeychainStartupPolicy(app.commandLine");
    const readyIndex = mainSource.indexOf("app.whenReady().then");

    expect(darwinBranchIndex).toBeGreaterThan(-1);
    expect(policyIndex).toBeGreaterThan(darwinBranchIndex);
    // Chromium reads command-line flags during early init, so a switch
    // appended after readiness would be ignored.
    expect(readyIndex).toBeGreaterThan(policyIndex);
  });

  test("passes the real E2E flag rather than hardcoding it on", () => {
    expect(mainSource).toContain(
      "applyDarwinKeychainStartupPolicy(app.commandLine, { platform: process.platform, isE2E })"
    );
    expect(mainSource).not.toContain('app.commandLine.appendSwitch("use-mock-keychain")');
  });
});
