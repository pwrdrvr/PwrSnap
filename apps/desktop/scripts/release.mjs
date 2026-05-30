#!/usr/bin/env node
/**
 * PwrSnap desktop release orchestrator.
 *
 * Adapted from PwrAgnt's apps/desktop/scripts/release.mjs — same shape,
 * same problems, same fix.
 *
 * Why this script exists:
 *   - electron-builder's default node_modules walk does not understand
 *     pnpm's symlinked virtual store (`.pnpm/...`). Running it against
 *     the workspace root produces broken bundles. The fix is to first
 *     run `pnpm deploy` to materialize a flat node_modules tree under
 *     a stage dir, then point electron-builder at the stage. This
 *     script encapsulates that.
 *   - Modes:
 *       --dryrun      : build + package unsigned, no publish (fast iteration
 *                       — the only mode usable today without Apple
 *                       Developer ID provisioning).
 *       --no-publish  : build + package signed/notarized, no publish (local
 *                       end-to-end verification — Phase E5 in the upcoming
 *                       release packaging plan).
 *       --prepare-only:
 *                       build + prepare release-stage, no package/sign/publish.
 *                       Used by the CI prepare job, which then archives the
 *                       stage and ships it to the secret-gated sign job.
 *       --sign-stage-only:
 *                       sign/notarize/publish an already prepared
 *                       release-stage without reinstalling dependencies,
 *                       running tests, or invoking pnpm/npx postinstall
 *                       lifecycle scripts. Used by the CI sign job, which
 *                       runs inside the apple-signing environment.
 *       (default)     : build + package signed/notarized + publish to the
 *                       channel configured in electron-builder.yml.
 *   - In CI, the App Store Connect API key may arrive as a base64-encoded
 *     env var (`APPLE_API_KEY_BASE64`) instead of a file path. This script
 *     decodes it to a temp file and re-exports `APPLE_API_KEY` for
 *     electron-builder before invoking it. Local runs that already have
 *     `APPLE_API_KEY=/path/to/AuthKey.p8` are passed through unchanged.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const stageDir = join(desktopRoot, "release-stage");
const releaseArch = "universal";
const pnpmProjectConfigEnv = {
  npm_config_global_pnpmfile: "",
  NPM_CONFIG_GLOBAL_PNPMFILE: ""
};
let codesignKeychainCleanup = null;

const args = process.argv.slice(2);
const dryrun = args.includes("--dryrun");
const noPublish = args.includes("--no-publish");
const prepareOnly = args.includes("--prepare-only");
const signStageOnly = args.includes("--sign-stage-only");
// `--skip-notarize`: produce a Developer-ID-signed but unnotarized
// build. Useful for fast local iteration where you have a signing
// keychain but no App Store Connect API key handy, and you're OK
// with macOS Gatekeeper requiring a right-click → Open the first
// time. Default is to notarize whenever the build is meant to be
// shipped (anything except --dryrun).
const skipNotarize = args.includes("--skip-notarize");

if (prepareOnly && signStageOnly) {
  throw new Error("--prepare-only and --sign-stage-only cannot be combined");
}
if (prepareOnly && dryrun) {
  throw new Error("--prepare-only and --dryrun cannot be combined");
}
if (skipNotarize && dryrun) {
  throw new Error("--skip-notarize is implied by --dryrun (already unsigned)");
}

const publish = !dryrun && !noPublish && !prepareOnly;

/**
 * Returns true when this run is expected to produce a notarizable
 * artifact: not a dryrun, not --skip-notarize, and we're on macOS.
 * The check below is structural — see `assertNotarizationCreds`
 * for the upfront cred check.
 */
function shouldNotarize() {
  if (dryrun) return false;
  if (skipNotarize) return false;
  if (process.platform !== "darwin") return false;
  return true;
}

/**
 * Validate notarization credentials BEFORE running electron-builder.
 * Without this check, a missing-creds build silently produces a
 * Developer-ID-signed-but-unnotarized DMG — Gatekeeper rejects it
 * on first open with no actionable error. Two credential paths are
 * supported (electron-builder accepts either):
 *
 *   1. App Store Connect API key (CI's preferred path) —
 *      `APPLE_API_KEY` (or base64-encoded `APPLE_API_KEY_BASE64`
 *      decoded by maybeDecodeAppleApiKey above) + `APPLE_API_KEY_ID`
 *      + `APPLE_API_ISSUER`.
 *   2. Apple ID + app-specific password (local-dev convenience) —
 *      `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
 *
 * Set either group, or pass `--skip-notarize` to produce an
 * unnotarized build deliberately. The third option (--dryrun) is
 * for fast iteration with no signing at all.
 */
