import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// AGENTS.md §"Loopback agent access — one door, one approval window": every
// bearer that reaches /mcp is minted by the operator's decision in the
// approval window, through the OAuth code exchange. That is a claim about
// call sites, which the type system cannot make — `createGrant` compiles
// from anywhere — so grep the production sources, in the shape
// tray-instant-hide.test.ts uses for the tray's show/hide invariant.
//
// If you are adding a way to mint a credential, the answer is "don't": route
// the client through the OAuth door. Do not widen these allowlists.

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

/** Production files (relative to src/main) with a non-comment line matching
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
    .map((path) => relative(mainRoot, path))
    .sort();
}

describe("local-agent credential minting stays behind the OAuth door", () => {
  test("createGrant (a direct mint) has no production caller", () => {
    expect(filesCalling(/\.createGrant\(/)).toEqual([]);
  });

  test("issueOAuthGrant is called only from the authorization-code exchange", () => {
    expect(filesCalling(/\.issueOAuthGrant\(/)).toEqual([
      "local-agents/local-agent-oauth.ts"
    ]);
  });

  test("makeToken is private to the grant service", () => {
    expect(filesCalling(/makeToken\(/)).toEqual(["local-agents/local-agent-grants.ts"]);
  });
});
