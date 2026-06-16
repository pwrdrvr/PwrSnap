import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkNodeVersion,
  ELECTRON_DEV_ENV_KEYS,
  ensureElectronInstalled,
  electronInstallState,
  runLongLived,
  sanitizeDevEnv
} from "./dev.mjs";

const tempDirs = [];

function tempElectronRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-electron-"));
  tempDirs.push(root);
  mkdirSync(join(root, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(root, "install.js"), "");
  writeFileSync(join(root, "path.txt"), "Electron.app/Contents/MacOS/Electron");
  writeFileSync(join(root, "dist", "version"), "41.5.0");
  writeFileSync(join(root, "dist", "Electron.app", "Contents", "MacOS", "Electron"), "");
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeProcess() {
  const listeners = new Map();
  return {
    on(signal, handler) {
      listeners.set(signal, [...(listeners.get(signal) ?? []), handler]);
    },
    off(signal, handler) {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter((candidate) => candidate !== handler)
      );
    },
    emit(signal) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
    listenerCount(signal) {
      return listeners.get(signal)?.length ?? 0;
    }
  };
}

function createFakeChild(pid = 12345) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

describe("dev launch environment", () => {
  it("scrubs inherited Electron and module-resolution variables", () => {
    const inherited = {
      ELECTRON_EXEC_PATH: "/other/repo/Electron",
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      NODE_PATH: "/other/repo/node_modules",
      PATH: "/usr/bin",
      PWRSNAP_DATA_ROOT: "/tmp/pwrsnap"
    };

    const { env, removed } = sanitizeDevEnv(inherited);

    for (const key of ELECTRON_DEV_ENV_KEYS) {
      expect(env).not.toHaveProperty(key);
    }
    expect(removed).toEqual(["ELECTRON_EXEC_PATH", "ELECTRON_RENDERER_URL", "NODE_PATH"]);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PWRSNAP_DATA_ROOT).toBe("/tmp/pwrsnap");
  });

  it("requires the active Node version to match .nvmrc exactly", () => {
    expect(checkNodeVersion("v24.14.1", "v24.14.1\n")).toMatchObject({ ok: true });
    expect(checkNodeVersion("v24.13.0", "v24.14.1\n")).toMatchObject({
      actual: "24.13.0",
      expected: "24.14.1",
      ok: false
    });
  });

  it("accepts a complete Electron package install", () => {
    expect(electronInstallState(tempElectronRoot(), "darwin")).toEqual({
      ok: true,
      reason: "ok"
    });
  });

  it("detects the partial Electron install that makes electron-vite fail", () => {
    const root = tempElectronRoot();
    rmSync(join(root, "path.txt"));

    expect(electronInstallState(root, "darwin")).toEqual({
      ok: false,
      reason: "electron path.txt is missing"
    });
  });

  it("detects a missing Electron executable payload", () => {
    const root = tempElectronRoot();
    rmSync(join(root, "dist", "Electron.app"), { recursive: true, force: true });

    expect(electronInstallState(root, "darwin")).toEqual({
      ok: false,
      reason: "electron executable is missing"
    });
  });

  it("repairs a partial Electron install by rerunning install.js", () => {
    const root = tempElectronRoot();
    rmSync(join(root, "path.txt"));
    writeFileSync(
      join(root, "install.js"),
      `
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
mkdirSync(join(__dirname, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true });
writeFileSync(join(__dirname, "path.txt"), "Electron.app/Contents/MacOS/Electron");
writeFileSync(join(__dirname, "dist", "version"), "41.5.0");
writeFileSync(join(__dirname, "dist", "Electron.app", "Contents", "MacOS", "Electron"), "");
`
    );

    expect(ensureElectronInstalled({}, root, process.execPath, "darwin")).toBe(0);
    expect(electronInstallState(root, "darwin")).toEqual({
      ok: true,
      reason: "ok"
    });
  });

  it("runs the long-lived dev child in a POSIX process group and forwards Ctrl+C", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(4242);
    const killCalls = [];
    let spawnOptions;
    const promise = runLongLived("node", ["electron-vite", "dev"], { PATH: "/usr/bin" }, {
      killProcess: (pid, signal) => {
        killCalls.push([pid, signal]);
        return true;
      },
      platform: "darwin",
      process: fakeProcess,
      spawn: (_command, _args, options) => {
        spawnOptions = options;
        return child;
      }
    });

    expect(spawnOptions.detached).toBe(true);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(1);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(1);

    fakeProcess.emit("SIGINT");
    child.emit("close", null, null);

    await expect(promise).resolves.toBe(130);
    expect(killCalls).toEqual([[-4242, "SIGINT"]]);
    expect(child.killCalls).toEqual([]);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("falls back to child.kill on Windows", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(5151);
    const promise = runLongLived("node", ["electron-vite", "dev"], {}, {
      platform: "win32",
      process: fakeProcess,
      spawn: () => child
    });

    fakeProcess.emit("SIGTERM");
    child.emit("close", null, null);

    await expect(promise).resolves.toBe(143);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  it("forces the long-lived dev child down on a repeated terminal signal", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(6262);
    const killCalls = [];
    const promise = runLongLived("node", ["electron-vite", "dev"], {}, {
      killProcess: (pid, signal) => {
        killCalls.push([pid, signal]);
        return true;
      },
      platform: "darwin",
      process: fakeProcess,
      spawn: () => child
    });

    fakeProcess.emit("SIGINT");
    fakeProcess.emit("SIGINT");
    child.emit("close", null, null);

    await expect(promise).resolves.toBe(130);
    expect(killCalls).toEqual([
      [-6262, "SIGINT"],
      [-6262, "SIGKILL"]
    ]);
  });
});
