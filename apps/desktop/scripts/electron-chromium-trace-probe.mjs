// Build the desktop bundle first, then run:
//   pnpm --filter @pwrsnap/desktop probe:chromium-trace
// This standalone fixture never starts PwrSnap or opens a visible window.
import assert from "node:assert/strict";
import { createPackage } from "@electron/asar";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, contentTracing } from "electron";
import { build } from "vite";
import { checkTraceCpuAttribution } from "./electron-chromium-trace-cpu-probe.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pwrsnap-chromium-probe-"));
app.setPath("userData", scratch);
if (process.platform === "darwin") app.setActivationPolicy("accessory");

async function checkCombinedCapture({ HotCpuProfiler, createHotCpuProfileSession }, window, trace, privateMarker, traceStatus) {
  const config = {
    enabled: true, outputRoot: scratch, repoRoot: scratch, startDelayMs: 0, intervalMs: 2000,
    triggerMode: "sustained", thresholdPercent: 50, slowburnThresholdPercent: 15, consecutiveSamples: 2,
    rules: [
      { id: "sustained", thresholdPercent: 50, durationMs: 4000, sampleCount: 2 },
      { id: "slowburn", thresholdPercent: 15, durationMs: 4000, sampleCount: 2 }
    ],
    profileDurationMs: 500, cooldownMs: 60_000, maxProfiles: 1, captureHeapSnapshot: false, heapSnapshotLimit: 2
  };
  const created = await createHotCpuProfileSession({
    config, target: "renderer",
    versions: { appVersion: app.getVersion(), electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome, nodeVersion: process.versions.node }
  });
  assert(created.ok, "create private diagnostics session");
  const { session } = created;
  const notice = Promise.withResolvers();
  const pid = window.webContents.getOSProcessId();
  const started = performance.now();
  let capture;
  let tracePath;
  const profiler = new HotCpuProfiler({
    config, session, target: window.webContents, logger: { info() {}, warn() {}, error: console.error },
    getAppMetrics: () => [{
      pid, cpu: { cumulativeCPUUsage: (performance.now() - started) * 0.0009, percentCPUUsage: 0 },
      memory: {}
    }],
    onEligibilityChanged: () => trace.setArmed(profiler.canCaptureAnotherProfile()),
    onProfileTriggered(profilePath, triggerAt) {
      tracePath = profilePath.replace(/\.cpuprofile$/u, ".trace.json");
      const cpuWritten = Promise.withResolvers();
      capture = trace.capture(tracePath, triggerAt, cpuWritten.promise, config.profileDurationMs);
      return cpuWritten.resolve;
    },
    onProfileWritten: notice.resolve
  });
  try {
    await profiler.start();
    await window.webContents.executeJavaScript(`
      (function burnBeforeCombinedCpuTrigger() {
        performance.mark(${JSON.stringify(privateMarker)});
        const until = performance.now() + 200;
        while (performance.now() < until) {
          document.body.style.width = (50 + performance.now() % 100) + 'px';
          document.body.getBoundingClientRect();
        }
      })()
    `);
    const event = await notice.promise;
    assert.deepEqual(event.matchedRules.map(({ id }) => id), ["sustained", "slowburn"]);
    const profile = JSON.parse(await readFile(event.profilePath, "utf8"));
    assert(profile.nodes.some(({ callFrame }) => callFrame.functionName === "burnBeforeCombinedCpuTrigger"),
      "actual V8 profile must contain pre-trigger work");
    const result = await capture;
    assert.equal(result?.status, traceStatus);
    const manifest = JSON.parse(await readFile(join(session.directoryPath, "session.json"), "utf8"));
    assert.deepEqual(manifest.artifacts, ["renderer-hot-0001.cpuprofile"]);
    if (traceStatus === "failed") {
      await assert.rejects(stat(tracePath), { code: "ENOENT" });
      console.log("A failed trace filter left the valid CPU profile in the session");
      return;
    }
    assert(result.filterCpuMs > 0 && result.filterWallMs > 0);
    await session.registerArtifact(basename(tracePath));
    const registered = JSON.parse(await readFile(join(session.directoryPath, "session.json"), "utf8"));
    assert.deepEqual(registered.artifacts, ["renderer-hot-0001.cpuprofile", "renderer-hot-0001.trace.json"]);
    const filtered = await readFile(tracePath, "utf8");
    assert(!filtered.includes(privateMarker));
    assert(JSON.parse(filtered).traceEvents.some(({ name }) => name === "Layout"));
    console.log("Combined rules: one CPU notice, V8 pre-trigger work, and a readable redacted trace in the same session");
  } finally {
    await profiler.stop();
  }
}

