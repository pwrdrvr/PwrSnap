import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProcessMetric } from "electron";
import type { HotCpuProfileCapturedEvent, HotCpuProfileTarget } from "@pwrsnap/shared";
import type { HotCpuProfileConfig } from "../hot-cpu-profile-config";
import type {
  HotCpuProfileEvent,
  HotCpuProfileSample,
  HotCpuProfileSession
} from "../hot-cpu-profile-session";
import { HotCpuProfiler, type HotCpuTarget } from "../hot-cpu-profiler";
import { createHotCpuProfileSession } from "../hot-cpu-profile-session";
import { createMainProcessHotCpuTarget } from "../main-process-hot-cpu-target";
import { createDiagnosticsShutdown } from "../diagnostics-shutdown";

vi.mock("../../log", () => ({
  getMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}));

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const PROFILE_FIXTURE = {
  nodes: [{ id: 1, callFrame: { functionName: "(root)" } }],
  startTime: 0,
  endTime: 1000,
  samples: [1, 1],
  timeDeltas: [0, 500]
};

function enabledConfig(
  overrides: Partial<Extract<HotCpuProfileConfig, { enabled: true }>> = {}
): Extract<HotCpuProfileConfig, { enabled: true }> {
  return {
    enabled: true,
    outputRoot: "/unused",
    repoRoot: "/unused",
    startDelayMs: 0,
    triggerMode: "sustained",
    intervalMs: 10,
    thresholdPercent: 50,
    slowburnThresholdPercent: 15,
    consecutiveSamples: 2,
    profileDurationMs: 30,
    cooldownMs: 1_000,
    maxProfiles: 5,
    captureHeapSnapshot: false,
    heapSnapshotLimit: 2,
    ...overrides
  };
}

function fakeSession(directoryPath: string, target: HotCpuProfileTarget) {
  const samples: HotCpuProfileSample[] = [];
  const events: HotCpuProfileEvent[] = [];
  const artifacts: string[] = [];
  const session: HotCpuProfileSession = {
    id: "test01",
    directoryName: "hot-cpu-test",
    directoryPath,
    samplesPath: join(directoryPath, "samples.ndjson"),
    eventsPath: join(directoryPath, "events.ndjson"),
    target,
    appendSample: async (sample) => {
      samples.push(sample);
    },
    appendEvent: async (event) => {
      events.push(event);
    },
    createProfilePath: (index) =>
      join(directoryPath, `${target}-hot-${String(index).padStart(4, "0")}.cpuprofile`),
    createHeapSnapshotPath: (index, phase) =>
      join(
        directoryPath,
        `${target}-hot-${String(index).padStart(4, "0")}-${phase}.heapsnapshot`
      ),
    registerArtifact: async (filename) => {
      artifacts.push(filename);
    }
  };
  return { session, samples, events, artifacts };
}

function fakeTarget(pid: number) {
  const commands: string[] = [];
  let attached = false;
  const target: HotCpuTarget = {
    debugger: {
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
      },
      isAttached: () => attached,
      sendCommand: async (method) => {
        commands.push(method);
        if (method === "Profiler.stop") return { profile: PROFILE_FIXTURE };
        return {};
      },
      on: () => {},
      off: () => {}
    },
    getOSProcessId: () => pid
  };
  return { target, commands };
}

/** Metrics feed: the target pid burns hot (cumulative +0.02 CPU-seconds
 *  per 10ms sample = 200%), the GPU process burns alongside it, and the
 *  browser process idles. */
function hotMetricsFeed(targetPid: number): () => ProcessMetric[] {
  let cumulative = 0;
  return () => {
    cumulative += 0.02;
    return [
      {
        pid: 1,
        type: "Browser",
        cpu: { percentCPUUsage: 1, idleWakeupsPerSecond: 0, cumulativeCPUUsage: 0.1 },
        memory: { workingSetSize: 100, peakWorkingSetSize: 100 }
      },
      {
        pid: 2,
        type: "GPU",
        cpu: {
          percentCPUUsage: 2.4,
          idleWakeupsPerSecond: 0,
          cumulativeCPUUsage: cumulative / 2
        },
        memory: { workingSetSize: 100, peakWorkingSetSize: 100 }
      },
      {
        pid: targetPid,
        type: "Tab",
        cpu: {
          percentCPUUsage: 90,
          idleWakeupsPerSecond: 5,
          cumulativeCPUUsage: cumulative
        },
        memory: { workingSetSize: 1_000, peakWorkingSetSize: 1_000 }
      }
    ] as ProcessMetric[];
  };
}

