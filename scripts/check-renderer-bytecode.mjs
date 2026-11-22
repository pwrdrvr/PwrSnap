#!/usr/bin/env node
import { globSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";
import { attributeLinkedFunctions, buildLinkedChunks, linkedBudgetCandidates } from "./lib/renderer-bytecode-attribution.mjs";
import { compilerRuntime, measureBytecode, optimizationLimit } from "./lib/renderer-bytecode-compiler.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(repoRoot, "apps/desktop");
const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
// Post-split maximum: 24,502 bytes. Keep growth near that measured size,
// rather than allowing functions to approach the old 48 KiB guard again.
export const bytecodeBudget = 26 * 1024;

export function rendererModules(root = repoRoot, discover = globSync) {
  return discover("apps/desktop/src/renderer/src/**/*.{ts,tsx,js,jsx,mjs}", { cwd: root })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !/(?:^|\/)(?:__tests__|__fixtures__|fixtures)(?:\/|$)|\.(?:test|spec)\.|\.d\.ts$/.test(file))
    .sort();
}

export function importTool(modulePath) {
  // Drive-letter paths are not ESM specifiers. File URLs also preserve #/%
  // in real filenames rather than treating them as URL syntax.
  return import(pathToFileURL(modulePath).href);
}

// Vitest 4's module-evaluator wrapper, including its CJS globals. Context
// layout affects bytecode size; a bare module is not the renderer-test oracle.
export function wrapModule(code) {
  const args = [
    "__vite_ssr_exports__", "__vite_ssr_import_meta__", "__vite_ssr_import__",
    "__vite_ssr_dynamic_import__", "__vite_ssr_exportAll__", "__vite_ssr_exportName__",
    "__filename", "__dirname", "module", "exports", "require"
  ];
  return `'use strict';async (${args.join(",")})=>{{${code}\n}}`;
}

export async function measureModules(modules) {
  const { records } = await measureBytecode(modules);
  return records.map(({ file, variant, name, ordinal, bytes }) => ({ file, variant, name, ordinal, bytes }));
}

async function* transformedModules(context, files) {
  const project = context.projects.find((entry) => entry.name === "desktop-renderer");
  const environment = project?.vite.environments.ssr;
  if (!environment) throw new Error("The desktop-renderer SSR environment is missing");
  const { fetchModule } = await importTool(desktopRequire.resolve("vite"));
  for (const file of files) {
    // jsdom tests run in Vitest's client environment; SSR covers the Node
    // transform too. Both receive the same real module-evaluator wrapper.
    for (const [variant, env] of [["Vitest-client", project.vite.environments.client], ["Vitest-SSR", environment]]) {
      const result = await fetchModule(env, resolve(repoRoot, file), undefined, { inlineSourceMap: false });
      if (!("code" in result)) throw new Error(`No transformed code for ${file} (${variant})`);
      yield { file, variant, code: wrapModule(result.code) };
    }
  }
}

async function rendererConfig(command, mode) {
  // Resolve tools from the desktop package that declares them, not a root
  // hoist or a dependency owned by another worktree.
  const electronVite = await importTool(desktopRequire.resolve("electron-vite"));
  const options = { root: desktopRoot, configFile: resolve(desktopRoot, "electron.vite.config.ts") };
  const config = (await electronVite.resolveConfig(options, command, mode)).config?.renderer;
  if (!config) throw new Error(`Renderer ${mode} configuration is missing`);
  return config;
}

async function* appModules(files, vite) {
  const devConfig = await rendererConfig("serve", "development");
  const server = await vite.createServer(vite.mergeConfig(devConfig, {
    configFile: false, server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: "error"
  }));
  try {
    for (const file of files) {
      const result = await server.transformRequest(`/@fs/${resolve(repoRoot, file).replaceAll("\\", "/")}`);
      if (!result) throw new Error(`No development transform for ${file}`);
      yield { file, variant: "development", code: result.code, esm: true };
    }
  } finally {
    await server.close();
  }
  const buildConfig = await rendererConfig("build", "production");
  // Real production React/Rollup/esbuild pipeline, with each application
  // module as an entry. External imports keep third-party code out of this
  // app-owned budget. This is per-module coverage, not final chunk coverage.
  const bundles = await vite.build({
    ...buildConfig, configFile: false, logLevel: "error",
    build: { ...buildConfig.build, write: false, sourcemap: false, emptyOutDir: false,
      rollupOptions: {
        ...buildConfig.build?.rollupOptions,
        input: Object.fromEntries(files.map((file, index) => [`module-${index}`, resolve(repoRoot, file)])),
        external: (_id, importer) => Boolean(importer),
        preserveEntrySignatures: "strict"
      }
    }
  });
  for (const bundle of Array.isArray(bundles) ? bundles : [bundles]) {
    for (const chunk of bundle.output) {
      if (chunk.type !== "chunk" || !chunk.facadeModuleId) continue;
      const file = relative(repoRoot, chunk.facadeModuleId).replaceAll("\\", "/");
      yield { file, variant: "production", code: chunk.code, esm: true };
    }
  }
}

export function overBudget(records) {
  return records.filter((record) => !Number.isInteger(record.bytes) || record.bytes > bytecodeBudget);
}

