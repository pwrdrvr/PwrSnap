import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const guardedSources = [
  resolve(repoRoot, "apps", "desktop", "src", "main", "import", "pwrsnap-import-service.ts")
];

describe("electron-vite ESM shim safety", () => {
  test("main-process prose never ends a quoted string with the import token", () => {
    const unsafe = [];
    for (const path of guardedSources) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/(?:^|[\s;])import(?=["'])/gmu)) {
        const line = source.slice(0, match.index).split("\n").length;
        unsafe.push(`${relative(repoRoot, path)}:${line}`);
      }
    }

    // electron-vite 5's ESM shim scanner treats prose ending this way as a
    // side-effect import and can inject JavaScript inside the next literal.
    expect(unsafe).toEqual([]);
  });
});
