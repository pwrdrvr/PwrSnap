import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  applyWindowsChromiumStartupFeaturePolicy,
  WINDOWS_DISABLED_CHROMIUM_FEATURES
} from "../windows-chromium-startup-policy";

describe("Windows Chromium startup feature policy", () => {
  test("skips DXGI capture and preserves the native occlusion workaround", () => {
    const appendSwitch = vi.fn();

    const disabledFeatures = applyWindowsChromiumStartupFeaturePolicy({
      appendSwitch
    });

    expect(WINDOWS_DISABLED_CHROMIUM_FEATURES).toEqual([
      "CalculateNativeWinOcclusion",
      "DirectXCapturer"
    ]);
    expect(disabledFeatures).toBe("CalculateNativeWinOcclusion,DirectXCapturer");
    expect(appendSwitch).toHaveBeenCalledOnce();
    expect(appendSwitch).toHaveBeenCalledWith(
      "disable-features",
      disabledFeatures
    );
  });
});

describe("Windows Chromium startup feature policy wiring", () => {
  const mainSource = readFileSync(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "utf8"
  );

  test("applies the policy only in the Windows branch and before app.whenReady", () => {
    const windowsBranchIndex = mainSource.indexOf(
      'if (process.platform === "win32")'
    );
    const policyIndex = mainSource.indexOf(
      "applyWindowsChromiumStartupFeaturePolicy(\n      app.commandLine\n    )"
    );
    const nextPlatformBranchIndex = mainSource.indexOf(
      'if (isE2E && process.platform === "linux")',
      windowsBranchIndex
    );
    const readyIndex = mainSource.indexOf("app.whenReady().then");

    expect(windowsBranchIndex).toBeGreaterThan(-1);
    expect(policyIndex).toBeGreaterThan(windowsBranchIndex);
    expect(nextPlatformBranchIndex).toBeGreaterThan(policyIndex);
    expect(readyIndex).toBeGreaterThan(policyIndex);
  });

  test("leaves the macOS ScreenCaptureKit feature list unchanged", () => {
    expect(mainSource).toContain(
      '"ScreenCaptureKitMac,ScreenCaptureKitMacWindow,ScreenCaptureKitMacScreen,ScreenCaptureKitPickerScreen"'
    );
  });

  test("logs the selected fallback and has no stale standalone occlusion switch", () => {
    expect(mainSource).toContain(
      'log.info("configured Windows Chromium screen capture fallback"'
    );
    expect(mainSource).not.toContain(
      'app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")'
    );
  });
});
