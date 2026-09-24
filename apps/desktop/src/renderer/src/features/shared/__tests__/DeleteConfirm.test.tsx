// Coverage for the inline delete-confirmation popover. Pins down the
// behavior the soft-delete buttons rely on:
//
//   • The trigger renders; the popover is closed until clicked.
//   • Opening the popover stops the click from bubbling to the cell/rail
//     behind it (otherwise the click would also open Focus on the very
//     capture being trashed).
//   • Confirm fires onConfirm exactly once and closes.
//   • Cancel, Escape, and an outside pointer-down all close WITHOUT firing
//     onConfirm.
//   • It is a modal confirm for the keyboard: Tab stays inside (the portal
//     puts it at the END of <body>, so an untrapped Tab fell off the page),
//     and closing returns focus to the trigger instead of <body>.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { DeleteConfirm } from "../DeleteConfirm";

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

async function renderConfirm(opts?: {
  enabled?: boolean;
  withDontAsk?: boolean;
}): Promise<{
  onConfirm: ReturnType<typeof vi.fn<() => void>>;
  onParentClick: ReturnType<typeof vi.fn<() => void>>;
  onDontAskAgain: ReturnType<typeof vi.fn<() => void>>;
}> {
  const onConfirm = vi.fn<() => void>();
  const onParentClick = vi.fn<() => void>();
  const onDontAskAgain = vi.fn<() => void>();
  const enabled = opts?.enabled ?? true;
  const withDontAsk = opts?.withDontAsk ?? false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <div onClick={onParentClick}>
        <DeleteConfirm
          message="Move to Trash?"
          enabled={enabled}
          onConfirm={onConfirm}
          {...(withDontAsk ? { onDontAskAgain } : {})}
        >
          {(trig) => (
            <button type="button" data-testid="trash-trigger" {...trig}>
              trash
            </button>
          )}
        </DeleteConfirm>
      </div>
    );
    await Promise.resolve();
  });
  return { onConfirm, onParentClick, onDontAskAgain };
}

function trigger(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    '[data-testid="trash-trigger"]'
  );
  if (el === null) throw new Error("trigger not found");
  return el;
}

function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ps-confirm");
}

async function clickTrigger(): Promise<void> {
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("DeleteConfirm", () => {
  test("popover is closed until the trigger is clicked", async () => {
    await renderConfirm();
    expect(popover()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    await clickTrigger();

    expect(popover()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  test("opening the popover does NOT bubble the click to the parent", async () => {
    const { onParentClick } = await renderConfirm();
    await clickTrigger();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  test("confirm fires onConfirm once and closes", async () => {
    const { onConfirm } = await renderConfirm();
    await clickTrigger();
    const confirmBtn = popover()?.querySelector<HTMLButtonElement>(
      ".ps-confirm__btn.is-danger"
    );
    await act(async () => {
      confirmBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
  });

  test("cancel closes without confirming", async () => {
    const { onConfirm } = await renderConfirm();
    await clickTrigger();
    const cancelBtn = popover()?.querySelector<HTMLButtonElement>(
      ".ps-confirm__btn:not(.is-danger)"
    );
    await act(async () => {
      cancelBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
  });

  test("Escape closes without confirming", async () => {
    const { onConfirm } = await renderConfirm();
    await clickTrigger();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await Promise.resolve();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
  });

  test("an outside pointer-down closes without confirming", async () => {
    const { onConfirm } = await renderConfirm();
    await clickTrigger();
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      );
      await Promise.resolve();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
  });

  test("enabled=false skips the popover and confirms immediately (still no bubble)", async () => {
    const { onConfirm, onParentClick } = await renderConfirm({ enabled: false });
    await clickTrigger();
    expect(popover()).toBeNull();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  test("no 'Don't ask again' checkbox unless onDontAskAgain is provided", async () => {
    await renderConfirm();
    await clickTrigger();
    expect(popover()?.querySelector(".ps-confirm__dont-ask")).toBeNull();
  });

  test("ticking 'Don't ask again' then confirming calls onDontAskAgain before onConfirm", async () => {
    const { onConfirm, onDontAskAgain } = await renderConfirm({ withDontAsk: true });
    await clickTrigger();
    const checkbox = popover()?.querySelector<HTMLInputElement>(
      ".ps-confirm__dont-ask input"
    );
    expect(checkbox).not.toBeNull();
    await act(async () => {
      checkbox!.click();
      await Promise.resolve();
    });
    const confirmBtn = popover()?.querySelector<HTMLButtonElement>(
      ".ps-confirm__btn.is-danger"
    );
    await act(async () => {
      confirmBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onDontAskAgain).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("confirming WITHOUT ticking the box does not call onDontAskAgain", async () => {
    const { onConfirm, onDontAskAgain } = await renderConfirm({ withDontAsk: true });
    await clickTrigger();
    const confirmBtn = popover()?.querySelector<HTMLButtonElement>(
      ".ps-confirm__btn.is-danger"
    );
    await act(async () => {
      confirmBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDontAskAgain).not.toHaveBeenCalled();
  });
});

describe("DeleteConfirm — keyboard", () => {
  async function press(key: string, shiftKey = false): Promise<KeyboardEvent> {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(e);
      await Promise.resolve();
    });
    return e;
  }

  function control(selector: string): HTMLElement {
    const el = popover()?.querySelector<HTMLElement>(selector) ?? null;
    if (el === null) throw new Error(`${selector} not found`);
    return el;
  }

  test("says it is modal, and focus lands on the confirm button", async () => {
    await renderConfirm();
    trigger().focus();
    await clickTrigger();
    expect(popover()?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(control(".ps-confirm__btn.is-danger"));
  });

  test("Tab from the last button wraps to the first control instead of leaving", async () => {
    await renderConfirm({ withDontAsk: true });
    trigger().focus();
    await clickTrigger();
    expect((await press("Tab")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(control('input[type="checkbox"]'));
  });

  test("Shift+Tab from the first control wraps to the last", async () => {
    await renderConfirm();
    trigger().focus();
    await clickTrigger();
    control(".ps-confirm__btn:not(.is-danger)").focus();
    expect((await press("Tab", true)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(control(".ps-confirm__btn.is-danger"));
  });

  test("Escape returns focus to the trigger, not <body>", async () => {
    await renderConfirm();
    trigger().focus();
    await clickTrigger();
    await press("Escape");
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  test("Cancel returns focus to the trigger too", async () => {
    await renderConfirm();
    trigger().focus();
    await clickTrigger();
    await act(async () => {
      control(".ps-confirm__btn:not(.is-danger)").click();
      await Promise.resolve();
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
