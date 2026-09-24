// ZoomMenu's popover used to say role="menu" while holding a text field and
// step buttons, which a menu cannot contain — so it could never deliver the
// arrow keys the role promises. It is a non-modal dialog now. Measured in
// headless Chromium before: Escape from any row dropped focus to <body>, and
// Tab walked out of the popover with it still open over the toolbar.

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ZoomMenu } from "../ZoomMenu";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

const setCustomPct = vi.fn();

function Harness(): ReactElement {
  const [mode, setMode] = useState<"fit" | "actual" | "custom">("fit");
  return (
    <div>
      <ZoomMenu
        shortcutPlatform="darwin"
        zoom={{
          mode,
          displayPct: 62,
          fitPct: 62,
          resetToFit: () => setMode("fit"),
          actualSize: () => setMode("actual"),
          setCustomPct,
          zoomBy: () => undefined
        }}
      />
      <button id="next-tool">next toolbar control</button>
    </div>
  );
}

async function openPopover(): Promise<HTMLButtonElement> {
  setCustomPct.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
  const trigger = document.querySelector<HTMLButtonElement>(".ed-zoom-btn")!;
  trigger.focus();
  await act(async () => trigger.click());
  return trigger;
}

function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ed-zoom-menu");
}

function row(name: string): HTMLButtonElement {
  const found = [...(popover()?.querySelectorAll("button") ?? [])].find((b) =>
    (b.textContent ?? "").startsWith(name)
  );
  if (found === undefined) throw new Error(`no "${name}" row`);
  return found;
}

async function press(key: string): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(e);
  });
  return e;
}

describe("ZoomMenu", () => {
  test("is a dialog popover, not a menu it cannot be", async () => {
    const trigger = await openPopover();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(popover()?.getAttribute("role")).toBe("dialog");
    expect(popover()?.getAttribute("aria-label")).toBe("Zoom");
    expect(document.querySelector('[role="menu"], [role="menuitemradio"]')).toBeNull();
    expect(row("Fit").getAttribute("aria-pressed")).toBe("true");
    expect(row("100%").getAttribute("aria-pressed")).toBe("false");
  });

  test("Escape from a row closes it, returns focus to the zoom button, and stops there", async () => {
    // The editor's handler: window-capture, registered after ours, and it
    // clears the canvas selection on Escape.
    const editor = vi.fn();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") editor();
    };
    window.addEventListener("keydown", onKey, true);
    try {
      const trigger = await openPopover();
      row("100%").focus();
      await press("Escape");
      expect(popover()).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(editor).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onKey, true);
    }
  });

  test("picking a row closes it and returns focus to the zoom button", async () => {
    const trigger = await openPopover();
    await act(async () => row("100%").click());
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("Escape in the field discards the typed draft", async () => {
    await openPopover();
    const input = popover()!.querySelector("input")!;
    input.focus();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "250");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Escape");
    expect(popover()).toBeNull();
    expect(setCustomPct).not.toHaveBeenCalled();
  });

  test("Tab out past the popover closes it", async () => {
    await openPopover();
    popover()!.querySelector<HTMLButtonElement>('[aria-label="Zoom in 20%"]')!.focus();
    await act(async () => {
      document.getElementById("next-tool")!.focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("next-tool"));
  });
});