let directoryPath: string | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  directoryPath = await mkdtemp(join(tmpdir(), "pwrsnap-hot-cpu-profiler-test-"));
});

afterEach(async () => {
  vi.useRealTimers();
  if (directoryPath !== null) {
    await rm(directoryPath, { recursive: true, force: true });
    directoryPath = null;
  }
});

async function runToProfileWritten(target: HotCpuProfileTarget): Promise<{
  captured: HotCpuProfileCapturedEvent[];
  commands: string[];
  samples: HotCpuProfileSample[];
  events: HotCpuProfileEvent[];
  artifacts: string[];
  profilePath: string;
}> {
  const dir = directoryPath;
  if (dir === null) throw new Error("missing temp dir");
  const { session, samples, events, artifacts } = fakeSession(dir, target);
  const { target: hotCpuTarget, commands } = fakeTarget(4242);
  const captured: HotCpuProfileCapturedEvent[] = [];
  const profiler = new HotCpuProfiler({
    config: enabledConfig({ maxProfiles: 1 }),
    getAppMetrics: hotMetricsFeed(4242),
    logger: silentLogger,
    onProfileWritten: (event) => {
      captured.push(event);
    },
    session,
    target: hotCpuTarget
  });

  await profiler.start();
  // Samples every 10ms, followed by a 30ms post-trigger recording.
  for (let i = 0; i < 12 && captured.length === 0; i += 1) {
    await vi.advanceTimersByTimeAsync(10);
  }
  await profiler.stop("test-finished");
  return {
    captured,
    commands,
    samples,
    events,
    artifacts,
    profilePath: session.createProfilePath(1)
  };
}

