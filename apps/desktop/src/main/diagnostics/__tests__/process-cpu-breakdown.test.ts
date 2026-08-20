import { describe, expect, test } from "vitest";
import type { ProcessMetric } from "electron";
import { ProcessCpuBreakdownTracker } from "../process-cpu-breakdown";

function metric(overrides: {
  pid: number;
  type?: string;
  cumulativeCPUUsage?: number;
  percentCPUUsage?: number;
  idleWakeupsPerSecond?: number;
  workingSetSize?: number;
  name?: string;
  serviceName?: string;
}): ProcessMetric {
  return {
    pid: overrides.pid,
    type: overrides.type ?? "Utility",
    cpu: {
      percentCPUUsage: overrides.percentCPUUsage ?? 0,
      idleWakeupsPerSecond: overrides.idleWakeupsPerSecond ?? 0,
      ...(overrides.cumulativeCPUUsage !== undefined
        ? { cumulativeCPUUsage: overrides.cumulativeCPUUsage }
        : {})
    },
    memory: {
      workingSetSize: overrides.workingSetSize ?? 1000,
      peakWorkingSetSize: overrides.workingSetSize ?? 1000
    },
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    ...(overrides.serviceName !== undefined ? { serviceName: overrides.serviceName } : {})
  } as ProcessMetric;
}

describe("ProcessCpuBreakdownTracker", () => {
  test("omits cpuPercent on the first sighting of a pid", () => {
    const tracker = new ProcessCpuBreakdownTracker();
    const entries = tracker.sample(
      [metric({ pid: 100, type: "Browser", cumulativeCPUUsage: 5 })],
      1_000
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pid).toBe(100);
    expect(entries[0]?.type).toBe("Browser");
    expect(entries[0]?.cpuPercent).toBeUndefined();
    expect(entries[0]?.cumulativeCpuSeconds).toBe(5);
  });

  test("computes cumulative-delta cpuPercent per pid across samples", () => {
    const tracker = new ProcessCpuBreakdownTracker();
    tracker.sample(
      [
        metric({ pid: 100, type: "Browser", cumulativeCPUUsage: 5 }),
        metric({ pid: 200, type: "GPU", cumulativeCPUUsage: 10 })
      ],
      1_000
    );
    const entries = tracker.sample(
      [
        metric({ pid: 100, type: "Browser", cumulativeCPUUsage: 5.5 }),
        metric({ pid: 200, type: "GPU", cumulativeCPUUsage: 11.12 })
      ],
      3_000
    );

    // 0.5 CPU-seconds over 2 wall-seconds = 25%.
    expect(entries.find((entry) => entry.pid === 100)?.cpuPercent).toBeCloseTo(25);
    // 1.12 CPU-seconds over 2 wall-seconds = 56% — the GPU-process case
    // the renderer-only monitor was blind to.
    expect(entries.find((entry) => entry.pid === 200)?.cpuPercent).toBeCloseTo(56);
  });

  test("never records Electron's instantaneous percentCPUUsage", () => {
    const tracker = new ProcessCpuBreakdownTracker();
    tracker.sample([metric({ pid: 100, cumulativeCPUUsage: 5, percentCPUUsage: 2.4 })], 1_000);
    const [entry] = tracker.sample(
      [metric({ pid: 100, cumulativeCPUUsage: 5.86, percentCPUUsage: 2.4 })],
      3_000
    );

    expect(entry?.cpuPercent).toBeCloseTo(43);
    expect(JSON.stringify(entry)).not.toContain("2.4");
  });

  test("prunes exited pids so a recycled pid never deltas against a dead process", () => {
    const tracker = new ProcessCpuBreakdownTracker();
    tracker.sample([metric({ pid: 100, cumulativeCPUUsage: 100 })], 1_000);
    tracker.sample([metric({ pid: 200, cumulativeCPUUsage: 1 })], 2_000);
    const entries = tracker.sample([metric({ pid: 100, cumulativeCPUUsage: 0.5 })], 3_000);

    expect(entries[0]?.cpuPercent).toBeUndefined();
  });

  test("guards against negative deltas and reset clears state", () => {
    const tracker = new ProcessCpuBreakdownTracker();
    tracker.sample([metric({ pid: 100, cumulativeCPUUsage: 5 })], 1_000);
    const [negative] = tracker.sample([metric({ pid: 100, cumulativeCPUUsage: 4 })], 2_000);
    expect(negative?.cpuPercent).toBeUndefined();

    tracker.sample([metric({ pid: 100, cumulativeCPUUsage: 5 })], 3_000);
    tracker.reset();
    const [afterReset] = tracker.sample([metric({ pid: 100, cumulativeCPUUsage: 6 })], 4_000);
    expect(afterReset?.cpuPercent).toBeUndefined();
  });

  test("tolerates platforms without cumulativeCPUUsage", () => {
    const tracker = new ProcessCpuBreakdownTracker();
    tracker.sample([metric({ pid: 100 })], 1_000);
    const [entry] = tracker.sample([metric({ pid: 100 })], 2_000);

    expect(entry?.cpuPercent).toBeUndefined();
    expect(entry?.cumulativeCpuSeconds).toBeUndefined();
  });

  test("carries process identity fields through", () => {
    const tracker = new ProcessCpuBreakdownTracker();
    const [entry] = tracker.sample(
      [
        metric({
          pid: 300,
          type: "Utility",
          cumulativeCPUUsage: 1,
          name: "Audio Service",
          serviceName: "audio.mojom.AudioService",
          idleWakeupsPerSecond: 12,
          workingSetSize: 2048
        })
      ],
      1_000
    );

    expect(entry).toMatchObject({
      pid: 300,
      type: "Utility",
      name: "Audio Service",
      serviceName: "audio.mojom.AudioService",
      idleWakeupsPerSecond: 12,
      workingSetSize: 2048
    });
  });
});
