// AiConsentDialog is aria-modal in all three places it opens (Library,
// Settings → AI Features, the post-capture float-over). Measured in
// headless Chromium before it used useModal: focus stayed on the control
// that opened it, the third Tab walked out behind the scrim, and Escape did
// nothing at all.

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { AiConsentDialog } from "../AiConsentDialog";

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

function Harness({ onAccept }: { onAccept: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" onClick={() => setOpen(true)}>
        Enable AI
      </button>
      {open ? (
        <AiConsentDialog
          onCancel={() => setOpen(false)}
          onAccept={() => {
            onAccept();
            setOpen(false);
          }}
        />
      ) : null}
      <button id="behind">Library control behind the scrim</button>
    </>
  );
}

async function openDialog(onAccept = vi.fn()): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness onAccept={onAccept} />));
  const opener = document.getElementById("opener")!;
  opener.focus();
  await act(async () => opener.click());
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function button(name: string): HTMLButtonElement {
  const found = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent === name
  );
  if (found === undefined) throw new Error(`no "${name}" button`);
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

describe("AiConsentDialog — keyboard", () => {
  test("focus moves into the dialog on open, onto Cancel", async () => {
    await openDialog();
    expect(document.activeElement).toBe(button("Cancel"));
  });

  test("Tab from the last button wraps to the first; Shift+Tab from the first wraps to the last", async () => {
    await openDialog();
    button("Enable AI enrichment").focus();
    expect((await press("Tab")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Cancel"));
    expect((await press("Tab", true)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Enable AI enrichment"));
  });

  test("Escape cancels, and the app's own Escape handler behind it never sees the key", async () => {
    const behind = vi.fn();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") behind();
    };
    // The Library's view handler: a window listener that does not check
    // defaultPrevented, and would leave Focus or collapse the rail.
    window.addEventListener("keydown", onKey);
    try {
      const onAccept = vi.fn();
      await openDialog(onAccept);
      await press("Escape");
      expect(dialog()).toBeNull();
      expect(onAccept).not.toHaveBeenCalled();
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onKey);
    }
  });

  test("closing returns focus to the control that opened it", async () => {
    await openDialog();
    await act(async () => button("Cancel").click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("opener"));
  });
});
