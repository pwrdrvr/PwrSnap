import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  NESTED_AGENTS_MD_MAX_BYTES,
  checkNestedAgentInstructionsSize,
  readTrackedAgentsSizes,
} from "./check-nested-agent-instructions-size.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("checkNestedAgentInstructionsSize", () => {
  it("gives nested files exactly the room the root limit leaves", () => {
    expect(NESTED_AGENTS_MD_MAX_BYTES).toBe(8 * 1024);
  });

  it("passes exactly the nested sizes at or under the limit", () => {
    for (let bytes = 0; bytes <= 200; bytes += 1) {
      const sizes = new Map([["AGENTS.md", 0], ["a/AGENTS.md", bytes]]);
      const errors = checkNestedAgentInstructionsSize(sizes, { nestedMax: 100, pathMax: 1000 });
      expect(errors.length === 0).toBe(bytes <= 100);
    }
  });

  it("sums every AGENTS.md on the path, not just root plus one", () => {
    // Each nested file is under its own cap; together they are not.
    const sizes = new Map([
      ["AGENTS.md", 60],
      ["a/AGENTS.md", 30],
      ["a/b/c/AGENTS.md", 30],
      ["x/AGENTS.md", 30],
    ]);
    expect(checkNestedAgentInstructionsSize(sizes, { nestedMax: 50, pathMax: 100 })).toEqual([
      "AGENTS.md files from the root down to a/b/c/AGENTS.md total 120 bytes; Codex reads 100 (20 over).",
    ]);
  });

  it("rejects a pair Codex would truncate even when each is under its cap", () => {
    const half = NESTED_AGENTS_MD_MAX_BYTES / 2 + 1;
    const sizes = new Map([
      ["AGENTS.md", CODEX_PROJECT_DOC_MAX_BYTES - NESTED_AGENTS_MD_MAX_BYTES],
      ["a/AGENTS.md", half],
      ["a/b/AGENTS.md", half],
    ]);
    expect(checkNestedAgentInstructionsSize(sizes)).toHaveLength(1);
  });

  it("finds the repository's nested files, so an empty list cannot pass", () => {
    const sizes = readTrackedAgentsSizes(repoRoot);
    expect(sizes.has("AGENTS.md")).toBe(true);
    expect([...sizes.keys()]).toContain("design/AGENTS.md");
  });

  it("reports a verdict when run as a CLI", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts/check-nested-agent-instructions-size.mjs")],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );
    expect(`${result.stdout}${result.stderr}`).toMatch(/nested AGENTS\.md files fit/);
    expect(result.status).toBe(0);
  });
});
