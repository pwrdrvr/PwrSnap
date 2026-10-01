import { act, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { useToolbarTooltip } from "../useToolbarTooltip";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;

function Harness(): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const tooltip = useToolbarTooltip(ref);
  return (
    <div ref={ref}>
      <button type="button" data-testid="one" data-tip="Red arrow" data-tip-keys="1" data-tip-detail={"Press 1 or click to draw with it\nRight-click to replace or clear"}>
        <span data-testid="one-glyph">→</span>
      </button>
      <button type="button" data-testid="two" data-tip="Green arrow" data-tip-keys="2">
        2
      </button>
      <span data-testid="gap">gap</span>
      {tooltip}
    </div>
  );
}

function el(id: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`missing ${id}`);
  return found;
}

function tooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="toolbar-tooltip"]');
}

function pointer(type: "pointerover" | "pointerout", target: Element, related: Element | null): void {
  // jsdom has no PointerEvent constructor; a MouseEvent of the same type
  // reaches the same listeners.
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: related }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("useToolbarTooltip", () => {
  test("shows after a short hover — not the native tooltip's multi-second wait", () => {
    pointer("pointerover", el("one-glyph"), el("gap"));
    expect(tooltip()).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    const tip = tooltip();
    expect(tip?.textContent).toContain("Red arrow");
    expect(tip?.querySelector("kbd")?.textContent).toBe("1");
    expect(tip?.textContent).toContain("Press 1 or click to draw with it");
    expect(el("one").getAttribute("aria-describedby")).toBe(tip?.id);
  });

  test("moving within the same button does not restart or hide it", () => {
    pointer("pointerover", el("one"), el("gap"));
    act(() => vi.advanceTimersByTime(400));
    pointer("pointerout", el("one"), el("one-glyph"));
    pointer("pointerover", el("one-glyph"), el("one"));
    expect(tooltip()?.textContent).toContain("Red arrow");
  });

  test("once one is up, the next button's shows at once", () => {
    pointer("pointerover", el("one"), el("gap"));
    act(() => vi.advanceTimersByTime(400));
    pointer("pointerout", el("one"), el("gap"));
    expect(tooltip()).toBeNull();
    pointer("pointerover", el("two"), el("gap"));
    expect(tooltip()?.textContent).toContain("Green arrow");
    expect(el("one").hasAttribute("aria-describedby")).toBe(false);
  });

  test("a key press hides it and is not consumed", () => {
    pointer("pointerover", el("one"), el("gap"));
    act(() => vi.advanceTimersByTime(400));
    const event = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(tooltip()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test("a press hides it, and a pending one never appears", () => {
    pointer("pointerover", el("one"), el("gap"));
    act(() => {
      el("one").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(tooltip()).toBeNull();
  });
});
