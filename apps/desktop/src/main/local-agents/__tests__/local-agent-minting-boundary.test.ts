import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Every native session must originate in Electron's consent boundary.
// Legacy credential minting has no production caller.

const mainRoot = fileURLToPath(new URL("../..", import.meta.url));

function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSources(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

/** Production files (relative to src/main, forward slashes on every platform —
 *  `relative()` yields backslashes on Windows) with a non-comment line matching
 *  `pattern`. Prose in comments describes the calls; it doesn't make them. */
function filesCalling(pattern: RegExp): string[] {
  return productionSources(mainRoot)
    .filter((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
        .some((line) => pattern.test(line))
    )
    .map((path) => relative(mainRoot, path).split(sep).join("/"))
    .sort();
}

describe("local-agent sessions stay behind native consent", () => {
  test("createGrant (a direct mint) has no production caller", () => {
    expect(filesCalling(/\.createGrant\(/)).toEqual([]);
  });

  test("retired OAuth minting has no production caller", () => {
    expect(filesCalling(/\.issueOAuthGrant\(/)).toEqual([]);
  });

  test("native sessions are opened only by the desktop MCP consent boundary", () => {
    expect(filesCalling(/\.openNativeSession\(/)).toEqual(["local-agents/mcp-server.ts"]);
  });

  test("makeToken is private to the grant service", () => {
    expect(filesCalling(/makeToken\(/)).toEqual(["local-agents/local-agent-grants.ts"]);
  });
});
