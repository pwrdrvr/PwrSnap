import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { typedLintFiles, typedLintPaths, typedSuppressionLines } from "../lint-typed.mjs";

const temporaryDirectories = [];
afterEach(() => temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("typed lint suppression guard", () => {
  it.each([
    "// oxlint-disable", "/* eslint-disable */",
    "// oxlint-disable-next-line typescript/unbound-method",
    "// eslint-disable-line @typescript-eslint/unbound-method",
    "/* eslint typescript/unbound-method: off */"
  ])("rejects receiver-check suppression: %s", (comment) => {
    expect(typedSuppressionLines("file.ts", `export {};\n${comment}\n`)).toEqual([2]);
  });
  it("allows targeted syntax exceptions and strings that resemble comments", () => {
    expect(typedSuppressionLines("file.ts", `
      // oxlint-disable-next-line no-control-regex -- reject control characters
      const controls = /[\\x00-\\x1f]/;
      const example = "// oxlint-disable unbound-method";
      const template = \`/* eslint-disable */\`;
    `)).toEqual([]);
  });
  it("reports exact lines after Unicode and inside TSX", () => {
    expect(typedSuppressionLines("file.tsx", `const text = "${"😀".repeat(50)}";\n// oxlint-disable\nconst view = <div />;\n`))
      .toEqual([2]);
  });
  it("derives production scope from the config while retaining preload and shared code", () => {
    const root = mkdtempSync(join(tmpdir(), "pwrsnap-typed-lint-"));
    temporaryDirectories.push(root);
    const paths = ["src/main.ts", "src/preload.ts", "src/__tests__/main.test.ts", "shared/result.ts"];
    for (const path of paths) {
      const file = join(root, path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "export {};\n");
    }
    writeFileSync(join(root, "oxlint.typed.json"), JSON.stringify({
      overrides: [{ files: ["src/**/*.ts", "shared/**/*.ts"] }], ignorePatterns: ["**/__tests__/**"]
    }));
    expect(typedLintFiles(root)).toEqual(["shared/result.ts", "src/main.ts", "src/preload.ts"]);
    expect(typedLintPaths(root)).toEqual(["src", "shared"]);
  });
  it("selects exactly the same real files for the suppression guard and native CLI", () => {
    const root = resolve(import.meta.dirname, "../..");
    const result = spawnSync(process.execPath, [resolve(root, "node_modules/oxlint/bin/oxlint"),
      "--config", "oxlint.typed.json", "--debug=files", ...typedLintPaths(root)],
      { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    const files = result.stdout.trim().split(/\r?\n/).map((path) =>
      relative(root, resolve(root, path)).replaceAll("\\", "/")).sort();
    expect(files).toEqual(typedLintFiles(root));
  });
  it("the installed native checker rejects a lost receiver and accepts its wrapper", () => {
    const root = resolve(import.meta.dirname, "../..");
    const fixture = mkdtempSync(join(tmpdir(), "pwrsnap-receiver-probe-"));
    temporaryDirectories.push(fixture);
    const file = join(fixture, "probe.ts");
    writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2023" }, include: ["probe.ts"]
    }));
    const declaration = "class Counter { private value = 1; read() { return this.value; } }\nconst counter = new Counter();\n";
    for (const [source, status] of [["export const read = counter.read;", 1],
      ["export const read = () => counter.read();", 0]]) {
      writeFileSync(file, declaration + source);
      const result = spawnSync(process.execPath, [resolve(root, "node_modules/oxlint/bin/oxlint"),
        "--config", resolve(root, "oxlint.typed.json"), "--format", "json", file],
        { cwd: fixture, encoding: "utf8" });
      expect(result.status, result.stderr + result.stdout).toBe(status);
      const findings = JSON.parse(result.stdout).diagnostics;
      expect(findings.map((finding) => finding.code)).toEqual(status === 1 ? ["typescript(unbound-method)"] : []);
    }
  }, 30_000);
});