function assertNotarizationCreds() {
  if (!shouldNotarize()) return;

  const hasApiKey =
    Boolean(process.env.APPLE_API_KEY)
    && Boolean(process.env.APPLE_API_KEY_ID)
    && Boolean(process.env.APPLE_API_ISSUER);
  const hasAppleId =
    Boolean(process.env.APPLE_ID)
    && Boolean(process.env.APPLE_APP_SPECIFIC_PASSWORD)
    && Boolean(process.env.APPLE_TEAM_ID);

  if (hasApiKey || hasAppleId) return;

  throw new Error([
    "Refusing to build without notarization credentials.",
    "",
    "Set ONE of these credential groups:",
    "",
    "  • App Store Connect API key (CI default):",
    "      APPLE_API_KEY=/path/to/AuthKey_<id>.p8",
    "      APPLE_API_KEY_ID=<10-char key id>",
    "      APPLE_API_ISSUER=<issuer uuid>",
    "",
    "  • Apple ID + app-specific password (local convenience):",
    "      APPLE_ID=<apple-id@example.com>",
    "      APPLE_APP_SPECIFIC_PASSWORD=<xxxx-xxxx-xxxx-xxxx>",
    "      APPLE_TEAM_ID=<10-char team id>",
    "",
    "Or pass --skip-notarize to build a signed-but-unnotarized DMG ",
    "(Gatekeeper will warn the first time the user opens it).",
    "Or pass --dryrun for a fast unsigned local build."
  ].join("\n"));
}

function step(label) {
  console.log(`\n→ ${label}`);
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, {
    stdio: "inherit",
    cwd: opts.cwd ?? desktopRoot,
    env: { ...process.env, ...opts.env }
  });
}

