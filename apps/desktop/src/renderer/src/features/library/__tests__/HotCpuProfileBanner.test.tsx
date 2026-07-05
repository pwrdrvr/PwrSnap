import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type HotCpuProfileCapturedEvent } from "@pwrsnap/shared";
import { HotCpuProfileBanner } from "../HotCpuProfileBanner";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };
type DispatchImpl = (name: string, req: unknown) => Promise<AnyResult>;

const event: HotCpuProfileCapturedEvent = {
  capturedAt: "2026-07-04T19:44:18.760Z",
  heapSnapshotArtifacts: [
    {
      filename: "renderer-hot-0001-start.heapsnapshot",
      path: "/diag/hot-cpu-2026-07-04-1543-8f0193/renderer-hot-0001-start.heapsnapshot",
      phase: "start"
    }
  ],
  profileFilename: "renderer-hot-0001.cpuprofile",
  profilePath: "/diag/hot-cpu-2026-07-04-1543-8f0193/renderer-hot-0001.cpuprofile",
  sessionDirectory: "/diag/hot-cpu-2026-07-04-1543-8f0193",
  sessionDirectoryName: "hot-cpu-2026-07-04-1543-8f0193",
  triggerConsecutiveSamples: 2,
  triggerCpuPercent: 104.3,
  triggerMode: "sustained",
  triggerThresholdPercent: 50
};

function installFakeApi(
  resultOrDispatch: AnyResult | DispatchImpl = { ok: true, value: undefined }
): {
  calls: { name: string; req: unknown }[];
  pushEvent: (channel: string, payload: unknown) => void;
} {
  const calls: { name: string; req: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (typeof resultOrDispatch === "function") return resultOrDispatch(name, req);
        return resultOrDispatch;
      },
      on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(handler);
        listeners.set(channel, channelListeners);
        return () => {
          channelListeners.delete(handler);
        };
      }
    }
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) }
  });
  return {
    calls,
    pushEvent: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    }
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderBanner(
  resultOrDispatch?: AnyResult | DispatchImpl
): Promise<ReturnType<typeof installFakeApi>> {
  const api = installFakeApi(resultOrDispatch);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(HotCpuProfileBanner));
  });
  return api;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("HotCpuProfileBanner", () => {
  test("reveals a captured hot CPU session through the diagnostics command", async () => {
    const api = await renderBanner();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.hotCpuProfileCaptured, event);
    });

    expect(container?.textContent).toContain("CPU profile captured");
    expect(container?.textContent).toContain("Reveal");
    const reveal = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Reveal"
    );
    expect(reveal).toBeDefined();

    await act(async () => {
      reveal?.click();
      await Promise.resolve();
    });

    expect(api.calls).toContainEqual({
      name: "diagnostics:revealHotCpuSession",
      req: { sessionDirectoryName: event.sessionDirectoryName }
    });
    expect(container?.textContent).toContain(`Session: ${event.sessionDirectoryName}`);
  });

  test("keeps the banner visible when reveal fails", async () => {
    const api = await renderBanner({
      ok: false,
      error: { message: "session missing" }
    });

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.hotCpuProfileCaptured, event);
    });
    const reveal = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Reveal"
    );

    await act(async () => {
      reveal?.click();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Failed to reveal session: session missing");
    expect(container?.textContent).toContain("CPU profile captured");
  });

  test("ignores late reveal failures after a newer capture replaces the banner", async () => {
    let resolveReveal: ((result: AnyResult) => void) | null = null;
    const revealPromise = new Promise<AnyResult>((resolve) => {
      resolveReveal = resolve;
    });
    const api = await renderBanner(async () => revealPromise);
    const nextEvent: HotCpuProfileCapturedEvent = {
      ...event,
      capturedAt: "2026-07-04T20:44:18.760Z",
      profileFilename: "renderer-hot-0002.cpuprofile",
      sessionDirectory: "/diag/hot-cpu-2026-07-04-1644-9abcde",
      sessionDirectoryName: "hot-cpu-2026-07-04-1644-9abcde"
    };

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.hotCpuProfileCaptured, event);
    });
    const reveal = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Reveal"
    );

    await act(async () => {
      reveal?.click();
      await Promise.resolve();
    });
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.hotCpuProfileCaptured, nextEvent);
    });
    await act(async () => {
      resolveReveal?.({ ok: false, error: { message: "old session missing" } });
      await revealPromise;
    });

    expect(container?.textContent).toContain(`Session: ${nextEvent.sessionDirectoryName}`);
    expect(container?.textContent).not.toContain("old session missing");
  });
});
