// Generalized hot-CPU monitor + profiler. One instance watches one
// process (its "target"): the renderer (CDP via webContents.debugger)
// or the Electron main process (node:inspector — see
// main-process-hot-cpu-target.ts). Both speak the same Profiler domain,
// so a target is just a debugger-shaped adapter; the trigger, cooldown,
// and heap-snapshot machinery is shared.

import fs from "node:fs/promises";
import path from "node:path";
import type { Profiler } from "node:inspector";
import type { ProcessMetric } from "electron";
import type {
  HotCpuProfileCapturedEvent,
  HotCpuProfileHeapSnapshotArtifact
} from "@pwrsnap/shared";
import type { HotCpuProfileConfig } from "./hot-cpu-profile-config";
import type { HotCpuProfileSession } from "./hot-cpu-profile-session";
import { joinCpuProfiles } from "./cpu-profile-history";
import { ProcessCpuBreakdownTracker } from "./process-cpu-breakdown";
import { getMainLogger } from "../log";

const CHROME_DEBUGGER_PROTOCOL_VERSION = "1.3";
const RECORDING_WINDOW_MS = 30_000;
const CDP_TIMEOUT_MS = 2_000;

type Logger = Pick<Console, "info" | "warn" | "error">;

export type HotCpuTargetDebugger = {
  attach: (version: string) => void;
  detach: () => void;
  isAttached: () => boolean;
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
  off?: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
};

export type HotCpuTarget = {
  debugger: HotCpuTargetDebugger;
  getOSProcessId: () => number;
  isDestroyed?: () => boolean;
  takeHeapSnapshot?: (filePath: string) => Promise<void>;
};

type CpuUsageReading = {
  cpuPercent: number;
  electronCpuPercent: number;
  cumulativeCpuDeltaSeconds?: number;
  wallDeltaSeconds?: number;
};

type ProfileTriggerListener = (
  profilePath: string, triggerMonotonicMs: number, capturedAt: string
) => ((written: boolean) => void) | undefined;

type ActiveProfileTrigger = Pick<
  HotCpuProfileCapturedEvent,
  | "triggerConsecutiveSamples"
  | "triggerCpuPercent"
  | "triggerMode"
  | "triggerThresholdPercent"
>;

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactFilename(filePath: string): string {
  return path.basename(filePath);
}

