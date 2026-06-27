#!/usr/bin/env node
/**
 * PwrSnap desktop Windows packaging orchestrator.
 *
 * Sibling of scripts/release.mjs (the macOS universal DMG/ZIP path),
 * trimmed to the Windows x64 NSIS installer. Same core shape — the
 * `pnpm deploy` → flat-stage → electron-builder dance — because
 * electron-builder's default node_modules walk does not understand
 * pnpm's symlinked virtual store. Differences from release.mjs:
 *
 *   - Target is `--win nsis --x64`, not `--mac --universal`.
 *   - Preview builds are unsigned; release/publish builds require
 *     Authenticode signing input so SmartScreen does not see an
 *     accidentally unsigned installer.
 *   - No bundled Swift native helpers or Quick Look extensions - those
 *     are macOS-only and live under `mac:` in electron-builder.yml.
 *   - Windows releases may bundle a vetted LGPL `ffmpeg.exe` when
 *     PWRSNAP_WINDOWS_FFMPEG_PATH (or PWRSNAP_FFMPEG_PATH) points at it.
 *   - The injected platform package is sharp's win32-x64 slice (which
 *     bundles libvips), not the four darwin slices.
 *
 * Modes:
 *   --dryrun  / default: build + pack an unsigned NSIS installer, no publish.
 *   --release: enforce Authenticode + bundled ffmpeg inputs, no publish.
 *   --unsigned-release: enforce release runtime inputs, but skip Authenticode
 *                       and electron-builder publishing. This is only for
 *                       temporary/manual installer testing before the Windows
 *                       signing cert is available; it must not publish an
 *                       updater feed.
 *   --publish: same release checks, then publish via electron-builder.
 *
 * Output: apps/desktop/release-stage/dist/PwrSnap-<version>-windows-x64-setup.exe
 */

import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const stageDir = join(desktopRoot, "release-stage");
const targetArch = "x64";

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const unsignedRelease = args.includes("--unsigned-release");
const releaseMode = publish || args.includes("--release") || unsignedRelease;

if (publish && unsignedRelease) {
  throw new Error("--publish and --unsigned-release cannot be combined");
}

// Force pnpm to ignore any user-level global-pnpmfile inside child
// processes — mirrors release.mjs so the staged install resolves the
// same pnpmfile combination CI's --frozen-lockfile recorded.
const pnpmProjectConfigEnv = {
  npm_config_global_pnpmfile: "",
  NPM_CONFIG_GLOBAL_PNPMFILE: ""
};

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
    env: { ...process.env, ...opts.env },
    // pnpm/node resolve to .cmd shims on Windows; spawnSync needs a shell
    // to find them on PATH.
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// electron-builder is a devDependency, so it lives in the dev node_modules,
// not the production-only `pnpm deploy` stage. Prefer the staged copy if it
// somehow exists (e.g. a non-prod stage), otherwise fall back to the desktop
// dev tree. Mirrors release.mjs's electronBuilderCli().
function resolveElectronBuilderCli() {
  const staged = join(stageDir, "node_modules", "electron-builder", "cli.js");
  if (existsSync(staged)) return staged;
  const dev = join(desktopRoot, "node_modules", "electron-builder", "cli.js");
  if (existsSync(dev)) return dev;
  throw new Error(
    `electron-builder CLI missing at ${staged} and ${dev}; run \`pnpm install\` from the repo root first`
  );
}

