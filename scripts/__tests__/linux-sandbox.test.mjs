import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../linux-sandbox.mjs";

function fixture() {
  const unconfigured = { isFile: () => true, uid: 1000, mode: 0o100755 };
  const configured = { isFile: () => true, uid: 0, mode: 0o104755 };
  const deps = {
    platform: "linux",
    resolveHelper: vi.fn(() => "/repo with spaces/electron/dist/chrome-sandbox"),
    stat: vi.fn(() => unconfigured),
    exec: vi.fn(), log: vi.fn(), warn: vi.fn()
  };
  return { deps, configured };
}

describe("Linux sandbox setup", () => {
  it("warns without invoking sudo or blocking launch", () => {
    const { deps } = fixture();
    runCli(["--warn"], deps);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("pnpm fix:linux-sandbox"));
    expect(deps.exec).not.toHaveBeenCalled();
  });
  it("repairs the resolved file with separate arguments and verifies it", () => {
    const { deps, configured } = fixture();
    deps.stat.mockReturnValueOnce({ isFile: () => true, uid: 1000, mode: 0o100755 }).mockReturnValueOnce(configured);
    runCli(["--fix"], deps);
    const path = deps.resolveHelper();
    expect(deps.exec.mock.calls).toEqual([
      ["sudo", ["chown", "root:root", "--", path], { stdio: "inherit" }],
      ["sudo", ["chmod", "4755", "--", path], { stdio: "inherit" }]
    ]);
  });
  it("does not elevate for a configured helper", () => {
    const { deps, configured } = fixture();
    deps.stat.mockReturnValue(configured);
    runCli(["--fix"], deps);
    runCli(["--warn"], deps);
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });
  it.each(["darwin", "win32"])("does not inspect or modify files on %s", (platform) => {
    const { deps } = fixture();
    runCli(["--fix"], { ...deps, platform });
    runCli(["--warn"], { ...deps, platform });
    expect(deps.resolveHelper).not.toHaveBeenCalled();
    expect(deps.exec).not.toHaveBeenCalled();
  });
  it("tolerates a missing helper for checks but fails explicit repair", () => {
    const { deps } = fixture();
    deps.resolveHelper.mockImplementation(() => { throw new Error("missing Electron"); });
    expect(() => runCli(["--warn"], deps)).not.toThrow();
    expect(deps.warn).toHaveBeenCalled();
    expect(() => runCli(["--fix"], deps)).toThrow("missing Electron");
    expect(deps.exec).not.toHaveBeenCalled();
  });
  it("stops when sudo fails", () => {
    const { deps } = fixture();
    deps.exec.mockImplementation(() => { throw new Error("sudo failed"); });
    expect(() => runCli(["--fix"], deps)).toThrow("sudo failed");
    expect(deps.exec).toHaveBeenCalledTimes(1);
  });
  it("fails if permissions remain incorrect after repair", () => {
    const { deps } = fixture();
    expect(() => runCli(["--fix"], deps)).toThrow("did not verify");
  });
});


describe("Linux sandbox integration", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  it("keeps explicit repair separate from install and preview", () => {
    const root = JSON.parse(read("../../package.json")).scripts;
    const desktop = JSON.parse(read("../../apps/desktop/package.json")).scripts;
    expect(root["fix:linux-sandbox"]).toBe("node ./scripts/linux-sandbox.mjs --fix");
    expect(root["check:linux-sandbox"]).toBe("node ./scripts/linux-sandbox.mjs --warn");
    expect(desktop.postinstall).toBe("pnpm run rebuild:electron-native && node ../../scripts/linux-sandbox.mjs --warn");
    expect(desktop.preview).toBe("node ../../scripts/linux-sandbox.mjs --warn && electron-vite preview");
    expect(desktop.dev).toBe("node ./scripts/dev.mjs");
  });
  it("checks dev after Electron repair and before native staging and launch", () => {
    const dev = read("../../apps/desktop/scripts/dev.mjs");
    expect(dev).toContain('import { runCli as checkLinuxSandbox } from "../../../scripts/linux-sandbox.mjs"');
    const repair = dev.indexOf("const electronStatus = ensureElectronInstalled(env)");
    const check = dev.indexOf('checkLinuxSandbox(["--warn"])');
    const staging = dev.indexOf('"./scripts/rebuild-native-for-electron.mjs"', repair);
    const launch = dev.indexOf('return runLongLived(node, [electronViteJs, "dev"');
    expect(repair).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(repair);
    expect(staging).toBeGreaterThan(check);
    expect(launch).toBeGreaterThan(staging);
  });
  it("rejects invalid arguments before inspecting or modifying the helper", () => {
    const { deps } = fixture();
    expect(() => runCli([], deps)).toThrow("Usage:");
    expect(() => runCli(["--fix", "--warn"], deps)).toThrow("Usage:");
    expect(deps.resolveHelper).not.toHaveBeenCalled();
    expect(deps.exec).not.toHaveBeenCalled();
  });
  it("does not attempt repair on a non-file helper", () => {
    const { deps } = fixture();
    deps.stat.mockReturnValue({ isFile: () => false });
    expect(() => runCli(["--warn"], deps)).not.toThrow();
    expect(() => runCli(["--fix"], deps)).toThrow("not a regular file");
    expect(deps.exec).not.toHaveBeenCalled();
  });
});