async function run() {
  const watchdog = setTimeout(() => {
    console.error("Chromium trace probe timed out");
    app.exit(1);
  }, 75_000).unref();
  const privateMarker = "pwrsnap-synthetic-private-mark";
  const server = createServer((_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("synthetic fixture");
  });
  let window;
  let trace;
  try {
    const workerName = "chromium-trace-worker.js";
    const archiveSource = join(scratch, "archive-source");
    const archive = join(scratch, "app.asar");
    await mkdir(archiveSource);
    await copyFile(join(import.meta.dirname, "../out/main", workerName), join(archiveSource, workerName));
    await writeFile(join(archiveSource, "package.json"), '{"type":"module"}');
    await createPackage(archiveSource, archive);
    const workerModule = join(archive, workerName);
    await build({
      configFile: false,
      logLevel: "warn",
      plugins: [{
        name: "probe-logger",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "../log" && importer?.endsWith("hot-cpu-profiler.ts")) return "\0probe-logger";
        },
        load(id) {
          if (id === "\0probe-logger") return "export function getMainLogger() { return console; }";
        }
      }],
      build: {
        ssr: true,
        outDir: scratch,
        emptyOutDir: false,
        rollupOptions: {
          input: Object.fromEntries([
            "chromium-trace", "hot-cpu-profiler", "hot-cpu-profile-session", "main-process-hot-cpu-target"
          ].map((name) =>
            [name, join(import.meta.dirname, `../src/main/diagnostics/${name}.ts`)]
          )),
          output: { entryFileNames: "[name].mjs" }
        }
      }
    });
    const load = (name) => import(pathToFileURL(join(scratch, `${name}.mjs`)).href);
    const [{ ChromiumTrace }, cpuProfiler, cpuSession] = await Promise.all([
      load("chromium-trace"), load("hot-cpu-profiler"), load("hot-cpu-profile-session")
    ]);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/trace?private=${privateMarker}`;
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    await window.loadURL("data:text/html,<main>Trace fixture</main>");
    if (process.env.PWRSNAP_TRACE_CPU_PROBE === "1") {
      await checkTraceCpuAttribution({
        ChromiumTrace, ...cpuProfiler, ...cpuSession, ...await load("main-process-hot-cpu-target")
      }, scratch, workerModule);
      return;
    }
    const execute = (script) => window.webContents.executeJavaScript(script);
    await execute("document.querySelector('main').insertAdjacentHTML('beforeend', '<div>Row</div>'.repeat(120))");

    let raw = "";
    trace = new ChromiumTrace(() => ({
      async startRecording(config) {
        // A small ring lets the same workload force evictions across hosts.
        await contentTracing.startRecording({ ...config, trace_buffer_size_in_kb: 1024 });
      },
      async stopRecording(file) {
        const saved = await contentTracing.stopRecording(file);
        raw = await readFile(saved, "utf8");
        return saved;
      }
    }), console.error, { workerModule });
    await trace.setArmed(true);

    await execute("performance.mark('early-overflow-marker')");
    for (let batch = 0; batch < 24; batch++) {
      await execute(`
        (() => {
          const rows = document.querySelector('main').children;
          for (let i = 0; i < 1200; i++) {
            const row = rows[i % rows.length];
            row.style.width = (300 + i % 64) + 'px';
            row.getBoundingClientRect();
            performance.mark('pressure-${batch}-' + i + '-' + 'x'.repeat(180));
          }
          performance.clearMarks();
        })()
      `);
      await delay(25);
    }
    await delay(750);
    await execute("performance.mark('lead-in-marker'); document.body.style.width = '511px'; document.body.getBoundingClientRect()");
    await delay(200);
    await execute(`
      (async () => {
        performance.mark(${JSON.stringify(privateMarker)});
        await fetch(${JSON.stringify(url)});
        document.body.style.width = '513px';
        document.body.getBoundingClientRect();
      })()
    `);
    const cpu = Promise.withResolvers();
    const artifact = join(scratch, "renderer-hot-0001.trace.json");
    const result = trace.capture(artifact, performance.now(), cpu.promise, 250);
    trace.setArmed(false);
    await delay(100);
    await execute("performance.mark('post-trigger-marker')");
    await delay(150);
    cpu.resolve(true);

    const captured = await result;
    assert.equal(captured.status, "written");
    const saved = await readFile(artifact, "utf8");
    const events = JSON.parse(raw).traceEvents;
    const pid = window.webContents.getOSProcessId();
    const marks = events.filter((event) => event.pid === pid).map((event) => event.name);
    assert(!marks.includes("early-overflow-marker"), "the rolling ring must evict old activity");
    assert(marks.includes("lead-in-marker"), "renderer activity before detection must survive");
    assert(marks.includes(privateMarker), "the native export must contain the private test mark");
    assert(!marks.includes("post-trigger-marker"), "the native trace must freeze at detection");
    assert(raw.includes(url), "the native export must contain the private test URL");
    assert(!saved.includes(privateMarker) && !saved.includes(url), "the exported artifact must redact private strings");
    const safeRendererEvents = JSON.parse(saved).traceEvents.filter((event) => event.pid === pid);
    assert(safeRendererEvents.some(({ name }) => name === "Layout"), "renderer layout timing must survive redaction");
    assert(safeRendererEvents.some(({ name }) => name === "ResourceSendRequest"), "redacted network timing must survive");
    if (process.platform !== "win32") assert.equal((await stat(artifact)).mode & 0o777, 0o600);
    console.log(`Electron ${process.versions.electron} on ${process.platform}: rolling eviction, trigger freeze, renderer timing and redaction verified (${captured.rawBytes} raw bytes)`);
    await checkCombinedCapture({ ...cpuProfiler, ...cpuSession }, window, trace, privateMarker, "written");
    await trace.shutdown(1_000);
    trace = new ChromiumTrace(() => ({
      startRecording: async () => {},
      stopRecording: async (file) => {
        await writeFile(file, '{"traceEvents":[{"args":"synthetic malformed trace"');
        return file;
      }
    }), () => {}, { workerModule });
    await checkCombinedCapture({ ...cpuProfiler, ...cpuSession }, window, trace, privateMarker, "failed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    await trace?.shutdown(1_000);
    window?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  }
}

void run();
