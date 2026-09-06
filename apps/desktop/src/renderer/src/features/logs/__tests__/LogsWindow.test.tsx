import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { err, ok, type AppLogEntry, type AppLogSnapshot, type Result } from "@pwrsnap/shared";
import { LogsWindow } from "../LogsWindow";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function entry(sequence: number, line: string): AppLogEntry {
  return { sequence, timestamp: sequence, level: "info", line };
}

function installFakeApi(snapshot: AppLogSnapshot): void {
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch: async (name: string) => {
        if (name === "logs:read") return { ok: true, value: snapshot };
        return { ok: true, value: undefined };
      },
      on: () => () => undefined
    }
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("LogsWindow search navigation", () => {
  test("scrolls the first match into view when a new query keeps index zero", async () => {
    installFakeApi({
      entries: [entry(1, "unrelated"), entry(2, "Codex tool failed")],
      readAt: 1,
      truncated: false,
      debugCollectionEnabled: false
    });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(LogsWindow));
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search logs"]');
    expect(input).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(input, "Codex");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("1 / 1");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });
});

const LOG_PATH = "/Users/example/Library/Logs/PwrSnap/app.log";

describe("LogsWindow log file copy", () => {
  function installCopyApi(copyResult: Result<void>): ReturnType<typeof vi.fn> {
    const snapshot: AppLogSnapshot = {
      entries: [entry(1, "hello")],
      readAt: 1,
      truncated: false,
      debugCollectionEnabled: false,
      logFilePath: LOG_PATH
    };
    const dispatch = vi.fn(async (name: string) => {
      if (name === "logs:read") return ok(snapshot);
      if (name === "clipboard:copyText") return copyResult;
      return ok(undefined);
    });
    Object.defineProperty(window, "pwrsnapApi", {
      configurable: true,
      value: { dispatch, on: () => () => undefined }
    });
    return dispatch;
  }

  async function renderWindow(): Promise<HTMLDivElement> {
    Element.prototype.scrollIntoView = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(LogsWindow));
      await Promise.resolve();
    });
    return container;
  }

  function copyButton(el: HTMLDivElement): HTMLButtonElement {
    const button = Array.from(
      el.querySelectorAll<HTMLButtonElement>("button.log-window__file-action")
    ).find((candidate) => candidate.textContent === "Copy");
    if (button === undefined) throw new Error("copy button not rendered");
    return button;
  }

  async function clickCopy(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }

  test("copies the log file path through clipboard:copyText and flips the button to Copied", async () => {
    const dispatch = installCopyApi(ok(undefined));
    const el = await renderWindow();
    const button = copyButton(el);

    await clickCopy(button);

    expect(dispatch).toHaveBeenCalledWith("clipboard:copyText", { text: LOG_PATH });
    expect(button.textContent).toBe("Copied");
    expect(button.getAttribute("data-copied")).toBe("true");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  test("a failed copy says so on the button and puts the reason in the error line", async () => {
    installCopyApi(
      err({ kind: "clipboard", code: "clipboard_unavailable", message: "clipboard unavailable" })
    );
    const el = await renderWindow();
    const button = copyButton(el);

    await clickCopy(button);

    expect(button.textContent).toBe("Copy failed");
    expect(button.getAttribute("data-copied")).toBeNull();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("clipboard unavailable");
  });
});
