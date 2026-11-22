// Build the desktop bundle first, then run:
//   pnpm --filter @pwrsnap/desktop probe:chromium-trace
// This standalone fixture never starts PwrSnap or opens a visible window.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, contentTracing } from "electron";
import { build } from "vite";

const scratch = await mkdtemp(join(tmpdir(), "pwrsnap-chromium-probe-"));
app.setPath("userData", scratch);
if (process.platform === "darwin") app.setActivationPolicy("accessory");

async function run() {
  const watchdog = setTimeout(() => {
    console.error("Chromium trace probe timed out");
    app.exit(1);
  }, 40_000).unref();
  const privateMarker = "pwrsnap-synthetic-private-mark";
  const server = createServer((_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("synthetic fixture");
  });
  let window;
  let trace;
  try {
    const workerModule = join(import.meta.dirname, "../out/main/chromium-trace-worker.js");
    await stat(workerModule);
    await build({
      configFile: false,
      logLevel: "warn",
      build: {
        ssr: join(import.meta.dirname, "../src/main/diagnostics/chromium-trace.ts"),
        outDir: scratch,
        emptyOutDir: false,
        rollupOptions: { output: { entryFileNames: "controller.mjs" } }
      }
    });
    const { ChromiumTrace } = await import(pathToFileURL(join(scratch, "controller.mjs")).href);
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
