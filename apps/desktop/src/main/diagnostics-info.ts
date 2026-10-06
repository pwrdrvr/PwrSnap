// Help → Copy Diagnostics Info: the text a bug report needs to say which
// PwrSnap it is about. Same shape as PwrGit's and PwrAgent's, so a report
// from any Pwr app reads the same way.
//
// Only identity goes in: version, build kind, OS and runtimes. No paths,
// no user or machine names, no settings — this lands on the clipboard and
// from there in public issues.

export type DiagnosticsInfoInput = {
  version: string;
  packaged: boolean;
  platform: NodeJS.Platform | string;
  platformVersion: string;
  arch: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
};

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux"
};

export function formatDiagnosticsInfo(input: DiagnosticsInfoInput): string {
  const platformName = PLATFORM_NAMES[input.platform] ?? input.platform;
  return [
    `PwrSnap ${input.version}`,
    `Build: ${input.packaged ? "Packaged" : "Development"}`,
    `Platform: ${platformName} ${input.platformVersion} (${input.arch})`,
    `Electron: ${input.electronVersion}`,
    `Chrome: ${input.chromeVersion}`,
    `Node: ${input.nodeVersion}`
  ].join("\n");
}
