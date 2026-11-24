// Run through the hidden Chromium trace probe with PWRSNAP_TRACE_CPU_PROBE=1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { app } from "electron";

const PRIVATE_MARKER = "https://example.invalid/synthetic-private-argument";
const SERVICE_NAME = "PwrSnap Chromium trace filter";
const INTERVAL_MS = 2_000;

async function writeFixture(path) {
  const event = {
    pid: 101, tid: 12, cat: "devtools.timeline", ph: "X", name: "Layout", ts: 121212121, dur: 10,
    args: { data: { url: PRIVATE_MARKER, rect: [0, 0, 640, 480] } }
  };
  const block = (JSON.stringify(event) + ",\n").repeat(2048);
  const size = Number(process.env.PWRSNAP_TRACE_CPU_FIXTURE_BYTES ?? 240_000_000);
  assert(Number.isSafeInteger(size) && size > 0 && size <= 288 * 1024 * 1024,
    "synthetic fixture must fit within the recorder's raw byte limit");
  const output = await open(path, "wx", 0o600);
  try {
    await output.write('{"traceEvents":[\n');
    for (let i = 0; i < Math.floor(size / Buffer.byteLength(block)); i++) await output.write(block);
    await output.write(JSON.stringify(event) + '],"metadata":{"fixture":true}}');
    return (await output.stat()).size;
  } finally {
    await output.close();
  }
}

function parseSyntheticIndex(index) {
  let rows = 0;
  const until = performance.now() + 18;
  do {
    rows += JSON.parse(index).length;
  } while (performance.now() < until);
  return rows;
}

function cpuMs(usage) {
  return (usage.user + usage.system) / 1000;
}

function readRows(path) {
  return readFile(path, "utf8").then((str) => str.trim().split("\n").map((line) => JSON.parse(line)));
}

