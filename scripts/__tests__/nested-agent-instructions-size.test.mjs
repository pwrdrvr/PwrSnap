import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ROOT_AGENTS_MD_MAX_BYTES } from "../check-agent-instructions-size.mjs";

// Every AGENTS.md is loaded automatically for work under its folder, and
// Codex spends one `project_doc_max_bytes` budget (32 KiB by default) on all
// of them from the repository root down to the working directory, silently
// dropping the rest. The root check caps AGENTS.md at 24 KiB; this caps each
// nested one at the remaining 8 KiB, so root + any nested file always fits.
// A nested AGENTS.md holds headline rules and a "read X before Y" trigger;
// full rules live in docs/agents/. See the root AGENTS.md, "Agent Instruction
// Files".
const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;
const NESTED_AGENTS_MD_MAX_BYTES =
  CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES - ROOT_AGENTS_MD_MAX_BYTES;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function trackedNestedAgentsFiles() {
  return execFileSync("git", ["ls-files", "-z", "--", "*AGENTS.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path !== "" && path !== "AGENTS.md" && path.endsWith("/AGENTS.md"));
}

describe("nested AGENTS.md size", () => {
  it("leaves the nested budget non-empty", () => {
    expect(NESTED_AGENTS_MD_MAX_BYTES).toBe(8 * 1024);
  });

  it("finds the nested files, so an empty list cannot pass", () => {
    expect(trackedNestedAgentsFiles()).toContain("design/AGENTS.md");
  });

  it("keeps every nested AGENTS.md within the room the root leaves", () => {
    const over = trackedNestedAgentsFiles()
      .map((path) => ({ path, bytes: readFileSync(join(repoRoot, path)).byteLength }))
      .filter(({ bytes }) => bytes > NESTED_AGENTS_MD_MAX_BYTES)
      .map(({ path, bytes }) => `${path}: ${bytes} bytes (limit ${NESTED_AGENTS_MD_MAX_BYTES})`);
    expect(over).toEqual([]);
  });
});
