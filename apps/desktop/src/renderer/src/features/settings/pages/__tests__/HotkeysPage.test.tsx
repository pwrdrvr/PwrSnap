import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_HOTKEYS,
  defaultHotkeysForPlatform,
  type HotkeyRegistrationStatusSnapshot,
  type Settings
} from "@pwrsnap/shared";
import type { UseSettingsValue } from "../../useSettings";
import { HotkeysPage } from "../HotkeysPage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let contextValue: Pick<UseSettingsValue, "settings" | "patch">;

vi.mock("../../SettingsContext", () => ({
  useSettingsContext: (): Pick<UseSettingsValue, "settings" | "patch"> => contextValue
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const patchMock = vi.fn(async (): Promise<void> => undefined);
const dispatchMock = vi.fn();

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
}

function settingsWith(
  hotkeys: Settings["hotkeys"] = defaultHotkeysForPlatform("win32")
): Settings {
  // HotkeysPage deliberately consumes only this settings branch. Keeping the
  // fixture narrow makes a future unrelated Settings field irrelevant here.
  return { hotkeys } as unknown as Settings;
}

function activeStatus(
  hotkeys: Settings["hotkeys"]
): HotkeyRegistrationStatusSnapshot {
  const status = {} as HotkeyRegistrationStatusSnapshot;
  for (const key of Object.keys(DEFAULT_HOTKEYS) as Array<keyof typeof DEFAULT_HOTKEYS>) {
    const accelerator = hotkeys[key];
    status[key] = {
      key,
      accelerator,
      state: accelerator === "" ? "unbound" : "active",
      failure: null
    };
  }
  return status;
}

async function renderPage(
  settings = settingsWith(),
  options: {
    hotkeyStatus?: HotkeyRegistrationStatusSnapshot;
    retryStatus?: HotkeyRegistrationStatusSnapshot;
  } = {}
): Promise<HTMLDivElement> {
  const hotkeyStatus = options.hotkeyStatus ?? activeStatus(settings.hotkeys);
  dispatchMock.mockImplementation(
    async (name: string, req: Record<string, unknown>) => ({
      ok: true,
      value:
        name === "settings:beginHotkeyRecording"
          ? {
              sessionId: req.sessionId,
              generation: req.generation,
              accepted: true,
              expiresAt: Date.now() + 120_000
            }
          : name === "settings:endHotkeyRecording"
            ? { ended: true }
            : name === "settings:retryHotkey"
              ? (options.retryStatus ?? hotkeyStatus)
              : hotkeyStatus
    })
  );
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "win32",
      dispatch: dispatchMock
    }
  });
  contextValue = {
    settings,
    patch: patchMock as unknown as UseSettingsValue["patch"]
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(HotkeysPage)));
  return container;
}

function buttonByName(name: string): HTMLButtonElement {
  const button = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (candidate) => candidate.getAttribute("aria-label")?.includes(name) === true
  );
  if (button === undefined) throw new Error(`Missing button: ${name}`);
  return button;
}

async function pressChord(key: string, code: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        key,
        code,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  patchMock.mockReset();
  patchMock.mockResolvedValue(undefined);
  dispatchMock.mockReset();
  Reflect.deleteProperty(window, "pwrsnapApi");
});