describe("HotCpuProfiler", () => {
  test.each(["main", "renderer"] as const)("arms the %s recorder before sampling and never forks its sample loop", async (target) => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 5, max: 30 }), fc.integer({ min: 2, max: 12 }),
      async (intervalMs, expectedSamples) => {
        const { session, artifacts } = fakeSession(directoryPath!, target);
        const { target: hotCpuTarget, commands } = fakeTarget(4242);
        const getAppMetrics = vi.fn(() => []);
        const profiler = new HotCpuProfiler({
          config: enabledConfig({ startDelayMs: 50, intervalMs }), session, target: hotCpuTarget,
          getAppMetrics, logger: silentLogger
        });
        try {
          await profiler.start();
          await vi.advanceTimersByTimeAsync(49);
          expect(getAppMetrics).not.toHaveBeenCalled();
          expect(commands).toEqual(["Profiler.enable", "Profiler.start"]);
          await vi.advanceTimersByTimeAsync(1 + (expectedSamples - 1) * intervalMs);
          expect(getAppMetrics).toHaveBeenCalledTimes(expectedSamples);
          expect(vi.getTimerCount()).toBe(1);
        } finally {
          await profiler.stop();
        }
        expect(artifacts).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      }
    ), { numRuns: 20 });
  });

  test("quit flush saves a real inspector profile and session manifest before resuming", async () => {
    vi.useRealTimers();
    const config = enabledConfig({
      outputRoot: directoryPath!,
      triggerMode: "spike",
      startDelayMs: 250,
      profileDurationMs: 30_000
    });
    const created = await createHotCpuProfileSession({
      config,
      target: "main",
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version }
    });
    if (!created.ok) throw new Error(created.message);
    const session = created.session;
    const target = createMainProcessHotCpuTarget();
    let started = false;
    const appendEvent = session.appendEvent;
    session.appendEvent = async (event) => {
      await appendEvent(event);
      if (event.type === "profile-started") started = true;
    };
    const profiler = new HotCpuProfiler({
      config, session, target, getAppMetrics: hotMetricsFeed(process.pid), logger: silentLogger
    });
    const resumeQuit = vi.fn();
    const warn = vi.fn();
    const shutdown = createDiagnosticsShutdown({ stop: () => profiler.stop("app-quit"), resumeQuit, warn });
    try {
      await profiler.start();
      function burnBeforeFirstCpuSample() {
        const until = performance.now() + 100;
        while (performance.now() < until) {
          // The inspector must retain this frame after the function returns.
        }
      }
      burnBeforeFirstCpuSample();
      await vi.waitFor(() => expect(started).toBe(true));
      shutdown.beforeQuit({ preventDefault: vi.fn() });
      await shutdown.flush();
      // Resumed one macrotask after the flush settles (quit-retry.ts).
      expect(resumeQuit).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(resumeQuit).toHaveBeenCalledOnce());
      expect(warn).not.toHaveBeenCalled();
      const profile = JSON.parse(await readFile(session.createProfilePath(1), "utf8"));
      expect(profile.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ callFrame: expect.objectContaining({ functionName: "burnBeforeFirstCpuSample" }) })
      ]));
      expect(profile.endTime).toBeGreaterThan(profile.startTime);
      const manifest = JSON.parse(await readFile(join(session.directoryPath, "session.json"), "utf8"));
      expect(manifest.artifacts).toContain("main-hot-0001.cpuprofile");
      expect(target.debugger.isAttached()).toBe(false);
    } finally {
      await profiler.stop();
    }
  });

  test.each(["main", "renderer"] as const)("quit joins an in-flight %s recorder start and discards its unclaimed history", async (target) => {
    const { session, artifacts, events } = fakeSession(directoryPath!, target);
    const { target: hotCpuTarget, commands } = fakeTarget(4242);
    let finishStart!: () => void;
    const starting = new Promise<void>((resolve) => { finishStart = resolve; });
    const send = hotCpuTarget.debugger.sendCommand;
    hotCpuTarget.debugger.sendCommand = async (method) => {
      const result = await send(method);
      if (method === "Profiler.start") await starting;
      return result;
    };
    const profiler = new HotCpuProfiler({
      config: enabledConfig({ profileDurationMs: 30_000 }),
      getAppMetrics: hotMetricsFeed(4242),
      logger: silentLogger,
      session,
      target: hotCpuTarget
    });
    const start = profiler.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(commands).toContain("Profiler.start");
    const stopped = vi.fn();
    const stop = profiler.stop("app-quit");
    expect(profiler.stop("window-closed")).toBe(stop);
    void stop.then(stopped);
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).not.toHaveBeenCalled();
    expect(hotCpuTarget.debugger.isAttached()).toBe(true);
    finishStart();
    await Promise.all([start, stop]);
    expect(commands).toEqual(["Profiler.enable", "Profiler.start"]);
    expect(artifacts).toEqual([]);
    expect(events.at(-1)?.type).toBe("monitor-stopped");
    expect(hotCpuTarget.debugger.isAttached()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("caps rolling history during a long start delay and releases the target after its final profile", async () => {
    const { session, artifacts } = fakeSession(directoryPath!, "renderer");
    const { target, commands } = fakeTarget(4242);
    const send = target.debugger.sendCommand;
    let rotations = 0;
    target.debugger.sendCommand = async (method) => {
      const result = await send(method);
      if (method !== "Profiler.stop") return result;
      const number = ++rotations;
      const startTime = (number - 1) * 30_000_000;
      return { profile: {
        nodes: [
          { id: 1, callFrame: { functionName: "(root)" }, children: [2] },
          { id: 2, callFrame: { functionName: `segment${number}` } }
        ],
        startTime, endTime: startTime + 29_900_000, samples: [2], timeDeltas: [1]
      } };
    };
    const getAppMetrics = vi.fn(hotMetricsFeed(4242));
    const profiler = new HotCpuProfiler({
      config: enabledConfig({ startDelayMs: 61_000, triggerMode: "spike", maxProfiles: 1 }),
      getAppMetrics, logger: silentLogger, session, target
    });
    try {
      await profiler.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getAppMetrics).not.toHaveBeenCalled();
      expect(rotations).toBe(2);
      await vi.advanceTimersByTimeAsync(1_030);
      await vi.waitFor(() => expect(profiler.hasPendingWork).toBe(false));
      const profile = JSON.parse(await readFile(session.createProfilePath(1), "utf8"));
      const names = profile.nodes.map((node: { callFrame: { functionName: string } }) => node.callFrame.functionName);
      expect(names).toEqual(["(root)", "segment2", "segment3", "(unrecorded)"]);
      expect(artifacts).toEqual(["renderer-hot-0001.cpuprofile"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getAppMetrics).toHaveBeenCalledTimes(2);
      expect(commands.filter((command) => command === "Profiler.start")).toHaveLength(3);
      expect(target.debugger.isAttached()).toBe(false);
    } finally {
      await profiler.stop();
    }
  });

  test("a Spike requires an observed interval after baseline and a gap cannot satisfy it", async () => {
    const { session, events } = fakeSession(directoryPath!, "renderer");
    const { target } = fakeTarget(4242);
    let now = 0;
    let cumulative = 0;
    const profiler = new HotCpuProfiler({
      config: enabledConfig({ triggerMode: "spike", intervalMs: 1000, profileDurationMs: 60_000 }),
      monotonicNow: () => now, session, target, logger: silentLogger,
      getAppMetrics() {
        return [{ pid: 4242, type: "Tab",
          cpu: { percentCPUUsage: 95, cumulativeCPUUsage: cumulative, idleWakeupsPerSecond: 0 },
          memory: { workingSetSize: 0, peakWorkingSetSize: 0 }
        }] as ProcessMetric[];
      }
    });
    const captures = () => events.filter((event) => event.type === "profile-started");
    try {
      await profiler.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(captures()).toEqual([]);
      now = 2000;
      cumulative = 2;
      await vi.advanceTimersByTimeAsync(1000);
      expect(captures()).toEqual([]);
      now = 3000;
      cumulative = 2.8;
      await vi.advanceTimersByTimeAsync(1000);
      expect(captures()).toHaveLength(1);
    } finally {
      await profiler.stop();
    }
  });

  test("profiles the target after consecutive hot samples and reports its target", async () => {
    const run = await runToProfileWritten("renderer");

    expect(run.commands).toEqual(["Profiler.enable", "Profiler.start", "Profiler.stop"]);
    expect(run.captured).toHaveLength(1);
    expect(run.captured[0]).toMatchObject({
      target: "renderer",
      profileFilename: "renderer-hot-0001.cpuprofile",
      triggerMode: "sustained",
      triggerThresholdPercent: 50
    });
    expect(run.artifacts).toContain("renderer-hot-0001.cpuprofile");
    expect(run.events.map((event) => event.type)).toContain("profile-written");
  });

  test("a main-target session produces main-hot artifacts and a main captured event", async () => {
    const run = await runToProfileWritten("main");

    expect(run.captured[0]).toMatchObject({
      target: "main",
      profileFilename: "main-hot-0001.cpuprofile"
    });
    expect(run.profilePath.endsWith("main-hot-0001.cpuprofile")).toBe(true);
  });

  test("writes the profile as compact single-line JSON", async () => {
    const run = await runToProfileWritten("renderer");
    const contents = await readFile(run.profilePath, "utf8");

    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(contents)).toEqual(PROFILE_FIXTURE);
  });

  test("records a per-process breakdown on every sample", async () => {
    const run = await runToProfileWritten("renderer");

    expect(run.samples.length).toBeGreaterThanOrEqual(2);
    for (const sample of run.samples) {
      const types = (sample.processes ?? []).map((entry) => entry.type).sort();
      expect(types).toEqual(["Browser", "GPU", "Tab"]);
    }
    const second = run.samples[1];
    const gpu = second?.processes?.find((entry) => entry.type === "GPU");
    // 0.01 cumulative CPU-seconds over the 10ms sample interval = 100%.
    expect(gpu?.cpuPercent).toBeCloseTo(100);
    const tab = second?.processes?.find((entry) => entry.type === "Tab");
    expect(tab?.cpuPercent).toBeCloseTo(200);
  });

  test("never trips when the target stays cold", async () => {
    const dir = directoryPath;
    if (dir === null) throw new Error("missing temp dir");
    const { session, samples } = fakeSession(dir, "renderer");
    const { target: hotCpuTarget, commands } = fakeTarget(4242);
    let cumulative = 0;
    const profiler = new HotCpuProfiler({
      config: enabledConfig(),
      getAppMetrics: () => {
        cumulative += 0.0005; // 5% CPU
        return [
          {
            pid: 4242,
            type: "Tab",
            cpu: {
              percentCPUUsage: 5,
              idleWakeupsPerSecond: 0,
              cumulativeCPUUsage: cumulative
            },
            memory: { workingSetSize: 100, peakWorkingSetSize: 100 }
          }
        ] as ProcessMetric[];
      },
      logger: silentLogger,
      session,
      target: hotCpuTarget
    });

    await profiler.start();
    await vi.advanceTimersByTimeAsync(100);
    await profiler.stop("test-finished");

    expect(commands).toEqual(["Profiler.enable", "Profiler.start"]);
    expect(samples.length).toBeGreaterThan(0);
  });
});
