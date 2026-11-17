import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { resolveRustEnvironment } from "../lib/rust-environment.mjs";

const missing = () => ({ error: Object.assign(new Error("not found"), { code: "ENOENT" }) });

it("prefers Cargo already on PATH without changing the inherited environment", () => {
  const env = { PATH: "/existing", KEEP: "value" };
  const calls = [];
  const result = resolveRustEnvironment({ cwd: "/checkout", env, run(command, args) {
    calls.push({ command, args });
    return { status: 0 };
  } });
  expect(result).toEqual({ cargo: "cargo", env });
  expect(result.env).toBe(env);
  expect(calls).toEqual([{ command: "cargo", args: ["--version"] }]);
});

it("uses rustup's checkout-selected Cargo with its toolchain bin in the child PATH", () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-zA-Z0-9 _#-]{1,25}$/), (part) => {
    const cwd = join(tmpdir(), "checkout with spaces");
    const cargo = join(tmpdir(), part, "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
    const env = { PATH: "/existing", KEEP: "value" };
    const result = resolveRustEnvironment({ cwd, env, run(command, args, options) {
      expect(options.cwd).toBe(cwd);
      if (command === "rustup") {
        expect(args).toEqual(["which", "cargo"]);
        return { status: 0, stdout: cargo + "\n" };
      }
      if (command === cargo) return { status: 0, stdout: "cargo 1.97" };
      return missing();
    } });
    expect(result.cargo).toBe(cargo);
    expect(result.env.PATH.split(delimiter)[0]).toBe(dirname(cargo));
    expect(result.env.KEEP).toBe("value");
    expect(env.PATH).toBe("/existing");
  }), { numRuns: 30 });
});

it("honors CARGO_HOME without invoking shell startup files", () => {
  const home = join(tmpdir(), "custom cargo home");
  const cargo = join(home, "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  const result = resolveRustEnvironment({ cwd: tmpdir(), env: { CARGO_HOME: home }, run(command) {
    return command === cargo ? { status: 0 } : missing();
  } });
  expect(result.cargo).toBe(cargo);
});

it("returns no toolchain for missing or unconfigured Cargo instead of choosing a different Rust default", () => {
  for (const run of [missing, () => ({ status: 1, stderr: "no toolchain installed" })])
    expect(resolveRustEnvironment({ cwd: tmpdir(), env: {}, run })).toBeNull();
});

it("preserves permission errors rather than treating them as missing tools", () => {
  expect(() => resolveRustEnvironment({ cwd: tmpdir(), env: {}, run() {
    return { error: Object.assign(new Error("permission denied"), { code: "EACCES" }) };
  } })).toThrow("permission denied");
});

it.skipIf(process.platform === "win32")("differential oracle: a rustup-only PATH fails direct Cargo but succeeds through discovery", () => {
  const base = mkdtempSync(join(tmpdir(), "pwrsnap-rustup-oracle-"));
  try {
    const path = join(base, "path");
    const cargo = join(base, "selected toolchain", "bin", "cargo");
    mkdirSync(path, { recursive: true });
    mkdirSync(dirname(cargo), { recursive: true });
    writeFileSync(cargo, '#!/bin/sh\nprintf "cargo fixture\\n"\n');
    chmodSync(cargo, 0o755);
    // JSON text is data read by Node; no interpolation into shell code.
    writeFileSync(join(path, "cargo-path.json"), JSON.stringify(cargo));
    const rustup = join(path, "rustup");
    writeFileSync(rustup, '#!' + process.execPath + '\n' +
      'const fs = require("node:fs"); const path = require("node:path");\n' +
      'console.log(JSON.parse(fs.readFileSync(path.join(__dirname, "cargo-path.json"), "utf8")));\n');
    chmodSync(rustup, 0o755);
    const env = { PATH: path };
    expect(spawnSync("cargo", ["--version"], { cwd: base, env }).error?.code).toBe("ENOENT");
    const resolved = resolveRustEnvironment({ cwd: base, env, home: join(base, "empty home"), platform: "linux" });
    expect(resolved.cargo).toBe(cargo);
    expect(spawnSync(resolved.cargo, ["--version"], { cwd: base, env: resolved.env }).status).toBe(0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
