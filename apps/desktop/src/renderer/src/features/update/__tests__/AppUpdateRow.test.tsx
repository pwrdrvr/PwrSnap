import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { EVENT_CHANNELS, type AppUpdateStatus } from "@pwrsnap/shared";
import { AppUpdateRow, resetAppUpdateDismissals } from "../AppUpdateRow";
import { appUpdateNotice } from "../app-update-notice";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

type FakeApi = {
  calls: { name: string; req: unknown }[];
  pushStatus: (status: AppUpdateStatus) => Promise<void>;
  /** Only meaningful with `deferSnapshot` — lets the pending
   *  `app:update:status` read resolve, so a test can land an event
   *  while the snapshot is still in flight. */
  releaseSnapshot: () => Promise<void>;
};

function installFakeApi(options: {
  snapshot?: AppUpdateStatus;
  installResult?: AnyResult;
  deferSnapshot?: boolean;
} = {}): FakeApi {
  const calls: { name: string; req: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let openSnapshotGate: (() => void) | undefined;
  const snapshotGate = options.deferSnapshot === true
    ? new Promise<void>((resolve) => {
        openSnapshotGate = resolve;
      })
    : Promise.resolve();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (name === "app:update:status") {
          await snapshotGate;
          return { ok: true, value: options.snapshot ?? { status: "idle" } };
        }
        if (name === "app:update:install") {
          return options.installResult ?? { ok: true, value: { status: "restarting" } };
        }
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
    pushStatus: async (status: AppUpdateStatus) => {
      await act(async () => {
        for (const listener of listeners.get(EVENT_CHANNELS.appUpdateStatus) ?? []) {
          listener(status);
        }
      });
    },
    releaseSnapshot: async () => {
      await act(async () => {
        openSnapshotGate?.();
        // Two turns: one for the awaited gate, one for the dispatch
        // promise the hook is sitting on.
        await Promise.resolve();
        await Promise.resolve();
      });
    }
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountRow(variant: "tray" | "float-over"): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AppUpdateRow, { variant }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function unmountRow(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll("button") ?? []).find(
    (el) => el.textContent?.trim() === label
  );
}

beforeEach(() => {
  resetAppUpdateDismissals();
});

afterEach(async () => {
  await unmountRow();
});

describe("AppUpdateRow", () => {
  // The row is a passenger on the tray popover and the post-capture
  // toast. Anything short of "there is something to press" must render
  // nothing at all, or every capture grows a strip that does nothing.
  test.each<AppUpdateStatus>([
    { status: "idle" },
    { status: "checking" },
    { status: "skipped", reason: "dev build" },
    { status: "no-update", version: "1.1.0" },
    { status: "available", version: "1.2.0" },
    { status: "downloading", version: "1.2.0", percent: 40 },
    { status: "error", message: "network down" }
  ])("renders nothing for status $status", async (status) => {
    const api = installFakeApi();
    await mountRow("tray");
    await api.pushStatus(status);
    expect(container?.querySelector(".psu")).toBeNull();

    // Positive control on the same subscription, so an assertion of
    // "nothing rendered" can't pass because nothing was delivered.
    await api.pushStatus({ status: "downloaded", version: "9.9.9" });
    expect(container?.querySelector(".psu")).not.toBeNull();
  });

  test("offers Restart for a downloaded update and dispatches the install", async () => {
    const api = installFakeApi();
    await mountRow("tray");
    await api.pushStatus({ status: "downloaded", version: "1.2.0" });

    expect(container?.textContent).toContain("Update ready");
    expect(container?.textContent).toContain("v1.2.0 · restart to install");

    const restart = button("Restart");
    expect(restart).toBeDefined();
    await act(async () => {
      restart?.click();
      await Promise.resolve();
    });

    expect(api.calls.some((call) => call.name === "app:update:install")).toBe(true);
    // main is quitting into the new build — the button must not be
    // pressable a second time on the way out.
    expect(button("Restarting...")?.disabled).toBe(true);
  });

  // A downgrade is the way back to the train the user picked. Calling
  // it an update next to a lower version number reads as a bug.
  test("words a downloaded downgrade as a switch", async () => {
    const api = installFakeApi();
    await mountRow("tray");
    await api.pushStatus({ status: "downloaded", version: "1.0.1", downgrade: true });

    expect(container?.textContent).toContain("Switch ready");
    expect(container?.textContent).toContain("v1.0.1 · restart to switch");
    expect(container?.textContent).not.toContain("restart to install");
  });

  test("offers Retry in the amber variant after a failed install", async () => {
    const api = installFakeApi();
    await mountRow("float-over");
    await api.pushStatus({
      status: "install-failed",
      version: "1.2.0",
      currentVersion: "1.1.0",
      attemptedAt: "2026-09-08T12:00:00.000Z",
      channel: "latest",
      train: "stable"
    });

    expect(container?.textContent).toContain("Update retry needed");
    expect(container?.querySelector(".psu")?.classList.contains("is-retry")).toBe(true);
    expect(button("Retry")).toBeDefined();
  });

  test("shows an install failure in place and leaves the button pressable", async () => {
    const api = installFakeApi({
      installResult: {
        ok: true,
        value: {
          status: "error",
          message: "Dev preview (v420.0.0): Restart only works in production builds."
        }
      }
    });
    await mountRow("float-over");
    await api.pushStatus({ status: "downloaded", version: "420.0.0" });

    await act(async () => {
      button("Restart")?.click();
      await Promise.resolve();
    });

    expect(container?.querySelector(".psu__err")?.textContent).toContain(
      "Restart only works in production builds."
    );
    expect(button("Restart")?.disabled).toBe(false);
  });

  // The popover is only on screen because the user opened it, so
  // nothing is being interrupted — and a dismissed strip would leave
  // Settings as the only route back to the Restart button.
  test("the tray strip has no dismiss control", async () => {
    const api = installFakeApi();
    await mountRow("tray");
    await api.pushStatus({ status: "downloaded", version: "1.2.0" });

    expect(container?.querySelector(".psu__x")).toBeNull();
  });

  // The toast arrives unbidden after every capture, and it remounts
  // per capture (`key={record.id}`). Component-scoped dismissal would
  // put the row straight back on the user's next snap.
  test("a float-over dismissal survives the toast's per-capture remount", async () => {
    const api = installFakeApi({ snapshot: { status: "downloaded", version: "1.2.0" } });
    await mountRow("float-over");
    await api.pushStatus({ status: "downloaded", version: "1.2.0" });

    const dismiss = container?.querySelector<HTMLButtonElement>(".psu__x");
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss?.click();
    });
    expect(container?.querySelector(".psu")).toBeNull();

    await unmountRow();
    await mountRow("float-over");
    expect(container?.querySelector(".psu")).toBeNull();
  });

  test("a newer version brings a dismissed row back", async () => {
    const api = installFakeApi();
    await mountRow("float-over");
    await api.pushStatus({ status: "downloaded", version: "1.2.0" });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".psu__x")?.click();
    });
    expect(container?.querySelector(".psu")).toBeNull();

    await api.pushStatus({ status: "downloaded", version: "1.3.0" });
    expect(container?.textContent).toContain("v1.3.0 · restart to install");
  });

  // The snapshot read exists because main usually reaches `downloaded`
  // long before either popover mounts.
  test("picks up a status that main reached before the row mounted", async () => {
    installFakeApi({ snapshot: { status: "downloaded", version: "1.4.0" } });
    await mountRow("tray");

    expect(container?.textContent).toContain("v1.4.0 · restart to install");
  });

  // The row must never take down the surface hosting it.
  test("ignores a malformed status payload", async () => {
    const api = installFakeApi();
    await mountRow("float-over");
    await api.pushStatus({ status: "downloaded", version: "1.2.0" });
    await api.pushStatus(undefined as unknown as AppUpdateStatus);

    expect(container?.textContent).toContain("Update ready");
  });

  // A rejected event must not also claim the race against the snapshot:
  // main only broadcasts on transitions, so a swallowed snapshot can
  // leave the window on `idle` for the rest of the session.
  test("a malformed event does not cancel the in-flight snapshot read", async () => {
    const api = installFakeApi({
      snapshot: { status: "downloaded", version: "1.5.0" },
      deferSnapshot: true
    });
    await mountRow("tray");
    await api.pushStatus(undefined as unknown as AppUpdateStatus);
    expect(container?.querySelector(".psu")).toBeNull();

    await api.releaseSnapshot();
    expect(container?.textContent).toContain("v1.5.0 · restart to install");
  });

  // Half-validating is worse than not validating: it renders
  // "vundefined" and writes a poisoned key into the dismissal set.
  test("rejects an actionable status carrying no version", async () => {
    const api = installFakeApi();
    await mountRow("tray");
    await api.pushStatus({ status: "downloaded" } as unknown as AppUpdateStatus);
    expect(container?.querySelector(".psu")).toBeNull();

    await api.pushStatus({ status: "downloaded", version: "1.2.0" });
    expect(container?.textContent).toContain("v1.2.0 · restart to install");
  });

  // The same version can arrive first as a switch back to the picked
  // train and later as an ordinary update — two different offers.
  test("dismissing a switch does not silence the same version's update", async () => {
    const api = installFakeApi();
    await mountRow("float-over");
    await api.pushStatus({ status: "downloaded", version: "1.0.1", downgrade: true });
    expect(container?.textContent).toContain("Switch ready");

    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".psu__x")?.click();
    });
    expect(container?.querySelector(".psu")).toBeNull();

    await api.pushStatus({ status: "downloaded", version: "1.0.1" });
    expect(container?.textContent).toContain("Update ready");
  });
});

describe("appUpdateNotice", () => {
  // The Library toast, the tray strip and the float-over card all read
  // from this one function so their wording cannot drift apart.
  test("carries both a full sentence and a compact line", () => {
    const notice = appUpdateNotice({ status: "downloaded", version: "2.0.0" });
    expect(notice?.message).toBe("Restart to update to v2.0.0.");
    expect(notice?.compact).toBe("v2.0.0 · restart to install");
    expect(notice?.action).toBe("Restart");
    expect(notice?.compactAction).toBe("Restart");
  });

  test("gives the roomy and compact surfaces different retry verbs", () => {
    const notice = appUpdateNotice({
      status: "install-failed",
      version: "2.0.0",
      currentVersion: "1.9.0",
      attemptedAt: "2026-09-08T12:00:00.000Z",
      channel: "latest",
      train: "stable"
    });
    expect(notice?.action).toBe("Retry update");
    expect(notice?.compactAction).toBe("Retry");
  });
});
