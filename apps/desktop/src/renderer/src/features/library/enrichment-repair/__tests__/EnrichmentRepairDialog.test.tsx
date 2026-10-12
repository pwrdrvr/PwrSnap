// The repair dialog's wiring: live counts from main, the token line feeding
// the criteria, Start handing the batch to the background job, and the
// running and outcome views drawn from the job main broadcasts.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  EnrichmentRepairCriteria,
  EnrichmentRepairJob,
  EnrichmentRepairOpenRequest,
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

const WIDER: EnrichmentRepairPreview = { total: 9, byStatus: { failed: 9, never: 0 }, apps: [] };

let container: HTMLDivElement;
let root: Root;
let calls: Array<{ name: string; req: unknown }>;
let preview: EnrichmentRepairPreview;
let onJobChange: ReturnType<typeof vi.fn<(job: EnrichmentRepairJob | null) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let onEnableAi: ReturnType<typeof vi.fn<() => void>>;

function job(criteria: EnrichmentRepairCriteria, overrides: Partial<EnrichmentRepairJob> = {}): EnrichmentRepairJob {
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
    finishedAt: null,
    ...overrides
  };
}

const ALL_FAILED: EnrichmentRepairCriteria = {
  statuses: ["failed"],
  since: null,
  until: null,
  apps: { mode: "include", appIds: [] }
};

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  preview = PREVIEW;
  onJobChange = vi.fn<(job: EnrichmentRepairJob | null) => void>();
  onClose = vi.fn<() => void>();
  onEnableAi = vi.fn<() => void>();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: () => () => undefined,
      dispatch: vi.fn(async (name: string, req: { criteria: EnrichmentRepairCriteria; jobId?: string }) => {
        calls.push({ name, req });
        if (name === "codex:repair:preview") {
          // The all-time view (no lower bound) has more to offer.
          return { ok: true, value: req.criteria.since === null && preview.total === 0 ? WIDER : preview };
        }
        if (name === "codex:repair:start") return { ok: true, value: job(req.criteria) };
        if (name === "codex:repair:cancel") {
          return { ok: true, value: job(ALL_FAILED, { state: "cancelled", finishedAt: "2026-10-07T12:01:00.000Z" }) };
        }
        if (name === "codex:repair:dismiss") return { ok: true, value: undefined };
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

async function mount(
  props: {
    job?: EnrichmentRepairJob | null;
    request?: EnrichmentRepairOpenRequest;
    aiEnabled?: boolean;
  } = {}
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(EnrichmentRepairDialog, {
        job: props.job ?? null,
        request: props.request,
        providerLabel: "Codex",
        aiEnabled: props.aiEnabled ?? true,
        altModifierLabel: "⌥",
        onJobChange,
        onEnableAi,
        onClose
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

function appRow(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".ps-repair-app")].find((b) =>
    b.textContent?.includes(name)
  );
  if (found === undefined) throw new Error(`no app row ${name}`);
  return found;
}

function token(prefix: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`.ps-repair-tok[aria-label^="${prefix}:"]`);
  if (found === null) throw new Error(`no token ${prefix}`);
  return found;
}

/** A pointer click on a popover option (keyboard-made clicks have detail 0). */
async function pick(label: string): Promise<void> {
  const option = [...container.querySelectorAll("label.ps-repair-opt")].find((l) => l.textContent?.includes(label));
  if (option === undefined) throw new Error(`no option ${label}`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

function previews(): EnrichmentRepairCriteria[] {
  return calls
    .filter((c) => c.name === "codex:repair:preview")
    .map((c) => (c.req as { criteria: EnrichmentRepairCriteria }).criteria);
}

function lastCriteria(): EnrichmentRepairCriteria {
  return previews().at(-1)!;
}

describe("EnrichmentRepairDialog — set up", () => {
  test("defaults to failed snaps from the last 30 days, across every app", async () => {
    await mount();
    const criteria = lastCriteria();
    expect(criteria.statuses).toEqual(["failed"]);
    expect(criteria.apps).toEqual({ mode: "include", appIds: [] });
    const age = Date.now() - Date.parse(criteria.since!);
    expect(Math.abs(age - 30 * 24 * 60 * 60 * 1000)).toBeLessThan(1_000);
    expect(container.textContent).toContain("Re-run 12 snaps");
    expect(container.textContent).toContain("Reads with Codex");
    expect(token("Captured").textContent).toBe("in the last 30 days");
    expect(token("At a time").textContent).toBe("one at a time");
    // Both tiles count, whichever is ticked.
    const tiles = [...container.querySelectorAll(".ps-repair-tile__n")].map((n) => n.textContent);
    expect(tiles).toEqual(["12", "40"]);
  });

  test("picking apps narrows the batch; ⌥-click excludes", async () => {
    await mount();
    await act(async () => token("Apps").click());
    expect(container.textContent).toContain("Unknown app");
    await act(async () => appRow("Safari").click());
    await act(async () => appRow("Slack").click());
    await flushPreview();
    expect(lastCriteria().apps).toEqual({
      mode: "include",
      appIds: ["com.apple.safari", "com.tinyspeck.slackmacgap"]
    });
    expect(appRow("Safari").getAttribute("aria-pressed")).toBe("true");
    expect(token("Apps").textContent).toBe("Safari and Slack");

    await act(async () => {
      appRow("Slack").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    });
    await flushPreview();
    expect(lastCriteria().apps).toEqual({ mode: "exclude", appIds: ["com.tinyspeck.slackmacgap"] });
    expect(token("Apps").textContent).toBe("all but Slack");
  });

  test("the window popover counts each preset, and picking one closes it", async () => {
    await mount();
    await act(async () => token("Captured").click());
    await flushPreview();
    // One preview per preset, with the tiles' statuses.
    expect(previews().filter((c) => c.statuses.join() === "failed").length).toBeGreaterThanOrEqual(6);
    expect(container.querySelector(".ps-repair-pop--when")?.textContent).toContain("12");
    await pick("Last 24 hours");
    expect(container.querySelector(".ps-repair-pop--when")).toBeNull();
    expect(token("Captured").textContent).toBe("in the last 24 hours");
  });

  test("Escape closes the open popover, not the dialog", async () => {
    await mount();
    await act(async () => token("At a time").click());
    expect(container.querySelector(".ps-repair-pop--pace")).not.toBeNull();
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".ps-repair-pop--pace")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a picked app that drops to zero in a narrower window keeps its name", async () => {
    await mount();
    await act(async () => token("Apps").click());
    await act(async () => appRow("Safari").click());
    preview = { ...PREVIEW, total: 0, apps: PREVIEW.apps.filter((app) => app.name !== "Safari") };
    await act(async () => token("Captured").click());
    await pick("Last 24 hours");
    await flushPreview();
    await act(async () => token("Apps").click());
    expect(appRow("Safari").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).not.toContain("com.apple.safari");
  });

  test("Never ran joins the batch when ticked", async () => {
    await mount();
    const never = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes("Never ran"));
    await act(async () => never?.querySelector("input")?.click());
    await flushPreview();
    expect(lastCriteria().statuses).toEqual(["failed", "never"]);
  });

  test("with neither tile ticked there is nothing to start", async () => {
    await mount();
    const failed = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes("Failed"));
    await act(async () => failed?.querySelector("input")?.click());
    await flushPreview();
    // Still counts both, for the tiles.
    expect(lastCriteria().statuses).toEqual(["failed", "never"]);
    expect(container.textContent).toContain("Pick Failed, Never ran, or both.");
    expect(container.textContent).not.toContain("Re-run 12");
  });

  test("Start hands the current criteria to the background job", async () => {
    await mount();
    await act(async () => button("Re-run 12 snaps").click());
    const start = calls.find((c) => c.name === "codex:repair:start");
    const sent = (start!.req as { criteria: EnrichmentRepairCriteria }).criteria;
    const shown = lastCriteria();
    expect({ ...sent, since: null }).toEqual({ ...shown, since: null });
    // The 30-day window is re-anchored to the moment Start is pressed.
    expect(Date.parse(sent.since!)).toBe(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(onJobChange).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", state: "running" }));
  });

  test("pace defaults to one at a time and is sent with the start", async () => {
    await mount();
    await act(async () => token("At a time").click());
    await pick("4 at a time");
    expect(token("At a time").textContent).toBe("4 at a time");
    await act(async () => button("Re-run 12 snaps").click());
    const start = calls.find((c) => c.name === "codex:repair:start");
    expect((start!.req as { concurrency: number }).concurrency).toBe(4);
  });

  test("a request from elsewhere sets the statuses and window", async () => {
    await mount({ request: { statuses: ["never"], window: "all" } });
    const criteria = lastCriteria();
    expect(criteria.statuses).toEqual(["never"]);
    expect(criteria.since).toBeNull();
    expect(token("Captured").textContent).toBe("at any time");
  });

  test("nothing in range offers what older snaps still have", async () => {
    preview = { total: 0, byStatus: { failed: 0, never: 0 }, apps: [] };
    await mount();
    await flushPreview();
    expect(container.textContent).toContain("No failed snaps captured in the last 30 days.");
    const chip = button("All time");
    expect(chip.textContent).toContain("9");
    await act(async () => chip.click());
    await flushPreview();
    expect(lastCriteria().since).toBeNull();
    expect(container.textContent).toContain("Re-run 9 snaps");
  });
});

describe("EnrichmentRepairDialog — running", () => {
  const running = job(ALL_FAILED, {
    total: 42,
    processed: 18,
    succeeded: 16,
    failed: 1,
    skipped: 1,
    inFlight: [{ captureId: "c", startedAt: new Date().toISOString() }]
  });

  test("shows the count, the split and the live line", async () => {
    await mount({ job: running });
    expect(container.querySelector("#ps-repair-title")?.textContent).toBe("Re-running AI");
    expect(container.querySelector(".ps-repair-big")?.textContent).toContain("18/ 42");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42");
    expect(container.textContent).toContain("16 fixed");
    expect(container.textContent).toContain("1 failed again");
    expect(container.textContent).toContain("Reading a snap");
    expect(calls.some((c) => c.name === "codex:repair:preview")).toBe(false);
  });

  test("Run in background closes; Stop cancels the job", async () => {
    await mount({ job: running });
    await act(async () => button("Run in background").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => button("Stop").click());
    expect(calls.find((c) => c.name === "codex:repair:cancel")?.req).toEqual({ jobId: "job-1" });
    expect(onJobChange).toHaveBeenCalledWith(expect.objectContaining({ state: "cancelled" }));
  });
});

describe("EnrichmentRepairDialog — between views", () => {
  test("Start moves focus to the dialog's close button, not to the page", async () => {
    await mount();
    const start = button("Re-run 12 snaps");
    start.focus();
    await act(async () => start.click());
    await act(async () => {
      root.render(
        createElement(EnrichmentRepairDialog, {
          job: job(ALL_FAILED),
          providerLabel: "Codex",
          aiEnabled: true,
          altModifierLabel: "⌥",
          onJobChange,
          onEnableAi,
          onClose
        })
      );
    });
    expect(container.querySelector("#ps-repair-title")?.textContent).toBe("Re-running AI");
    expect(document.activeElement).toBe(container.querySelector(".ps-repair__x"));
  });

  test("opened to set up while a job runs, it ends on that job's outcome", async () => {
    const render = async (current: EnrichmentRepairJob): Promise<void> => {
      await act(async () => {
        root.render(
          createElement(EnrichmentRepairDialog, {
            job: current,
            request: { statuses: ["failed"], window: "all" },
            providerLabel: "Codex",
            aiEnabled: true,
            altModifierLabel: "⌥",
            onJobChange,
            onEnableAi,
            onClose
          })
        );
      });
    };
    await render(job(ALL_FAILED));
    expect(container.querySelector("#ps-repair-title")?.textContent).toBe("Re-running AI");
    await render(
      job(ALL_FAILED, { state: "completed", processed: 12, succeeded: 12, finishedAt: "2026-10-07T12:02:00.000Z" })
    );
    expect(container.querySelector(".ps-repair-out__t")?.textContent).toBe("All 12 fixed");
  });
});

describe("EnrichmentRepairDialog — outcome", () => {
  const finished = {
    total: 42,
    processed: 42,
    succeeded: 38,
    failed: 3,
    skipped: 1,
    finishedAt: "2026-10-07T12:14:00.000Z"
  };

  test("a clean run says so, and Done dismisses it", async () => {
    await mount({ job: job(ALL_FAILED, { ...finished, state: "completed", succeeded: 42, failed: 0, skipped: 0 }) });
    expect(container.querySelector(".ps-repair-out__t")?.textContent).toBe("All 42 fixed");
    expect(container.textContent).toContain("Finished in 14 min.");
    expect(calls.some((c) => c.name === "codex:repair:preview")).toBe(false);
    await act(async () => button("Done").click());
    expect(calls.find((c) => c.name === "codex:repair:dismiss")?.req).toEqual({ jobId: "job-1" });
    expect(onJobChange).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalled();
  });

  test("a mixed run offers to re-run what failed again, at the same pace", async () => {
    preview = { total: 3, byStatus: { failed: 3, never: 0 }, apps: [] };
    await mount({ job: job(ALL_FAILED, { ...finished, state: "completed", concurrency: 2 }) });
    expect(container.querySelector(".ps-repair-out__t")?.textContent).toBe("38 of 42 fixed");
    expect(container.textContent).toContain("3 failed again");
    expect(container.textContent).toContain("1 was skipped");
    expect(lastCriteria().statuses).toEqual(["failed"]);
    await act(async () => button("Re-run 3 failed").click());
    const start = calls.find((c) => c.name === "codex:repair:start")!.req as {
      criteria: EnrichmentRepairCriteria;
      concurrency: number;
    };
    expect(start.criteria.statuses).toEqual(["failed"]);
    expect(start.concurrency).toBe(2);
  });

  test("a paused run with AI off offers to turn AI back on", async () => {
    await mount({
      job: job(ALL_FAILED, { ...finished, processed: 18, state: "stopped", stopReason: "AI enrichment was turned off." }),
      aiEnabled: false
    });
    expect(container.querySelector(".ps-repair-out__t")?.textContent).toBe("Paused: AI enrichment was turned off");
    await act(async () => button("Turn on AI").click());
    expect(onEnableAi).toHaveBeenCalledTimes(1);
  });

  test("Re-run other snaps goes back to set up", async () => {
    await mount({ job: job(ALL_FAILED, { ...finished, state: "completed", succeeded: 42, failed: 0, skipped: 0 }) });
    await act(async () => button("Re-run other snaps").click());
    await flushPreview();
    expect(onJobChange).toHaveBeenCalledWith(null);
    expect(container.querySelector(".ps-repair-tiles")).not.toBeNull();
  });
});