function readElectronBuilderVersion() {
  const config = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
  const match = /^electronVersion:\s*([^\s#]+)/m.exec(config);
  if (!match) {
    throw new Error("electron-builder.yml is missing electronVersion");
  }
  return match[1];
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

function assertWindowsReleaseInputs({ requireSigning }) {
  if (process.platform !== "win32") {
    throw new Error("Windows release packaging must run on Windows so native packaging is exercised.");
  }

  const cscLink = process.env.WIN_CSC_LINK || process.env.CSC_LINK;
  const cscPassword = process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD;
  if (requireSigning && (!cscLink || !cscPassword)) {
    throw new Error(
      "Windows release packaging requires WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD " +
        "(or CSC_LINK/CSC_KEY_PASSWORD) for Authenticode signing."
    );
  }
  if (cscLink && cscPassword) {
    process.env.CSC_LINK ??= cscLink;
    process.env.CSC_KEY_PASSWORD ??= cscPassword;
  }

  if (publish && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    throw new Error("--publish requires GH_TOKEN or GITHUB_TOKEN so electron-builder can upload artifacts.");
  }

  const ffmpeg = resolveWindowsFfmpegInput();
  if (ffmpeg === null) {
    throw new Error(
      "Windows release packaging requires a vetted LGPL ffmpeg.exe. " +
        "Set PWRSNAP_WINDOWS_FFMPEG_PATH (preferred) or PWRSNAP_FFMPEG_PATH."
    );
  }
}

function resolveWindowsFfmpegInput() {
  const source = process.env.PWRSNAP_WINDOWS_FFMPEG_PATH || process.env.PWRSNAP_FFMPEG_PATH;
  if (!source || source.length === 0) return null;
  if (!existsSync(source)) {
    throw new Error(`configured Windows ffmpeg input does not exist: ${source}`);
  }
  return source;
}

function injectWindowsFfmpegResource(configPath) {
  let config = readFileSync(configPath, "utf8");
  if (config.includes("PwrSnapFFmpeg.exe")) return;
  const marker = '    - from: "build/native/window-list.exe"\n      to: "PwrSnapWindowList.exe"\n';
  const normalized = config.replace(/\r\n/g, "\n");
  if (!normalized.includes(marker)) {
    throw new Error("electron-builder.yml win.extraResources window-list marker not found");
  }
  config = normalized.replace(
    marker,
    marker + '    - from: "build/ffmpeg/ffmpeg.exe"\n      to: "PwrSnapFFmpeg.exe"\n'
  );
  writeFileSync(configPath, config);
}

function copyWindowsFfmpegIntoStage({ required }) {
  const source = resolveWindowsFfmpegInput();
  if (source === null) {
    if (required) {
      throw new Error("missing Windows ffmpeg release input");
    }
    console.log(
      "  ! no Windows ffmpeg configured; packaged video export/sizzle will rely on PWRSNAP_FFMPEG_PATH or PATH"
    );
    return;
  }
  const target = join(stageDir, "build", "ffmpeg", "ffmpeg.exe");
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  injectWindowsFfmpegResource(join(stageDir, "electron-builder.yml"));
  console.log(`  + bundled ffmpeg.exe from ${source}`);
}

function assertRequiredWindowsResources() {
  const required = [
    {
      label: "Windows window-list helper",
      path: join(stageDir, "build", "native", "window-list.exe"),
      hint: "Run `pnpm --filter @pwrsnap/desktop build:native` on Windows before packaging."
    }
  ];

  const missing = required.filter(({ path }) => !existsSync(path));
  if (missing.length === 0) return;

  const details = missing
    .map(({ label, path, hint }) => `- ${label} missing at ${path}\n  ${hint}`)
    .join("\n");
  throw new Error(`Windows package is missing required runtime resources:\n${details}`);
}

/**
 * `pnpm deploy --prod --legacy` stages only the host arch's slice and
 * drops platform-specific optionalDependencies. On the Windows runner
 * the host arch IS win32-x64, so sharp's binding is usually present —
 * but `pnpm deploy` still drops the optional dependency entry, leaving
 * an empty/stale package directory. Hand-copy the win32-x64 slice from
 * the workspace pnpm store so electron-builder packages the real
 * binding + bundled libvips. Mirrors release.mjs's
 * injectDarwinPlatformPackages().
 */
function injectWin32PlatformPackages() {
  const pnpmStore = join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(pnpmStore)) {
    throw new Error(
      `workspace pnpm store missing at ${pnpmStore}; run \`pnpm install\` from the repo root first`
    );
  }

  // sharp's win32-x64 package bundles libvips, so unlike darwin there is
  // no separate sharp-libvips-win32 slice to inject.
  const targets = [["@img/sharp-win32-x64", "sharp"]];

  for (const [pkgName, parent] of targets) {
    const parentManifest = readStagedPackageJson(parent);
    const expected = parentManifest.optionalDependencies?.[pkgName];
    if (typeof expected !== "string" || expected.length === 0) {
      throw new Error(
        `${parent} doesn't declare ${pkgName} in optionalDependencies; ` +
        `package-win.mjs platform-package list is out of sync with sharp version`
      );
    }
    const flatName = pkgName.replace("/", "+");
    const source = join(pnpmStore, `${flatName}@${expected}`, "node_modules", pkgName);
    if (!existsSync(source)) {
      throw new Error(
        `cannot find ${pkgName}@${expected} in workspace pnpm store at ${source}.\n` +
        `Run \`pnpm install\` from the repo root — pnpm-workspace.yaml's ` +
        `supportedArchitectures should pull the win32-x64 slice.`
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

if (releaseMode) {
  assertWindowsReleaseInputs({ requireSigning: !unsignedRelease });
}

// 1. License notices check (cheap, fail-fast).
step("license notices check");
runChecked("pnpm", ["licenses:check"], { cwd: repoRoot });

// 2. Build (electron-vite -> apps/desktop/out/).
step("electron-vite build");
runChecked("pnpm", ["--filter", "@pwrsnap/desktop", "build"], { cwd: repoRoot });

// 3. Materialize a self-contained, flat node_modules under stage.
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

// 3b. Inject sharp's win32-x64 slice that `pnpm deploy` drops.
step("inject win32 platform packages from workspace pnpm store");
injectWin32PlatformPackages();

// 4. Build the staged Electron-native better-sqlite3 sidecar for
//    win32-x64. The stage contains only production deps, so the script
//    reads the packaged Electron version from electron-builder.yml and
//    targets x64 via npm_config_arch.
step("prepare staged better-sqlite3 Electron sidecar (win32-x64)");
runChecked("node", ["scripts/rebuild-native-for-electron.mjs"], {
  cwd: stageDir,
  env: {
    PWRSNAP_ELECTRON_VERSION: readElectronBuilderVersion(),
    npm_config_arch: targetArch,
    npm_config_target_arch: targetArch
  }
});

// 5. Seed the stage with build output + electron-builder inputs.
step("seed stage with build output + builder inputs");
for (const dir of ["out", "build"]) {
  const target = join(stageDir, dir);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  const source = join(desktopRoot, dir);
  if (!existsSync(source)) continue;
  cpSync(source, target, { recursive: true });
}
cpSync(
  join(desktopRoot, "electron-builder.yml"),
  join(stageDir, "electron-builder.yml")
);
cpSync(join(repoRoot, ".npmrc"), join(stageDir, ".npmrc"));
for (const file of ["THIRD_PARTY_LICENSES", "CHANGELOG.md"]) {
  cpSync(join(repoRoot, file), join(stageDir, file));
}
copyWindowsFfmpegIntoStage({ required: releaseMode });
assertRequiredWindowsResources();

// 6. electron-builder --win nsis --x64.
//    electron-builder is a devDependency, so `pnpm deploy --prod` does NOT
//    stage it. Resolve the CLI from the dev node_modules (same approach as
//    release.mjs's electronBuilderCli fallback). Run with cwd = stageDir so
//    electron-builder packages the flat, production-only staged tree.
step(
  `electron-builder --win nsis --${targetArch} (${
    publish ? "publish" : unsignedRelease ? "unsigned release, no publish" : "no publish"
  })`
);
const builderCli = resolveElectronBuilderCli();
const builderArgs = [
  builderCli,
  "--win",
  "nsis",
  `--${targetArch}`,
  publish ? "--publish" : "--publish=never"
];
if (publish) builderArgs.push("always");
runChecked("node", builderArgs.filter(Boolean), {
  cwd: stageDir,
  env: pnpmProjectConfigEnv
});

// 7. Verify the installer actually landed. electron-builder can exit 0 even
//    when a target silently produces nothing (e.g. a missing icon/native
//    slice degrades to a partial build), so assert the .exe exists here
//    rather than letting CI upload an empty artifact and calling it green.
step("verify installer artifact");
const dist = join(stageDir, "dist");
const installers = existsSync(dist)
  ? readdirSync(dist).filter((name) => name.endsWith("-setup.exe"))
  : [];
if (installers.length === 0) {
  throw new Error(
    `electron-builder reported success but produced no *-setup.exe in ${dist}. ` +
    `Check the electron-builder output above (icon conversion, native slices).`
  );
}
for (const name of installers) {
  console.log(`  ✓ ${name}`);
}

step("done");
console.log(`  artifacts: ${dist}`);
