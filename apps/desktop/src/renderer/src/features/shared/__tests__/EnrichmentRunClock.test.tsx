// The AI run clock: silent for a quick run, ticking once a run passes
// 20s, and a total only for a run this view watched finish.

import { EventEmitter } from "node:events";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type AiRunSnapshot, type AiRunStatus } from "@pwrsnap/shared";
import { createEventSubscriber, LATCHED_EVENT_CHANNELS } from "../../../../../preload/latched-events";
import { EnrichmentRunClock, formatRunDuration, parseRunTimestamp } from "../EnrichmentRunClock";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const START = "2026-10-07 12:00:00";
const START_MS = Date.parse("2026-10-07T12:00:00Z");

function run(status: AiRunStatus, completedAt: string | null = null): AiRunSnapshot {
  return {
    id: "run-1",
    captureId: "cap-1",
    kind: "enrich",
    task: "enrich",
    triggerSource: "auto-enrichment",
    selectedModel: null,
    status,
    error: null,
    latencyMs: null,
    createdAt: START,
    startedAt: START,
    completedAt
  };
}

let container: HTMLDivElement;
let root: Root;
let ipc: EventEmitter;
let stored: AiRunSnapshot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
  ipc = new EventEmitter();
  stored = run("running");
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: createEventSubscriber(ipc, LATCHED_EVENT_CHANNELS),
      dispatch: vi.fn(async (name: string) =>
        name === "codex:runStatus" ? { ok: true, value: stored } : { ok: false, error: { code: "x" } }
      )
    }
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(status: AiRunStatus | null): Promise<void> {
  await act(async () => {
    root.render(createElement(EnrichmentRunClock, { runId: "run-1", status }));
  });
}

const text = (): string => container.textContent ?? "";

describe("formatRunDuration", () => {
  test.each([
    [0, "0s"],
    [8_900, "8s"],
    [95_000, "1m35s"],
    [3_600_000 + 120_000, "1h02m"]
  ])("%i ms → %s", (ms, label) => {
    expect(formatRunDuration(ms)).toBe(label);
  });

  test("reads SQLite's zone-less UTC timestamps as UTC", () => {
    expect(parseRunTimestamp(START)).toBe(START_MS);
  });
});

describe("EnrichmentRunClock", () => {
  test("shows nothing for the first 20s, then a ticking clock", async () => {
    await render("running");
    expect(text()).toBe("");
    await act(async () => vi.advanceTimersByTime(19_000));
    expect(text()).toBe("");
    await act(async () => vi.advanceTimersByTime(76_000));
    expect(text()).toBe("1m35s");
  });

  test("counts from the run's start, not from when the view opened", async () => {
    vi.setSystemTime(START_MS + 42_000);
    await render("running");
    expect(text()).toBe("42s");
  });

  test("shows the total when a watched run finishes, however short", async () => {
    await render("running");
    await act(async () => vi.advanceTimersByTime(5_000));
    stored = run("completed", "2026-10-07 12:00:05");
    await act(async () => {
      ipc.emit(EVENT_CHANNELS.aiRunUpdated, {}, { run: stored, enrichment: null });
    });
    await render("completed");
    expect(text()).toBe("took 5s");
  });

  test("says how long a failed run lasted", async () => {
    await render("queued");
    stored = run("failed", "2026-10-07 12:01:10");
    await render("failed");
    expect(text()).toBe("after 1m10s");
  });

  test("an old finished run that nobody watched shows no total", async () => {
    stored = run("completed", "2026-10-07 12:00:05");
    await render("completed");
    expect(text()).toBe("");
  });
});
