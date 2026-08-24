import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { BUNDLED_FFMPEG } from "../../../scripts/generate-third-party-licenses.mjs";

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
    // artifact names they download, the pin tables in three docs, and — the one
    // with legal consequences — the LGPL-2.1 attribution and written source
    // offer in THIRD_PARTY_LICENSES.
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
      "docs/windows/README.md",
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
      "doc:docs/windows/README.md",
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

  test("all three signing/preview jobs reconcile the artifact against the shipped notice", () => {
    const workflow = read(".github/workflows/release.yml");
    const preview = read(".github/workflows/preview-build.yml");
    const archiveScript = read("scripts/release/archive-windows-signing-input.ps1");

    // Static agreement above only proves this repo is self-consistent. It
    // cannot see the build repo, so it cannot catch an artifact whose manifest
    // reports a version nobody mirrored here. The signing jobs close that by
    // comparing the manifest shipped with the binary against the notice being
    // packaged alongside it.
    expect(workflow.match(/node scripts\/check-bundled-ffmpeg-notice\.mjs/g) ?? []).toHaveLength(2);
    // The preview job is the only site that can fire before a tag exists; both
    // docs advertise it, so assert it rather than letting it be deleted silently.
    expect(preview).toContain("node scripts/check-bundled-ffmpeg-notice.mjs");

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
