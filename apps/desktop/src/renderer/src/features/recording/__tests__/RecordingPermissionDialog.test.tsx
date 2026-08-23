import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import type {
  PwrSnapError,
  RecordingPermissionPreflight
} from "@pwrsnap/shared";
import { RecordingPermissionDialog } from "../RecordingPermissionDialog";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverMock
  });
});

const originalResizeObserver = globalThis.ResizeObserver;
const resizeObservers: ResizeObserverMock[] = [];
let measuredBounds = { width: 560, height: 318 };
let boundsSpy: ReturnType<typeof vi.spyOn> | null = null;

class ResizeObserverMock {
  private observed: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(target: Element): void {
    this.observed = target;
  }

  unobserve(): void {
    this.observed = null;
  }

  disconnect(): void {
    this.observed = null;
  }

  fire(): void {
    if (this.observed === null) return;
    this.callback([], this as unknown as ResizeObserver);
  }

  target(): Element | null {
    return this.observed;
  }
}

type Call = { name: string; req: unknown };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const basePreflight: RecordingPermissionPreflight = {
  requestId: "request-1",
  displayId: 7,
  capabilities: { microphone: false, systemAudio: false },
  missing: [{ permission: "screen", status: "denied" }]
};

function installApi(
  platform: "darwin" | "win32" | "linux",
  error: PwrSnapError | null = null
): Call[] {
  const calls: Call[] = [];
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform,
      dispatch: async (name: string, req: unknown) => {
        calls.push({ name, req });
        return error === null
          ? { ok: true, value: undefined }
          : { ok: false, error };
      },
      on: () => () => undefined
    }
  });
  return calls;
}

beforeEach(() => {
  measuredBounds = { width: 560, height: 318 };
  resizeObservers.length = 0;
  boundsSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: measuredBounds.width,
          bottom: measuredBounds.height,
          width: measuredBounds.width,
          height: measuredBounds.height,
          toJSON: () => ({})
        }) as DOMRect
    );
});

async function render(
  preflight: RecordingPermissionPreflight,
  platform: "darwin" | "win32" | "linux" = "darwin",
  error: PwrSnapError | null = null
): Promise<Call[]> {
  const calls = installApi(platform, error);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(RecordingPermissionDialog, { preflight }));
  });
  return calls;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  boundsSpy?.mockRestore();
  boundsSpy = null;
});

afterAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: originalResizeObserver
  });
});

function button(action: string, permission?: string): HTMLButtonElement {
  const suffix = permission === undefined ? "" : `[data-permission="${permission}"]`;
  const found = container?.querySelector<HTMLButtonElement>(
    `button[data-permission-action="${action}"]${suffix}`
  );
  if (found === null || found === undefined) {
    throw new Error(`button ${action}/${permission ?? "all"} not found`);
  }
  return found;
}

