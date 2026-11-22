// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { BurstSessionView } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => mocks.dispatch(...args)
}));

import { BurstReview, readBurstId } from "../BurstReview";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement;
let root: Root;

function view(overrides: Partial<BurstSessionView> = {}): BurstSessionView {
  // Five stills; a 0.9 s still screen between the 3rd and 4th.
  const offsets = [0, 100, 200, 1100, 1200];
  return {
    burstId: "burst-abc123",
    frames: offsets.map((offsetMs, i) => ({
      index: 10 + i,
      capturedAt: new Date(Date.UTC(2026, 10, 21, 9, 15, 30) + offsetMs).toISOString(),
      offsetMs,
      widthPx: 800,
      heightPx: 600,
      url: `pwrsnap-screen://b/burst-abc123/${10 + i}`,
      thumbUrl: `pwrsnap-screen://b/burst-abc123/${10 + i}/thumb`
    })),
    evictedFrames: 0,
    droppedFrames: 0,
    keptIndexes: [],
    sourceAppName: "Cereal Mixer",
    devicePixelRatio: 2,
    ...overrides
  };
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(BurstReview, { burstId: "burst-abc123" }));
  });
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (testId: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const chosen = () => $$("burst-thumb").filter((t) => t.dataset.chosen === "true").map((t) => Number(t.dataset.index));
const current = () => Number(container.querySelector<HTMLElement>('[aria-current="true"]')?.dataset.index);

beforeEach(() => {
  mocks.dispatch.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("BurstReview", () => {
  test("reads the burst id from the hash and nothing else", () => {
    expect(readBurstId("#stage=burst-review&burst=abcDEF_12-")).toBe("abcDEF_12-");
    expect(readBurstId("#stage=burst-review&burst=../x")).toBeNull();
    expect(readBurstId("#stage=burst-review")).toBeNull();
  });

  test("opens on the newest still, marks the still gap, and keeps what the keys chose", async () => {
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "burst:get") return { ok: true, value: view() };
      if (channel === "burst:keep") return { ok: true, value: { captureIds: ["a", "b", "c"] } };
      throw new Error(`unexpected ${channel}`);
    });
    await mount();

    expect(current()).toBe(14);
    expect($("burst-stage-img")?.getAttribute("src")).toBe("pwrsnap-screen://b/burst-abc123/14");
    // The strip draws thumbnails, never the full stills.
    expect($$("burst-thumb").map((t) => t.querySelector("img")?.getAttribute("src"))).toEqual(
      [10, 11, 12, 13, 14].map((i) => `pwrsnap-screen://b/burst-abc123/${i}/thumb`)
    );
    expect($$("burst-gap")).toHaveLength(1);
    expect($("burst-keep")).toHaveProperty("disabled", true);

    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(current()).toBe(12);
    await press(" ");
    expect(chosen()).toEqual([12]);
    await press("ArrowLeft", { shiftKey: true });
    await press("ArrowLeft", { shiftKey: true });
    expect(chosen()).toEqual([10, 11, 12]);
    expect($("burst-chosen-count")?.textContent).toBe("3 of 5");
    // The preview label counts from the first CHOSEN still (10), so 12 is +0.200 s.
    await press("ArrowRight");
    await press("ArrowRight");
    expect($("burst-stamp-preview")?.textContent).toMatch(/\(\+0\.200 s\)$/);

    await press("Enter", { metaKey: true });
    expect(mocks.dispatch).toHaveBeenCalledWith("burst:keep", {
      burstId: "burst-abc123",
      frameIndexes: [10, 11, 12],
      stampTime: true,
      pointer: true
    });
  });

  test("A chooses everything keepable, then nothing", async () => {
    mocks.dispatch.mockResolvedValue({ ok: true, value: view({ keptIndexes: [11] }) });
    await mount();
    await press("a");
    expect(chosen()).toEqual([10, 12, 13, 14]);
    await press("a");
    expect(chosen()).toEqual([]);
  });

  test("a keep that fails part way says so and shows what did land", async () => {
    let gets = 0;
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "burst:get") {
        gets += 1;
        return { ok: true, value: gets === 1 ? view() : view({ keptIndexes: [13] }) };
      }
      if (channel === "burst:keep") {
        return { ok: false, error: { kind: "persistence", code: "disk_full", message: "The disk is full" } };
      }
      throw new Error(`unexpected ${channel}`);
    });
    await mount();
    await press(" "); // 14
    await press("ArrowLeft");
    await press(" "); // 13
    await act(async () => {
      $("burst-keep")!.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The disk is full");
    const kept = $$("burst-thumb").filter((t) => t.dataset.kept === "true").map((t) => Number(t.dataset.index));
    expect(kept).toEqual([13]);
    // 13 is a snap now; only 14 is still waiting to be kept.
    expect(chosen()).toEqual([14]);
    expect($("burst-keep")?.textContent).toBe("Keep 1 snap");
  });

  test("Discard all asks once more before deleting", async () => {
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "burst:get") return { ok: true, value: view() };
      if (channel === "burst:discard") return { ok: true, value: undefined };
      throw new Error(`unexpected ${channel}`);
    });
    await mount();
    await act(async () => {
      $("burst-discard")!.click();
    });
    expect(mocks.dispatch).not.toHaveBeenCalledWith("burst:discard", expect.anything());
    expect($("burst-discard")?.textContent).toBe("Discard 5 stills?");
    await act(async () => {
      $("burst-discard")!.click();
    });
    expect(mocks.dispatch).toHaveBeenCalledWith("burst:discard", { burstId: "burst-abc123" });
  });

  test("the pointer is drawn over the still where it was, and the toggle hides it and leaves it off the snaps", async () => {
    const pointer = { url: "pwrsnap-screen://b/burst-abc123/pointer/0", left: 0.25, top: 0.5, width: 0.02, height: 0.04 };
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "burst:get") {
        const v = view();
        // Only the newest still (14) had the pointer over it.
        v.frames[4] = { ...v.frames[4]!, pointer };
        return { ok: true, value: v };
      }
      if (channel === "burst:keep") return { ok: true, value: { captureIds: ["a"] } };
      throw new Error(`unexpected ${channel}`);
    });
    await mount();
    const drawn = $("burst-stage-pointer");
    expect(drawn?.getAttribute("src")).toBe(pointer.url);
    expect(drawn?.style.left).toBe("25%");
    expect(drawn?.style.top).toBe("50%");
    expect(drawn?.style.width).toBe("2%");
    expect(drawn?.style.height).toBe("4%");
    // The stage box carries the still's own aspect ratio for the overlay.
    expect(drawn?.parentElement?.style.getPropertyValue("--ps-burst-ar")).toBe(String(800 / 600));

    await press("ArrowLeft"); // 13: no pointer over it
    expect($("burst-stage-pointer")).toBeNull();
    await press("ArrowRight");
    expect($("burst-stage-pointer")).not.toBeNull();

    await act(async () => {
      $("burst-pointer")!.click();
    });
    expect($("burst-stage-pointer")).toBeNull();
    await press(" ");
    await press("Enter", { metaKey: true });
    expect(mocks.dispatch).toHaveBeenCalledWith("burst:keep", {
      burstId: "burst-abc123",
      frameIndexes: [14],
      stampTime: true,
      pointer: false
    });
  });

  test("a burst without a tracked pointer offers no pointer toggle", async () => {
    mocks.dispatch.mockResolvedValue({ ok: true, value: view() });
    await mount();
    expect($("burst-pointer")).toBeNull();
    expect($("burst-stage-pointer")).toBeNull();
  });

  test("a burst that already ended says so", async () => {
    mocks.dispatch.mockResolvedValue({
      ok: false,
      error: { kind: "validation", code: "burst_not_found", message: "gone" }
    });
    await mount();
    expect(container.textContent).toContain("This burst has ended");
  });
});
