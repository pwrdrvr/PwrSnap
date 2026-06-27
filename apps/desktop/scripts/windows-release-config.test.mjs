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

    expect(script).toContain('const unsignedRelease = args.includes("--unsigned-release");');
    expect(script).toContain("publish || args.includes(\"--release\") || unsignedRelease");
    expect(script).toContain("--publish and --unsigned-release cannot be combined");
    expect(script).toContain("assertWindowsReleaseInputs({ requireSigning: !unsignedRelease });");
    expect(script).toContain("assertRequiredWindowsResources();");
    expect(script).toContain("build/native/window-list.exe");
    expect(script).toContain("WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD");
    expect(script).toContain("PWRSNAP_WINDOWS_FFMPEG_PATH");
    expect(script).toContain('to: "PwrSnapFFmpeg.exe"');
  });

  test("macOS release preparation can defer FFmpeg to the protected signing job", () => {
    const script = read("apps/desktop/scripts/release.mjs");

    expect(script).toContain("PWRSNAP_SKIP_FFMPEG_BUILD");
    expect(script).toContain("external FFmpeg artifact will be injected before packaging");
    expect(script).toContain('for (const dir of ["build/ffmpeg", "build/ffmpeg-source"])');
    expect(script).toContain("build:ffmpeg");
  });

  test("tagged release workflow publishes signed installers with controlled FFmpeg artifacts", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain("PWRSNAP_SKIP_FFMPEG_BUILD: \"1\"");
    expect(workflow).toContain("apple-signing");
    expect(workflow).toContain("windows-signing");
    expect(workflow).toContain("actions/create-github-app-token@v3");
    expect(workflow).toContain("vars.FFMPEG_BUILDS_APP_CLIENT_ID");
    expect(workflow).toContain("secrets.FFMPEG_BUILDS_APP_PRIVATE_KEY");
    expect(workflow).toContain("steps.ffmpeg-builds-token.outputs.token");
    expect(workflow).toContain("secrets.WIN_CSC_LINK");
    expect(workflow).toContain("secrets.WIN_CSC_KEY_PASSWORD");
    expect(workflow).toContain("pwrdrvr/pwrsnap-ffmpeg-builds");
    expect(workflow).toContain("a72aa24cd310cb3aa684b2481261cb2d8e313bfd");
    expect(workflow).toContain("ffmpeg-8.1.1-macos-universal");
    expect(workflow).toContain("ffmpeg-8.1.1-windows-x64");
    expect(workflow).toContain("manifest.json");
    expect(workflow).toContain("h264_videotoolbox");
    expect(workflow).toContain("release-stage/build/ffmpeg/ffmpeg");
    expect(workflow).toContain("PWRSNAP_WINDOWS_FFMPEG_PATH=$ffmpeg");
    expect(workflow).toContain("vars.WINDOWS_UNSIGNED_RELEASE != 'true'");
    expect(workflow).toContain("vars.WINDOWS_UNSIGNED_RELEASE == 'true'");
    expect(workflow).toContain("pnpm --filter @pwrsnap/desktop package:win -- --publish");
    expect(workflow).toContain("pnpm --filter @pwrsnap/desktop package:win -- --unsigned-release");
    expect(workflow).toContain("gh release upload $env:RELEASE_TAG");
    expect(workflow).toContain("-unsigned-setup.exe");
    expect(workflow).not.toContain("FFMPEG_BUILDS_PAT");
  });
});
