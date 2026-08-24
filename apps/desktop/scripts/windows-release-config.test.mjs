import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { BUNDLED_FFMPEG } from "../../../scripts/generate-third-party-licenses.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function expectLocalMarkdownLinksToExist(path) {
  const sourcePath = resolve(repoRoot, path);
  const missing = [];

  for (const match of read(path).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (/^(?:https?:|mailto:)/.test(target) || target.length === 0) continue;
    if (!existsSync(resolve(dirname(sourcePath), target))) missing.push(target);
  }

  expect(missing, `${path} has missing local Markdown links`).toEqual([]);
}

describe("Windows release configuration", () => {
  test("electron-builder declares signing, updater, and .pwrsnap association metadata", () => {
    const config = read("apps/desktop/electron-builder.yml");

    expect(config).toMatch(/win:\r?\n[\s\S]*verifyUpdateCodeSignature: true/);
    expect(config).toMatch(/win:\r?\n[\s\S]*fileAssociations:\r?\n[\s\S]*ext: pwrsnap/);
    expect(config).toContain("mimeType: application/vnd.pwrdrvr.pwrsnap.bundle+zip");
    expect(config).toContain("artifactName: \"${productName}-${version}-windows-${arch}-setup.${ext}\"");
    expect(config).toContain("releaseType: prerelease");

    // The ARP DisplayName must not carry the version. electron-builder
    // defaults uninstallDisplayName to "${productName} ${version}"; leaving
    // it unset puts "PwrSnap <version>" in Add or Remove Programs and makes
    // the winget manifest's AppsAndFeaturesEntries.DisplayName move every
    // release. See docs/windows/winget/README.md.
    //
    // Anchored on purpose, and worth keeping that way. `^` rejects the key
    // commented out (`  # uninstallDisplayName: ...`), and walking only
    // two-space-indented lines from `nsis:` — rather than `[\s\S]*` — stops
    // the match escaping into a sibling top-level block, which would let the
    // nsis target lose the setting while this test still passed. Both are
    // realistic regressions that a looser pattern waves through.
    expect(config).toMatch(
      /^nsis:\r?\n(?: {2}.*\r?\n)*? {2}uninstallDisplayName: PwrSnap\r?$/m
    );
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
    expect(script).toContain("PWRSNAP_TARGET_ARCH: targetArch");
    expect(script).toContain("writeWindowsChecksums");
    expect(script).toContain("assertRequiredWindowsResources();");
    expect(script).toContain("build/native/window-list.exe");
    expect(script).toContain('"native", "verified-file.exe"');
    expect(script).toContain("PWRSNAP_WINDOWS_FFMPEG_PATH");
    expect(script).toContain('to: "PwrSnapFFmpeg.exe"');
    expect(script).toContain('from "./sharp-platform-packages.mjs"');
    expect(script).not.toContain("WIN_CSC_LINK");
    expect(script).not.toContain("--unsigned-release");

    const injection = script.indexOf("injectWin32PlatformPackages();");
    const pruning = script.indexOf("pruneSharpNativePackages({", injection);
    const nativeRebuild = script.indexOf("prepare staged better-sqlite3", pruning);
    const prepareOnlyExit = script.indexOf("if (prepareOnly) {", pruning);
    const electronBuilder = script.indexOf("const builderCli = resolveElectronBuilderCli();", pruning);
    expect(injection).toBeGreaterThan(-1);
    expect(pruning).toBeGreaterThan(injection);
    expect(nativeRebuild).toBeGreaterThan(pruning);
    expect(prepareOnlyExit).toBeGreaterThan(pruning);
    expect(electronBuilder).toBeGreaterThan(pruning);
  });

  test("Windows packages the atomic verified-file helper", () => {
    const config = read("apps/desktop/electron-builder.yml");
    const builder = read("apps/desktop/scripts/build-native.mjs");

    expect(config).toContain('from: "build/native/verified-file.exe"');
    expect(config).toContain('to: "PwrSnapVerifiedFile.exe"');
    expect(builder).toContain('join(nativeRoot, "verified-file-win", "main.cpp")');
    expect(builder).toContain('join(buildRoot, "verified-file.exe")');
  });

  test("the packaged native helper owns real CF_HDROP file copy and Explorer readback", () => {
    const source = read("apps/desktop/native/window-list-win/main.cpp");
    const fileClipboard = read("apps/desktop/src/main/clipboard/file-clipboard.ts");

    // CF_HDROP is predefined numeric format 15. A named Electron custom
    // format called "CF_HDROP" is not equivalent and must never replace this
    // Win32 write/read path.
    expect(source).toContain("--write-file-clipboard");
    expect(source).toContain("#include <shlobj.h>");
    expect(source).toContain('static_assert(CF_HDROP == 15');
    expect(source).toContain("SetClipboardData(CF_HDROP, dropMemory)");
    expect(source).toContain("drop->fWide = TRUE");
    expect(source).toContain("GMEM_MOVEABLE | GMEM_ZEROINIT");
    expect(source).toContain('RegisterClipboardFormatW(L"Preferred DropEffect")');
    expect(source).toContain("*effect = DROPEFFECT_COPY");
    expect(source).toContain("OpenClipboard(owner)");
    expect(source).toContain("DragQueryFileW(writtenDrop");

    expect(source).toContain("--read-file-clipboard");
    expect(source).toContain("GetClipboardData(CF_HDROP)");
    expect(source).toContain("IsFullyQualifiedWindowsPath");
    expect(source).toContain("CF_HDROP contains no files");

    expect(fileClipboard).toContain('format: "CF_HDROP"');
    expect(fileClipboard).toContain('["--write-file-clipboard", filePath]');
    expect(fileClipboard).not.toContain('writeBuffer("CF_HDROP"');

    // The same binary is already a required, packaged extraResource; the
    // clipboard commands must not become a dev-only helper.
    const config = read("apps/desktop/electron-builder.yml");
    expect(config).toContain('to: "PwrSnapWindowList.exe"');

    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain('PWRSNAP_WINDOWS_NATIVE_CLIPBOARD_SMOKE: "1"');
    expect(ci).toContain("windows-file-clipboard-native.test.ts");
    expect(ci.indexOf("Build native Windows clipboard helper")).toBeLessThan(
      ci.indexOf("Smoke-test native CF_HDROP round trip")
    );
  });

  test("Windows media export and packaging agree on the controlled h264_mf artifact", () => {
    const exporter = read("apps/desktop/src/main/recording/recording-exporter.ts");
    const resolver = read("apps/desktop/src/main/recording/ffmpeg-resolver.ts");
    const workflow = read(".github/workflows/release.yml");

    expect(exporter).toContain('["-c:v", "h264_mf"]');
    expect(exporter).toContain('platform === "win32"');
    expect(resolver).toContain('"PwrSnapFFmpeg.exe"');
    expect(workflow).toContain('foreach ($encoder in @("h264_mf", "aac"))');
    expect(workflow).toContain("PWRSNAP_WINDOWS_FFMPEG_PATH=$ffmpeg");

    const packager = read("apps/desktop/scripts/package-win.mjs");
    expect(packager).toContain('to: "PwrSnapFFmpeg.exe"');
    expect(packager).toContain("assertRequiredWindowsResources();");
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
    expect(workflow).toContain(`ffmpeg-${BUNDLED_FFMPEG.version}-macos-universal`);
    expect(workflow).toContain(`ffmpeg-${BUNDLED_FFMPEG.version}-windows-x64`);
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

  test("pull-request previews use hash-pinned public FFmpeg release payloads without secrets", () => {
    const preview = read(".github/workflows/preview-build.yml");

    // PR-authored workflow code must never receive the private build-repo App
    // credentials or enter a signing environment. The tagged release workflow
    // retains that protected path; previews consume only already-public bytes.
    expect(preview).not.toContain("actions/create-github-app-token");
    expect(preview).not.toContain("FFMPEG_BUILDS_APP_CLIENT_ID");
    expect(preview).not.toContain("FFMPEG_BUILDS_APP_PRIVATE_KEY");
    expect(preview).not.toContain("pwrsnap-ffmpeg-builds");
    expect(preview).not.toContain("gh run download");
    expect(preview).not.toMatch(/\$\{\{\s*(?:secrets|vars)\./);

    expect(
      preview.match(
        /FFMPEG_RELEASE_BASE_URL:\s*https:\/\/github\.com\/pwrdrvr\/PwrSnap\/releases\/download\/v1\.1\.0-alpha\.4/g,
      ) ?? [],
    ).toHaveLength(2);
    expect(preview).toContain("PwrSnap-1.1.0-alpha.4-universal-mac.zip");
    expect(preview).toContain(
      "607c1ac88e2740d805780e5c3d69d5a31c675ee12f1ca5b9bc0f7ad85f5b9d15",
    );
    expect(preview).toContain(
      "e058fa321d48b686e586bc337b1e9876f3b9cbfc34ad6ac623a6938de4e9a868",
    );
    expect(preview).toContain("PwrSnap-1.1.0-alpha.4-windows-x64-setup.exe");
    expect(preview).toContain(
      "88b821460701a3012a72f63225f4ed788024995f51c5b8017c89fe46f5962246",
    );
    expect(preview.match(/FFMPEG_RELEASE_PAYLOAD_SHA256:\s*[0-9a-f]{64}/g) ?? []).toHaveLength(2);
    expect(preview).toContain("shasum -a 256");
    expect(preview).toContain("Get-FileHash -Algorithm SHA256");

    // release.mjs removes stale FFmpeg while preparing the stage. Injection
    // must therefore happen between prepare and the actual ad-hoc package,
    // never before a one-shot package:dryrun invocation that would delete it.
    expect(preview.indexOf("Prepare preview package stage")).toBeLessThan(
      preview.indexOf("Stage controlled macOS FFmpeg from public release"),
    );
    expect(preview.indexOf("Stage controlled macOS FFmpeg from public release")).toBeLessThan(
      preview.indexOf("Build preview package (unsigned)"),
    );
    expect(preview).toContain("release.mjs --prepare-only");
    expect(preview).toContain("release.mjs --sign-stage-only --dryrun");
    expect(preview).not.toContain("package:dryrun");

    // Keep both expensive product checks: real installers are still built and
    // the extracted Windows binary still performs production-args encodes.
    expect(preview).toContain("Build preview installer (unsigned)");
    expect(preview).toContain("windows-ffmpeg-export-smoke.test.ts");
    expect(preview.indexOf("Stage controlled Windows FFmpeg from public release")).toBeLessThan(
      preview.indexOf("windows-ffmpeg-export-smoke.test.ts"),
    );
    expect(preview.indexOf("windows-ffmpeg-export-smoke.test.ts")).toBeLessThan(
      preview.indexOf("Build preview installer (unsigned)"),
    );
  });

  test("the signed Windows installer also publishes under a stable alias", () => {
    const workflow = read(".github/workflows/release.yml");

    // The websites want to hardcode releases/latest/download/<name>, so each
    // platform attaches one version-free copy. Without the Windows half the
    // site has to call the GitHub Releases API from the browser just to learn
    // the installer's URL.
    expect(workflow).toContain("Prepare stable-name DMG alias");
    expect(workflow).toContain("Prepare stable-name Windows installer alias");

    const protectedWindowsJob = workflow
      .split("\n  windows-sign:\n")[1]
      ?.split("\n  publish-release-assets:\n")[0];
    expect(protectedWindowsJob, "the protected Windows job is missing").toBeDefined();

    // The alias has to be born inside the protected job, after packaging and
    // before the upload: anywhere earlier and it predates the installer,
    // anywhere later and it is an unsigned file with a trusted name.
    const order = (needle) => protectedWindowsJob.indexOf(needle);
    expect(order("Prepare stable-name Windows installer alias")).toBeGreaterThan(
      order("--sign-stage-only --release --require-signing"),
    );
    expect(order("Prepare stable-name Windows installer alias")).toBeLessThan(
      order("Upload Windows installer artifact"),
    );

    const aliasStep = protectedWindowsJob
      .split("- name: Prepare stable-name Windows installer alias")[1]
      .split("\n      - name:")[0];

    expect(aliasStep).toContain('$aliasName = "PwrSnap-windows-x64-setup.exe"');
    // A copy, never a second trip through Azure signing — identical bytes keep
    // the Authenticode signature the previous step just verified.
    expect(aliasStep).toContain("Copy-Item -LiteralPath $versioned.FullName");
    expect(aliasStep).not.toContain("Invoke-TrustedSigning");
    // PwrSnap-windows-SHA256SUMS stays authoritative for every installer that
    // ships, alias included.
    expect(aliasStep).toContain('$lines += "$actual  $aliasName"');
    // ...but the alias must never reach updater metadata. electron-updater
    // resolves latest.yml and the .blockmap by exact filename, so aiming
    // either at a name that moves every release breaks update resolution and
    // delta downloads for everyone already installed. Assert against the
    // executable lines only — the comment explaining the rule names both
    // files, and should keep naming them.
    const aliasScript = aliasStep
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(aliasScript).not.toContain("latest.yml");
    expect(aliasScript).not.toContain("blockmap");

    // Both aliases have to survive the trip into the release, and the glob
    // that carries the Windows one is easy to narrow by accident. Anchor to
    // end-of-line: a plain toContain("...dist/*-setup.exe") is also satisfied
    // by the "...dist/*-setup.exe.blockmap" line below it, so deleting the
    // installer glob outright would still have passed.
    expect(workflow).toMatch(/release-stage\/dist\/\*-setup\.exe\r?$/m);
    expect(workflow).toContain("mac-dist/dist/PwrSnap.dmg");
    expect(workflow).toContain("windows-dist/PwrSnap-windows-x64-setup.exe");
  });

  test("install and support docs describe the shipping Windows contract", () => {
    const rootReadme = read("README.md");
    const windowsReadme = read("docs/windows/README.md");
    const wingetReadme = read("docs/windows/winget/README.md");
    const userFacingDocs = `${rootReadme}\n${windowsReadme}`;
    const paths = read("apps/desktop/src/main/persistence/paths.ts");
    const builder = read("apps/desktop/electron-builder.yml");
    const previewWorkflow = read(".github/workflows/preview-build.yml");
    const wingetInstaller = read("docs/windows/winget/PwrDrvr.PwrSnap.installer.yaml");

    // These source contracts make the documentation assertions evidence-based
    // instead of preserving prose after the product changes underneath it.
    expect(paths).toContain('join(app.getPath("documents"), "PwrSnap")');
    expect(paths).toContain('join(app.getPath("home"), "PwrSnap")');
    expect(paths).toContain('join(getDataRoot(), "pwrsnap.db")');
    expect(builder).toContain('LSMinimumSystemVersion: "14.0"');
    expect(builder).toMatch(/win:\r?\n[\s\S]*?target:\r?\n[\s\S]*?arch: \[x64\]/);
    expect(builder).toContain("verifyUpdateCodeSignature: true");
    expect(wingetInstaller).toContain("MinimumOSVersion: 10.0.0.0");
    expect(previewWorkflow).toContain("Build preview installer (unsigned)");
    expect(previewWorkflow).toContain("retention-days: 14");

    expect(rootReadme).toContain("macOS 14 or later");
    expect(rootReadme).toContain("Windows 10 or Windows 11");
    expect(rootReadme).toContain("Apple Silicon + Intel");
    expect(rootReadme).toContain("Linux desktop support is not shipped");
    expect(rootReadme).toContain("Developer ID signed, hardened, and Apple-notarized");
    expect(rootReadme).toContain("Authenticode-signed");
    expect(rootReadme).toMatch(/To install a\s+1\.1 prerelease/);
    expect(rootReadme).toMatch(/Once 1\.1 is promoted\s+stable/);

    for (const docs of [rootReadme, windowsReadme]) {
      expect(docs).toContain("PwrSnap-<version>-windows-x64-setup.exe");
      expect(docs).toContain("https://github.com/pwrdrvr/PwrSnap/releases/latest");
      expect(docs).toContain("https://github.com/pwrdrvr/PwrSnap/releases");
      expect(docs).toContain("Settings → General → Updates");
      expect(docs).toContain("%APPDATA%\\PwrSnap");
    }

    expect(rootReadme).toContain("~/Documents/PwrSnap");
    expect(windowsReadme).toContain("%USERPROFILE%\\Documents\\PwrSnap");
    expect(windowsReadme).toContain("%USERPROFILE%\\PwrSnap");
    expect(windowsReadme).toContain("PwrSnapFFmpeg.exe");
    expect(windowsReadme).toContain("users do not install FFmpeg separately");
    expect(windowsReadme).toContain("Windows Actions artifact");
    expect(windowsReadme).toContain("14 days and is unsigned");
    expect(windowsReadme).toContain("Windows video capture records the screen");
    expect(windowsReadme).toContain("Arm64 is not packaged");
    expect(windowsReadme).toContain("Help → Logs");
    expect(windowsReadme).toMatch(/To install a\s+1\.1 prerelease/);
    expect(windowsReadme).toMatch(/Once 1\.1 is promoted\s+stable/);
    expect(windowsReadme).toContain("preserves the previous working binding");
    expect(windowsReadme).toContain("Full-window capture on Windows depends on Electron");
    expect(wingetReadme).toContain("PwrSnap is not published there yet");
    expect(windowsReadme).toContain("not currently published in the Windows Package Manager");

    for (const stale of [
      "Windows Preview",
      "1.0.0-beta.20",
      "The real public release still needs final Authenticode signing",
      "Settings → Experimental",
      "Captures land under `~/Library/Application Support/PwrSnap/`",
      "https://github.com/pwrdrvr/PwrSnap/releases/latest/download/PwrSnap-windows-x64-setup.exe",
      "The 1.1 line is currently a prerelease",
      "For the current 1.1 prerelease line",
      "Windows video currently includes the pointer",
      "Some in-app shortcut labels still render macOS key glyphs",
      "shows the macOS Command glyph",
      "the remaining fallback is macOS-only",
      "Headed Windows smoke testing is not",
    ]) {
      expect(userFacingDocs).not.toContain(stale);
    }

    for (const protectedDetail of [
      "pwrdrvr/pwrsnap-ffmpeg-builds",
      "FFMPEG_BUILDS_APP_PRIVATE_KEY",
      "WIN_AZURE_SIGN_",
      "eus.codesigning.azure.net",
    ]) {
      expect(windowsReadme).not.toContain(protectedDetail);
    }

    for (const path of [
      "README.md",
      "docs/windows/README.md",
      "docs/windows/winget/README.md",
    ]) {
      expectLocalMarkdownLinksToExist(path);
    }
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
    // The protected macOS + Windows release jobs and the reference doc pin the
    // private build-repo commit independently. PR previews intentionally use
    // no private-repo credential; the public-release digest contract above
    // pins their exact derived payloads instead.
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
    // artifact names they download, the pin tables in the release docs, and —
    // the one with legal consequences — the LGPL-2.1 attribution and written
    // source offer in THIRD_PARTY_LICENSES.
    //
    // A repin PR that updates the workflows and forgets the notice would ship a
    // correct binary under a false attribution, and every other check would
    // still pass: the workflows only compare the artifact against their own
    // hardcode. Deriving is impossible across repos, so every restatement must
    // agree, and the release jobs additionally reconcile the downloaded
    // artifact's manifest against the notice.
    //
    // Version classes below must accept a hyphen (8.2.0-rc1). Excluding it
    // silently dropped every artifact-name pin for prerelease versions while
    // the test still passed. Quotes are optional because `FFMPEG_VERSION:
    // "8.1.1"` is an ordinary YAML edit, and `[ \t]*` rather than `\s*` so a
    // valueless key cannot bind to a token on the next line.
    const VERSION = "[0-9][0-9A-Za-z.+-]*";
    const envPattern = new RegExp(`FFMPEG_VERSION:[ \\t]*["']?(${VERSION})["']?`, "g");
    const artifactPattern = new RegExp(`ffmpeg-(${VERSION})-(?:macos|windows|linux)\\b`, "g");

    const found = [{ source: "generator", version: BUNDLED_FFMPEG.version }];
    const push = (source, text, pattern) => {
      for (const match of text.matchAll(pattern)) found.push({ source, version: match[1] });
    };

    for (const entry of readdirSync(resolve(repoRoot, ".github/workflows"))) {
      if (!/\.ya?ml$/.test(entry)) continue;
      const text = read(`.github/workflows/${entry}`);
      push(`workflow-env:${entry}`, text, envPattern);
      push(`workflow-artifact:${entry}`, text, artifactPattern);
    }

    // Read the docs unconditionally. Wrapping these in existsSync() means a
    // rename silently drops their pins with a green build.
    for (const docPath of [
      "docs/ffmpeg-build-reference.md",
      "docs/desktop-release-runbook.md",
    ]) {
      push(`doc:${docPath}`, read(docPath), artifactPattern);
    }

    push("notice", read("THIRD_PARTY_LICENSES"), /\bFFmpeg@([0-9][0-9A-Za-z.+-]*)/g);

    // Per-source floors, not a global count. A single total is satisfied by the
    // sources that did match: with 20 pins today, dropping THIRD_PARTY_LICENSES
    // entirely still cleared a `>= 5` floor, so the arm the test exists for
    // could contribute nothing and the test stayed green.
    for (const required of [
      "generator",
      "notice",
      "workflow-env:release.yml",
      "workflow-artifact:release.yml",
      "workflow-artifact:preview-build.yml",
      "doc:docs/ffmpeg-build-reference.md",
      "doc:docs/desktop-release-runbook.md",
    ]) {
      expect(
        found.filter((entry) => entry.source === required),
        `no FFmpeg version pin found in ${required}; its regex has stopped matching`,
      ).not.toHaveLength(0);
    }

    const distinct = [...new Set(found.map((entry) => entry.version))];
    expect(
      distinct,
      `FFmpeg version pins disagree: ${found.map((e) => `${e.source}=${e.version}`).join(", ")}`
    ).toHaveLength(1);
  });

  test("the pin scan does not police historical prose", () => {
    // docs/ffmpeg-build-reference.md records that a Linux artifact was built and
    // never shipped. If that sentence names a version, the scan above demands it
    // equal the CURRENT one, and the next bump can only go green by rewriting a
    // true statement into a false one — claiming the build repo produced an
    // artifact it never produced. CLAUDE.md protects this class of document.
    const linuxSection = read("docs/ffmpeg-build-reference.md").split("Why Linux was dropped")[1];
    expect(linuxSection, "the Linux post-mortem section is missing").toBeDefined();
    expect(linuxSection).not.toMatch(/ffmpeg-[0-9][0-9A-Za-z.+-]*-linux/);
  });

  test("release signing and public preview jobs reconcile artifacts against the shipped notice", () => {
    const workflow = read(".github/workflows/release.yml");
    const preview = read(".github/workflows/preview-build.yml");
    const archiveScript = read("scripts/release/archive-windows-signing-input.ps1");

    // Static agreement above only proves this repo is self-consistent. It
    // cannot see the build repo, so it cannot catch an artifact whose manifest
    // reports a version nobody mirrored here. The signing jobs close that by
    // comparing the manifest shipped with the binary against the notice being
    // packaged alongside it.
    expect(workflow.match(/node scripts\/check-bundled-ffmpeg-notice\.mjs/g) ?? []).toHaveLength(2);
    // Preview jobs are the only sites that can fire before a tag exists; both
    // platforms must reconcile their artifact rather than relying on PATH.
    expect(preview.match(/node scripts\/check-bundled-ffmpeg-notice\.mjs/g) ?? []).toHaveLength(2);
    expect(preview).toContain("resources/PwrSnapFFmpeg.exe");
    expect(preview).toContain('PWRSNAP_WINDOWS_FFMPEG_SMOKE: "1"');
    expect(preview).toContain("windows-ffmpeg-export-smoke.test.ts");
    expect(preview.indexOf("windows-ffmpeg-export-smoke.test.ts")).toBeGreaterThan(
      preview.indexOf("Stage controlled Windows FFmpeg from public release"),
    );
    expect(preview.indexOf("windows-ffmpeg-export-smoke.test.ts")).toBeLessThan(
      preview.indexOf("Build preview installer (unsigned)"),
    );

    // Both signing jobs check the STAGED notice — the bytes about to be packaged
    // — not the repo copy. Assert per job: a single toContain is satisfied by
    // either one, so a wrong path in the other would pass.
    const macJob = workflow.split("Download controlled macOS FFmpeg artifact")[1].split("- name:")[0];
    const winJob = workflow.split("Download controlled Windows FFmpeg artifact")[1].split("- name:")[0];
    for (const [label, job] of [["macOS", macJob], ["Windows", winJob]]) {
      expect(job, `${label} job must check the staged notice`).toContain(
        "--notice apps/desktop/release-stage/THIRD_PARTY_LICENSES",
      );
    }

    // Neither signing job has a checkout, so each tarball must carry the script.
    // Anchor the macOS assertion to the `tar -czf` list: the bare filename also
    // appears on the invocation line, so a plain toContain stayed green when the
    // tar-list entry was deleted — and the release then died at signing time.
    const tarList = workflow.split("tar -czf")[1].split("sha256=")[0];
    expect(tarList, "macOS signing input must pack the checker").toContain(
      "scripts/check-bundled-ffmpeg-notice.mjs",
    );
    expect(tarList, "macOS signing input must pack Sharp layout helpers").toContain(
      "apps/desktop/scripts/sharp-platform-packages.mjs",
    );
    expect(archiveScript).toContain("scripts/check-bundled-ffmpeg-notice.mjs");
  });

  test("windows signing input covers every transitive import", () => {
    // The windows-sign job has no checkout: it unpacks this allowlist and
    // nothing else. A script whose import is missing does not fail lint, it
    // throws ERR_MODULE_NOT_FOUND inside the protected job AFTER Azure signing.
    // That is not hypothetical — verify-asar-contents.mjs gained an import of
    // scripts/lib/cli-entrypoint.mjs in #426, which updated the macOS allowlist
    // in release.yml and missed this one, breaking every Windows release.
    const listed = [
      ...read("scripts/release/archive-windows-signing-input.ps1")
        .split("$paths = @(")[1]
        .split(")")[0]
        .matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]);

    // The allowlist is written with forward slashes (it is consumed by tar and
    // by PowerShell string matching), but node:path yields native separators —
    // on Windows `relative()` returns "scripts\\lib\\cli-entrypoint.mjs", which
    // matches no entry and reports every import as missing. Compare in one
    // separator style.
    const posix = (path) => path.split(sep).join("/");
    const covered = (path) =>
      listed.some((entry) => path === entry || path.startsWith(`${entry}/`));

    const missing = [];
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file) || !file.endsWith(".mjs") || !existsSync(resolve(repoRoot, file))) return;
      seen.add(file);
      for (const match of read(file).matchAll(/^import[^"']*from\s+["'](\.[^"']+)["']/gm)) {
        const dep = posix(relative(repoRoot, resolve(repoRoot, dirname(file), match[1])));
        if (!covered(dep)) missing.push(`${file} imports ${dep}`);
        walk(dep);
      }
    };
    for (const entry of listed.filter((path) => path.endsWith(".mjs"))) walk(entry);

    expect(missing, `Windows signing input is missing transitive imports`).toEqual([]);
  });
});
