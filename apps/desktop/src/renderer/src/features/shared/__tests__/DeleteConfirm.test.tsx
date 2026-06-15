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

async function renderConfirm(): Promise<{
  onConfirm: ReturnType<typeof vi.fn<() => void>>;
  onParentClick: ReturnType<typeof vi.fn<() => void>>;
}> {
  const onConfirm = vi.fn<() => void>();
  const onParentClick = vi.fn<() => void>();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <div onClick={onParentClick}>
        <DeleteConfirm message="Move to Trash?" onConfirm={onConfirm}>
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
  return { onConfirm, onParentClick };
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
});
