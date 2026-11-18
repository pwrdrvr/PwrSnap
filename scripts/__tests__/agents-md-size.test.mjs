import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AGENTS_MD_MAX_BYTES, checkAgentsMdSize } from "../check-agents-md-size.mjs";

let tempRoots = [];

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

function tempRoot(agents, topics = {}) {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-agents-md-size-test-"));
  tempRoots.push(root);
  writeFileSync(join(root, "AGENTS.md"), agents);
  if (Object.keys(topics).length > 0) {
    mkdirSync(join(root, "docs/agents"), { recursive: true });
    for (const [name, body] of Object.entries(topics)) {
      writeFileSync(join(root, "docs/agents", name), body);
    }
  }
  return root;
}

describe("checkAgentsMdSize", () => {
  test("the committed root AGENTS.md passes", () => {
    expect(checkAgentsMdSize(resolve(import.meta.dirname, "../.."))).toEqual([]);
  });

  test("accepts a file exactly at the limit", () => {
    expect(checkAgentsMdSize(tempRoot("x".repeat(AGENTS_MD_MAX_BYTES)))).toEqual([]);
  });

  test("rejects a file one byte past the limit, counting bytes not characters", () => {
    // "é" is two UTF-8 bytes: half the limit in characters is exactly the
    // limit in bytes, and one more ASCII byte crosses it.
    const atLimit = "é".repeat(AGENTS_MD_MAX_BYTES / 2);
    expect(checkAgentsMdSize(tempRoot(atLimit))).toEqual([]);
    const errors = checkAgentsMdSize(tempRoot(`${atLimit}x`));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/32769 bytes/);
  });

  test("rejects a docs/agents topic file the root never links", () => {
    const root = tempRoot("Read [docs/agents/a.md](docs/agents/a.md).", {
      "a.md": "# a",
      "b.md": "# b",
    });
    expect(checkAgentsMdSize(root)).toEqual(["docs/agents/b.md is not linked from AGENTS.md"]);
  });

  test("a missing root file fails rather than passing", () => {
    const root = mkdtempSync(join(tmpdir(), "pwrsnap-agents-md-size-test-"));
    tempRoots.push(root);
    expect(checkAgentsMdSize(root)).toEqual(["AGENTS.md is missing"]);
  });
});
