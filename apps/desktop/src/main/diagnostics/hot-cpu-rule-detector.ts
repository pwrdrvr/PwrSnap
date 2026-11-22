import type { HotCpuEffectiveRule, HotCpuRuleMatch } from "@pwrsnap/shared";

type Observation = { pid: number; timeMs: number; cumulative?: number; electronCpuPercent: number };
type Interval = { cpuPercent: number; durationMs: number; source: "cumulative" | "electron" };

export class HotCpuRuleDetector {
  private previous: Observation | undefined;
  private readonly streaks: Interval[][];

  constructor(private readonly rules: readonly HotCpuEffectiveRule[], private readonly cadenceMs: number) {
    this.streaks = rules.map(() => []);
  }

  reset(): void {
    this.previous = undefined;
    this.clearStreaks();
  }

  private clearStreaks(): void {
    for (const streak of this.streaks) streak.length = 0;
  }

  sample(current: Observation) {
    const previous = this.previous;
    this.previous = current;
    const interval = this.measure(previous, current);
    if (!interval) {
      this.clearStreaks();
      return { matches: [], consecutiveHotSamples: 0 };
    }
    const matches: HotCpuRuleMatch[] = [];
    let consecutiveHotSamples = 0;
    const jitterMs = Math.min(100, this.cadenceMs * 0.05);
    for (const [index, rule] of this.rules.entries()) {
      const streak = this.streaks[index]!;
      if (interval.cpuPercent + 1e-9 < rule.thresholdPercent) {
        streak.length = 0;
        continue;
      }
      streak.push(interval);
      if (streak.length > rule.sampleCount) streak.shift();
      if (index === 0) consecutiveHotSamples = streak.length;
      if (streak.length !== rule.sampleCount) continue;
      let observedDurationMs = 0;
      let peakCpuPercent = 0;
      let measurement: HotCpuRuleMatch["measurement"] = interval.source;
      for (const sample of streak) {
        observedDurationMs += sample.durationMs;
        peakCpuPercent = Math.max(peakCpuPercent, sample.cpuPercent);
        if (sample.source !== interval.source) measurement = "mixed";
      }
      if (observedDurationMs + jitterMs < rule.durationMs) continue;
      matches.push({
        ...rule, cadenceMs: this.cadenceMs, observedDurationMs,
        triggerCpuPercent: interval.cpuPercent, peakCpuPercent, measurement
      });
    }
    return { interval, matches, consecutiveHotSamples };
  }

  private measure(previous: Observation | undefined, current: Observation): Interval | undefined {
    if (!previous || previous.pid !== current.pid) return;
    const durationMs = current.timeMs - previous.timeMs;
    if (durationMs <= 0 || durationMs > this.cadenceMs * 1.5) return;
    if (current.cumulative === undefined && previous.cumulative === undefined) {
      // Electron's platform estimate is usable only with a preceding
      // observation on this target and a real interval at the active cadence.
      if (Number.isFinite(current.electronCpuPercent) && current.electronCpuPercent >= 0) {
        return { cpuPercent: current.electronCpuPercent, durationMs, source: "electron" };
      }
      return;
    }
    if (current.cumulative === undefined || previous.cumulative === undefined) return;
    const delta = current.cumulative - previous.cumulative;
    if (!Number.isFinite(delta) || delta < 0) return;
    return { cpuPercent: delta * 100_000 / durationMs, durationMs, source: "cumulative" };
  }
}
