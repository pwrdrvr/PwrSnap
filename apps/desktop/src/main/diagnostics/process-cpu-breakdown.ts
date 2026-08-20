// Per-process CPU attribution for hot-CPU diagnostics sessions.
//
// `app.getAppMetrics()` already walks every Electron child process
// (browser, GPU, renderers, utilities), but the monitor historically
// recorded only its own target's pid — during the 2026-08-20 incident
// the GPU process was the actual burner (~56%) and the session data was
// blind to it. This tracker turns each metrics snapshot into a compact
// per-process breakdown that rides along on every samples.ndjson row.
//
// CPU percent is computed from `cumulativeCPUUsage` deltas over wall
// time, the same approach the per-target sampler uses. Electron's
// instantaneous `percentCPUUsage` is deliberately NOT recorded here:
// during the same incident it read ~2.4% while the cumulative-delta
// computation correctly read ~43%.

import type { ProcessMetric } from "electron";

export type HotCpuProcessBreakdownEntry = {
  pid: number;
  /** ProcessMetric.type verbatim: "Browser" | "GPU" | "Tab" | "Utility" | ... */
  type: string;
  /** Cumulative-delta CPU percent over wall time. Absent on the first
   *  sighting of a pid (no previous cumulative reading to delta from)
   *  and on platforms where `cumulativeCPUUsage` is unavailable. */
  cpuPercent?: number;
  cumulativeCpuSeconds?: number;
  idleWakeupsPerSecond?: number;
  workingSetSize?: number;
  name?: string;
  serviceName?: string;
};

type PreviousReading = {
  cumulativeCpuSeconds: number;
  sampledAtMs: number;
};

export class ProcessCpuBreakdownTracker {
  private previousByPid = new Map<number, PreviousReading>();

  /** Reset delta state (e.g. after sampling paused for a profile), so
   *  the next breakdown does not average across the gap. */
  reset(): void {
    this.previousByPid.clear();
  }

  sample(metrics: ProcessMetric[], sampledAtMs: number): HotCpuProcessBreakdownEntry[] {
    const nextByPid = new Map<number, PreviousReading>();
    const entries: HotCpuProcessBreakdownEntry[] = [];

    for (const metric of metrics) {
      const cumulativeCpuSeconds = metric.cpu.cumulativeCPUUsage;
      const entry: HotCpuProcessBreakdownEntry = {
        pid: metric.pid,
        type: metric.type,
        ...(cumulativeCpuSeconds !== undefined ? { cumulativeCpuSeconds } : {}),
        ...(metric.cpu.idleWakeupsPerSecond !== undefined
          ? { idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond }
          : {}),
        ...(metric.memory?.workingSetSize !== undefined
          ? { workingSetSize: metric.memory.workingSetSize }
          : {}),
        ...(metric.name !== undefined ? { name: metric.name } : {}),
        ...(metric.serviceName !== undefined ? { serviceName: metric.serviceName } : {})
      };

      if (cumulativeCpuSeconds !== undefined) {
        nextByPid.set(metric.pid, { cumulativeCpuSeconds, sampledAtMs });
        const previous = this.previousByPid.get(metric.pid);
        if (previous) {
          const cpuDeltaSeconds = cumulativeCpuSeconds - previous.cumulativeCpuSeconds;
          const wallDeltaSeconds = (sampledAtMs - previous.sampledAtMs) / 1_000;
          if (cpuDeltaSeconds >= 0 && wallDeltaSeconds > 0) {
            entry.cpuPercent = (cpuDeltaSeconds / wallDeltaSeconds) * 100;
          }
        }
      }

      entries.push(entry);
    }

    // Replacing (not merging) the map prunes exited pids, so a recycled
    // OS pid can never delta against a dead process's counter.
    this.previousByPid = nextByPid;
    return entries;
  }
}
