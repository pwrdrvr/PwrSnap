import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { EVENT_CHANNELS, type AppUpdateStatus } from "@pwrsnap/shared";
import { AppUpdateBanner } from "../AppUpdateBanner";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

function installFakeApi(initialStatus: AppUpdateStatus): {
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
        if (name === "app:update:status") return { ok: true, value: initialStatus };
        if (name === "app:update:install") return { ok: true, value: { status: "restarting" } };
        return { ok: true, value: undefined };
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
  return {
    calls,
    pushEvent: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    }
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderBanner(initialStatus: AppUpdateStatus = { status: "idle" }): Promise<{
  calls: { name: string; req: unknown }[];
  pushEvent: (channel: string, payload: unknown) => void;
}> {
  const api = installFakeApi(initialStatus);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AppUpdateBanner));
  });
  await act(async () => {
    await Promise.resolve();
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

describe("AppUpdateBanner", () => {
  test("shows failed install recovery and retries the install command", async () => {
    const api = await renderBanner();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "install-failed",
        version: "1.0.0-beta.23",
        currentVersion: "1.0.0-beta.22",
        attemptedAt: "2026-06-29T12:00:00.000Z",
        channel: "prerelease"
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toContain("Update retry needed");
    expect(container?.textContent).toContain("did not finish installing");
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Retry update"
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(api.calls.some((call) => call.name === "app:update:install")).toBe(true);
  });
});
