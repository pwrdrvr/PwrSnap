// Coverage for the Undo toast's self-owned auto-dismiss countdown and its
// Undo / dismiss buttons. The countdown drives a depleting strip (scaleX
// 1 → 0) and calls onDismiss when it runs out; hovering pauses it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { UndoToast } from "../UndoToast";

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "requestAnimationFrame", "cancelAnimationFrame", "performance"]
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function render(durationMs: number): {
  onUndo: ReturnType<typeof vi.fn<() => void>>;
  onDismiss: ReturnType<typeof vi.fn<() => void>>;
} {
  const onUndo = vi.fn<() => void>();
  const onDismiss = vi.fn<() => void>();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <UndoToast
        message="Moved to Trash"
        durationMs={durationMs}
        onUndo={onUndo}
        onDismiss={onDismiss}
      />
    );
  });
  return { onUndo, onDismiss };
}

function toast(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".ps-undo-toast");
  if (el === null) throw new Error("toast not found");
  return el;
}

describe("UndoToast", () => {
  test("calls onDismiss once the countdown elapses", () => {
    const { onDismiss } = render(1000);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1100));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("does not dismiss before the duration", () => {
    const { onDismiss } = render(1000);
    act(() => vi.advanceTimersByTime(500));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("the countdown strip depletes over time", () => {
    render(1000);
    const fill = toast().querySelector<HTMLElement>(".ps-undo-toast__progress-fill");
    act(() => vi.advanceTimersByTime(500));
    // ~half depleted — somewhere between full and empty.
    const t = fill?.style.transform ?? "";
    const match = /scaleX\(([0-9.]+)\)/.exec(t);
    const scale = match !== null ? Number(match[1]) : 1;
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);
  });

  test("hovering pauses the countdown — no dismiss past the duration", () => {
    const { onDismiss } = render(1000);
    // React 19 synthesizes onMouseEnter from a bubbling `mouseover`.
    act(() => {
      toast().dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("Undo button calls onUndo; close button calls onDismiss", () => {
    const { onUndo, onDismiss } = render(10000);
    act(() => {
      toast()
        .querySelector<HTMLButtonElement>(".ps-undo-toast__undo")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    act(() => {
      toast()
        .querySelector<HTMLButtonElement>(".ps-undo-toast__close")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
