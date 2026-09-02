import type { CaptureInvocation } from "@pwrsnap/shared";
import { performance } from "node:perf_hooks";
import { getMainLogger } from "../log";

export type CaptureLatencyOutcome = "presented" | "cancel" | "error" | "destroy";

export const CAPTURE_LATENCY_STAGES = [
  "trigger_callback",
  "dispatch_start",
  "dispatch_receive",
  "permission_preflight",
  "storage_readiness",
  "timed_countdown",
  "settings_read",
  "cursor_sample",
  "cursor_sampling_budget",
  "shared_session",
  "selector_prewarm_load",
  "target_display_resolution",
  "pwrsnap_chrome_protection",
  "native_window_enumeration",
  "screen_frame_acquisition",
  "renderer_signal_receipt",
  "frozen_source_decode_ready",
  "browser_window_present_calls",
  "first_visible_paint_ack"
] as const;

export type CaptureLatencyStage = (typeof CAPTURE_LATENCY_STAGES)[number];

type CaptureLatencyFields = Record<
  string,
  string | number | boolean | null | undefined
>;

type CaptureLatencyLogger = {
  info(message: string, fields: Record<string, unknown>): void;
};

export type CaptureLatencyStageToken = {
  readonly stage: CaptureLatencyStage;
  readonly startedAtMonotonicMs: number;
};

type StageRecord = {
  stage: CaptureLatencyStage;
  elapsedMs: number;
  durationMs: number;
  wallTime: string;
  fields: CaptureLatencyFields;
};

const defaultLogger = getMainLogger("pwrsnap:capture-latency");

function compactMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

/**
 * Per-invocation diagnostic recorder. All intervals come from the Performance
 * clock; ISO wall time appears only so an operator can correlate the entry with
 * OS/native-helper logs. Stage completion order is clamped nondecreasing to
 * protect summaries from sub-millisecond cross-process clock-origin skew.
 * Stage records stay in memory until finish(), so durable synchronous logging
 * cannot perturb the trigger-to-presentation interval being measured.
 */
export class CaptureLatencyTrace {
  private readonly stages: StageRecord[] = [];
  private readonly activeStages = new Set<CaptureLatencyStageToken>();
  private lastEventAtMonotonicMs: number;
  private finished = false;

  constructor(
    readonly invocation: CaptureInvocation,
    readonly mode: "auto" | "region" | "window" | "timed",
    private readonly deps: {
      monotonicNow?: () => number;
      wallNow?: () => string;
      logger?: CaptureLatencyLogger;
    } = {}
  ) {
    this.lastEventAtMonotonicMs = invocation.triggerMonotonicMs;
    this.recordAt("trigger_callback", invocation.triggerMonotonicMs, 0, {
      source: invocation.origin
    });
    this.recordAt(
      "dispatch_start",
      invocation.dispatchMonotonicMs,
      invocation.dispatchMonotonicMs - invocation.triggerMonotonicMs
    );
  }

  isFinished(): boolean {
    return this.finished;
  }

  mark(stage: CaptureLatencyStage, fields: CaptureLatencyFields = {}): void {
    if (this.finished) return;
    this.recordAt(stage, this.now(), 0, fields);
  }

  begin(stage: CaptureLatencyStage): CaptureLatencyStageToken {
    const token = { stage, startedAtMonotonicMs: this.now() };
    if (!this.finished) this.activeStages.add(token);
    return token;
  }

  end(token: CaptureLatencyStageToken, fields: CaptureLatencyFields = {}): void {
    if (this.finished) return;
    this.activeStages.delete(token);
    const endedAt = this.now();
    this.recordAt(
      token.stage,
      endedAt,
      endedAt - token.startedAtMonotonicMs,
      fields
    );
  }

  finish(outcome: CaptureLatencyOutcome, fields: CaptureLatencyFields = {}): void {
    if (this.finished) return;
    const endedAt = Math.max(this.lastEventAtMonotonicMs, this.now());
    for (const token of this.activeStages) {
      this.recordAt(
        token.stage,
        endedAt,
        endedAt - token.startedAtMonotonicMs,
        { outcome: "in_progress_at_terminal" }
      );
    }
    this.activeStages.clear();
    this.finished = true;
    const terminalWallTime = this.wallNow();
    const totalDurationMs = compactMs(
      endedAt - this.invocation.triggerMonotonicMs
    );
    const slowestStages = [...this.stages]
      .filter((stage) => stage.durationMs > 0)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map(({ stage, durationMs }) => ({ stage, durationMs }));
    const logger = this.logger();
    for (const stage of this.stages) {
      logger.info("capture latency stage", {
        event: "capture_latency_stage",
        invocationId: this.invocation.id,
        origin: this.invocation.origin,
        mode: this.mode,
        wallTime: stage.wallTime,
        triggerWallTime: this.invocation.triggerWallTime,
        stage: stage.stage,
        elapsedMs: stage.elapsedMs,
        durationMs: stage.durationMs,
        ...stage.fields
      });
    }
    logger.info("capture latency summary", {
      event: "capture_latency_summary",
      invocationId: this.invocation.id,
      origin: this.invocation.origin,
      mode: this.mode,
      outcome,
      wallTime: terminalWallTime,
      triggerWallTime: this.invocation.triggerWallTime,
      totalDurationMs,
      stageCount: this.stages.length,
      slowestStages,
      ...fields
    });
  }

  private recordAt(
    stage: CaptureLatencyStage,
    requestedAtMonotonicMs: number,
    requestedDurationMs: number,
    fields: CaptureLatencyFields = {}
  ): void {
    const atMonotonicMs = Math.max(
      this.lastEventAtMonotonicMs,
      requestedAtMonotonicMs
    );
    this.lastEventAtMonotonicMs = atMonotonicMs;
    const record: StageRecord = {
      stage,
      elapsedMs: compactMs(
        atMonotonicMs - this.invocation.triggerMonotonicMs
      ),
      durationMs: compactMs(requestedDurationMs),
      wallTime: this.wallNow(),
      fields
    };
    this.stages.push(record);
  }

  private now(): number {
    return (this.deps.monotonicNow ?? (() => performance.timeOrigin + performance.now()))();
  }

  private wallNow(): string {
    return (this.deps.wallNow ?? (() => new Date().toISOString()))();
  }

  private logger(): CaptureLatencyLogger {
    return this.deps.logger ?? defaultLogger;
  }
}
