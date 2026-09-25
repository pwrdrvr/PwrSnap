/**
 * Keep better-sqlite3's Node and Electron native bindings side-by-side.
 *
 * The default build/Release/better_sqlite3.node remains compiled for the
 * developer's Node runtime, so unit tests and scripts keep working. This script
 * puts an Electron-ABI binding into electron-native/ and the app opts into that
 * binding when running inside Electron.
 *
 * The Electron binding is the published prebuild when one exists, and a source
 * build when none does. better-sqlite3 12.x is the last line written against
 * V8's own API (13.x moved to N-API), and its last prebuilds stop at Electron 43
 * (ABI 148) — so on Electron 44 and later every platform compiles. The compile
 * runs in a scratch copy of the package, never in the installed one: node-gyp's
 * `rebuild` starts by deleting build/, which is where the Node binding lives.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);

const betterSqlite3PackagePath = require.resolve("better-sqlite3/package.json");
const betterSqlite3Dir = dirname(betterSqlite3PackagePath);
const betterSqlite3Version = require(betterSqlite3PackagePath).version;
const electronVersion = resolveElectronVersion();
const electronArch = resolveElectronArch();

const electronNativeDir = join(betterSqlite3Dir, "electron-native");
const targetBinary = join(electronNativeDir, "better_sqlite3.node");
const metadataFile = join(electronNativeDir, "metadata.json");
const defaultBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node");
const backupBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node.bak");
const expectedMetadata = {
  arch: electronArch,
  betterSqlite3Version,
  electronVersion
};

const ELECTRON_HEADERS_URL = "https://electronjs.org/headers";
// Electron's own recipe keeps its headers out of node-gyp's default cache,
// which is keyed by version number alone and shared with Node's headers.
const ELECTRON_GYP_DIR = join(homedir(), ".electron-gyp");
// Top-level entries of the installed package that the scratch build must not
// inherit: build/ holds the Node binding, electron-native/ is this script's
// output, and node_modules/ is pnpm's link farm for the package's own deps.
const SCRATCH_EXCLUDES = new Set(["build", "electron-native", "node_modules"]);
// node-gyp reads every `npm_config_<key>` variable as an option and applies it
// AFTER the command line, so these would silently win over the flags below.
// The release scripts export `npm_config_arch=universal` for this script's
// benefit, which is not an arch node-gyp can build.
const NODE_GYP_TARGET_ENV =
  /^npm_config_(arch|target_arch|target|runtime|disturl|dist_url|nodedir|devdir)$/i;

ensureDefaultNodeBinding();

if (isCurrentElectronBinary()) {
  console.log(`Electron better-sqlite3 binary already exists for Electron ${electronVersion}.`);
  process.exit(0);
}

console.log(`Preparing better-sqlite3 binding for Electron ${electronVersion} (${electronArch})...`);
rmSync(electronNativeDir, { force: true, recursive: true });

if (existsSync(defaultBinary)) {
  copyFileSync(defaultBinary, backupBinary);
}

try {
  mkdirSync(electronNativeDir, { recursive: true });
  if (electronArch === "universal") {
    // Universal build: prepare arm64 and x64 bindings into temp paths,
    // then `lipo` them into a fat binary at the sidecar location.
    // Required by the `electron-builder --universal` target, which itself
    // merges two single-arch .app bundles via @electron/universal — but the
    // better-sqlite3 native binding has to already be universal in the
    // staged tree before that runs, because each per-arch build pulls from
    // the same node_modules.
    prepareUniversalBinding();
  } else {
    prepareElectronBinding(electronArch, targetBinary);
  }
} catch (error) {
  rmSync(electronNativeDir, { force: true, recursive: true });
  restoreDefaultBinary();
  console.error("Failed to prepare the Electron better-sqlite3 binding:", error.message);
  process.exit(1);
}

writeFileSync(metadataFile, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
restoreDefaultBinary();

console.log(`Electron better-sqlite3 binary placed at ${targetBinary}`);

function prepareUniversalBinding() {
  if (process.platform !== "darwin") {
    throw new Error("universal arch is only supported on darwin (requires lipo)");
  }
  const slicePaths = [];
  try {
    for (const arch of ["arm64", "x64"]) {
      console.log(`  preparing ${arch} slice...`);
      const slicePath = join(tmpdir(), `better_sqlite3.${arch}.${process.pid}.node`);
      prepareElectronBinding(arch, slicePath);
      slicePaths.push(slicePath);
    }
    const lipoResult = spawnSync(
      "lipo",
      ["-create", ...slicePaths, "-output", targetBinary],
      { stdio: "inherit" }
    );
    if (lipoResult.status !== 0) {
      throw new Error(`lipo -create failed with status ${lipoResult.status}`);
    }
  } finally {
    for (const slice of slicePaths) {
      try { unlinkSync(slice); } catch { /* best effort */ }
    }
  }
  console.log(`  universal binary at ${targetBinary}`);
}

