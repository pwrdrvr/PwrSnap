import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { platformPath } from "../../apps/desktop/scripts/electron-runtime-cache.mjs";
import { isCliEntrypoint } from "./cli-entrypoint.mjs";

const workerPath = fileURLToPath(import.meta.url);
const desktopRequire = createRequire(resolve(import.meta.dirname, "../../apps/desktop/package.json"));
const scriptPrefix = "pwrsnap-bytecode:";

export function compilerRuntime(electron = false) {
  const env = { ...process.env };
  for (const key of ["NODE_OPTIONS", "NODE_COMPILE_CACHE", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  // Use the stock distribution pinned by the desktop package. The shipped
  // PwrSnap executable turns off runAsNode and must never be launched here.
  if (!electron) return { executable: process.execPath, env };
  env.ELECTRON_RUN_AS_NODE = "1";
  const packagePath = desktopRequire.resolve("electron/package.json");
  return { executable: join(dirname(packagePath), "dist", platformPath(process.platform)), electron: desktopRequire(packagePath).version, env };
}

export function optimizationLimit(runtime) {
  const options = execFileSync(runtime.executable, ["--v8-options"], {
    env: runtime.env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"]
  });
  return Number(/default: --max-optimized-bytecode-size=(\d+)/.exec(options)?.[1]);
}

async function compile() {
  console.log(JSON.stringify(process.versions));
  let index = 0;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const { file, variant, code, esm } = JSON.parse(line);
    const identifier = scriptPrefix + index++;
    try {
      // No run, link or evaluate calls. --no-lazy compiles uncalled children.
      if (esm) new vm.SourceTextModule(code, { identifier });
      else new vm.Script(code, { filename: identifier });
    } catch (error) {
      throw new Error(`${file} (${variant}): ${error.message.slice(0, 500)}`);
    }
  }
}

// V8 logs Ignition instruction sizes (~) and joins them to source positions
// by code address. The numeric script identifier is ours, so commas, drive
// letters, and minified or duplicated function names cannot affect the join.
const creation = /^code-creation,(Script|JS|Function),\d+,\d+,(0x[0-9a-f]+),(\d+),(.*?) ?pwrsnap-bytecode:(\d+):\d+:\d+,0x[0-9a-f]+,~$/i;
const sourceInfo = /^code-source-info,(0x[0-9a-f]+),(\d+),(\d+),(\d+),((?:C\d+O\d+)*),,$/i;

async function readMeasurements(logPath, inputs) {
  const pending = new Map();
  const records = [];
  const roots = new Set();
  const scripts = new Map();
  const interpreted = new Map();
  for await (const line of createInterface({ input: createReadStream(logPath), crlfDelay: Infinity })) {
    const event = creation.exec(line);
    if (event) {
      const [, kind, address, size, name, index] = event;
      const input = inputs[Number(index)];
      if (!input || pending.has(address) || Number(size) <= 0) throw new Error("Invalid V8 code creation event");
      pending.set(address, { input, name: name || "(anonymous)", bytes: Number(size), topLevel: kind === "Script" });
      continue;
    }
    if (line.startsWith("function,")) {
      const [, event, id] = line.split(",", 3);
      if (event === "interpreter" && scripts.has(id)) interpreted.set(id, (interpreted.get(id) ?? 0) + 1);
      if (event === "first-execution" && scripts.has(id)) throw new Error("V8 executed bytecode from an audited input");
      continue;
    }
    if (!line.startsWith("code-source-info,")) continue;
    const position = sourceInfo.exec(line);
    if (!position) continue;
    const [, address, scriptId, startText, endText, positionText] = position;
    const eventRecord = pending.get(address);
    if (!eventRecord) continue;
    const { input, ...record } = eventRecord;
    const start = Number(startText);
    const end = Number(endText);
    const positions = [...positionText.matchAll(/C\d+O(\d+)/g)].map((match) => Number(match[1]));
    if (start > end || end > input.length || positions.some((offset) => offset > input.length)) {
      throw new Error(`Invalid V8 source positions for ${input.file} (${input.variant})`);
    }
    pending.delete(address);
    if (record.topLevel) {
      roots.add(input);
      scripts.set(scriptId, input);
    }
    if (scripts.get(scriptId) !== input) throw new Error(`Unexpected V8 script ID for ${input.file} (${input.variant})`);
    records.push({ ...record, file: input.file, variant: input.variant, ordinal: ++input.ordinal, start, end, positions });
  }
  if (pending.size) throw new Error(`V8 reported ${pending.size} bytecode records without source positions`);
  const missing = inputs.find((input) => !roots.has(input));
  if (missing) throw new Error(`V8 reported no script bytecode for ${missing.file} (${missing.variant})`);
  for (const [id, { file, variant, ordinal }] of scripts) {
    if (interpreted.get(id) !== ordinal) throw new Error(`Incomplete V8 bytecode events for ${file} (${variant})`);
  }
  return records;
}

export async function measureBytecode(modules, runtime = compilerRuntime()) {
  const scratch = mkdtempSync(join(tmpdir(), "pwrsnap-bytecode-"));
  // V8 expands %p and %t in --logfile. Keep the scratch path in cwd.
  const logFile = "v8.log";
  try {
    const child = spawn(runtime.executable, [
      "--no-lazy", "--no-compilation-cache", "--experimental-vm-modules", "--log-code", "--log-source-position", "--log-function-events",
      "--no-log-source-code", "--no-logfile-per-isolate", `--logfile=${logFile}`, workerPath
    ], { cwd: scratch, env: runtime.env, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] });
    const inputs = [];
    const lines = async function* () {
      for await (const module of modules) {
        inputs.push({ file: module.file, variant: module.variant, length: module.code.length, ordinal: 0 });
        yield JSON.stringify(module) + "\n";
      }
    };
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-4000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const [exited, sent] = await Promise.allSettled([once(child, "close"), pipeline(Readable.from(lines()), child.stdin)]);
    if (exited.status === "rejected") throw exited.reason;
    const [code, signal] = exited.value;
    if (code !== 0) throw new Error(`Bytecode compiler exited ${code ?? signal}: ${stderr.trim()}`);
    if (sent.status === "rejected") throw sent.reason;
    const versions = JSON.parse(stdout);
    if (!versions.v8 || versions.electron !== runtime.electron) throw new Error("Unexpected V8 compiler runtime");
    const records = await readMeasurements(join(scratch, logFile), inputs);
    return { versions, records };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    await compile();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
