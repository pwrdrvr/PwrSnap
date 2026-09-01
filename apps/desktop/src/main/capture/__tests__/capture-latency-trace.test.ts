import { describe, expect, test } from "vitest";
import type { CaptureInvocation } from "@pwrsnap/shared";
import {
  CAPTURE_LATENCY_STAGES,
  CaptureLatencyTrace,
  type CaptureLatencyOutcome
} from "../capture-latency-trace";

type LogEntry = { message: string; fields: Record<string, unknown> };

const INVOCATION: CaptureInvocation = {
  id: "trace-12345678",
  origin: "tray.window",
  triggerMonotonicMs: 100,
  dispatchMonotonicMs: 102,
  triggerWallTime: "2026-09-01T12:00:00.000Z"
};

describe("CaptureLatencyTrace", () => {
  test("pins the production stage vocabulary", () => {
    expect(CAPTURE_LATENCY_STAGES).toEqual([
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
    ]);
  });

  test("uses monotonic durations, clamps event order, and emits one compact summary", () => {
    const entries: LogEntry[] = [];
    const clock = [110, 125, 120, 140];
    const trace = new CaptureLatencyTrace(INVOCATION, "window", {
      monotonicNow: () => clock.shift() ?? 140,
      wallNow: () => "2099-01-01T00:00:00.000Z",
      logger: { info: (message, fields) => entries.push({ message, fields }) }
    });

    const permission = trace.begin("permission_preflight");
    trace.end(permission, { outcome: "granted" });
    trace.mark("settings_read", { outcome: "ready" });
    trace.finish("presented", { generation: 4 });
    trace.finish("error", { code: "must_be_ignored" });

    const stages = entries
      .filter((entry) => entry.fields.event === "capture_latency_stage")
      .map((entry) => entry.fields);
    expect(stages.map((entry) => entry.stage)).toEqual([
      "trigger_callback",
      "dispatch_start",
      "permission_preflight",
      "settings_read"
    ]);
    expect(stages.map((entry) => entry.elapsedMs)).toEqual([0, 2, 25, 25]);
    expect(stages[2]?.durationMs).toBe(15);
    expect(stages.every((entry) => entry.wallTime === "2099-01-01T00:00:00.000Z")).toBe(
      true
    );

    const summaries = entries.filter(
      (entry) => entry.fields.event === "capture_latency_summary"
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.fields).toMatchObject({
      invocationId: INVOCATION.id,
      origin: INVOCATION.origin,
      mode: "window",
      outcome: "presented",
      totalDurationMs: 40,
      generation: 4,
      slowestStages: [
        { stage: "permission_preflight", durationMs: 15 },
        { stage: "dispatch_start", durationMs: 2 }
      ]
    });
  });

  test.each<CaptureLatencyOutcome>(["presented", "cancel", "error", "destroy"])(
    "emits a terminal %s summary",
    (outcome) => {
      const entries: LogEntry[] = [];
      const trace = new CaptureLatencyTrace(INVOCATION, "auto", {
        monotonicNow: () => 130,
        wallNow: () => "2026-09-01T12:00:01.000Z",
        logger: { info: (message, fields) => entries.push({ message, fields }) }
      });

      trace.finish(outcome, { reason: "fixture" });

      expect(entries.at(-1)?.fields).toMatchObject({
        event: "capture_latency_summary",
        outcome,
        reason: "fixture",
        totalDurationMs: 30
      });
    }
  );

  test("closes concurrent stages at the terminal boundary without waiting for them", () => {
    const entries: LogEntry[] = [];
    const samples = [110, 135];
    const trace = new CaptureLatencyTrace(INVOCATION, "auto", {
      monotonicNow: () => samples.shift() ?? 135,
      wallNow: () => "2026-09-01T12:00:01.000Z",
      logger: { info: (message, fields) => entries.push({ message, fields }) }
    });

    trace.begin("native_window_enumeration");
    trace.finish("presented");

    expect(
      entries.find(
        (entry) => entry.fields.stage === "native_window_enumeration"
      )?.fields
    ).toMatchObject({
      outcome: "in_progress_at_terminal",
      durationMs: 25,
      elapsedMs: 35
    });
    expect(entries.at(-1)?.fields).toMatchObject({
      event: "capture_latency_summary",
      outcome: "presented",
      totalDurationMs: 35
    });
  });
});