function checkOptimizationLimit(runtime) {
  const limit = optimizationLimit(runtime);
  if (!Number.isInteger(limit) || limit < bytecodeBudget + 12 * 1024) {
    throw new Error(`Cannot establish 12 KiB of V8 optimization headroom: runtime limit ${limit}, budget ${bytecodeBudget}`);
  }
  return limit;
}

async function linkedRenderer(vite, files) {
  const cwd = process.cwd();
  // electron-vite's renderer preset resolves its default root from the
  // desktop CLI's working directory. Both shipping HTML entries stay intact.
  process.chdir(desktopRoot);
  try {
    return await buildLinkedChunks(vite, await rendererConfig("build", "production"), repoRoot, files);
  } finally {
    process.chdir(cwd);
  }
}

function largest(records, count) {
  return [...records].sort((a, b) => b.bytes - a.bytes).slice(0, count);
}

function describeLinked(record) {
  const origins = record.origins.slice(0, 3).map(({ file, line, column }) => `${file}:${line}:${column}`);
  if (record.origins.length > 3) origins.push(`+${record.origins.length - 3} more`);
  const sources = origins.length ? ` from ${origins.join(", ")}` : "";
  return `${record.file}@${record.start}: ${record.name} uses ${record.bytes} bytes (${record.ownership}${sources})`;
}

async function measurePerModule(vite, files) {
  const { createVitest } = await import("vitest/node");
  const nodeEnv = process.env.NODE_ENV;
  const context = await createVitest("test", {
    root: repoRoot, config: resolve(repoRoot, "vitest.workspace.ts"),
    project: ["desktop-renderer"], watch: false
  });
  try {
    await context.standalone();
    const modules = async function* () {
      yield* transformedModules(context, files);
      yield* appModules(files, vite);
    };
    const records = await measureModules(modules());
    const measured = new Set(records.map(({ file, variant }) => `${file}:${variant}`));
    for (const file of files) {
      for (const variant of ["Vitest-client", "Vitest-SSR", "development", "production"]) {
        if (!measured.has(`${file}:${variant}`)) throw new Error(`V8 reported no functions for ${file} (${variant})`);
      }
    }
    return records;
  } finally {
    await context.close();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
}

function printLinkedBudget({ versions, records, optimizationLimit: limit }) {
  const runtime = versions.electron ? `Electron ${versions.electron}` : `Node ${versions.node}`;
  const failures = overBudget(linkedBudgetCandidates(records));
  const counts = Object.groupBy(records, (record) => record.ownership);
  const summary = Object.entries(counts).map(([kind, rows]) => `${rows.length} ${kind}`).join(", ");
  console.log(`${runtime}, V8 ${versions.v8}, TurboFan limit ${limit} bytes: ${summary}`);
  for (const record of largest(records.filter((record) => record.ownership === "application"), 3)) console.log(describeLinked(record));
  for (const record of largest(failures, 10)) console.error(`${runtime}: ${describeLinked(record)}`);
  return failures.length;
}

async function checkBytecode() {
  const runtimes = [compilerRuntime(), compilerRuntime(true)].map((runtime) => ({ runtime, limit: checkOptimizationLimit(runtime) }));
  const vite = await importTool(desktopRequire.resolve("vite"));
  const files = rendererModules();
  if (!files.length) throw new Error("No renderer modules discovered");
  const records = await measurePerModule(vite, files);
  const applicationFiles = new Set(files);
  const chunks = await linkedRenderer(vite, applicationFiles);
  const input = chunks.map(({ file, variant, code, esm }) => ({ file, variant, code, esm }));
  const linked = await Promise.all(runtimes.map(async ({ runtime, limit }) => {
    const { versions, records } = await measureBytecode(input, runtime);
    return { versions, optimizationLimit: limit, records: attributeLinkedFunctions(chunks, records, applicationFiles) };
  }));
  const reportIndex = process.argv.indexOf("--report");
  if (reportIndex !== -1) {
    const report = { versions: process.versions, budget: bytecodeBudget, optimizationLimit: linked[0].optimizationLimit, files, records, linked };
    writeFileSync(process.argv[reportIndex + 1], JSON.stringify(report, null, 2) + "\n");
  }
  console.log(`Renderer function limit ${bytecodeBudget} bytes across ${files.length} modules and ${chunks.length} linked chunks`);
  for (const record of largest(records, 10)) {
    console.log(`${record.file}: ${record.name} (${record.variant}) ${record.bytes} bytes`);
  }
  const moduleFailures = overBudget(records);
  for (const record of largest(moduleFailures, 10)) {
    console.error(`${record.file}: ${record.name} [function ${record.ordinal}] (${record.variant}) uses ${record.bytes} bytes`);
  }
  const failureCount = linked.map(printLinkedBudget).reduce((count, failures) => count + failures, moduleFailures.length);
  if (failureCount) throw new Error(`${failureCount} function measurements exceed the ${bytecodeBudget}-byte budget`);
  console.log(`Renderer bytecode budget passed: ${records.length} per-module and ${linked.reduce((count, result) => count + result.records.length, 0)} linked function measurements`);
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    await checkBytecode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