export async function checkTraceCpuAttribution(modules, scratch, workerModule) {
  const { ChromiumTrace, HotCpuProfiler, createHotCpuProfileSession, createMainProcessHotCpuTarget } = modules;
  const fixture = join(scratch, "synthetic-trace.json");
  const rawBytes = await writeFixture(fixture);
  // Run the same worker in the browser PID as a positive control. Measure
  // its thread CPU without changing the parser or the browser CPU sampler.
  const source = await readFile(workerModule, "utf8");
  const measuredWorker = `const startedAt = performance.now(); const startedCpu = process.threadCpuUsage();\n
    ${source}
    import { parentPort as probePort } from "node:worker_threads";
    probePort.postMessage({ cpu: process.threadCpuUsage(startedCpu), wallMs: performance.now() - startedAt });\n`;
  const legacyEntry = new URL(`data:text/javascript;base64,${Buffer.from(measuredWorker).toString("base64")}`);
  const index = JSON.stringify(Array.from({ length: 1000 }, (_, id) => ({ id, path: `synthetic/${id}` })));
  console.log(`Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform}/${process.arch}, ${rawBytes} bytes, 50% spike over 2 seconds`);
  const scenarios = [];
  for (const busy of [false, true]) {
    for (const mode of ["control", "legacy", "production"]) {
      const name = `${mode}-${busy ? "busy" : "idle"}`;
      const config = {
        enabled: true, outputRoot: scratch, repoRoot: scratch, startDelayMs: 0, intervalMs: INTERVAL_MS,
        triggerMode: "spike", thresholdPercent: 50, slowburnThresholdPercent: 15, consecutiveSamples: 1,
        rules: [{ id: "spike", thresholdPercent: 50, durationMs: INTERVAL_MS, sampleCount: 1 }],
        profileDurationMs: 250, cooldownMs: 60_000, maxProfiles: 1, captureHeapSnapshot: false, heapSnapshotLimit: 2
      };
      const created = await createHotCpuProfileSession({
        config, target: "main",
        versions: { appVersion: app.getVersion(), electronVersion: process.versions.electron,
          chromeVersion: process.versions.chrome, nodeVersion: process.versions.node }
      });
      assert(created.ok);
      const { session } = created;
      const profileWritten = Promise.withResolvers();
      const rawCopied = Promise.withResolvers();
      const baseline = Promise.withResolvers();
      const sampled = Promise.withResolvers();
      let legacyCost;
      const readings = [];
      const warnings = [];
      const filterTrace = mode === "control"
        ? (_raw, output) => writeFile(output, '{"traceEvents":[]}')
        : mode === "legacy" ? async (rawPath, filteredPath) => {
          const worker = new Worker(legacyEntry, {
            workerData: { rawPath, filteredPath, allowedCategories: ["devtools.timeline", "blink.user_timing", "cc", "viz"] },
            resourceLimits: { maxOldGenerationSizeMb: 96 }
          });
          try {
            await new Promise((resolve, reject) => {
              worker.once("message", (message) => { legacyCost = message; });
              worker.once("error", reject);
              worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Legacy filter failed")));
            });
          } finally {
            await worker.terminate();
          }
        } : undefined;
      const trace = new ChromiumTrace(() => ({
        startRecording: async () => {},
        stopRecording: async (path) => {
          await copyFile(fixture, path);
          rawCopied.resolve();
          return path;
        }
      }), (message) => warnings.push(message), { workerModule, filterTrace });
      const captures = [];
      const triggerTimes = [];
      const profiler = new HotCpuProfiler({
        config, session, target: createMainProcessHotCpuTarget(),
        logger: { info() {}, warn() {}, error: console.error },
        getAppMetrics() {
          const metrics = app.getAppMetrics();
          readings.push(process.threadCpuUsage());
          if (readings.length === 1) baseline.resolve();
          if (readings.length === 2) sampled.resolve();
          return metrics;
        },
        onProfileTriggered(_path, _monotonicMs, capturedAt) { triggerTimes.push(capturedAt); },
        onProfileWritten: (event) => { captures.push(event); }
      });
      const artifact = join(scratch, `${name}.trace.json`);
      try {
        await trace.setArmed(true);
        const capture = trace.capture(artifact, performance.now() + 1, profileWritten.promise, 250);
        void trace.setArmed(false);
        await rawCopied.promise;
        await profiler.start();
        await baseline.promise;
        const busyUntil = performance.now() + INTERVAL_MS;
        const mainWork = busy ? (async () => {
          while (performance.now() < busyUntil) {
            assert(parseSyntheticIndex(index) > 0);
            await delay(2);
          }
        })() : Promise.resolve();
        // Idle measures as much of the filter as possible. Busy starts it
        // later so the main trigger sample must see the active helper.
        await delay(busy ? 1_450 : 400);
        profileWritten.resolve(true);
        await sampled.promise;
        await mainWork;
        await delay(500);
        const result = await capture;
        assert.equal(result.status, "written", warnings.join(", "));
        await profiler.stop();
        const [, sample] = await readRows(join(session.directoryPath, "samples.ndjson"));
        assert.equal(sample.measurement, "cumulative");
        const helper = sample.processes.find((entry) => entry.name === SERVICE_NAME || entry.serviceName === SERVICE_NAME);
        const threadMs = cpuMs(readings[1]) - cpuMs(readings[0]);
        const hash = createHash("sha256");
        if (mode !== "control") {
          for await (const chunk of createReadStream(artifact)) {
            assert(!chunk.includes(PRIVATE_MARKER));
            hash.update(chunk);
          }
        }
        const record = {
          name, browserPercent: Number(sample.cpuPercent.toFixed(1)),
          mainThreadPercent: Number((threadMs / (10 * sample.wallDeltaSeconds)).toFixed(1)),
          filterCpuMs: legacyCost ? cpuMs(legacyCost.cpu) : result.filterCpuMs ?? 0,
          filterWallMs: legacyCost?.wallMs ?? result.filterWallMs ?? 0,
          utilityInSample: Boolean(helper), utilityCpuMsAtSample: (helper?.cumulativeCpuSeconds ?? 0) * 1000,
          spikeThresholdObserved: sample.consecutiveHotSamples === 1,
          captures: captures.length, capturedAtSample: triggerTimes.includes(sample.capturedAt),
          hash: mode === "control" ? undefined : hash.digest("hex")
        };
        console.log(JSON.stringify(record));
        if (busy) {
          assert.equal(captures.length, 1);
          assert(record.capturedAtSample);
          const { nodes } = JSON.parse(await readFile(captures[0].profilePath, "utf8"));
          assert(nodes.some(({ callFrame }) => callFrame.functionName === "parseSyntheticIndex"));
        }
        scenarios.push(record);
      } finally {
        profileWritten.resolve(false);
        await profiler.stop();
        await trace.shutdown(1000);
      }
    }
  }
  const [controlIdle, legacyIdle, filteredIdle, , legacyBusy, filteredBusy] = scenarios;
  assert.equal(controlIdle.captures, 0);
  assert.equal(new Set([legacyIdle.hash, filteredIdle.hash, legacyBusy.hash, filteredBusy.hash]).size, 1);
  assert.equal(filteredIdle.captures, 0, "trace filtering alone must stay below the main spike threshold");
  assert(filteredIdle.filterCpuMs > 0 && filteredIdle.filterWallMs > 0);

  const missing = [];
  if (legacyIdle.spikeThresholdObserved) {
    assert(legacyIdle.captures === 1 && legacyIdle.capturedAtSample, "the hot legacy control sample must trigger a capture");
  } else {
    missing.push("the idle legacy filter did not reach the spike threshold");
  }
  if (!filteredBusy.utilityInSample || filteredBusy.utilityCpuMsAtSample <= 0) {
    missing.push("the busy capture sample did not observe an active trace filter");
  }
  if (missing.length) {
    console.warn(`Trace CPU comparison is inconclusive because ${missing.join(" and ")}.`);
    return;
  }
  console.log("Trace CPU comparison verified a legacy false trigger and a main capture during isolated filtering.");
}
