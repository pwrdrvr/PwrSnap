import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ROOT_AGENTS_MD_MAX_BYTES,
  checkAgentInstructionsSize,
} from "./check-agent-instructions-size.mjs";

const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("checkAgentInstructionsSize", () => {
  it("keeps the limit under Codex's default project-doc budget", () => {
    expect(ROOT_AGENTS_MD_MAX_BYTES).toBeLessThan(
      CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES,
    );
  });

  it("passes exactly the sizes at or under the limit", () => {
    const limit = 100;
    for (let bytes = 0; bytes <= 2 * limit; bytes += 1) {
      const result = checkAgentInstructionsSize(bytes, limit);
      expect(result.ok).toBe(bytes <= limit);
      if (!result.ok) {
        expect(result.message).toContain(`${bytes - limit} over`);
      }
    }
  });

  it("rejects a file Codex would truncate", () => {
    expect(
      checkAgentInstructionsSize(CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES + 1).ok,
    ).toBe(false);
  });

  // A guard whose entrypoint test never fires exits 0 having checked nothing.
  // Run the real CLI so silence cannot pass.
  it("reports a verdict when run as a CLI", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts/check-agent-instructions-size.mjs")],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toMatch(/AGENTS\.md is \d+ (of|bytes)/);
    expect(result.status).toBe(0);
  });
});
