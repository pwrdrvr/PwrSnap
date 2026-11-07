#!/usr/bin/env node
// Deterministic license disclosure for every supported native transport target.
// Ordinary lint verifies lock alignment without installing Rust. Native builds
// additionally compare the snapshot with Cargo's selected normal/build graph.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSpdxExpression, isPermissive } from "./check-third-party-license-allowlist.mjs";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = join(root, "crates/pwrsnap-mcp/Cargo.toml");
const snapshotPath = join(root, "scripts/mcp-rust-licenses.json");
const targets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu"
];
function digest() {
  return createHash("sha256")
    .update(readFileSync(manifest))
    .update(readFileSync(join(root, "crates/pwrsnap-mcp/Cargo.lock")))
    .digest("hex");
}
export function readMcpRustLicenseRecords() {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (snapshot.digest !== digest())
    throw new Error(
      "MCP Rust license snapshot is stale. Run node scripts/check-mcp-rust-licenses.mjs --write"
    );
  for (const record of snapshot.records)
    if (!evaluateSpdxExpression(record.declaredLicense, isPermissive))
      throw new Error(
        `MCP Rust dependency ${record.name} has an unapproved license: ${record.declaredLicense}`
      );
  return snapshot.records;
}
function cargo(args) {
  const result = spawnSync("cargo", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout;
}
function generate() {
  const selected = new Set();
  for (const target of targets) {
    for (const line of cargo([
      "tree",
      "--locked",
      "--manifest-path",
      manifest,
      "--target",
      target,
      "--edges",
      "normal,build",
      "--prefix",
      "none",
      "--format",
      "{p}"
    ]).split("\n")) {
      const match = /^(\S+) v(\S+)/.exec(line);
      if (match) selected.add(`${match[1]}@${match[2]}`);
    }
  }
  const metadata = JSON.parse(
    cargo(["metadata", "--locked", "--manifest-path", manifest, "--format-version", "1"])
  );
  const records = metadata.packages
    .filter((p) => p.name !== "pwrsnap-mcp" && selected.has(`${p.name}@${p.version}`))
    .map((p) => {
      // Check metadata before opening source/license files. Never disclose an
      // unknown license automatically merely to make a drift check pass.
      const chosenLicense = p.license.split(" OR ").includes("MIT") ? "MIT" : p.license;
      if (!evaluateSpdxExpression(chosenLicense, isPermissive))
        throw new Error(`MCP Rust dependency ${p.name} has an unapproved license: ${p.license}`);
      const dir = dirname(p.manifest_path);
      const files = readdirSync(dir)
        .filter((file) => /^(LICENSE|COPYING|NOTICE)([.-]|$)/i.test(file))
        .sort();
      if (!files.length) throw new Error(`Missing license text for ${p.name}`);
      return {
        name: `rust/${p.name}`,
        version: p.version,
        declaredLicense: chosenLicense,
        licenseExpression: p.license,
        source: p.repository ?? `https://crates.io/crates/${p.name}`,
        bundledBinary: true,
        licenseText: files.map((file) => readFileSync(join(dir, file), "utf8")).join("\n\n")
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { digest: digest(), records };
}
if (isCliEntrypoint(import.meta.url)) {
  if (process.argv.includes("--write"))
    writeFileSync(snapshotPath, JSON.stringify(generate(), null, 2) + "\n");
  else {
    readMcpRustLicenseRecords();
    if (
      process.argv.includes("--verify-cargo") &&
      JSON.stringify(generate()) !== JSON.stringify(JSON.parse(readFileSync(snapshotPath, "utf8")))
    )
      throw new Error("Cargo MCP graph/licenses differ from the committed snapshot");
    console.log("MCP Rust license policy and snapshot passed");
  }
}
