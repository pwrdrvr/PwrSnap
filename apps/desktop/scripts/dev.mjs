#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
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

const TERMINAL_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"];

function exitCodeForSignal(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function signalChild(child, signal, platform = process.platform, killProcess = process.kill) {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }

  if (platform !== "win32") {
    try {
      killProcess(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }

  child.kill(signal);
}

export function runLongLived(command, args, env, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawn ?? spawn;
  const processTarget = options.process ?? process;
  const killProcess = options.killProcess ?? process.kill;
  const child = spawnImpl(command, args, {
    cwd: desktopRoot,
    detached: platform !== "win32",
    env,
    stdio: "inherit"
  });

  if (child.pid === undefined) {
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    let shutdownSignal = null;
    let forced = false;
    const signalHandlers = new Map();

    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) {
        processTarget.off(signal, handler);
      }
    };

    for (const signal of TERMINAL_SHUTDOWN_SIGNALS) {
      const handler = () => {
        if (forced) return;
        if (shutdownSignal !== null) {
          forced = true;
          signalChild(child, "SIGKILL", platform, killProcess);
          return;
        }

        shutdownSignal = signal;
        signalChild(child, signal, platform, killProcess);
      };
      signalHandlers.set(signal, handler);
      processTarget.on(signal, handler);
    }

    child.on("error", (error) => {
      cleanup();
      console.error(`[dev] failed to run ${command}: ${error.message}`);
      resolve(1);
    });

    child.on("close", (status, signal) => {
      cleanup();
      if (typeof status === "number") {
        resolve(status);
        return;
      }
      if (shutdownSignal !== null) {
        resolve(exitCodeForSignal(shutdownSignal));
        return;
      }
      if (signal === "SIGINT" || signal === "SIGTERM") {
        resolve(exitCodeForSignal(signal));
        return;
      }
      resolve(1);
    });
  });
}

export function electronExecutableRelativePath(platform = process.platform) {
  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      return null;
  }
}

export function electronInstallState(
  electronRoot = resolve(desktopRoot, "node_modules/electron"),
  platform = process.platform
) {
  const installScript = resolve(electronRoot, "install.js");
  if (!existsSync(installScript)) {
    return { ok: false, reason: "electron package is missing" };
  }

  const expectedPath = electronExecutableRelativePath(platform);
  if (expectedPath === null) {
    return { ok: false, reason: `Electron is not available on ${platform}` };
  }

  const pathFile = resolve(electronRoot, "path.txt");
  let relativePath = "";
  try {
    relativePath = readFileSync(pathFile, "utf8");
  } catch {
    return { ok: false, reason: "electron path.txt is missing" };
  }
  if (relativePath !== expectedPath) {
    return { ok: false, reason: "electron path.txt points at the wrong executable" };
  }

  if (!existsSync(resolve(electronRoot, "dist/version"))) {
    return { ok: false, reason: "electron dist/version is missing" };
  }
  if (!existsSync(resolve(electronRoot, "dist", relativePath))) {
    return { ok: false, reason: "electron executable is missing" };
  }

  return { ok: true, reason: "ok" };
}

export function ensureElectronInstalled(
  env,
  electronRoot = resolve(desktopRoot, "node_modules/electron"),
  node = process.execPath,
  platform = process.platform
) {
  const before = electronInstallState(electronRoot, platform);
  if (before.ok) return 0;
  if (!existsSync(resolve(electronRoot, "install.js"))) {
    console.error("[dev] Electron package is missing; run `pnpm install`.");
    return 1;
  }

  console.warn(`[dev] repairing Electron install: ${before.reason}`);
  const status = run(node, [resolve(electronRoot, "install.js")], env);
  if (status !== 0) return status;

  const after = electronInstallState(electronRoot, platform);
  if (!after.ok) {
    console.error(`[dev] Electron install is still incomplete: ${after.reason}`);
    console.error("[dev] Run `pnpm install` from the repo root, then retry `pnpm dev`.");
    return 1;
  }
  return 0;
}

export async function main(argv = process.argv.slice(2), inputEnv = process.env) {
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

  const electronStatus = ensureElectronInstalled(env);
  if (electronStatus !== 0) return electronStatus;

  const node = process.execPath;
  for (const script of [
    "./scripts/rebuild-native-for-electron.mjs",
    "./scripts/build-native.mjs"
  ]) {
    const status = run(node, [script], env);
    if (status !== 0) return status;
  }

  // Run electron-vite's JS entry directly with node rather than the
  // node_modules/.bin shim. The `.bin/electron-vite` entry is a platform-
  // specific wrapper — a `.cmd` on Windows — which spawnSync can't execute
  // without a shell (ENOENT). The JS bin is cross-platform and is exactly
  // what that shim invokes (`node …/bin/electron-vite.js`).
  const electronViteJs = resolve(
    desktopRoot,
    "node_modules/electron-vite/bin/electron-vite.js"
  );
  if (!existsSync(electronViteJs)) {
    console.error("[dev] electron-vite is missing; run `pnpm install`.");
    return 1;
  }

  return runLongLived(node, [electronViteJs, "dev", ...argv], env);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = await main();
}
