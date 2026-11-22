import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { bytecodeBudget, importTool, overBudget } from "./check-renderer-bytecode.mjs";
import { attributeLinkedFunctions, buildLinkedChunks, linkedBudgetCandidates } from "./lib/renderer-bytecode-attribution.mjs";
import { compilerRuntime, measureBytecode } from "./lib/renderer-bytecode-compiler.mjs";

const desktopRequire = createRequire(resolve(import.meta.dirname, "../apps/desktop/package.json"));

test("V8 code log sizes agree with Ignition disassembly for same-name nested functions", async () => {
  const source = `import 'must-never-be-linked';
    export function same() { globalThis.save(function same() { return '😀'; }); }
    export const arrow = () => { return () => 100; };
    throw new Error('must never execute');`;
  const runtime = compilerRuntime();
  const script = `const vm = require('node:vm');
    const v8 = require('node:v8');
    v8.setFlagsFromString('--print-bytecode');
    new vm.SourceTextModule(${JSON.stringify(source)});
    v8.setFlagsFromString('--no-print-bytecode');`;
  const disassembly = execFileSync(runtime.executable, ["--no-lazy", "--experimental-vm-modules", "--eval", script], {
    env: runtime.env, encoding: "utf8", maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"]
  });
  const printSizes = Array.from(disassembly.matchAll(/^Bytecode length: (\d+)$/gm), (match) => Number(match[1]));
  expect(printSizes).toHaveLength(5);
  const { records } = await measureBytecode([{ file: "fixture.js", variant: "fixture", code: source, esm: true }], runtime);
  expect(records.map(({ bytes }) => bytes)).toEqual(printSizes);
  const same = records.filter(({ name }) => name === "same");
  expect(same).toHaveLength(2);
  expect(new Set(same.map(({ start }) => start)).size).toBe(2);
});

test.each([["Node", false], ["Electron", true]])("%s measurements survive V8 log placeholders in the temp path", async (_name, useElectron) => {
  const inputs = [{
    file: "fixture.js", variant: "fixture", esm: true,
    code: "import 'must-never-be-linked'; export function outer() { return () => 42; }"
  }];
  const expected = await measureBytecode(inputs, compilerRuntime(useElectron));
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-%p-%t-"));
  try {
    for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, root);
    expect(await measureBytecode(inputs, compilerRuntime(useElectron))).toEqual(expected);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked minified chunks keep application and vendor bytecode budgets distinct in Node and Electron", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pwrsnap-linked-bytecode-"));
  try {
    mkdirSync(join(root, "src"));
    const vendorFile = "node_modules/fixture/vendor.js";
    const workerVendorFile = "node_modules/fixture/worker-initializer.js";
    mkdirSync(join(root, "node_modules/fixture"), { recursive: true });
    const body = Array.from({ length: 2500 }, (_, index) => `sink(${index});`).join("\n");
    const nested = `globalThis.publish(function () { const sink = globalThis.sink; ${body} });`;
    for (const [file, source] of Object.entries({
      "index.html": '<script type="module" src="/src/app.js"></script>',
      "camera.html": '<script type="module" src="/src/camera.js"></script>',
      "src/app.js": `import 'must-never-be-linked'; import '../${vendorFile}';
        globalThis.publish('😀'); globalThis.publish(() => { ${nested} });
        globalThis.publish(() => import('./lazy.js')); throw new Error('must never execute');`,
      "src/camera.js": "globalThis.publish(() => new Worker(new URL('./fixture.worker.js', import.meta.url), { type: 'module' }));",
      "src/lazy.js": nested,
      "src/fixture.worker.js": `import '../${workerVendorFile}'; ${nested}`,
      [vendorFile]: `globalThis.publish(() => { ${nested} });`,
      [workerVendorFile]: `const sink = globalThis.sink; ${body}`
    })) writeFileSync(join(root, file), source);
    const vite = await importTool(desktopRequire.resolve("vite"));
    const config = {
      root, configFile: false, logLevel: "error",
      build: { write: false, minify: "esbuild", rollupOptions: {
        input: [join(root, "index.html"), join(root, "camera.html")], external: ["must-never-be-linked"]
      } }
    };
    const appFiles = new Set(["src/app.js", "src/camera.js", "src/lazy.js", "src/fixture.worker.js"]);
    const chunks = await buildLinkedChunks(vite, config, root, appFiles);
    // A matching ordinary build is the oracle for input bytes and chunk hashes.
    const ordinary = (await vite.build(config)).output.filter((output) => output.fileName.endsWith(".js"));
    const byFile = ([fileA], [fileB]) => fileA.localeCompare(fileB);
    expect(chunks.map(({ file, code }) => [file, code]).sort(byFile)).toEqual(
      ordinary.map((output) => [output.fileName, output.type === "chunk" ? output.code : output.source]).sort(byFile)
    );
    const inputs = chunks.map(({ file, variant, code, esm }) => ({ file, variant, code, esm }));
    for (const useElectron of [false, true]) {
      const { versions, records } = await measureBytecode(inputs, compilerRuntime(useElectron));
      expect(Boolean(versions.electron)).toBe(useElectron);
      const attributed = attributeLinkedFunctions(chunks, records, appFiles);
      const failures = overBudget(linkedBudgetCandidates(attributed));
      expect(failures.map(({ origins }) => origins.map(({ file }) => file)).sort()).toEqual([
        ["src/app.js"], ["src/fixture.worker.js"], ["src/lazy.js"]
      ]);
      expect(failures.every(({ name }) => name === "(anonymous)")).toBe(true);
      expect(new Set(failures.map(({ file }) => file)).size).toBe(3);
      const vendor = overBudget(attributed).filter(({ ownership }) => ownership === "outside-renderer");
      expect(vendor.map(({ origins }) => origins.map(({ file }) => file))).toEqual([[vendorFile]]);
      expect(vendor[0].file).toBe(failures.find(({ origins }) => origins[0].file === "src/app.js").file);
      const workerChunk = failures.find(({ origins }) => origins[0].file === "src/fixture.worker.js").file;
      expect(overBudget(attributed).some(({ file, ownership }) => file === workerChunk && ownership === "initializer")).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

test("unmapped positions cannot inherit mappings from adjacent functions or lines", () => {
  const map = new SourceMap({ version: 3, sources: ["app.js", "vendor.js"], names: [], mappings: "AAAA,ICAA;AAAA,E;" });
  const chunk = { file: "linked.js", code: "abcdefgh\nabcd\nabc", map,
    sourceFiles: new Map([["app.js", "src/app.js"], ["vendor.js", "node_modules/vendor.js"]]) };
  const base = { file: chunk.file, bytes: bytecodeBudget + 1 };
  const records = [
    { ...base, start: 2, end: 4, positions: [3, 4] }, // Before the vendor segment and after the app segment.
    { ...base, start: 0, end: 6, positions: [1, 5] }, // Positive evidence for both sources.
    { ...base, start: 11, end: 13, positions: [12] }, // Explicit unmapped segment.
    { ...base, start: 14, end: 17, positions: [16] }, // No mappings on this line.
    { ...base, start: 0, end: 17, positions: [1, 5], topLevel: true }
  ];
  const attributed = attributeLinkedFunctions([chunk], records, new Set(["src/app.js"]));
  expect(attributed.map(({ ownership }) => ownership)).toEqual(["unmapped", "mixed", "unmapped", "unmapped", "initializer"]);
  expect(overBudget(linkedBudgetCandidates(attributed))).toEqual(attributed.slice(0, 4));
});
