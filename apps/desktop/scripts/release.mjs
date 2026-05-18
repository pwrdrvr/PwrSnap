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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

const args = process.argv.slice(2);
const dryrun = args.includes("--dryrun");
const noPublish = args.includes("--no-publish");
const prepareOnly = args.includes("--prepare-only");
const signStageOnly = args.includes("--sign-stage-only");

if (prepareOnly && signStageOnly) {
  throw new Error("--prepare-only and --sign-stage-only cannot be combined");
}
if (prepareOnly && dryrun) {
  throw new Error("--prepare-only and --dryrun cannot be combined");
}

const publish = !dryrun && !noPublish && !prepareOnly;

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
}
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
}
builderArgs.push(publish ? "--publish" : "--publish=never", publish ? "always" : "");
const cleanedArgs = builderArgs.filter((arg) => arg !== "");
runChecked("node", [electronBuilderCli(), ...cleanedArgs], {
  cwd: stageDir,
  env: pnpmProjectConfigEnv
});

const builtApp = join(stageDir, "dist", `mac-${releaseArch}`, "PwrSnap.app");

// 9. Verify native helper packaging/signing. The helper is a standalone
//    executable under Contents/Resources, not a Node addon; end-user installs
//    must get a prebuilt, signed binary.
step("verify packaged native helpers");
const windowListHelper = join(builtApp, "Contents", "Resources", "PwrSnapWindowList");
if (!existsSync(windowListHelper)) {
  throw new Error(`missing packaged native helper: ${windowListHelper}`);
}
if (process.platform === "darwin") {
  runChecked("codesign", ["--verify", "--strict", "--verbose=2", windowListHelper]);
}

// 9. For universal builds, verify both Apple Silicon and Intel slices are
//    present in the main executable, the bundled Swift helper, and the
//    better-sqlite3 native addon. A single-arch slice slipping through
//    means Intel users would launch into an immediate SIGKILL.
if (releaseArch === "universal" && process.platform === "darwin") {
  step("verify universal binary slices");
  const lipoTargets = [
    join(builtApp, "Contents", "MacOS", "PwrSnap"),
    windowListHelper,
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
