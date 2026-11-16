import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bytecodeBudget, measureModules, overBudget, rendererModules, wrapModule } from "./check-renderer-bytecode.mjs";

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
