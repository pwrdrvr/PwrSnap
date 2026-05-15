#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");

export const ELECTRON_DEV_ENV_KEYS = [
  "ELECTRON_EXEC_PATH",
  "ELECTRON_RENDERER_URL",
  "ELECTRON_RUN_AS_NODE",
  "NODE_PATH",
  "PNPM_SCRIPT_SRC_DIR"
];

export function sanitizeDevEnv(input = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) env[key] = value;
  }

  const removed = [];
  for (const key of ELECTRON_DEV_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      removed.push(key);
    }
  }

  return { env, removed };
}

export function normalizeNodeVersion(version) {
  return version.trim().replace(/^v/, "");
}

export function checkNodeVersion(actualVersion, nvmrcContents) {
  const actual = normalizeNodeVersion(actualVersion);
  const expected = normalizeNodeVersion(nvmrcContents);
  return {
    actual,
    expected,
    ok: actual === expected
  };
}

function readExpectedNodeVersion() {
  return readFileSync(resolve(repoRoot, ".nvmrc"), "utf8").trim();
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env,
    stdio: "inherit"
  });
  if (result.error !== undefined) {
    console.error(`[dev] failed to run ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

export function main(argv = process.argv.slice(2), inputEnv = process.env) {
  const nodeCheck = checkNodeVersion(process.version, readExpectedNodeVersion());
  if (!nodeCheck.ok) {
    console.error(
      `[dev] Node ${process.version} does not match .nvmrc v${nodeCheck.expected}.`
    );
    console.error("[dev] Run `nvm use` from the repo root, then retry `pnpm dev`.");
    return 1;
  }

  const { env, removed } = sanitizeDevEnv(inputEnv);
  if (removed.length > 0) {
    console.warn(`[dev] scrubbed inherited launch env: ${removed.join(", ")}`);
  }

  const node = process.execPath;
  for (const script of [
    "./scripts/rebuild-native-for-electron.mjs",
    "./scripts/build-native.mjs"
  ]) {
    const status = run(node, [script], env);
    if (status !== 0) return status;
  }

  const electronViteBin = resolve(desktopRoot, "node_modules/.bin/electron-vite");
  if (!existsSync(electronViteBin)) {
    console.error("[dev] electron-vite binary is missing; run `pnpm install`.");
    return 1;
  }

  return run(electronViteBin, ["dev", ...argv], env);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = main();
}
