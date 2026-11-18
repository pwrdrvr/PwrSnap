#!/usr/bin/env node

// Companion to check-agent-instructions-size.mjs (which stays identical across
// the PwrDrvr repos and checks only the root file). Every AGENTS.md is loaded
// automatically for work under its folder, and Codex spends ONE
// `project_doc_max_bytes` budget (32 KiB by default) on all of them from the
// repository root down to the working directory, silently dropping the rest.
//
// So two limits, per tracked nested AGENTS.md:
//   - the file itself fits in what the 24 KiB root limit leaves (8 KiB);
//   - the root plus every AGENTS.md on the path down to it fits in 32 KiB,
//     which the first rule alone does not ensure once two nested files share
//     a path.
// A nested AGENTS.md holds headline rules and a "read X before Y" trigger;
// full rules live in docs/agents/. See the root AGENTS.md, "Agent Instruction
// Files".
//
// Dependency-free so CI's classifier can run it from a sparse checkout.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_AGENTS_MD_MAX_BYTES } from "./check-agent-instructions-size.mjs";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const NESTED_AGENTS_MD_MAX_BYTES = CODEX_PROJECT_DOC_MAX_BYTES - ROOT_AGENTS_MD_MAX_BYTES;

/**
 * @param {Map<string, number>} sizes repo-relative POSIX path -> bytes, for the
 *   root "AGENTS.md" and every nested ".../AGENTS.md".
 * @returns {string[]} one message per violation; empty when every path fits.
 */
export function checkNestedAgentInstructionsSize(
  sizes,
  { nestedMax = NESTED_AGENTS_MD_MAX_BYTES, pathMax = CODEX_PROJECT_DOC_MAX_BYTES } = {},
) {
  const errors = [];
  for (const [path, bytes] of [...sizes].sort(([a], [b]) => a.localeCompare(b))) {
    if (path === "AGENTS.md") continue;
    if (bytes > nestedMax) {
      errors.push(`${path} is ${bytes} bytes; the nested limit is ${nestedMax} (${bytes - nestedMax} over).`);
    }
    let total = 0;
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      total += sizes.get(dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`) ?? 0;
      if (dir === ".") break;
    }
    if (total > pathMax) {
      errors.push(
        `AGENTS.md files from the root down to ${path} total ${total} bytes; ` +
          `Codex reads ${pathMax} (${total - pathMax} over).`,
      );
    }
  }
  return errors;
}

export function readTrackedAgentsSizes(repoRoot) {
  const paths = execFileSync("git", ["ls-files", "-z", "--", "AGENTS.md", "*/AGENTS.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const sizes = new Map();
  for (const path of paths) {
    const full = join(repoRoot, path);
    // A sparse checkout lists files it did not materialize; only AGENTS.md
    // files are checked out there, and those are all this reads.
    if (existsSync(full)) sizes.set(path, readFileSync(full).byteLength);
  }
  return sizes;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sizes = readTrackedAgentsSizes(repoRoot);
  const nested = [...sizes.keys()].filter((path) => path !== "AGENTS.md");
  if (!sizes.has("AGENTS.md") || nested.length === 0) {
    console.error("Found no root or nested AGENTS.md to check; refusing to pass on an empty list.");
    process.exit(1);
  }
  const errors = checkNestedAgentInstructionsSize(sizes);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error(
      "Keep a nested AGENTS.md to headline rules and a when-to-read trigger; " +
        "move the full rules into docs/agents/.",
    );
    process.exit(1);
  }
  console.log(`${nested.length} nested AGENTS.md files fit (each <= ${NESTED_AGENTS_MD_MAX_BYTES} bytes).`);
}

if (isCliEntrypoint(import.meta.url)) main();
