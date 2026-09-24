// The Sizzle capture picker ("+ Add scene") had a scrim and nothing else a
// modal needs: no role, no label, no Escape, no focus move, no trap — Tab
// walked from its grid into the editor behind the scrim.

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("../../../lib/pwrsnap", () => ({
  cacheUrl: (id: string) => `pwrsnap-cache://${id}`,
  captureSrcUrl: (id: string) => `pwrsnap-capture://${id}`
}));

import { CapturePicker } from "../CapturePicker";

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

function Harness(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="add-scene" onClick={() => setOpen(true)}>
        + Add scene
      </button>
      {open ? (
        <CapturePicker
          captures={[]}
          existing={new Set()}
          onPick={() => undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
      <button id="behind">timeline control behind the scrim</button>
    </>
  );
}

async function openPicker(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
  const opener = document.getElementById("add-scene")!;
  opener.focus();
  await act(async () => opener.click());
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".szl__modal");
}

async function press(key: string, shiftKey = false): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(e);
  });
  return e;
}

describe("CapturePicker — a modal", () => {
  test("is a labelled modal dialog, and takes focus on open", async () => {
    await openPicker();
    const el = dialog()!;
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    const titleId = el.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("Add scene from Library");
    expect(el.contains(document.activeElement)).toBe(true);
  });

  test("Tab stays inside", async () => {
    await openPicker();
    const close = dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
    close.focus();
    expect((await press("Tab")).defaultPrevented).toBe(true);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  test("Escape closes it and returns focus to + Add scene", async () => {
    await openPicker();
    await press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("add-scene"));
  });
});