export class HotCpuProfiler {
  private readonly detachListener = (_event: unknown, reason: string) => {
    this.debuggerAttached = false;
    this.recording = null;
    this.previousRecording = null;
    void this.onEligibilityChanged?.();
    void this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "debugger-detached",
      detail: { reason }
    }).catch(() => undefined);
    this.logger.warn("[pwrsnap:hot-cpu] target debugger detached", {
      reason,
      target: this.session.target,
      sessionDirectory: this.session.directoryPath
    });
  };

  private readonly config: Extract<HotCpuProfileConfig, { enabled: true }>;
  private readonly getAppMetrics: () => ProcessMetric[];
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly onHeapSnapshotLimitReached: (() => void | Promise<void>) | undefined;
  private readonly onProfileWritten: ((
    event: HotCpuProfileCapturedEvent
  ) => void | Promise<void>) | undefined;
  private readonly onProfileTriggered: ProfileTriggerListener | undefined;
  private readonly onEligibilityChanged: (() => void | Promise<void>) | undefined;
  private readonly monotonicNow: () => number;
  private readonly session: HotCpuProfileSession;
  private readonly target: HotCpuTarget;
  private readonly processBreakdown = new ProcessCpuBreakdownTracker();

  private recording: { monotonicMs: number; wallTime: string } | null = null;
  private previousRecording: { profile: Profiler.Profile; monotonicMs: number; wallTime: string } | null = null;
  private settleCompanion: ((written: boolean) => void) | undefined;
  private startPromise: Promise<void> | null = null;
  private nextSampleAtMs = 0;
  private activeProfileHeapSnapshotCaptures = new Set<Promise<void>>();
  private activeProfileHeapSnapshots: HotCpuProfileHeapSnapshotArtifact[] = [];
  private activeProfileTrigger: ActiveProfileTrigger | null = null;
  private consecutiveHotSamples = 0;
  private debuggerAttached = false;
  private heapSnapshotLimitReached = false;
  private heapSnapshotsCaptured = 0;
  private heapSnapshotMidTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProfileAtMs: number | null = null;
  private previousCumulativeCpuSeconds: number | null = null;
  private previousSampleAtMs: number | null = null;
  private profileCount = 0;
  private profileDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private profiling = false;
  private stopProfilePromise: Promise<void> | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private samplePromise: Promise<void> | null = null;

  constructor(options: {
    config: Extract<HotCpuProfileConfig, { enabled: true }>;
    getAppMetrics: () => ProcessMetric[];
    session: HotCpuProfileSession;
    target: HotCpuTarget;
    logger?: Logger;
    now?: () => Date;
    monotonicNow?: () => number;
    onProfileTriggered?: ProfileTriggerListener;
    onEligibilityChanged?: () => void | Promise<void>;
    onHeapSnapshotLimitReached?: () => void | Promise<void>;
    onProfileWritten?: (event: HotCpuProfileCapturedEvent) => void | Promise<void>;
  }) {
    this.config = options.config;
    this.getAppMetrics = options.getAppMetrics;
    this.logger = options.logger ?? getMainLogger("pwrsnap:hot-cpu");
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.onProfileTriggered = options.onProfileTriggered;
    this.onEligibilityChanged = options.onEligibilityChanged;
    this.onHeapSnapshotLimitReached = options.onHeapSnapshotLimitReached;
    this.onProfileWritten = options.onProfileWritten;
    this.session = options.session;
    this.target = options.target;
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.startPromise ??= this.startInner();
    return this.startPromise;
  }

  get hasPendingWork(): boolean {
    return this.debuggerAttached || this.intervalTimer !== null || this.samplePromise !== null ||
      this.stopProfilePromise !== null || this.profiling;
  }

  canCaptureAnotherProfile(): boolean {
    return !this.stopped && !this.profiling && this.recording !== null &&
      this.profileCount < this.config.maxProfiles && !this.isTargetDestroyed();
  }

  private async startInner(): Promise<void> {

    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "monitor-started",
      detail: {
        intervalMs: this.config.intervalMs,
        startDelayMs: this.config.startDelayMs,
        triggerMode: this.config.triggerMode,
        thresholdPercent: this.config.thresholdPercent,
        slowburnThresholdPercent: this.config.slowburnThresholdPercent,
        consecutiveSamples: this.config.consecutiveSamples,
        profileDurationMs: this.config.profileDurationMs,
        captureHeapSnapshot: this.config.captureHeapSnapshot,
        heapSnapshotLimit: this.config.heapSnapshotLimit
      }
    });
    this.logger.info("[pwrsnap:hot-cpu] monitoring started", {
      target: this.session.target,
      sessionDirectory: this.session.directoryPath,
      startDelayMs: this.config.startDelayMs,
      triggerMode: this.config.triggerMode,
      thresholdPercent: this.config.thresholdPercent,
      slowburnThresholdPercent: this.config.slowburnThresholdPercent,
      profileDurationMs: this.config.profileDurationMs
    });
    this.nextSampleAtMs = this.monotonicNow() + this.config.startDelayMs;
    await this.ensureRecording();
    this.scheduleNextSample();
  }

  stop(reason = "stopped"): Promise<void> {
    this.stopPromise ??= this.stopInner(reason);
    return this.stopPromise;
  }

  private async stopInner(reason: string): Promise<void> {
    this.stopped = true;
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.clearProfileDurationTimer();
    this.clearHeapSnapshotMidTimer();

    void this.onEligibilityChanged?.();
    await this.startPromise?.catch(() => undefined);
    await Promise.all([this.samplePromise?.catch(() => undefined), this.stopProfile(reason)]);

    // Without a trigger, detaching discards the live profile in V8.
    this.recording = null;
    this.previousRecording = null;
    this.detachDebugger();
    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "monitor-stopped",
      detail: { reason }
    });
  }

  private scheduleNextSample(): void {
    if (this.stopped || this.profiling || this.stopProfilePromise || this.intervalTimer || this.samplePromise ||
        this.profileCount >= this.config.maxProfiles || this.isTargetDestroyed()) return;
    const rotateAtMs = this.recording === null
      ? Infinity : this.recording.monotonicMs + RECORDING_WINDOW_MS;
    const nextAtMs = Math.min(this.nextSampleAtMs, rotateAtMs);
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = null;
      const sample = this.sampleAndMaintainRecording();
      this.samplePromise = sample;
      void sample.catch((error: unknown) => {
        this.logger.error("[pwrsnap:hot-cpu] sample task failed", error);
      }).finally(() => {
        if (this.samplePromise === sample) this.samplePromise = null;
        this.scheduleNextSample();
      });
    }, Math.max(0, Math.min(nextAtMs - this.monotonicNow(), 2_147_483_647)));
  }

  private async sampleAndMaintainRecording(): Promise<void> {
    if (this.stopped || this.isTargetDestroyed()) return;
    const sampledAtMs = this.monotonicNow();
    // Timers can fire a fraction of a millisecond early.
    if (sampledAtMs + 1 >= this.nextSampleAtMs) {
      this.nextSampleAtMs = sampledAtMs + this.config.intervalMs;
      await this.captureSample(sampledAtMs);
    }
    if (this.stopped || this.profiling || this.stopProfilePromise) return;
    if (this.recording !== null && sampledAtMs + 1 >= this.recording.monotonicMs + RECORDING_WINDOW_MS) {
      await this.rotateRecording();
    } else {
      await this.ensureRecording();
    }
  }

  private async captureSample(capturedAtMs: number): Promise<void> {
    const capturedAt = this.now().toISOString();
    try {
      const pid = this.target.getOSProcessId();
      const metrics = this.getAppMetrics();
      const processes = this.processBreakdown.sample(metrics, capturedAtMs);
      const metric = metrics.find((candidate) => candidate.pid === pid);
      if (!metric) {
        this.resetTriggerSamples();
        await this.session.appendEvent({
          capturedAt,
          type: "sample-skipped",
          detail: { reason: "metric-not-found", pid }
        });
        return;
      }

      const cumulativeCpuSeconds = metric.cpu.cumulativeCPUUsage;
      const cpuUsage = this.calculateCpuUsage({
        capturedAtMs,
        electronCpuPercent: metric.cpu.percentCPUUsage,
        ...(cumulativeCpuSeconds !== undefined ? { cumulativeCpuSeconds } : {})
      });
      const triggerThresholdPercent = this.triggerThresholdPercent();
      this.consecutiveHotSamples =
        cpuUsage.cpuPercent >= triggerThresholdPercent
          ? this.consecutiveHotSamples + 1
          : 0;

      // Claim the trace synchronously at detection. Sample persistence and
      // heap snapshots can outlast the useful window in Chromium's ring.
      const trigger = this.shouldStartProfile(cpuUsage.cpuPercent, capturedAtMs)
        ? this.startProfile({ capturedAt, capturedAtMs, cpuPercent: cpuUsage.cpuPercent, pid })
        : undefined;
      await Promise.all([trigger, this.session.appendSample({
        capturedAt,
        pid,
        cpuPercent: cpuUsage.cpuPercent,
        electronCpuPercent: cpuUsage.electronCpuPercent,
        ...(cpuUsage.cumulativeCpuDeltaSeconds !== undefined
          ? { cumulativeCpuDeltaSeconds: cpuUsage.cumulativeCpuDeltaSeconds }
          : {}),
        ...(cumulativeCpuSeconds !== undefined ? { cumulativeCpuSeconds } : {}),
        ...(cpuUsage.wallDeltaSeconds !== undefined
          ? { wallDeltaSeconds: cpuUsage.wallDeltaSeconds }
          : {}),
        idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
        workingSetSize: metric.memory.workingSetSize,
        peakWorkingSetSize: metric.memory.peakWorkingSetSize,
        consecutiveHotSamples: this.consecutiveHotSamples,
        processes
      })]);
    } catch (error) {
      await this.session.appendEvent({
        capturedAt,
        type: "sample-failed",
        detail: { error: serializeError(error) }
      });
      this.logger.error("[pwrsnap:hot-cpu] sample failed", error);
    }
  }

  private calculateCpuUsage(options: {
    capturedAtMs: number;
    cumulativeCpuSeconds?: number;
    electronCpuPercent: number;
  }): CpuUsageReading {
    if (options.cumulativeCpuSeconds === undefined) {
      this.previousCumulativeCpuSeconds = null;
      this.previousSampleAtMs = null;
      return {
        cpuPercent: options.electronCpuPercent,
        electronCpuPercent: options.electronCpuPercent
      };
    }

    const previousCumulativeCpuSeconds = this.previousCumulativeCpuSeconds;
    const previousSampleAtMs = this.previousSampleAtMs;
    this.previousCumulativeCpuSeconds = options.cumulativeCpuSeconds;
    this.previousSampleAtMs = options.capturedAtMs;

    if (previousCumulativeCpuSeconds === null || previousSampleAtMs === null) {
      return {
        cpuPercent: options.electronCpuPercent,
        electronCpuPercent: options.electronCpuPercent
      };
    }

    const cumulativeCpuDeltaSeconds =
      options.cumulativeCpuSeconds - previousCumulativeCpuSeconds;
    const wallDeltaSeconds = (options.capturedAtMs - previousSampleAtMs) / 1_000;
    if (cumulativeCpuDeltaSeconds < 0 || wallDeltaSeconds <= 0) {
      return {
        cpuPercent: options.electronCpuPercent,
        electronCpuPercent: options.electronCpuPercent
      };
    }

    return {
      cpuPercent: (cumulativeCpuDeltaSeconds / wallDeltaSeconds) * 100,
      electronCpuPercent: options.electronCpuPercent,
      cumulativeCpuDeltaSeconds,
      wallDeltaSeconds
    };
  }

  private shouldStartProfile(cpuPercent: number, capturedAtMs: number): boolean {
    if (this.profiling || cpuPercent < this.triggerThresholdPercent()) return false;
    if (this.consecutiveHotSamples < this.triggerConsecutiveSamples()) return false;
    if (this.profileCount >= this.config.maxProfiles) return false;

    return (
      this.lastProfileAtMs === null ||
      capturedAtMs - this.lastProfileAtMs >= this.config.cooldownMs
    );
  }

  private triggerThresholdPercent(): number {
    return this.config.triggerMode === "slowburn"
      ? this.config.slowburnThresholdPercent
      : this.config.thresholdPercent;
  }

  private triggerConsecutiveSamples(): number {
    return this.config.triggerMode === "spike" ? 1 : this.config.consecutiveSamples;
  }

  private async sendProfilerCommand(method: string): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.target.debugger.sendCommand(method),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out`)), CDP_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureRecording(): Promise<void> {
    if (this.stopped || this.recording || this.isTargetDestroyed() ||
        this.profileCount >= this.config.maxProfiles || this.target.debugger.isAttached()) return;
    try {
      this.target.debugger.attach(CHROME_DEBUGGER_PROTOCOL_VERSION);
      this.debuggerAttached = true;
      this.target.debugger.on("detach", this.detachListener);
      await this.sendProfilerCommand("Profiler.enable");
      if (this.stopped || !this.debuggerAttached) return;
      await this.startRecording();
    } catch (error) {
      this.detachDebugger();
      this.logger.warn("[pwrsnap:hot-cpu] CPU recorder failed to arm", error);
    }
  }

  private async startRecording(): Promise<void> {
    await this.sendProfilerCommand("Profiler.start");
    if (!this.debuggerAttached || this.stopped) return;
    this.recording = { monotonicMs: this.monotonicNow(), wallTime: this.now().toISOString() };
    // Give the optional recorder its bounded native start before first sampling.
    await this.onEligibilityChanged?.();
  }

  private async finishRecording(): Promise<Profiler.Profile> {
    if (this.recording === null) throw new Error("CPU recorder is not armed");
    this.recording = null;
    const result = await this.sendProfilerCommand("Profiler.stop") as { profile?: Profiler.Profile };
    if (!result.profile?.nodes.length) throw new Error("CPU recorder returned no profile");
    return result.profile;
  }

  private async rotateRecording(): Promise<void> {
    const recording = this.recording!;
    try {
      const profile = await this.finishRecording();
      if (this.stopped || !this.debuggerAttached) return;
      this.previousRecording = { ...recording, profile };
      await this.startRecording();
    } catch (error) {
      this.previousRecording = null;
      this.detachDebugger();
      void this.onEligibilityChanged?.();
      this.logger.warn("[pwrsnap:hot-cpu] CPU recorder failed to rotate", error);
    }
  }

  private async startProfile(options: {
    capturedAt: string;
    capturedAtMs: number;
    cpuPercent: number;
    pid: number;
  }): Promise<void> {
    const recording = this.recording;
    if (recording === null || options.capturedAtMs < recording.monotonicMs) return;

    this.profiling = true;
    this.activeProfileHeapSnapshots = [];
    this.activeProfileTrigger = {
      triggerConsecutiveSamples: this.triggerConsecutiveSamples(),
      triggerCpuPercent: options.cpuPercent,
      triggerMode: this.config.triggerMode,
      triggerThresholdPercent: this.triggerThresholdPercent()
    };
    const index = ++this.profileCount;
    this.lastProfileAtMs = options.capturedAtMs;
    try {
      this.settleCompanion = this.onProfileTriggered?.(
        this.session.createProfilePath(index), options.capturedAtMs, options.capturedAt
      );
    } catch (error) {
      this.logger.warn("[pwrsnap:hot-cpu] companion capture failed to start", error);
    }
    void this.onEligibilityChanged?.();
    this.profileDurationTimer = setTimeout(() => {
      void this.stopProfile("duration-elapsed").catch((error: unknown) => {
        this.logger.warn("[pwrsnap:hot-cpu] CPU profile finalization failed", error);
      });
    }, Math.min(this.config.profileDurationMs, 2_147_483_647));
    const started = this.previousRecording ?? recording;
    if (this.config.captureHeapSnapshot && this.target.takeHeapSnapshot) {
      void this.captureHeapSnapshot(index, "start").catch((error: unknown) => {
        this.logger.warn("[pwrsnap:hot-cpu] start heap snapshot failed", error);
      });
      this.scheduleMidProfileHeapSnapshot(index);
    }

    await this.session.appendEvent({
      capturedAt: options.capturedAt,
      type: "profile-started",
      detail: {
        index,
        cpuPercent: options.cpuPercent,
        triggerMode: this.config.triggerMode,
        triggerThresholdPercent: this.triggerThresholdPercent(),
        triggerConsecutiveSamples: this.triggerConsecutiveSamples(),
        pid: options.pid,
        durationMs: this.config.profileDurationMs,
        recordingStartedAt: started.wallTime,
        preTriggerDurationMs: options.capturedAtMs - started.monotonicMs
      }
    });
    this.logger.warn("[pwrsnap:hot-cpu] CPU profile started", {
      cpuPercent: options.cpuPercent,
      pid: options.pid,
      target: this.session.target,
      sessionDirectory: this.session.directoryPath
    });
  }

  private async stopProfile(reason: string): Promise<void> {
    if (this.stopProfilePromise) {
      await this.stopProfilePromise;
      return;
    }
    if (!this.profiling) return;

    this.stopProfilePromise = this.stopProfileInner(reason);
    try {
      await this.stopProfilePromise;
    } finally {
      this.stopProfilePromise = null;
      this.scheduleNextSample();
    }
  }

  private async stopProfileInner(reason: string): Promise<void> {
    this.profiling = false;
    this.clearProfileDurationTimer();
    this.clearHeapSnapshotMidTimer();
    const index = this.profileCount;
    const profilePath = this.session.createProfilePath(index);
    const profileFilename = artifactFilename(profilePath);
    const activeProfileTrigger =
      this.activeProfileTrigger ?? {
        triggerConsecutiveSamples: this.triggerConsecutiveSamples(),
        triggerCpuPercent: 0,
        triggerMode: this.config.triggerMode,
        triggerThresholdPercent: this.triggerThresholdPercent()
      };

    try {
      const previous = this.previousRecording;
      const current = await this.finishRecording();
      const profile = previous ? joinCpuProfiles([previous.profile, current]) : current;
      const pendingPath = `${profilePath}.pending`;
      try {
        await fs.writeFile(pendingPath, `${JSON.stringify(profile)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.rename(pendingPath, profilePath);
      } finally {
        await fs.rm(pendingPath, { force: true });
      }
      await this.session.registerArtifact(profileFilename);
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-written",
        detail: { filename: profileFilename, reason }
      });

      this.settleProfileCompanion(true);
      if (!this.stopped && this.config.captureHeapSnapshot && this.target.takeHeapSnapshot) {
        await this.drainActiveHeapSnapshotCaptures();
        await this.captureHeapSnapshot(index, "stop");
      }
      await this.drainActiveHeapSnapshotCaptures();
      await this.onProfileWritten?.({
        capturedAt: this.now().toISOString(),
        heapSnapshotArtifacts: [...this.activeProfileHeapSnapshots],
        profileFilename,
        profilePath,
        sessionDirectory: this.session.directoryPath,
        sessionDirectoryName: this.session.directoryName,
        target: this.session.target,
        ...activeProfileTrigger
      });
    } catch (error) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-stop-failed",
        detail: {
          filename: profileFilename,
          reason,
          error: serializeError(error)
        }
      });
      this.logger.error("[pwrsnap:hot-cpu] CPU profile failed to stop", error);
    } finally {
      this.settleProfileCompanion(false);
      this.activeProfileTrigger = null;
      await this.drainActiveHeapSnapshotCaptures();
      this.activeProfileHeapSnapshots = [];
      this.previousRecording = null;
      this.detachDebugger();
      this.resetTriggerSamples();
      this.processBreakdown.reset();
      this.nextSampleAtMs = this.monotonicNow() + this.config.intervalMs;
      await this.ensureRecording();
      void this.onEligibilityChanged?.();
    }
  }

  private settleProfileCompanion(written: boolean): void {
    const settle = this.settleCompanion;
    this.settleCompanion = undefined;
    settle?.(written);
  }

  private resetTriggerSamples(): void {
    this.consecutiveHotSamples = 0;
    this.previousCumulativeCpuSeconds = null;
    this.previousSampleAtMs = null;
  }

  private async captureHeapSnapshot(index: number, phase: string): Promise<void> {
    const capture = this.writeHeapSnapshot(index, phase);
    if (index === this.profileCount) {
      this.activeProfileHeapSnapshotCaptures.add(capture);
    }
    try {
      await capture;
    } finally {
      this.activeProfileHeapSnapshotCaptures.delete(capture);
    }
  }

  private async writeHeapSnapshot(index: number, phase: string): Promise<void> {
    if (!this.target.takeHeapSnapshot) return;

    if (this.heapSnapshotsCaptured >= this.config.heapSnapshotLimit) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-skipped",
        detail: {
          index,
          phase,
          reason: "limit-reached",
          limit: this.config.heapSnapshotLimit
        }
      });
      await this.notifyHeapSnapshotLimitReached();
      return;
    }

    const snapshotNumber = this.heapSnapshotsCaptured + 1;
    this.heapSnapshotsCaptured = snapshotNumber;
    const snapshotPath = this.session.createHeapSnapshotPath(index, phase);
    const snapshotFilename = artifactFilename(snapshotPath);
    try {
      await this.target.takeHeapSnapshot(snapshotPath);
      await this.session.registerArtifact(snapshotFilename);
      if (index === this.profileCount) {
        this.activeProfileHeapSnapshots.push({
          filename: snapshotFilename,
          path: snapshotPath,
          phase
        });
      }
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-written",
        detail: {
          filename: snapshotFilename,
          index,
          phase,
          snapshotNumber,
          limit: this.config.heapSnapshotLimit
        }
      });
    } catch (error) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-failed",
        detail: {
          filename: snapshotFilename,
          index,
          phase,
          snapshotNumber,
          limit: this.config.heapSnapshotLimit,
          error: serializeError(error)
        }
      });
      this.logger.error("[pwrsnap:hot-cpu] heap snapshot failed", error);
    } finally {
      if (this.heapSnapshotsCaptured >= this.config.heapSnapshotLimit) {
        await this.notifyHeapSnapshotLimitReached();
      }
    }
  }

  private async drainActiveHeapSnapshotCaptures(): Promise<void> {
    while (this.activeProfileHeapSnapshotCaptures.size > 0) {
      await Promise.allSettled([...this.activeProfileHeapSnapshotCaptures]);
    }
  }

  private scheduleMidProfileHeapSnapshot(index: number): void {
    if (
      !this.config.captureHeapSnapshot ||
      !this.target.takeHeapSnapshot ||
      this.config.heapSnapshotLimit < 3 ||
      this.heapSnapshotLimitReached
    ) {
      return;
    }

    this.clearHeapSnapshotMidTimer();
    this.heapSnapshotMidTimer = setTimeout(() => {
      this.heapSnapshotMidTimer = null;
      // A blocked start snapshot still owns this target.
      if (this.activeProfileHeapSnapshotCaptures.size === 0) {
        void this.captureHeapSnapshot(index, "mid").catch((error: unknown) => {
          this.logger.warn("[pwrsnap:hot-cpu] mid heap snapshot failed", error);
        });
      }
    }, Math.max(1, Math.floor(Math.min(this.config.profileDurationMs, 2_147_483_647) / 2)));
  }

  private async notifyHeapSnapshotLimitReached(): Promise<void> {
    if (this.heapSnapshotLimitReached) return;

    this.heapSnapshotLimitReached = true;
    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "heap-snapshot-limit-reached",
      detail: {
        captured: this.heapSnapshotsCaptured,
        limit: this.config.heapSnapshotLimit
      }
    });

    try {
      await this.onHeapSnapshotLimitReached?.();
    } catch (error) {
      this.logger.warn("[pwrsnap:hot-cpu] heap snapshot auto-disable failed", {
        error: serializeError(error),
        sessionDirectory: this.session.directoryPath
      });
    }
  }

  private detachDebugger(): void {
    if (this.isTargetDestroyed()) {
      this.debuggerAttached = false;
      return;
    }

    try {
      this.target.debugger.off?.("detach", this.detachListener);
      if (!this.debuggerAttached || !this.target.debugger.isAttached()) return;
      this.target.debugger.detach();
      this.debuggerAttached = false;
    } catch (error) {
      this.debuggerAttached = false;
      this.logger.warn("[pwrsnap:hot-cpu] target debugger detach failed", {
        error: serializeError(error),
        target: this.session.target,
        sessionDirectory: this.session.directoryPath
      });
    }
  }

  private isTargetDestroyed(): boolean {
    return Boolean(this.target.isDestroyed?.());
  }

  private clearProfileDurationTimer(): void {
    if (!this.profileDurationTimer) return;
    clearTimeout(this.profileDurationTimer);
    this.profileDurationTimer = null;
  }

  private clearHeapSnapshotMidTimer(): void {
    if (!this.heapSnapshotMidTimer) return;
    clearTimeout(this.heapSnapshotMidTimer);
    this.heapSnapshotMidTimer = null;
  }
}
