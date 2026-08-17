import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { BUNDLED_FFMPEG_VERSION } from "../../../scripts/generate-third-party-licenses.mjs";

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
    expect(workflow).toContain(`ffmpeg-${BUNDLED_FFMPEG_VERSION}-macos-universal`);
    expect(workflow).toContain(`ffmpeg-${BUNDLED_FFMPEG_VERSION}-windows-x64`);
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

  test("release manifest verification asserts the decoder contract on both platforms", () => {
    const workflow = read(".github/workflows/release.yml");

    // The controlled build repo shipped a binary with no PNG decoder for two
    // months because CI verified encoders and devices but never decoders. Every
    // image-backed Sizzle reel failed to render in packaged builds. Both jobs
    // must reject a manifest that does not carry the decoder contract.
    expect(workflow).toContain("macOS FFmpeg manifest is missing required decoder check");
    expect(workflow).toContain("Windows FFmpeg manifest is missing required decoder check");
    expect(workflow.match(/requiredDecoders/g) ?? []).toHaveLength(2);
  });

  test("every FFmpeg build pin agrees across workflows and docs", () => {
    // The macOS release job, the Windows release job, and (once the preview
    // build consumes the controlled artifact) the preview job each pin
    // FFMPEG_BUILD_SHA independently. If they drift, macOS and Windows ship
    // binaries built from different sources and preview DMGs diverge from
    // release DMGs — which is exactly what hid the missing PNG decoder.
    const found = [];

    const workflowDir = resolve(repoRoot, ".github/workflows");
    for (const entry of readdirSync(workflowDir)) {
      if (!/\.ya?ml$/.test(entry)) continue;
      const text = read(`.github/workflows/${entry}`);
      for (const match of text.matchAll(/FFMPEG_BUILD_SHA:\s*([0-9a-f]{40})\b/g)) {
        found.push({ source: entry, sha: match[1] });
      }
    }

    // Optional: the reference doc tabulates the same pin.
    const docPath = "docs/ffmpeg-build-reference.md";
    if (existsSync(resolve(repoRoot, docPath))) {
      for (const match of read(docPath).matchAll(
        /`FFMPEG_BUILD_SHA`\s*\|\s*`([0-9a-f]{40})`/g
      )) {
        found.push({ source: docPath, sha: match[1] });
      }
    }

    expect(found.length).toBeGreaterThanOrEqual(2);

    const distinct = [...new Set(found.map((entry) => entry.sha))];
    expect(
      distinct,
      `FFmpeg build pins disagree: ${found.map((e) => `${e.source}=${e.sha}`).join(", ")}`
    ).toHaveLength(1);
  });

  test("every FFmpeg version pin agrees with the version THIRD_PARTY_LICENSES claims", () => {
    // The bundled ffmpeg's version is owned by another repository
    // (pwrdrvr/pwrsnap-ffmpeg-builds, FFMPEG_VERSION in scripts/lib/config.mjs)
    // and cannot be derived from anything installed here, so it is restated in
    // this repo once per consumer: the workflows' FFMPEG_VERSION guards, the
    // artifact names they download, the reference doc's pin table, and — the
    // one with legal consequences — the LGPL-2.1 attribution and written source
    // offer in THIRD_PARTY_LICENSES.
    //
    // A repin PR that updates the workflows and forgets the notice would ship a
    // correct binary under a false attribution, and every existing check would
    // still pass: the workflows only compare the artifact against their own
    // hardcode. This is the same shape as the @img/sharp-darwin-arm64 pin that
    // drifted from 0.34.5 to a shipping 0.35.3 unnoticed (fixed in df421b58 by
    // deriving it). Deriving is impossible across repos, so instead every
    // restatement must agree, and the release jobs additionally reconcile the
    // downloaded artifact's manifest against the notice.
    const found = [{ source: "scripts/generate-third-party-licenses.mjs", version: BUNDLED_FFMPEG_VERSION }];

    const workflowDir = resolve(repoRoot, ".github/workflows");
    for (const entry of readdirSync(workflowDir)) {
      if (!/\.ya?ml$/.test(entry)) continue;
      const text = read(`.github/workflows/${entry}`);
      for (const match of text.matchAll(/FFMPEG_VERSION:\s*([0-9][0-9A-Za-z.+-]*)/g)) {
        found.push({ source: `${entry} (FFMPEG_VERSION)`, version: match[1] });
      }
      for (const match of text.matchAll(/ffmpeg-([0-9][0-9A-Za-z.+]*)-(?:macos|windows|linux)\b/g)) {
        found.push({ source: `${entry} (artifact name)`, version: match[1] });
      }
    }

    const docPath = "docs/ffmpeg-build-reference.md";
    if (existsSync(resolve(repoRoot, docPath))) {
      for (const match of read(docPath).matchAll(/ffmpeg-([0-9][0-9A-Za-z.+]*)-(?:macos|windows|linux)\b/g)) {
        found.push({ source: docPath, version: match[1] });
      }
    }

    // The shipped notice is the point of the exercise, not an afterthought.
    for (const match of read("THIRD_PARTY_LICENSES").matchAll(/\bFFmpeg@([0-9][0-9A-Za-z.+-]*)/g)) {
      found.push({ source: "THIRD_PARTY_LICENSES", version: match[1] });
    }

    // Generator + both release jobs + the notice, at an absolute minimum. A
    // regex that silently stops matching would otherwise pass vacuously.
    expect(found.length).toBeGreaterThanOrEqual(5);

    const distinct = [...new Set(found.map((entry) => entry.version))];
    expect(
      distinct,
      `FFmpeg version pins disagree: ${found.map((e) => `${e.source}=${e.version}`).join(", ")}`
    ).toHaveLength(1);
  });

  test("both signing jobs reconcile the downloaded FFmpeg artifact against the shipped notice", () => {
    const workflow = read(".github/workflows/release.yml");
    const archiveScript = read("scripts/release/archive-windows-signing-input.ps1");

    // Static agreement above only proves this repo is self-consistent. It
    // cannot see the build repo, so it cannot catch an artifact whose manifest
    // reports a version nobody mirrored here. The signing jobs close that by
    // comparing the manifest that ships with the binary against the notice
    // being packaged alongside it.
    expect(workflow.match(/node scripts\/check-bundled-ffmpeg-notice\.mjs/g) ?? []).toHaveLength(2);
    // ...and packs it into the macOS signing input, which also has no checkout.
    expect(workflow).toContain("scripts/check-bundled-ffmpeg-notice.mjs \\");
    expect(workflow).toContain("--notice apps/desktop/release-stage/THIRD_PARTY_LICENSES");

    // windows-sign has no checkout, so the checker only exists there if the
    // archive step packs it. Wiring the call without this is a release-time
    // "file not found", which is why it is asserted rather than assumed.
    expect(archiveScript).toContain("scripts/check-bundled-ffmpeg-notice.mjs");
  });
});
