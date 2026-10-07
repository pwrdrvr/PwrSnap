// The repair dialog's wiring: live counts from main, the app picker feeding
// the criteria, and Start handing the batch to the background job.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  EnrichmentRepairCriteria,
  EnrichmentRepairJob,
  EnrichmentRepairPreview
} from "@pwrsnap/shared";

import { EnrichmentRepairDialog } from "../EnrichmentRepairDialog";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const PREVIEW: EnrichmentRepairPreview = {
  total: 12,
  byStatus: { failed: 12, never: 40 },
  apps: [
    { appKey: "com.apple.safari", bundleId: "com.apple.Safari", name: "Safari", count: 8 },
    { appKey: "com.tinyspeck.slackmacgap", bundleId: "com.tinyspeck.slackmacgap", name: "Slack", count: 3 },
    { appKey: "", bundleId: null, name: null, count: 1 }
  ]
};

let container: HTMLDivElement;
let root: Root;
let calls: Array<{ name: string; req: unknown }>;
let onJobChange: ReturnType<typeof vi.fn<(job: EnrichmentRepairJob | null) => void>>;

function job(criteria: EnrichmentRepairCriteria): EnrichmentRepairJob {
  return {
    jobId: "job-1",
    state: "running",
    criteria,
    total: 12,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    concurrency: 1,
    inFlight: [],
    waitingUntil: null,
    stopReason: null,
    startedAt: "2026-10-07T12:00:00.000Z",
    finishedAt: null
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  onJobChange = vi.fn<(job: EnrichmentRepairJob | null) => void>();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: () => () => undefined,
      dispatch: vi.fn(async (name: string, req: { criteria: EnrichmentRepairCriteria }) => {
        calls.push({ name, req });
        if (name === "codex:repair:preview") return { ok: true, value: PREVIEW };
        if (name === "codex:repair:start") return { ok: true, value: job(req.criteria) };
        return { ok: false, error: { kind: "unknown", code: "unexpected", message: name } };
      })
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

async function flushPreview(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(EnrichmentRepairDialog, {
        job: null,
        altModifierLabel: "⌥",
        onJobChange,
        onClose: () => undefined
      })
    );
  });
  await flushPreview();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

function lastCriteria(): EnrichmentRepairCriteria {
  const last = calls.filter((c) => c.name === "codex:repair:preview").at(-1);
  return (last?.req as { criteria: EnrichmentRepairCriteria }).criteria;
}

describe("EnrichmentRepairDialog", () => {
  test("defaults to failed snaps from the last 30 days, across every app", async () => {
    await mount();
    const criteria = lastCriteria();
    expect(criteria.statuses).toEqual(["failed"]);
    expect(criteria.apps).toEqual({ mode: "include", appIds: [] });
    const age = Date.now() - Date.parse(criteria.since!);
    expect(Math.abs(age - 30 * 24 * 60 * 60 * 1000)).toBeLessThan(1_000);
    expect(container.textContent).toContain("Re-run 12 snaps");
    expect(container.textContent).toContain("Unknown app");
  });

  test("clicking apps narrows the batch; ⌥-click excludes", async () => {
    await mount();
    await act(async () => button("Safari").click());
    await act(async () => button("Slack").click());
    await flushPreview();
    expect(lastCriteria().apps).toEqual({
      mode: "include",
      appIds: ["com.apple.safari", "com.tinyspeck.slackmacgap"]
    });
    expect(button("Safari").getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      button("Slack").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    });
    await flushPreview();
    expect(lastCriteria().apps).toEqual({ mode: "exclude", appIds: ["com.tinyspeck.slackmacgap"] });
  });

  test("Never ran joins the batch when ticked", async () => {
    await mount();
    const never = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes("Never ran"));
    await act(async () => never?.querySelector("input")?.click());
    await flushPreview();
    expect(lastCriteria().statuses).toEqual(["failed", "never"]);
  });

  test("Start hands the current criteria to the background job", async () => {
    await mount();
    await act(async () => button("Re-run 12 snaps").click());
    const start = calls.find((c) => c.name === "codex:repair:start");
    expect((start?.req as { criteria: EnrichmentRepairCriteria }).criteria).toEqual(lastCriteria());
    expect(onJobChange).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", state: "running" }));
  });

  test("At a time defaults to one and is sent with the start", async () => {
    await mount();
    expect(container.textContent).toContain("one at a time");
    const four = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "4");
    await act(async () => four?.click());
    expect(container.textContent).toContain("4 at a time");
    await act(async () => button("Re-run 12 snaps").click());
    const start = calls.find((c) => c.name === "codex:repair:start");
    expect((start?.req as { concurrency: number }).concurrency).toBe(4);
  });
});
