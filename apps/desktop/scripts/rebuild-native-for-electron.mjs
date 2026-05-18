/**
 * Keep better-sqlite3's Node and Electron native bindings side-by-side.
 *
 * The default build/Release/better_sqlite3.node remains compiled for the
 * developer's Node runtime, so unit tests and scripts keep working. This script
 * downloads the Electron-compatible prebuild into electron-native/ and the app
 * opts into that binding when running inside Electron.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

ensureDefaultNodeBinding();

if (isCurrentElectronBinary()) {
  console.log(`Electron better-sqlite3 binary already exists for Electron ${electronVersion}.`);
  process.exit(0);
}

console.log(`Downloading better-sqlite3 prebuild for Electron ${electronVersion} (${electronArch})...`);
rmSync(electronNativeDir, { force: true, recursive: true });

if (existsSync(defaultBinary)) {
  copyFileSync(defaultBinary, backupBinary);
}

try {
  if (electronArch === "universal") {
    // Universal build: download both arm64 and x64 prebuilds into temp
    // paths, then `lipo` them into a fat binary at the sidecar
    // location. Required by the `electron-builder --universal` target,
    // which itself merges two single-arch .app bundles via
    // @electron/universal — but the better-sqlite3 native binding has
    // to already be universal in the staged tree before that runs,
    // because each per-arch build pulls from the same node_modules.
    downloadUniversalPrebuild();
  } else {
    execSync(
      `${resolvePrebuildInstallCommand()} --runtime=electron --target=${electronVersion} --arch=${electronArch} --tag-prefix=v --strip`,
      { cwd: betterSqlite3Dir, stdio: "inherit" }
    );
    mkdirSync(electronNativeDir, { recursive: true });
    copyFileSync(defaultBinary, targetBinary);
  }
} catch (error) {
  restoreDefaultBinary();
  console.error("Failed to download Electron better-sqlite3 prebuild:", error.message);
  process.exit(1);
}

writeFileSync(metadataFile, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
restoreDefaultBinary();

console.log(`Electron better-sqlite3 binary placed at ${targetBinary}`);

function downloadUniversalPrebuild() {
  if (process.platform !== "darwin") {
    throw new Error("universal arch is only supported on darwin (requires lipo)");
  }
  const archs = ["arm64", "x64"];
  const slicePaths = [];
  for (const arch of archs) {
    console.log(`  downloading ${arch} prebuild...`);
    execSync(
      `${resolvePrebuildInstallCommand()} --runtime=electron --target=${electronVersion} --arch=${arch} --tag-prefix=v --strip`,
      { cwd: betterSqlite3Dir, stdio: "inherit" }
    );
    if (!existsSync(defaultBinary)) {
      throw new Error(`prebuild-install left no binary at ${defaultBinary} for arch=${arch}`);
    }
    const slicePath = join(tmpdir(), `better_sqlite3.${arch}.${process.pid}.node`);
    copyFileSync(defaultBinary, slicePath);
    slicePaths.push(slicePath);
  }
  mkdirSync(electronNativeDir, { recursive: true });
  const lipoResult = spawnSync(
    "lipo",
    ["-create", ...slicePaths, "-output", targetBinary],
    { stdio: "inherit" }
  );
  for (const slice of slicePaths) {
    try { unlinkSync(slice); } catch { /* best effort */ }
  }
  if (lipoResult.status !== 0) {
    throw new Error(`lipo -create failed with status ${lipoResult.status}`);
  }
  console.log(`  universal binary at ${targetBinary}`);
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
  execFileSync("npm", ["run", "install"], { cwd: betterSqlite3Dir, env, stdio: "inherit" });

  if (!isDefaultNodeBindingUsable()) {
    throw new Error("better-sqlite3 default Node binding is still unusable after rebuild");
  }
}

function isDefaultNodeBindingUsable() {
  try {
    execFileSync(process.execPath, ["-e", "require(process.argv[1])", betterSqlite3Dir], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}
