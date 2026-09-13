import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  type AppUpdateCheckResult,
  type AppUpdateStatus
} from "@pwrsnap/shared";
import { AppUpdateBanner, UPDATE_OUTCOME_DISMISS_MS } from "../AppUpdateBanner";

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
  vi.useRealTimers();
});

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll("button") ?? []).find(
    (el) => el.textContent === label
  );
}

function progressBar(): HTMLElement | null {
  return container?.querySelector("[role='progressbar']") ?? null;
}

function timerStrip(): HTMLElement | null {
  return container?.querySelector(".app-update-banner__timer") ?? null;
}

/** One `checking` tick on the user-initiated channel — the only thing that
 *  raises the live card. */
async function startMenuCheck(api: {
  pushEvent: (channel: string, payload: unknown) => void;
}): Promise<void> {
  await act(async () => {
    api.pushEvent(EVENT_CHANNELS.appUpdateCheckResult, {
      status: "checking"
    } satisfies AppUpdateCheckResult);
  });
}

describe("AppUpdateBanner", () => {
  test("shows failed install recovery and retries the install command", async () => {
    const api = await renderBanner();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "install-failed",
        version: "1.0.0-beta.23",
        currentVersion: "1.0.0-beta.22",
        attemptedAt: "2026-06-29T12:00:00.000Z",
        channel: "prerelease",
        train: "stable"
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
  // A downgrade back to the selected train is not an update. Reading
  // "Restart to update to v1.0.1" while running 1.1.0-alpha.2 looks like
  // the app got the version wrong.
  test("words a downloaded downgrade as a switch", async () => {
    const api = await renderBanner();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloaded",
        version: "1.0.1",
        downgrade: true
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toContain("Switch ready");
    expect(container?.textContent).toContain("Restart to switch to v1.0.1.");
    expect(container?.textContent).not.toContain("Restart to update");
  });

  test("still words an ordinary downloaded update as an update", async () => {
    const api = await renderBanner();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloaded",
        version: "1.0.2"
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toContain("Update ready");
    expect(container?.textContent).toContain("Restart to update to v1.0.2.");
  });

  test("reports a menu check live, on a progress track and no countdown", async () => {
    const api = await renderBanner();

    await startMenuCheck(api);

    // The `checking` tick outruns the status event it mirrors, and the
    // release read behind it takes seconds — so the card must be on screen
    // before the status channel has moved at all.
    expect(container?.textContent).toContain("Checking for updates");
    expect(progressBar()).not.toBeNull();
    // An indeterminate sweep, because there is no percent to draw yet.
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe(null);
    // And NOT on a dismiss countdown: the work it reports has no fixed
    // duration, which is the whole defect this card replaces.
    expect(timerStrip()).toBeNull();
  });

  test("follows the download with a meter and a way out", async () => {
    const api = await renderBanner();
    await startMenuCheck(api);

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "available",
        version: "1.0.0"
      } satisfies AppUpdateStatus);
    });
    expect(container?.textContent).toContain("Starting download of v1.0.0...");
    // Cancel is offered here, before any byte has moved.
    expect(button("Cancel")).toBeDefined();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloading",
        version: "1.0.0",
        percent: 42,
        transferred: 50_000_000,
        total: 118_000_000,
        bytesPerSecond: 3_300_000
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toContain("PwrSnap v1.0.0 - 42%");
    expect(container?.textContent).toContain("48 MB of 113 MB");
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("42");
    expect(timerStrip()).toBeNull();

    await act(async () => {
      button("Cancel")?.click();
      await Promise.resolve();
    });

    expect(api.calls.some((call) => call.name === "app:update:cancel")).toBe(true);
    // aria-disabled, never `disabled`: Chromium blurs a newly disabled element
    // and would throw focus to <body> the instant the user asked to stop.
    expect(button("Canceling...")?.getAttribute("aria-disabled")).toBe("true");
    expect(button("Canceling...")?.hasAttribute("disabled")).toBe(false);
  });

  test("hands a settled outcome to a countdown notice and drops the live card", async () => {
    vi.useFakeTimers();
    const api = await renderBanner();
    await startMenuCheck(api);
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloading",
        version: "1.0.0",
        percent: 42
      } satisfies AppUpdateStatus);
    });
    expect(container?.textContent).toContain("Downloading update");

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateCheckResult, {
        status: "canceled",
        version: "1.0.0"
      } satisfies AppUpdateCheckResult);
    });

    expect(container?.textContent).not.toContain("Downloading update");
    expect(container?.textContent).toContain("Download canceled");
    expect(container?.textContent).toContain("PwrSnap v1.0.0 is still available");
    // A cancel is not a failure: no danger tint, and it IS a finished notice
    // now, so the countdown is correct here.
    expect(container?.querySelector(".app-update-banner--error")).toBeNull();
    expect(timerStrip()).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(UPDATE_OUTCOME_DISMISS_MS + 10);
    });
    expect(container?.textContent).toBe("");
  });

  test("dresses a failed check, and only a failed check, as an error", async () => {
    const api = await renderBanner();
    await startMenuCheck(api);

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateCheckResult, {
        status: "error",
        message: "GitHub releases request failed with 404"
      } satisfies AppUpdateCheckResult);
    });

    expect(container?.textContent).toContain("Update check failed");
    expect(container?.querySelector(".app-update-banner--error")).not.toBeNull();
  });

  test("stays silent while a background check downloads", async () => {
    const api = await renderBanner();

    // No `app:update:check-result` — nobody asked, so nothing may appear until
    // there is something to act on.
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, { status: "checking" });
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloading",
        version: "1.0.0",
        percent: 30
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toBe("");
  });

  test("picks the live card up mid-download when a check joins one", async () => {
    // Help -> Check for Updates while a background download is already running
    // joins it in main, so the `checking` tick arrives after the status has
    // moved on. Rewinding the card there would report a finished step.
    const api = await renderBanner({ status: "downloading", version: "1.0.0", percent: 70 });

    await startMenuCheck(api);

    expect(container?.textContent).toContain("PwrSnap v1.0.0 - 70%");
    expect(container?.textContent).not.toContain("Asking GitHub");
  });

  test("drops the live card the moment the download is ready to install", async () => {
    const api = await renderBanner();
    await startMenuCheck(api);
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloading",
        version: "1.0.0",
        percent: 99
      } satisfies AppUpdateStatus);
    });
    expect(container?.textContent).toContain("Downloading update");

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloaded",
        version: "1.0.0"
      } satisfies AppUpdateStatus);
      api.pushEvent(EVENT_CHANNELS.appUpdateCheckResult, {
        status: "downloaded",
        version: "1.0.0"
      } satisfies AppUpdateCheckResult);
    });

    expect(container?.textContent).not.toContain("Downloading update");
    // The sticky Restart notice owns a downloaded update — one offer, not two.
    expect(container?.textContent).toContain("Restart to update to v1.0.0.");
    expect(timerStrip()).toBeNull();
  });

  test("keeps a standing Restart offer while a fresh check runs beside it", async () => {
    // The `checking` stand-in is held beside the status, never written into
    // it: a check started while an update is already downloaded must not walk
    // that status backwards, or the offer the user already has disappears for
    // the length of the check — and, on the fast path where main answers
    // `downloaded` without emitting a single status event, never comes back.
    const api = await renderBanner();
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloaded",
        version: "1.0.0"
      } satisfies AppUpdateStatus);
    });

    await startMenuCheck(api);

    expect(container?.textContent).toContain("Checking for updates");
    expect(container?.textContent).toContain("Restart to update to v1.0.0.");

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateCheckResult, {
        status: "downloaded",
        version: "1.0.0"
      } satisfies AppUpdateCheckResult);
    });

    expect(container?.textContent).not.toContain("Checking for updates");
    expect(container?.textContent).toContain("Restart to update to v1.0.0.");
  });

  test("brings a dismissed offer back when the user asks again", async () => {
    const api = await renderBanner();
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloaded",
        version: "1.0.0"
      } satisfies AppUpdateStatus);
    });
    await act(async () => {
      button("Dismiss")?.click();
    });
    expect(container?.textContent).toBe("");

    await startMenuCheck(api);
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateCheckResult, {
        status: "downloaded",
        version: "1.0.0"
      } satisfies AppUpdateCheckResult);
    });

    // Asking again is asking to see the answer again — otherwise the check
    // looks dead.
    expect(container?.textContent).toContain("Restart to update to v1.0.0.");
  });
});
