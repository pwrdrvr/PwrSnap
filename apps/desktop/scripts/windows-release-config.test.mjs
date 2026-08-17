import { existsSync, readFileSync } from "node:fs";
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
    expect(config).toContain("releaseType: prerelease");
  });

  test("Windows packager isolates preparation and fails closed on Azure signing", () => {
    const script = read("apps/desktop/scripts/package-win.mjs");

    expect(script).toContain('const prepareOnly = args.includes("--prepare-only");');
    expect(script).toContain('const signStageOnly = args.includes("--sign-stage-only");');
    expect(script).toContain('args.includes("--require-signing")');
    expect(script).toContain("resolveWindowsAzureSigning");
    expect(script).toContain("--config.win.azureSignOptions.publisherName");
    expect(script).toContain("--config.node-linker=hoisted");
    expect(script).toContain("PWRSNAP_ASAR_MODULE_ROOT");
    expect(script).toContain("writeWindowsChecksums");
    expect(script).toContain("assertRequiredWindowsResources();");
    expect(script).toContain("build/native/window-list.exe");
    expect(script).toContain("PWRSNAP_WINDOWS_FFMPEG_PATH");
    expect(script).toContain('to: "PwrSnapFFmpeg.exe"');
    expect(script).not.toContain("WIN_CSC_LINK");
    expect(script).not.toContain("--unsigned-release");
  });

  test("macOS release preparation always defers FFmpeg to the injected artifact", () => {
    const script = read("apps/desktop/scripts/release.mjs");

    expect(script).toContain("controlled artifact will be injected into release-stage/build/ffmpeg");
    expect(script).toContain('for (const dir of ["build/ffmpeg", "build/ffmpeg-source"])');
    expect(script).toContain("forcePrereleasePublishConfig");
    // The in-repo ffmpeg builder was deleted so there is exactly one source of
    // truth for the bundled binary; release.mjs must never build it again.
    expect(script).not.toContain("build:ffmpeg");
    expect(existsSync(resolve(repoRoot, "apps/desktop/scripts/build-ffmpeg.mjs"))).toBe(false);
  });

  test("tagged release workflow gates publication on Linux, macOS, and Azure-signed Windows", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain("apple-signing");
    expect(workflow).toContain("windows-signing");
    expect(workflow).toContain("actions/create-github-app-token@v3");
    expect(workflow).toContain("vars.FFMPEG_BUILDS_APP_CLIENT_ID");
    expect(workflow).toContain("secrets.FFMPEG_BUILDS_APP_PRIVATE_KEY");
    expect(workflow).toContain("steps.ffmpeg-builds-token.outputs.token");
    expect(workflow).toContain("windows-prepare:");
    expect(workflow).toContain("windows-sign:");
    expect(workflow).toContain("linux-build:");
    expect(workflow).toContain("publish-release-assets:");
    expect(workflow).toContain("environment: windows-signing");
    expect(workflow).toContain("vars.WIN_AZURE_SIGN_PUBLISHER_NAME");
    expect(workflow).toContain("vars.WIN_AZURE_SIGN_ENDPOINT");
    expect(workflow).toContain("vars.WIN_AZURE_SIGN_ACCOUNT");
    expect(workflow).toContain("vars.WIN_AZURE_SIGN_PROFILE");
    expect(workflow).toContain("secrets.AZURE_TENANT_ID");
    expect(workflow).toContain("secrets.AZURE_CLIENT_ID");
    expect(workflow).toContain("secrets.AZURE_CLIENT_SECRET");
    expect(workflow).toContain("pwrdrvr/pwrsnap-ffmpeg-builds");
    expect(workflow).toContain("3d775403a83990a2ad9503d865f5d481d9c0316a");
    expect(workflow).toContain("ffmpeg-8.1.1-macos-universal");
    expect(workflow).toContain("ffmpeg-8.1.1-windows-x64");
    expect(workflow).toContain("apps/desktop/electron-builder.yml");
    expect(workflow).toContain("manifest.json");
    expect(workflow).toContain("h264_videotoolbox");
    expect(workflow).toContain("release-stage/build/ffmpeg/ffmpeg");
    expect(workflow).toContain("PWRSNAP_WINDOWS_FFMPEG_PATH=$ffmpeg");
    expect(workflow).toContain("--sign-stage-only --release --require-signing");
    expect(workflow).toContain("archive-windows-signing-input.ps1");
    expect(workflow).toContain("install-trusted-signing.ps1");
    expect(workflow).toContain("- linux-build");
    expect(workflow).toContain("- sign");
    expect(workflow).toContain("- windows-sign");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--verify-tag");
    expect(workflow).toContain("--json isPrerelease");
    expect(workflow).not.toContain("WINDOWS_UNSIGNED_RELEASE");
    expect(workflow).not.toContain("WIN_CSC_LINK");
    expect(workflow).not.toContain("FFMPEG_BUILDS_PAT");
  });
});
