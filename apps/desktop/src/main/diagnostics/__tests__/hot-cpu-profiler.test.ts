import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  vi.useFakeTimers();
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
    config: enabledConfig(),
    getAppMetrics: hotMetricsFeed(4242),
    logger: silentLogger,
    onProfileWritten: (event) => {
      captured.push(event);
    },
    session,
    target: hotCpuTarget
  });

  await profiler.start();
  // Samples every 10ms; the 3rd sample is the 2nd consecutive hot one
  // (the 1st has no cumulative delta yet), which starts a 30ms profile.
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

    expect(commands).toEqual([]);
    expect(samples.length).toBeGreaterThan(0);
  });
});
