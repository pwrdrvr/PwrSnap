// HotkeyResetModal — Settings → Hotkeys → "Reset to defaults". Measured in
// headless Chromium before it used useModal: the second Tab left the dialog
// for the Settings page behind it, and closing dropped focus to <body>, so
// the next Tab started from the top of the window. Its change list scrolls
// (`.pss__modal-body { overflow: auto }`), which Chromium makes a Tab stop
// of its own.

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { HotkeyResetModal, type HotkeyChange } from "../components/HotkeyResetModal";

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

const CHANGES: HotkeyChange[] = [
  { key: "a", label: "Pancake capture", current: "CommandOrControl+Shift+P", next: "" },
  { key: "b", label: "Waffle capture", current: "", next: "CommandOrControl+Shift+W" }
];

function Harness({ onConfirm }: { onConfirm: () => Promise<void> }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" onClick={() => setOpen(true)}>
        Reset to defaults
      </button>
      {open ? (
        <HotkeyResetModal
          changes={CHANGES}
          platform="mac"
          onCancel={() => setOpen(false)}
          onConfirm={onConfirm}
        />
      ) : null}
    </>
  );
}

async function openModal(onConfirm: () => Promise<void> = () => Promise.resolve()): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness onConfirm={onConfirm} />));
  const opener = document.getElementById("opener")!;
  opener.focus();
  await act(async () => opener.click());
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function button(prefix: string): HTMLButtonElement {
  const found = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) =>
    (b.textContent ?? "").startsWith(prefix)
  );
  if (found === undefined) throw new Error(`no "${prefix}" button`);
  return found;
}

async function press(key: string, shiftKey = false): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(e);
  });
  return e;
}

describe("HotkeyResetModal — keyboard", () => {
  test("focus starts on Cancel, the safe default", async () => {
    await openModal();
    expect(document.activeElement).toBe(button("Cancel"));
  });

  test("Tab from Reset wraps inside the dialog instead of walking into Settings", async () => {
    await openModal();
    button("Reset 2").focus();
    expect((await press("Tab")).defaultPrevented).toBe(true);
    expect(dialog()?.contains(document.activeElement)).toBe(true);
  });

  test("the scrolling change list is the cycle's first stop", async () => {
    await openModal();
    const body = dialog()!.querySelector<HTMLElement>(".pss__modal-body")!;
    body.style.overflowY = "auto";
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 300 });
    const focusBody = vi.spyOn(body, "focus");
    button("Reset 2").focus();
    expect((await press("Tab")).defaultPrevented).toBe(true);
    // Chromium focuses the scroller; jsdom will not — assert the aim.
    expect(focusBody).toHaveBeenCalled();
    // And Shift+Tab from Cancel is Chromium's step onto the list, not a wrap.
    button("Cancel").focus();
    expect((await press("Tab", true)).defaultPrevented).toBe(false);
  });

  test("Escape cancels and returns focus to Reset to defaults", async () => {
    await openModal();
    await press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("opener"));
  });

  test("while the reset is being written, Escape does not close it", async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await openModal(onConfirm);
    await act(async () => button("Reset 2").click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await press("Escape");
    expect(dialog()).not.toBeNull();
    await act(async () => finish());
  });
});