describe("HotkeysPage recorder ownership", () => {
  test("renders every Windows shortcut without Cmd or the Command glyph", async () => {
    const view = await renderPage();
    expect(view.textContent).toContain("Ctrl");
    expect(view.textContent).not.toMatch(/Cmd|⌘/);
  });

  test("treats canonical Windows spelling as the unchanged platform default", async () => {
    const defaults = defaultHotkeysForPlatform("win32");
    const view = await renderPage(
      settingsWith({ ...defaults, quickCapture: "Control+Shift+C" })
    );
    const reset = Array.from(view.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Reset to defaults"
    );

    expect(view.textContent).not.toContain("customization");
    expect(reset?.disabled).toBe(true);
  });

  test("queries boot status on open and explains an inactive persisted binding", async () => {
    const settings = settingsWith();
    const status = activeStatus(settings.hotkeys);
    status.quickCapture = {
      key: "quickCapture",
      accelerator: settings.hotkeys.quickCapture,
      state: "inactive",
      failure: {
        code: "unavailable",
        message:
          "Quick Capture is not active — Windows or another app has reserved or is using Control+Shift+C. Choose another combination, or Retry after it is freed."
      }
    };

    const view = await renderPage(settings, { hotkeyStatus: status });

    expect(dispatchMock).toHaveBeenCalledWith("settings:hotkeyStatus", {});
    expect(view.querySelector("[role='alert']")?.textContent).toContain(
      "not active — Windows or another app has reserved or is using"
    );
    expect(buttonByName("Retry Quick Capture hotkey")).not.toBeNull();
    expect(view.textContent).toContain("Ctrl");
  });

  test("Retry replaces the inactive warning with active status", async () => {
    const settings = settingsWith();
    const failed = activeStatus(settings.hotkeys);
    failed.quickCapture = {
      key: "quickCapture",
      accelerator: settings.hotkeys.quickCapture,
      state: "inactive",
      failure: {
        code: "unavailable",
        message: "Quick Capture is not active — reserved or in use. Choose another."
      }
    };
    const retried = activeStatus(settings.hotkeys);
    const view = await renderPage(settings, {
      hotkeyStatus: failed,
      retryStatus: retried
    });

    await act(async () => {
      buttonByName("Retry Quick Capture hotkey").click();
      await Promise.resolve();
    });

    expect(dispatchMock).toHaveBeenCalledWith("settings:retryHotkey", {
      key: "quickCapture"
    });
    expect(view.textContent).not.toContain("reserved or in use");
    expect(
      Array.from(view.querySelectorAll("button")).some((button) =>
        button.getAttribute("aria-label")?.includes("Retry Quick Capture")
      )
    ).toBe(false);
  });

  test("does not show a stale failure for a newly persisted accelerator", async () => {
    const settings = settingsWith({
      ...defaultHotkeysForPlatform("win32"),
      quickCapture: "Control+Alt+R"
    });
    const stale = activeStatus(settings.hotkeys);
    stale.quickCapture = {
      key: "quickCapture",
      accelerator: "Control+Shift+C",
      state: "inactive",
      failure: {
        code: "unavailable",
        message: "Old Quick Capture is not active — reserved or in use."
      }
    };

    const view = await renderPage(settings, { hotkeyStatus: stale });

    expect(view.textContent).not.toContain("Old Quick Capture is not active");
    expect(
      Array.from(view.querySelectorAll("button")).some((button) =>
        button.getAttribute("aria-label")?.includes("Retry Quick Capture")
      )
    ).toBe(false);
  });

  test("disables Retry while a hotkey save is in flight", async () => {
    const settings = settingsWith();
    const failed = activeStatus(settings.hotkeys);
    failed.quickCapture = {
      key: "quickCapture",
      accelerator: settings.hotkeys.quickCapture,
      state: "inactive",
      failure: {
        code: "unavailable",
        message: "Quick Capture is not active — reserved or in use."
      }
    };
    const save = deferredSignal();
    patchMock.mockImplementationOnce(() => save.promise);
    await renderPage(settings, { hotkeyStatus: failed });
    await act(async () => buttonByName("Change Quick Capture").click());

    await pressChord("r", "KeyR");

    expect(buttonByName("Retry Quick Capture hotkey").disabled).toBe(true);

    await act(async () => {
      save.resolve();
      await save.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(buttonByName("Retry Quick Capture hotkey").disabled).toBe(false);
  });

  test("keeps the active recorder open when the transactional write rejects", async () => {
    patchMock.mockRejectedValueOnce(new Error("Windows could not register that shortcut."));
    const view = await renderPage();
    await act(async () => buttonByName("Change Quick Capture").click());
    await pressChord("r", "KeyR");

    expect(patchMock).toHaveBeenCalledWith({
      hotkeys: { quickCapture: "Control+Shift+R" }
    });
    expect(view.querySelector(".pss__hk-capture.is-recording")).not.toBeNull();
    expect(view.querySelector("[role='alert']")?.textContent).toContain(
      "previous binding is still active"
    );
  });

  test("opening and cancelling reset stops recording without changing a binding", async () => {
    const custom = settingsWith({
      ...defaultHotkeysForPlatform("win32"),
      quickCapture: "Control+Alt+K"
    });
    const view = await renderPage(custom);
    await act(async () => buttonByName("Change Quick Capture").click());
    expect(view.querySelector(".pss__hk-capture.is-recording")).not.toBeNull();

    const reset = Array.from(view.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Reset to defaults"
    );
    if (reset === undefined) throw new Error("Missing reset button");
    await act(async () => reset.click());
    expect(view.querySelector("[role='dialog']")).not.toBeNull();
    expect(view.querySelector(".pss__hk-capture.is-recording")).toBeNull();
    expect(patchMock).not.toHaveBeenCalled();

    const cancel = Array.from(view.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Cancel"
    );
    if (cancel === undefined) throw new Error("Missing modal Cancel button");
    await act(async () => cancel.click());
    expect(view.querySelector("[role='dialog']")).toBeNull();
    expect(patchMock).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Ctrl");
  });

  test("a failed reset remains open and explains that existing shortcuts survived", async () => {
    patchMock.mockRejectedValueOnce(new Error("A default shortcut is reserved by Windows."));
    const view = await renderPage(
      settingsWith({
        ...defaultHotkeysForPlatform("win32"),
        quickCapture: "Control+Alt+K"
      })
    );
    const reset = Array.from(view.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Reset to defaults"
    );
    if (reset === undefined) throw new Error("Missing reset button");
    await act(async () => reset.click());
    const confirm = Array.from(view.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Reset 1 hotkey"
    );
    if (confirm === undefined) throw new Error("Missing modal confirm button");
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });

    expect(patchMock).toHaveBeenCalledWith({
      hotkeys: defaultHotkeysForPlatform("win32")
    });
    expect(view.querySelector("[role='dialog']")).not.toBeNull();
    expect(view.querySelector("[role='alert']")?.textContent).toContain(
      "existing shortcuts are still active"
    );
  });

  test("only the explicit Clear control sends an unbind patch", async () => {
    await renderPage();
    await act(async () => {
      buttonByName("Clear Quick Capture hotkey").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({ hotkeys: { quickCapture: "" } });
    expect(
      dispatchMock.mock.calls.filter(([name]) => name === "settings:hotkeyStatus")
    ).toHaveLength(2);
  });
});
