import { SourceMap } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";

const slash = (path) => path.replaceAll("\\", "/");
export const linkedVariant = "linked-production";

function workerInitializer(file, code) {
  const { program, errors } = parseSync(file, code);
  if (errors.length) throw new Error(`Cannot parse the linked worker initializer in ${file}`);
  const [statement] = program.body;
  if (program.body.length !== 1 || statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") return;
  const { callee } = statement.expression;
  const fn = callee.type === "ParenthesizedExpression" ? callee.expression : callee;
  if (fn.type === "FunctionExpression" || fn.type === "ArrowFunctionExpression") {
    return { start: fn.start, bodyStart: fn.body.start, end: fn.end };
  }
}

export async function buildLinkedChunks(vite, config, root, files) {
  let outDir;
  const workers = new Map();
  const bundles = await vite.build(vite.mergeConfig(config, {
    configFile: false,
    logLevel: "error",
    plugins: [{
      name: "renderer-bytecode-output-directory",
      configResolved(resolved) { outDir = resolve(resolved.root, resolved.build.outDir); }
    }],
    worker: { plugins: () => [{
      name: "renderer-bytecode-worker-chunks",
      generateBundle(options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          // Vite's separate worker build can resolve maps relative to cwd.
          // Its outer build emits worker JS as assets, losing module metadata.
          const path = options.file ? resolve(options.sourcemapFile || options.file) : resolve(options.dir || ".", chunk.fileName);
          workers.set(chunk.fileName, { chunk, sourceDir: dirname(path), format: options.format });
        }
      }
    }] },
    build: { write: false, sourcemap: "hidden", emptyOutDir: false }
  }));
  if (!outDir) throw new Error("Renderer build output directory was not resolved");
  const chunks = [];
  for (const bundle of Array.isArray(bundles) ? bundles : [bundles]) {
    for (const output of bundle.output) {
      const worker = output.type === "asset" && workers.get(output.fileName);
      if (output.type !== "chunk" && !worker) continue;
      const chunk = worker ? worker.chunk : output;
      const { fileName: file, code, map } = chunk;
      if (worker && output.source !== code) throw new Error(`Emitted worker code differs from the mapped chunk for ${file}`);
      if (!map) throw new Error(`Missing linked source map for ${file}`);
      const sourceDir = worker ? worker.sourceDir : dirname(resolve(outDir, file));
      const { version, sources, names, mappings } = map;
      const sourceFiles = new Map(sources.map((source) => [source, slash(relative(root, resolve(sourceDir, source)))]));
      const hasApplicationCode = Object.entries(chunk.modules).some(([id, module]) =>
        module.renderedLength > 0 && files.has(slash(relative(root, id)))
      );
      if (hasApplicationCode && (!mappings || ![...sourceFiles.values()].some((source) => files.has(source)))) {
        throw new Error(`No application source in the linked map for ${file}`);
      }
      const initializer = worker?.format === "iife" ? workerInitializer(file, code) : undefined;
      chunks.push({ file, variant: linkedVariant, esm: true, code, hasApplicationCode, sourceFiles, initializer,
        map: new SourceMap({ version, sources, names, mappings }) });
    }
  }
  if (!chunks.some((chunk) => chunk.hasApplicationCode)) throw new Error("No application modules in linked renderer chunks");
  return chunks;
}

function originalLocation(chunk, lines, offset, start) {
  let low = 0;
  let high = lines.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle] <= offset) low = middle;
    else high = middle;
  }
  const entry = chunk.map.findEntry(low, offset - lines[low]);
  // A greatest-lower-bound lookup can borrow a preceding line or function's
  // mapping in an unmapped region. Require a segment inside this function.
  if (entry.generatedLine !== low || lines[low] + entry.generatedColumn < start) return;
  const file = chunk.sourceFiles.get(entry.originalSource);
  if (file) return { file, line: entry.originalLine + 1, column: entry.originalColumn + 1 };
}

export function attributeLinkedFunctions(chunks, records, files) {
  const chunksByFile = new Map(chunks.map((chunk) => [chunk.file, {
    chunk, lines: [0, ...Array.from(chunk.code.matchAll(/\r\n|[\n\r\u2028\u2029]/g), (match) => match.index + match[0].length)]
  }]));
  const attributed = records.map(({ start, end, positions, topLevel, ...record }) => {
    const { chunk, lines } = chunksByFile.get(record.file);
    // Rollup can put the worker's whole linked body in an IIFE. Match only
    // that syntactic wrapper, including V8's start position at its parameters.
    const initializer = chunk.initializer;
    const isWorkerInitializer = initializer && end === initializer.end && start >= initializer.start && start <= initializer.bodyStart;
    if (topLevel || isWorkerInitializer) return { ...record, start, ownership: "initializer", origins: [] };
    const origins = new Map();
    // Source positions describe this function's own bytecode. Scanning every
    // mapping in its span would also pick up code belonging to nested functions.
    for (const offset of new Set([start, ...positions.filter((position) => position >= start && position < end)])) {
      const origin = originalLocation(chunk, lines, offset, start);
      if (origin && !origins.has(origin.file)) origins.set(origin.file, origin);
    }
    const application = [...origins.keys()].filter((file) => files.has(file));
    const ownership = application.length
      ? application.length === origins.size ? "application" : "mixed"
      : origins.size ? "outside-renderer" : "unmapped";
    return { ...record, start, ownership, origins: [...origins.values()] };
  });
  if (!attributed.some((record) => record.ownership === "application" || record.ownership === "mixed")) {
    throw new Error("No linked functions mapped to application source");
  }
  return attributed;
}

export function linkedBudgetCandidates(records) {
  // Mixed and unmapped functions need inspection if large. Only positively
  // mapped external functions and the multi-source chunk initializer are exempt.
  return records.filter((record) => !["outside-renderer", "initializer"].includes(record.ownership));
}
