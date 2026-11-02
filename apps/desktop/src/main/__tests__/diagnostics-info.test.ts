import { describe, expect, test } from "vitest";
import { formatDiagnosticsInfo, type DiagnosticsInfoInput } from "../diagnostics-info";

const input: DiagnosticsInfoInput = {
  version: "1.4.0-beta.2",
  packaged: true,
  platform: "darwin",
  platformVersion: "26.6.1",
  arch: "arm64",
  electronVersion: "41.10.7",
  chromeVersion: "146.0.7680.80",
  nodeVersion: "24.14.1"
};

describe("Help → Copy Diagnostics Info", () => {
  test("names the app, build, platform and runtimes, one per line", () => {
    expect(formatDiagnosticsInfo(input)).toBe(
      [
        "PwrSnap 1.4.0-beta.2",
        "Build: Packaged",
        "Platform: macOS 26.6.1 (arm64)",
        "Electron: 41.10.7",
        "Chrome: 146.0.7680.80",
        "Node: 24.14.1"
      ].join("\n")
    );
  });

  test("names development builds and every shipped platform", () => {
    const dev = formatDiagnosticsInfo({ ...input, packaged: false });
    expect(dev.split("\n")[1]).toBe("Build: Development");
    expect(
      formatDiagnosticsInfo({ ...input, platform: "win32", platformVersion: "10.0.26100", arch: "x64" })
    ).toContain("Platform: Windows 10.0.26100 (x64)");
    expect(formatDiagnosticsInfo({ ...input, platform: "linux", platformVersion: "6.8.0" })).toContain(
      "Platform: Linux 6.8.0 (arm64)"
    );
    expect(formatDiagnosticsInfo({ ...input, platform: "freebsd" })).toContain(
      "Platform: freebsd 26.6.1"
    );
  });
});
