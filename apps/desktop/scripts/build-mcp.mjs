#!/usr/bin/env node
// Native stdio transport. Packaged macOS helpers are universal; developer/test
// builds may request --host. Fail rather than ship a missing/stale executable.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = join(root, "crates/pwrsnap-mcp/Cargo.toml");
const output = join(root, "apps/desktop/build/mcp");
// Local native setup can finish without Rust. Explicit MCP/app builds, CI and
// release staging stay strict so they cannot ship a missing or stale helper.
const allowMissingCargo = process.argv.includes("--allow-missing-cargo")
  && process.argv.includes("--host")
  && !process.env.CI
  && process.env.PWRSNAP_NATIVE_UNIVERSAL !== "1";
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (command === "cargo" && result.error?.code === "ENOENT" && allowMissingCargo) {
    console.warn("[build-mcp] WARNING: cargo was not found on PATH; skipping the Rust MCP helper. " +
      "Native setup will continue, but MCP transport requires a built helper. " +
      "Install Rust or add Cargo to PATH, then run pnpm --filter @pwrsnap/desktop build:mcp --host.");
    process.exit(0);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
mkdirSync(output, { recursive: true });
const targets =
  process.platform === "darwin" && !process.argv.includes("--host")
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
    : [];
if (targets.length) {
  run("rustup", ["target", "add", ...targets]);
  for (const target of targets)
    run("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      manifest,
      "--target",
      target
    ]);
  run("lipo", [
    "-create",
    ...targets.map((target) =>
      join(root, "crates/pwrsnap-mcp/target", target, "release/pwrsnap-mcp")
    ),
    "-output",
    join(output, "pwrsnap-mcp")
  ]);
} else {
  run("cargo", ["build", "--locked", "--release", "--manifest-path", manifest]);
  const name = process.platform === "win32" ? "pwrsnap-mcp.exe" : "pwrsnap-mcp";
  copyFileSync(resolve(root, "crates/pwrsnap-mcp/target/release", name), join(output, name));
}

run(process.execPath, [join(root, "scripts/check-mcp-rust-licenses.mjs"), "--verify-cargo"]);
