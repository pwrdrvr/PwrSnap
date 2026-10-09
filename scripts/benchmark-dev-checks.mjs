#!/usr/bin/env node
// Compare both compilers on one checkout, sequentially. No incremental cache,
// installs, builds, or editor processes are included in these measurements.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const iterations = Number(process.env.CHECK_BENCH_ITERATIONS ?? "3");
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
  throw new Error("CHECK_BENCH_ITERATIONS must be an integer from 1 to 20");
}
const output = resolve(root, process.env.CHECK_BENCH_OUTPUT ?? ".local/check-performance/paired.json");
const compilers = {
  legacy: resolve(root, "node_modules/typescript/bin/tsc"),
  native: resolve(root, "node_modules/typescript-native/bin/tsc")
};
const projects = ["packages/shared", "apps/desktop"];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options
  });
  if (result.error) throw result.error;
  return result;
}
function compile(compiler, project, extra = []) {
  return run(process.execPath, [compilers[compiler], "--noEmit", "-p", `${project}/tsconfig.json`, ...extra]);
}
function assertSuccess(result) {
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}
const report = {
  revision: run("git", ["rev-parse", "HEAD"]).stdout.trim(),
  node: process.version,
  versions: Object.fromEntries(Object.keys(compilers).map((name) => [name,
    JSON.parse(readFileSync(resolve(compilers[name], "../../package.json"), "utf8")).version])),
  machine: { platform: platform(), cpu: cpus()[0]?.model, logicalCpus: availableParallelism(), totalBytes: totalmem() },
  cache: "Fresh compiler processes, incremental disabled; filesystem/dependency caches warm after first pair",
  inventories: {}, probes: [], samples: []
};
// Compare repository source sets rather than assuming exit zero implies coverage.
// Dependency declarations differ in ordering; those are outside this inventory.
for (const project of projects) {
  const inventories = Object.keys(compilers).map((compiler) => {
    const result = compile(compiler, project, ["--listFilesOnly"]);
    assertSuccess(result);
    return result.stdout.split(/\r?\n/).map((line) => relative(root, line.trim()).replaceAll("\\", "/"))
      .filter((line) => line && !line.startsWith("..") && !line.startsWith("node_modules/") && !line.includes("/node_modules/"))
      .sort();
  });
  if (JSON.stringify(inventories[0]) !== JSON.stringify(inventories[1])) {
    throw new Error(`Compiler file inventories differ for ${project}`);
  }
  report.inventories[project] = { files: inventories[0].length,
    sha256: createHash("sha256").update(inventories[0].join("\n")).digest("hex") };
}
// Each probe must fail independently. In particular, '_' only exempts parameters,
// not locals/imports, and a mixed value/type import must still report the value.
const probes = {
  type: { source: "export const probe: string = 123;\n", code: "TS2322" },
  local: { source: "const _unused = 1;\nexport {};\n", code: "TS6133" },
  parameter: { source: "export function probe(unused: number) { return 1; }\n", code: "TS6133" },
  import: { source: 'import { z, type ZodType } from "zod";\nexport type Probe = ZodType;\n', code: "TS6133" },
  allowedParameter: { source: "export function probe(_unused: number) { return 1; }\n", code: null }
};
for (const project of projects) {
  const probePath = resolve(root, project, "src/dev-check-compiler-probe.ts");
  // Never overwrite an existing file, even if a previous interrupted run left it.
  writeFileSync(probePath, "", { flag: "wx" });
  try {
    for (const [name, probe] of Object.entries(probes)) {
      writeFileSync(probePath, probe.source);
      for (const compiler of Object.keys(compilers)) {
        const result = compile(compiler, project);
        const diagnostic = result.stdout + result.stderr;
        if (probe.code === null) assertSuccess(result);
        else if (result.status === 0 || !diagnostic.includes(probe.code) || !diagnostic.includes("dev-check-compiler-probe.ts")) {
          throw new Error(`${compiler} failed to detect ${project}/${name}: ${diagnostic}`);
        }
        report.probes.push({ project, compiler, name, expected: probe.code, status: result.status });
      }
    }
  } finally {
    rmSync(probePath);
  }
}
for (let iteration = 0; iteration < iterations; iteration++) {
  // Alternate first-run order to avoid always favoring the second compiler.
  for (const compiler of iteration % 2 ? ["native", "legacy"] : ["legacy", "native"]) {
    const start = performance.now();
    const before = { load: loadavg(), freeBytes: freemem() };
    assertSuccess(run(platform() === "win32" ? "pnpm.cmd" : "pnpm",
      [compiler === "legacy" ? "typecheck:legacy" : "typecheck"], { shell: platform() === "win32" }));
    const sample = { iteration, compiler, seconds: (performance.now() - start) / 1000, before, after: { load: loadavg(), freeBytes: freemem() } };
    report.samples.push(sample);
    console.log(JSON.stringify(sample));
  }
}
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Inventories match; ${report.probes.length} compiler probes passed. Results: ${relative(root, output)}`);