function prepareElectronBinding(arch, destination) {
  try {
    execSync(
      `${resolvePrebuildInstallCommand()} --runtime=electron --target=${electronVersion} --arch=${arch} --tag-prefix=v --strip`,
      { cwd: betterSqlite3Dir, stdio: ["ignore", "inherit", "pipe"] }
    );
  } catch (error) {
    // Both ways this misses fail loudly rather than fetching a wrong ABI:
    // prebuild-install's node-abi THROWS for an Electron it does not know
    // (it never guesses the nearest ABI), and a known ABI with no published
    // asset is a 404. Either way the answer is the same: compile.
    console.log(
      `  no ${arch} prebuild for Electron ${electronVersion} (${prebuildFailureReason(error)}); compiling from source...`
    );
    compileElectronBinding(arch, destination);
    return;
  }
  if (!existsSync(defaultBinary)) {
    throw new Error(`prebuild-install left no binary at ${defaultBinary} for arch=${arch}`);
  }
  copyFileSync(defaultBinary, destination);
}

function prebuildFailureReason(error) {
  const lines = String(error.stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.find((line) => line.startsWith("Error:") || line.includes("No prebuilt binaries")) ??
    lines.at(-1) ??
    error.message
  );
}

function compileElectronBinding(arch, destination) {
  const workDir = mkdtempSync(join(tmpdir(), "pwrsnap-better-sqlite3-"));
  try {
    cpSync(betterSqlite3Dir, workDir, {
      recursive: true,
      dereference: true,
      filter: (source) => !SCRATCH_EXCLUDES.has(relative(betterSqlite3Dir, source).split(sep)[0])
    });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (NODE_GYP_TARGET_ENV.test(key)) delete env[key];
    }
    execFileSync(
      process.execPath,
      [
        resolveNodeGyp(),
        "rebuild",
        "--release",
        `--target=${electronVersion}`,
        `--arch=${arch}`,
        `--dist-url=${ELECTRON_HEADERS_URL}`,
        `--devdir=${ELECTRON_GYP_DIR}`,
        "--jobs=max"
      ],
      { cwd: workDir, env, stdio: "inherit" }
    );
    const built = join(workDir, "build", "Release", "better_sqlite3.node");
    if (!existsSync(built)) {
      throw new Error(`node-gyp left no binary at ${built} for arch=${arch}`);
    }
    copyFileSync(built, destination);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function resolveNodeGyp() {
  // `pnpm run` and `npm run` both export the node-gyp they bundle. dev.mjs and
  // the release scripts launch this file with plain `node`, and the macOS
  // release stage is `pnpm deploy --prod` (no dev dependencies), so the
  // fallback is the npm that ships alongside whichever Node is running this.
  const bundledWithNode =
    process.platform === "win32"
      ? join(dirname(process.execPath), "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js")
      : join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js");
  const candidates = [process.env.npm_config_node_gyp, bundledWithNode].filter(
    (candidate) => typeof candidate === "string" && candidate.endsWith(".js")
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`node-gyp not found to compile better-sqlite3; tried ${candidates.join(", ")}`);
  }
  return found;
}

function isCurrentElectronBinary() {
  if (!existsSync(targetBinary) || !existsSync(metadataFile)) {
    return false;
  }

  try {
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    return (
      metadata.arch === expectedMetadata.arch &&
      metadata.betterSqlite3Version === expectedMetadata.betterSqlite3Version &&
      metadata.electronVersion === expectedMetadata.electronVersion
    );
  } catch {
    return false;
  }
}

function resolvePrebuildInstallCommand() {
  const packageBin = resolve(betterSqlite3Dir, "node_modules", ".bin", "prebuild-install");
  if (existsSync(packageBin)) {
    return packageBin;
  }

  const pnpmFallback = resolve(betterSqlite3Dir, "..", "prebuild-install", "bin.js");
  return `node ${pnpmFallback}`;
}

function restoreDefaultBinary() {
  if (!existsSync(backupBinary)) {
    return;
  }

  copyFileSync(backupBinary, defaultBinary);
  unlinkSync(backupBinary);
}

function resolveElectronArch() {
  return process.env.npm_config_arch || process.env.npm_config_target_arch || process.arch;
}

function resolveElectronVersion() {
  if (process.env.PWRSNAP_ELECTRON_VERSION) {
    return process.env.PWRSNAP_ELECTRON_VERSION;
  }

  try {
    return require("electron/package.json").version;
  } catch {
    throw new Error(
      "Unable to resolve Electron version; set PWRSNAP_ELECTRON_VERSION when running from a production dependency tree."
    );
  }
}

function ensureDefaultNodeBinding() {
  if (isDefaultNodeBindingUsable()) {
    return;
  }

  console.log("Default better-sqlite3 Node binding is unusable; rebuilding for system Node...");
  const env = {
    ...process.env,
    npm_config_arch: process.arch,
    npm_config_runtime: "node",
    npm_config_target: process.versions.node,
    npm_config_target_arch: process.arch
  };
  execSync("npm run install", { cwd: betterSqlite3Dir, env, stdio: "inherit" });

  if (!isDefaultNodeBindingUsable()) {
    throw new Error("better-sqlite3 default Node binding is still unusable after rebuild");
  }
}

function isDefaultNodeBindingUsable() {
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        'const Database = require(process.argv[1]); const database = new Database(":memory:"); database.close();',
        betterSqlite3Dir
      ],
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}
