import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("sandboxed preload import safety", () => {
  test("does not runtime-import the shared package barrel", () => {
    const preloadSource = readFileSync(
      fileURLToPath(new URL("../index.ts", import.meta.url)),
      "utf8"
    );

    // The shared barrel re-exports Zod-backed schemas. Electron sandboxed
    // preloads cannot resolve that runtime dependency, so importing the barrel
    // prevents window.pwrsnap from being exposed and strands every renderer.
    expect(preloadSource).not.toMatch(
      /import\s+(?!type\b)[\s\S]*?from\s+["']@pwrsnap\/shared["']/
    );
  });
});
