#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";
import { pnpmCommand } from "./lib/pnpm-command.mjs";

const root = resolve(import.meta.dirname, "..");
function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export function testArguments(files) {
  // Tooling, fixtures, setup, removals and unsupported file types can affect
  // tests without a discoverable Vite import edge. In those cases run all tests.
  if (files.some((file) => !/\.(?:tsx?|jsx?|mjs|cjs|css)$/.test(file) ||
    /(^|\/)(?:scripts|e2e|fixtures|test-setup|__fixtures__)(\/|$)/.test(file) ||
    /(^|\/)(?:package\.json|tsconfig[^/]*|vitest[^/]*|[^/]*\.config\.[^/]*)$/.test(file))) {
    return ["test"];
  }
  return files.length ? ["exec", "vitest", "related", "--run", "--config", "vitest.workspace.ts", ...files] : [];
}

async function main() {
  const common = resolve(root, git("rev-parse", "--git-common-dir").trim());
  const key = createHash("sha256").update(common).digest("hex").slice(0, 16);
  const lock = resolve(tmpdir(), `pwrsnap-check-${process.getuid?.() ?? "user"}-${key}.json`);
  let descriptor;
  try {
    descriptor = openSync(lock, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Fail promptly rather than start another expensive checker in this repo.
    // Do not expire a live lock based on age. A crash leaves an explicit lock
    // to inspect, rather than racing another worktree with automatic deletion.
    throw new Error(`Another changed-work check owns ${lock}: ${readFileSync(lock, "utf8")}`);
  }
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  closeSync(descriptor);
  let child;
  let interrupted = false;
  const interrupt = () => { interrupted = true; process.exitCode = 130; child?.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    let base;
    try { base = git("merge-base", "HEAD", "origin/main").trim(); }
    catch { throw new Error("Cannot determine origin/main merge base; fetch origin main before checking changed work"); }
    const files = [...new Set([
      ...git("diff", "--name-only", "-z", "--no-renames", base).split("\0"),
      ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0")
    ].filter(Boolean))];
    // Full lint always runs: typechecking individual changed files would miss
    // their consumers, and policy gates depend on configuration and resolution.
    const tests = testArguments(files);
    const deleted = git("diff", "--name-only", "--diff-filter=D", "-z", "--no-renames", base).length > 0;
    for (const args of [["lint"], deleted ? ["test"] : tests].filter((args) => args.length)) {
      if (interrupted) break;
      console.log(`Checking ${files.length} changed paths: pnpm ${args.join(" ")}`);
      const invocation = pnpmCommand(args);
      const status = await new Promise((accept, reject) => {
        child = spawn(invocation.command, invocation.args, { cwd: root, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => accept(code ?? 1));
      });
      child = undefined;
      if (status !== 0) { process.exitCode = status; break; }
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    unlinkSync(lock);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