describe("RecordingPermissionDialog", () => {
  test("macOS required screen gap offers System Settings and explicit Cancel, never degrade", async () => {
    const calls = await render(basePreflight, "darwin");
    const screen = container?.querySelector('[data-permission-gap="screen"]');
    expect(screen?.textContent).toContain("REQUIRED");
    expect(screen?.textContent).toContain("Open System Settings");
    expect(
      screen?.querySelector('[data-permission-action="continue-without"]')
    ).toBeNull();
    expect(button("cancel").textContent).toBe("Cancel");

    await act(async () => {
      button("open-settings", "screen").click();
    });
    expect(calls.at(-1)).toEqual({
      name: "recording:permissionAction",
      req: {
        requestId: "request-1",
        action: "openSettings",
        permission: "screen"
      }
    });
  });

  test("optional gaps offer per-source degraded continuation and explain persistence", async () => {
    const preflight: RecordingPermissionPreflight = {
      ...basePreflight,
      capabilities: { microphone: true, systemAudio: true },
      missing: [
        { permission: "microphone", status: "denied" },
        { permission: "systemAudio", status: "unavailable" }
      ]
    };
    const calls = await render(preflight, "darwin");
    expect(container?.querySelector('[data-permission-gap="screen"]')).toBeNull();
    expect(button("continue-without", "microphone").textContent).toContain(
      "Continue without mic"
    );
    expect(button("continue-without", "systemAudio").textContent).toContain(
      "Continue without system audio"
    );
    expect(
      container?.querySelector("[data-permission-persistence-note]")?.textContent
    ).toContain("saved recording options stay unchanged");
    expect(
      container?.querySelector(
        '[data-permission-gap="systemAudio"] [data-permission-action="open-settings"]'
      )
    ).toBeNull();

    await act(async () => {
      button("continue-without", "microphone").click();
    });
    expect(calls.at(-1)?.req).toEqual({
      requestId: "request-1",
      action: "continueWithout",
      permission: "microphone"
    });
  });

  test("restricted screen is managed by policy and offers only recheck or cancel", async () => {
    await render(
      {
        ...basePreflight,
        missing: [{ permission: "screen", status: "restricted" }]
      },
      "darwin"
    );

    const screen = container?.querySelector('[data-permission-gap="screen"]');
    expect(screen?.textContent).toContain(
      "managed by a device or organization policy"
    );
    expect(screen?.textContent).toContain("PwrSnap can’t change it");
    expect(container?.textContent).toContain(
      "PwrSnap can’t change that policy or start this recording"
    );
    expect(container?.textContent).not.toContain("Turn on");
    expect(container?.textContent).not.toContain("Open System Settings");
    expect(
      screen?.querySelector('[data-permission-action="open-settings"]')
    ).toBeNull();
    expect(
      screen?.querySelector('[data-permission-action="continue-without"]')
    ).toBeNull();
    expect(button("recheck")).toBeTruthy();
    expect(button("cancel")).toBeTruthy();
  });

  test("restricted microphone offers truthful managed-policy copy and continue without", async () => {
    const calls = await render(
      {
        ...basePreflight,
        capabilities: { microphone: true, systemAudio: false },
        missing: [{ permission: "microphone", status: "restricted" }]
      },
      "darwin"
    );

    const microphone = container?.querySelector(
      '[data-permission-gap="microphone"]'
    );
    expect(microphone?.textContent).toContain(
      "managed by a device or organization policy"
    );
    expect(container?.textContent).toContain(
      "Continue without it or contact your administrator"
    );
    expect(container?.textContent).not.toContain("fix access now");
    expect(container?.textContent).not.toContain("Turn on");
    expect(container?.textContent).not.toContain("Open System Settings");
    expect(
      microphone?.querySelector('[data-permission-action="open-settings"]')
    ).toBeNull();

    await act(async () => {
      button("continue-without", "microphone").click();
    });
    expect(calls.at(-1)).toEqual({
      name: "recording:permissionAction",
      req: {
        requestId: "request-1",
        action: "continueWithout",
        permission: "microphone"
      }
    });
  });

  test("Windows uses video-only copy and never offers a misleading Settings link", async () => {
    const preflight: RecordingPermissionPreflight = {
      ...basePreflight,
      capabilities: { microphone: true, systemAudio: true },
      missing: [
        { permission: "microphone", status: "unavailable" },
        { permission: "systemAudio", status: "unavailable" }
      ]
    };
    await render(preflight, "win32");
    expect(container?.textContent).toContain("current Windows recorder produces video-only clips");
    expect(container?.textContent).not.toContain("System Settings");
    expect(container?.textContent).not.toContain("macOS");
    expect(button("continue-without", "microphone")).toBeTruthy();
    expect(button("cancel")).toBeTruthy();
  });

  test("returning focus automatically rechecks and Escape cancels", async () => {
    const calls = await render(basePreflight, "darwin");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(calls.at(-1)).toEqual({
      name: "recording:permissionAction",
      req: { requestId: "request-1", action: "recheck" }
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(calls.at(-1)).toEqual({
      name: "recording:permissionAction",
      req: { requestId: "request-1", action: "cancel" }
    });
  });

  test("surfaces command-bus Result errors inline", async () => {
    await render(basePreflight, "darwin", {
      kind: "permission",
      code: "open_settings_failed",
      message: "Settings could not be opened"
    });
    await act(async () => {
      button("open-settings", "screen").click();
    });
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      "Settings could not be opened"
    );
  });

  test("measures the natural wrapper, suppresses duplicates, and sanity-caps resize requests", async () => {
    const calls = await render(basePreflight, "darwin");
    const measurer = container?.querySelector<HTMLElement>(
      "[data-permission-dialog-measurer]"
    );
    const dialog = container?.querySelector<HTMLElement>('[role="dialog"]');
    expect(measurer?.style.display).toBe("inline-block");
    expect(dialog?.style.height).toBe("");
    expect(resizeObservers.at(-1)?.target()).toBe(measurer);

    const resizeCalls = (): Call[] =>
      calls.filter(
        (call) => call.name === "recording:resizePermissionController"
      );
    expect(resizeCalls()).toEqual([
      {
        name: "recording:resizePermissionController",
        req: { requestId: "request-1", width: 560, height: 318 }
      }
    ]);

    await act(async () => {
      resizeObservers.at(-1)?.fire();
    });
    expect(resizeCalls()).toHaveLength(1);

    measuredBounds = { width: 9_000, height: 8_000 };
    await act(async () => {
      resizeObservers.at(-1)?.fire();
    });
    expect(resizeCalls().at(-1)).toEqual({
      name: "recording:resizePermissionController",
      req: { requestId: "request-1", width: 1_200, height: 1_600 }
    });
  });
});
