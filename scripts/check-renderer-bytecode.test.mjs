import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bytecodeBudget, measureModules, overBudget, rendererModules, wrapModule } from "./check-renderer-bytecode.mjs";

test("resolved tools import the exact filesystem file even when its path contains URL syntax", () => {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-bytecode-import-"));
  try {
    const modulePath = join(root, "tool # 100%.mjs");
    writeFileSync(modulePath, "export const marker = 'loaded the filesystem file';");
    // Use Node's actual ESM loader, not Vitest's dynamic-import transform.
    const code = `import { importTool } from ${JSON.stringify(new URL("./check-renderer-bytecode.mjs", import.meta.url).href)};
      process.stdout.write((await importTool(${JSON.stringify(modulePath)})).marker);`;
    expect(execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
      encoding: "utf8", maxBuffer: 16 * 1024
    })).toBe("loaded the filesystem file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["/", "\\"])("module discovery excludes non-application files with %s path separators", (separator) => {
  const prefix = "apps/desktop/src/renderer/src/";
  const files = [
    "area/Anonymous.tsx", "area/useNewHook.ts", "area/types.d.ts",
    "area/Example.test.tsx", "area/Example.spec.ts",
    "area/__tests__/nested/helper.ts", "area/__fixtures__/helper.tsx",
    "area/fixtures/nested/helper.js"
  ].map((file) => (prefix + file).replaceAll("/", separator));
  expect(rendererModules("unused", () => files)).toEqual([
    prefix + "area/Anonymous.tsx", prefix + "area/useNewHook.ts"
  ]);
});

test("V8's oracle checks uncalled nested and anonymous functions without running imports or code", async () => {
  const largeBody = Array.from({ length: 6500 }, (_, index) => `sink(${index});`).join("\n");
  const code = `
    import 'must-never-be-loaded';
    throw new Error('must never execute');
    export function outer() {
      globalThis.saved = function nested() { const sink = globalThis.sink; ${largeBody} };
      globalThis.sink(function () { const sink = globalThis.sink; ${largeBody} });
    }
  `;
  const records = await measureModules([
    { file: "oversized-fixture.js", variant: "production", code, esm: true },
    // Repeating source must still produce measurements, not silently use
    // V8's compilation cache and report no bytecode for the second variant.
    { file: "oversized-fixture.js", variant: "development", code, esm: true },
    { file: "valid-fixture.js", variant: "Vitest-client", code: wrapModule("function small() { return 42; } throw new Error('must never execute');") }
  ]);
  for (const variant of ["production", "development"]) {
    const failures = overBudget(records.filter((record) => record.variant === variant));
    expect(failures.map((record) => record.name).sort()).toEqual(["(anonymous)", "nested"]);
    expect(failures.every((record) => record.file === "oversized-fixture.js" && record.bytes > bytecodeBudget)).toBe(true);
  }
  expect(overBudget(records.filter((record) => record.file === "valid-fixture.js"))).toEqual([]);
});

test("the budget includes its boundary and rejects invalid measurements", () => {
  const records = [bytecodeBudget - 1, bytecodeBudget, bytecodeBudget + 1, NaN].map((bytes) => ({ bytes }));
  expect(overBudget(records)).toEqual(records.slice(2));
});

test("the growth gate rejects a controller well below the former 48 KiB budget", async () => {
  const body = Array.from({ length: 2200 }, (_, index) => `sink(${index});`).join("\n");
  const records = await measureModules([{
    file: "controller-growth.js", variant: "Vitest-client",
    code: wrapModule(`globalThis.controller = function growingController() { const sink = globalThis.sink; ${body} };`)
  }]);
  const controller = records.find((record) => record.name === "growingController");
  expect(controller).toBeDefined();
  expect(controller.bytes).toBeLessThan(48 * 1024);
  expect(overBudget(records)).toContainEqual(controller);
});

test("automatic discovery includes new hooks and modules without checking their export names", () => {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-bytecode-discovery-"));
  try {
    const directory = join(root, "apps/desktop/src/renderer/src/new-area");
    mkdirSync(join(directory, "__tests__"), { recursive: true });
    for (const file of ["Anonymous.tsx", "useNewHook.ts", "types.d.ts", "Example.test.tsx", "__tests__/fixture.ts"]) {
      writeFileSync(join(directory, file), "");
    }
    expect(rendererModules(root).map((file) => file.split("/").at(-1))).toEqual(["Anonymous.tsx", "useNewHook.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compiler syntax failure fails closed", async () => {
  await expect(measureModules([{ file: "broken.js", variant: "test", code: "function {" }]))
    .rejects.toThrow("Bytecode compiler exited 1");
});
