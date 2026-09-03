export interface ChromiumCommandLine {
  appendSwitch(name: string, value?: string): void;
}

export const WINDOWS_DISABLED_CHROMIUM_FEATURES = [
  "CalculateNativeWinOcclusion",
  "DirectXCapturer"
] as const;

/** Apply the Windows-only Chromium feature policy before app readiness. */
export function applyWindowsChromiumStartupFeaturePolicy(
  commandLine: ChromiumCommandLine
): string {
  const disabledFeatures = WINDOWS_DISABLED_CHROMIUM_FEATURES.join(",");
  commandLine.appendSwitch("disable-features", disabledFeatures);
  return disabledFeatures;
}