function runChecked(file, argv, opts = {}) {
  console.log(`  $ ${file} ${argv.join(" ")}`);
  const result = spawnSync(file, argv, {
    stdio: "inherit",
    cwd: opts.cwd ?? desktopRoot,
    env: { ...process.env, ...opts.env }
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runQuiet(file, argv) {
  const result = spawnSync(file, argv, {
    cwd: desktopRoot,
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${file} ${argv.join(" ")} failed with exit ${result.status}${detail ? `:\n${detail}` : ""}`
    );
  }
  return result.stdout ?? "";
}

function parseSecurityKeychains(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^"|"$/g, ""));
}

function cscLinkFilePath() {
  const link = process.env.CSC_LINK;
  if (!link) return null;
  if (link.startsWith("file://")) {
    return fileURLToPath(link);
  }
  if (link.startsWith("~/")) {
    return join(process.env.HOME ?? "", link.slice(2));
  }
  if (existsSync(link)) {
    return link;
  }
  return null;
}

function findDeveloperIdIdentity(keychainPath) {
  const args = ["find-identity", "-v", "-p", "codesigning"];
  if (keychainPath) args.push(keychainPath);
  const out = runQuiet("security", args);
  const match = out.match(/"(Developer ID Application: [^"]+)"/);
  return match?.[1] ?? null;
}

function stripDeveloperIdApplicationPrefix(identity) {
  return identity.replace(/^Developer ID Application:\s*/, "");
}

function restoreCodesignKeychains(originalKeychains, keychainPath) {
  try {
    runQuiet("security", ["list-keychains", "-d", "user", "-s", ...originalKeychains]);
  } catch {
    // Process exit cleanup must not mask the original build result.
  }
  try {
    runQuiet("security", ["delete-keychain", keychainPath]);
  } catch {
    // Best effort only; GitHub-hosted runners are disposable.
  }
}

// Resolve electron-builder's CLI from the staged node_modules. The sign job
// runs without pnpm install / npx — invoking the CLI by absolute path through
// `node` keeps lifecycle scripts and package-manager binaries off the
// signing runner.
function electronBuilderCli() {
  const cli = join(stageDir, "node_modules", "electron-builder", "cli.js");
  if (existsSync(cli)) return cli;
  const fallback = join(desktopRoot, "node_modules", "electron-builder", "cli.js");
  if (existsSync(fallback)) return fallback;
  throw new Error(
    `electron-builder CLI is missing at ${cli} and ${fallback}; signing jobs must use a prepared release-stage artifact`
  );
}

// 1. Decode CI-provided Apple API key (if present) to a real .p8 file.
function maybeDecodeAppleApiKey() {
  if (process.env.APPLE_API_KEY && existsSync(process.env.APPLE_API_KEY)) {
    return; // already a path; nothing to do
  }
  const base64 = process.env.APPLE_API_KEY_BASE64;
  if (!base64) {
    return; // not set; signing/notarize will fail later if it was needed
  }
  const keyId = process.env.APPLE_API_KEY_ID;
  if (!keyId) {
    throw new Error("APPLE_API_KEY_BASE64 is set but APPLE_API_KEY_ID is missing");
  }
  const target = join(tmpdir(), `AuthKey_${keyId}.p8`);
  writeFileSync(target, Buffer.from(base64, "base64"));
  chmodSync(target, 0o600);
  process.env.APPLE_API_KEY = target;
  console.log("  decoded APPLE_API_KEY_BASE64 -> temporary App Store Connect key file");
}

// 1b. Decode CI-provided signing certificate (if present) to a real .p12 file.
//     electron-builder accepts base64 in CSC_LINK, but decoding it here avoids
//     ambiguity where a secret value gets interpreted as a relative file path
//     from the staged app directory.
function maybeDecodeCscLink() {
  const link = process.env.CSC_LINK;
  if (!link) return;
  if (
    link.startsWith("http://")
    || link.startsWith("https://")
    || link.startsWith("file://")
    || link.startsWith("/")
    || link.startsWith("~/")
    || existsSync(link)
  ) {
    return;
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(link)) {
    return;
  }
  const target = join(tmpdir(), "PwrSnap_Developer_ID_Application.p12");
  writeFileSync(target, Buffer.from(link, "base64"));
  chmodSync(target, 0o600);
  process.env.CSC_LINK = target;
  console.log("  decoded CSC_LINK -> temporary Developer ID certificate file");
}

// electron-builder imports CSC_LINK before its parent-app signing pass, but
// our afterPack hook must sign Quick Look .appex bundles earlier. In CI,
// preload the .p12 into a temporary keychain so both the hook and
// electron-builder resolve the same Developer ID identity deterministically.
function maybePrepareCodesignKeychain() {
  if (process.platform !== "darwin") return;
  if (!process.env.CSC_LINK) return;
  if (!process.env.CSC_KEY_PASSWORD) {
    throw new Error("CSC_LINK is set but CSC_KEY_PASSWORD is missing");
  }
  const certificatePath = cscLinkFilePath();
  if (certificatePath === null) {
    return;
  }

  const existingIdentity = findDeveloperIdIdentity(null);
  if (existingIdentity !== null) {
    process.env.PWRSNAP_APPEX_SIGN_IDENTITY ??= existingIdentity;
    process.env.CSC_NAME ??= stripDeveloperIdApplicationPrefix(existingIdentity);
    return;
  }

  const keychainPath = join(
    tmpdir(),
    `pwrsnap-codesign-${process.pid}-${Date.now()}.keychain-db`
  );
  const keychainPassword = `pwrsnap-${process.pid}-${Date.now()}`;
  const originalKeychains = parseSecurityKeychains(
    runQuiet("security", ["list-keychains", "-d", "user"])
  );

  runQuiet("security", ["create-keychain", "-p", keychainPassword, keychainPath]);
  runQuiet("security", ["set-keychain-settings", "-lut", "21600", keychainPath]);
  runQuiet("security", ["unlock-keychain", "-p", keychainPassword, keychainPath]);
  runQuiet("security", [
    "import",
    certificatePath,
    "-k",
    keychainPath,
    "-P",
    process.env.CSC_KEY_PASSWORD,
    "-T",
    "/usr/bin/codesign",
    "-T",
    "/usr/bin/security",
    "-T",
    "/usr/bin/productbuild"
  ]);
  runQuiet("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    keychainPassword,
    keychainPath
  ]);
  runQuiet("security", [
    "list-keychains",
    "-d",
    "user",
    "-s",
    keychainPath,
    ...originalKeychains
  ]);

  const identity = findDeveloperIdIdentity(keychainPath);
  if (identity === null) {
    restoreCodesignKeychains(originalKeychains, keychainPath);
    throw new Error(
      `imported ${pathToFileURL(certificatePath).href} into ${keychainPath}, ` +
      "but no Developer ID Application identity was found"
    );
  }

  process.env.CSC_KEYCHAIN = keychainPath;
  process.env.PWRSNAP_APPEX_SIGN_IDENTITY ??= identity;
  process.env.CSC_NAME ??= stripDeveloperIdApplicationPrefix(identity);
  codesignKeychainCleanup = () => restoreCodesignKeychains(originalKeychains, keychainPath);
  process.once("exit", () => {
    if (codesignKeychainCleanup !== null) {
      codesignKeychainCleanup();
      codesignKeychainCleanup = null;
    }
  });
  console.log(`  imported CSC_LINK into temporary keychain for ${identity}`);
}

if (!signStageOnly) {
  // 2. Check license notices before doing expensive release work.
  step("license notices check");
  runChecked("pnpm", ["licenses:check"], { cwd: repoRoot });

  // 3. Build native helpers. CI also runs this explicitly as an early,
  // readable failure, but release.mjs must be self-contained for local
  // package/release runs. PWRSNAP_NATIVE_UNIVERSAL=1 makes build-native
  // produce a fat binary (both arm64 and x86_64 slices) so the helper
  // can run on either arch under the universal `.app`.
  step("build native helpers");
  runChecked("pnpm", ["--filter", "@pwrsnap/desktop", "build:native"], {
    cwd: repoRoot,
    env: releaseArch === "universal" ? { PWRSNAP_NATIVE_UNIVERSAL: "1" } : {}
  });

  // 3b. Build the bundled LGPL ffmpeg binary from upstream source.
  // The previous npm binary was GPL+nonfree; this produces a
  // redistributable binary and verifies the configure line before
  // anything is packaged.
  step("build bundled LGPL ffmpeg");
  runChecked("pnpm", ["--filter", "@pwrsnap/desktop", "build:ffmpeg"], {
    cwd: repoRoot,
    env: releaseArch === "universal" ? { PWRSNAP_FFMPEG_UNIVERSAL: "1" } : {}
  });

  // 4. Build (electron-vite -> apps/desktop/out/).
  step("electron-vite build");
  runChecked("pnpm", ["--filter", "@pwrsnap/desktop", "build"], { cwd: repoRoot });

  // 5. Materialize a self-contained, flat node_modules under stage.
  step("pnpm deploy --prod -> release-stage");
  if (existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
  }
  mkdirSync(stageDir, { recursive: true });
  runChecked(
    "pnpm",
    ["deploy", "--filter", "@pwrsnap/desktop", "--prod", "--legacy", stageDir],
    { cwd: repoRoot }
  );

  // 5b. Inject darwin-arm64 + darwin-x64 platform packages that
  //     `pnpm deploy` drops on the floor. `pnpm-workspace.yaml`
  //     declares supportedArchitectures so the workspace install
  //     pulls all darwin slices into `node_modules/.pnpm/`, but
  //     `pnpm deploy --prod --legacy` only stages the host arch
  //     and even then drops platform-specific optionalDependencies
  //     entirely. Universal builds need both arch slices for sharp
  //     (native binding + libvips dylib), so we hand-copy them from
  //     the workspace pnpm store before
  //     electron-builder runs. Without this, the produced .app
  //     crashes on first launch with "Could not load the sharp
  //     module using the darwin-arm64 runtime" (we shipped this
  //     bug in Beta.3 — every install was DOA).
  step("inject darwin platform packages from workspace pnpm store");
  injectDarwinPlatformPackages();

  // 6. Build the staged Electron-native sqlite sidecar. The stage contains only
  //    production dependencies, so the script gets the packaged Electron version
  //    from electron-builder.yml instead of devDependency resolution.
  step("prepare staged better-sqlite3 Electron sidecar");
  runChecked("node", ["scripts/rebuild-native-for-electron.mjs"], {
    cwd: stageDir,
    env: {
      PWRSNAP_ELECTRON_VERSION: readElectronBuilderVersion(),
      npm_config_arch: releaseArch,
      npm_config_target_arch: releaseArch
    }
  });

  // 7. Seed the stage with the build output + electron-builder inputs.
  //    pnpm deploy copies the package source tree (including out/ if it
  //    exists) into the stage. Remove stale copies before our controlled
  //    cp to avoid macOS cp -R nesting (cp -R src dst/ creates dst/src/
  //    when dst exists).
  step("seed stage with build output + builder inputs");
  for (const dir of ["out", "build"]) {
    const target = join(stageDir, dir);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    const source = join(desktopRoot, dir);
    if (!existsSync(source)) continue;
    run(`cp -R ${source} ${target}`);
  }
  run(
    `cp ${join(desktopRoot, "electron-builder.yml")} ${join(stageDir, "electron-builder.yml")}`
  );
  run(`cp ${join(repoRoot, ".npmrc")} ${join(stageDir, ".npmrc")}`);
  for (const file of ["THIRD_PARTY_LICENSES", "CHANGELOG.md"]) {
    run(`cp ${join(repoRoot, file)} ${join(stageDir, file)}`);
  }

  // electron-builder also needs electron-builder.yml to resolve
  // electronVersion before signing. The CI sign job re-derives this from
  // the file we just copied. (Local --prepare-only is rare but supported.)
  if (prepareOnly) {
    step("prepared release-stage");
    console.log(`  stage: ${stageDir}`);
    console.log("  next: run release.mjs --sign-stage-only against this stage");
    process.exit(0);
  }
} else {
  if (!existsSync(stageDir)) {
    throw new Error(
      `release-stage is missing at ${stageDir}; --sign-stage-only requires a stage produced by --prepare-only`
    );
  }
  if (!existsSync(join(stageDir, "out"))) {
    throw new Error(`release-stage at ${stageDir} is missing out/; prepare step did not complete`);
  }
  if (!existsSync(join(stageDir, "node_modules"))) {
    throw new Error(`release-stage at ${stageDir} is missing node_modules/; prepare step did not complete`);
  }
}

// 8. electron-builder.
//    Dryrun mode (preview/dev) builds DMG only — saves ~30s of CI time and
//    keeps the preview-build artifact uncluttered. Real releases build both
//    DMG and ZIP because electron-updater requires the ZIP on macOS.
step(
  `electron-builder --mac${dryrun ? " dmg" : ""} --${releaseArch} (${publish ? "publish" : "no publish"}, ${
    dryrun ? "ad-hoc signed" : "signed"
  })`
);
maybeDecodeAppleApiKey();
if (!dryrun) {
  maybeDecodeCscLink();
  maybePrepareCodesignKeychain();
}
// Fail loudly BEFORE invoking electron-builder if we expect to
// notarize but don't have the creds. Cheaper than letting the
// notarize step run for ~10 minutes and then fail (or worse,
// silently produce an unnotarized artifact that Gatekeeper
// rejects on first open).
assertNotarizationCreds();
const builderArgs = ["--mac"];
if (dryrun) {
  builderArgs.push("dmg");
}
builderArgs.push(`--${releaseArch}`);
if (dryrun) {
  // Use ad-hoc signing (identity=-) instead of no signing (identity=null).
  // electron-builder modifies the Electron binary to set fuses, which
  // invalidates its original code signature. Without re-signing, macOS
  // kills the app with SIGKILL (Code Signature Invalid) on launch.
  // Ad-hoc signing creates a locally valid signature that satisfies
  // macOS page validation without requiring a Developer ID certificate.
  builderArgs.push("--config.mac.identity=-", "--config.mac.notarize=false");
} else if (skipNotarize) {
  // Sign with the real Developer ID identity (so the .app and its
  // nested .appex bundles pass codesign --verify), but skip the
  // Apple-server notarization call. Result: Gatekeeper warns on
  // first open; user can right-click → Open to dismiss.
  builderArgs.push("--config.mac.notarize=false");
}
builderArgs.push(publish ? "--publish" : "--publish=never", publish ? "always" : "");
const cleanedArgs = builderArgs.filter((arg) => arg !== "");
runChecked("node", [electronBuilderCli(), ...cleanedArgs], {
  cwd: stageDir,
  env: pnpmProjectConfigEnv
});
if (codesignKeychainCleanup !== null) {
  codesignKeychainCleanup();
  codesignKeychainCleanup = null;
}

const builtApp = join(stageDir, "dist", `mac-${releaseArch}`, "PwrSnap.app");

// 9. Verify native helper packaging/signing. The helpers are standalone
//    executables under Contents/Resources, not Node addons; end-user installs
//    must get prebuilt, signed binaries. Both helpers ship via
//    `extraResources` in electron-builder.yml; electron-osx-sign walks the
//    .app at sign time and re-signs every Mach-O it finds, but a missing
//    or unsigned helper would silently fail at runtime / notarization, so
//    we verify here.
step("verify packaged native helpers");
const nativeHelpers = [
  join(builtApp, "Contents", "Resources", "PwrSnapWindowList"),
  // PwrSnapRecorder — ScreenCaptureKit + AVFoundation recorder for
  // Fast Video Capture (issue #64). Without a valid Developer ID
  // signature, notarization rejects the bundle.
  join(builtApp, "Contents", "Resources", "PwrSnapRecorder"),
  join(builtApp, "Contents", "Resources", "PwrSnapFFmpeg")
];
for (const helper of nativeHelpers) {
  if (!existsSync(helper)) {
    throw new Error(`missing packaged native helper: ${helper}`);
  }
  if (process.platform === "darwin") {
    runChecked("codesign", ["--verify", "--strict", "--verbose=2", helper]);
  }
}

// 9. For universal builds, verify both Apple Silicon and Intel slices are
//    present in the main executable, the bundled Swift helper, and the
//    better-sqlite3 native addon. A single-arch slice slipping through
//    means Intel users would launch into an immediate SIGKILL.
if (releaseArch === "universal" && process.platform === "darwin") {
  step("verify universal binary slices");
  const lipoTargets = [
    join(builtApp, "Contents", "MacOS", "PwrSnap"),
    ...nativeHelpers,
    join(
      builtApp,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "electron-native",
      "better_sqlite3.node"
    )
  ];
  for (const target of lipoTargets) {
    runChecked("lipo", [target, "-verify_arch", "x86_64", "arm64"]);
  }
}

// 10. Post-build asar contents check — fails if forbidden files (TS sources,
//    tests, third-party docs, design docs, screenshots, etc.) leaked into the
//    bundle. Exclusions are configured in electron-builder.yml; this script
//    is a belt-and-braces guard against accidental edits to that YAML.
//    Pass the .app path explicitly so resolution doesn't compound off cwd.
step("verify packaged asar contents");
runChecked("node", [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp]);

step("done");
const dist = join(stageDir, "dist");
console.log(`  artifacts: ${dist}`);

function readElectronBuilderVersion() {
  const config = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
  const match = /^electronVersion:\s*([^\s#]+)/m.exec(config);
  if (!match) {
    throw new Error("electron-builder.yml is missing electronVersion");
  }
  return match[1];
}

/**
 * Workaround for `pnpm deploy` dropping platform-specific
 * optionalDependencies (sharp's libvips + native binding). See the
 * call site for the full incident note. We resolve each missing
 * package's expected version
 * from its parent's optionalDependencies in the already-staged
 * package.json, then hand-copy the matching tree out of the
 * workspace's pnpm store and into the stage's node_modules so
 * electron-builder + @electron/universal see both Darwin slices.
 */
function injectDarwinPlatformPackages() {
  const pnpmStore = join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(pnpmStore)) {
    throw new Error(
      `workspace pnpm store missing at ${pnpmStore}; run \`pnpm install\` from the repo root first`
    );
  }

  // Each entry: [npm-style package name, parent package whose
  //              optionalDependencies pin the version]
  const targets = [
    ["@img/sharp-darwin-arm64", "sharp"],
    ["@img/sharp-darwin-x64", "sharp"],
    ["@img/sharp-libvips-darwin-arm64", "sharp"],
    ["@img/sharp-libvips-darwin-x64", "sharp"]
  ];

  const parentVersions = new Map();
  for (const [pkgName, parent] of targets) {
    const parentManifest = parentVersions.get(parent) ?? readStagedPackageJson(parent);
    parentVersions.set(parent, parentManifest);
    const expected = parentManifest.optionalDependencies?.[pkgName];
    if (typeof expected !== "string" || expected.length === 0) {
      throw new Error(
        `${parent} doesn't declare ${pkgName} in optionalDependencies; ` +
        `release.mjs platform-package list is out of sync with sharp/ffmpeg versions`
      );
    }
    const flatName = pkgName.replace("/", "+");
    const source = join(pnpmStore, `${flatName}@${expected}`, "node_modules", pkgName);
    if (!existsSync(source)) {
      throw new Error(
        `cannot find ${pkgName}@${expected} in workspace pnpm store at ${source}.\n` +
        `Run \`pnpm install\` from the repo root — pnpm-workspace.yaml's ` +
        `supportedArchitectures should pull every darwin slice.`
      );
    }
    const target = join(stageDir, "node_modules", pkgName);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, dereference: true });
    console.log(`  + ${pkgName}@${expected}`);
  }
}

function readStagedPackageJson(pkgName) {
  const path = join(stageDir, "node_modules", pkgName, "package.json");
  if (!existsSync(path)) {
    throw new Error(
      `staged ${pkgName}/package.json missing at ${path}; pnpm deploy didn't install the parent package`
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
