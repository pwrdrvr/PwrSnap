import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Windows release configuration", () => {
  test("electron-builder declares signing, updater, and .pwrsnap association metadata", () => {
    const config = read("apps/desktop/electron-builder.yml");

    expect(config).toMatch(/win:\r?\n[\s\S]*verifyUpdateCodeSignature: true/);
    expect(config).toMatch(/win:\r?\n[\s\S]*fileAssociations:\r?\n[\s\S]*ext: pwrsnap/);
    expect(config).toContain("mimeType: application/vnd.pwrdrvr.pwrsnap.bundle+zip");
    expect(config).toContain("artifactName: \"${productName}-${version}-windows-${arch}-setup.${ext}\"");
  });

  test("Windows packager has an explicit guarded release mode", () => {
    const script = read("apps/desktop/scripts/package-win.mjs");

    expect(script).toContain('const releaseMode = publish || args.includes("--release");');
    expect(script).toContain("assertWindowsReleaseInputs();");
    expect(script).toContain("assertRequiredWindowsResources();");
    expect(script).toContain("build/native/window-list.exe");
    expect(script).toContain("WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD");
    expect(script).toContain("PWRSNAP_WINDOWS_FFMPEG_PATH");
    expect(script).toContain('to: "PwrSnapFFmpeg.exe"');
  });

  test("tagged release workflow publishes a signed Windows installer", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain("windows-signing");
    expect(workflow).toContain("secrets.WIN_CSC_LINK");
    expect(workflow).toContain("secrets.WIN_CSC_KEY_PASSWORD");
    expect(workflow).toContain("pwrdrvr/pwrsnap-ffmpeg-builds");
    expect(workflow).toContain("a72aa24cd310cb3aa684b2481261cb2d8e313bfd");
    expect(workflow).toContain("ffmpeg-8.1.1-windows-x64");
    expect(workflow).toContain("manifest.json");
    expect(workflow).toContain("PWRSNAP_WINDOWS_FFMPEG_PATH=$ffmpeg");
    expect(workflow).toContain("pnpm --filter @pwrsnap/desktop package:win -- --publish");
  });
});
