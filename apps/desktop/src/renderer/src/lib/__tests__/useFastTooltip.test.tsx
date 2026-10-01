import { act, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { GAP_PX, RING_REACH_PX, placeTooltip, useFastTooltip } from "../useFastTooltip";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
let setShowTwo: (show: boolean) => void = () => undefined;

function Harness(): ReactElement {
  const tooltip = useFastTooltip();
  const [showTwo, setShow] = useState(true);
  setShowTwo = setShow;
  return (
    <div>
      <button type="button" data-testid="one" aria-label="Red arrow" data-tip="Red arrow" data-tip-keys="1" data-tip-detail={"Press 1 or click to draw with it\nRight-click to replace or clear"}>
        <span data-testid="one-glyph">→</span>
      </button>
      {showTwo && (
        <button type="button" data-testid="two" data-tip="Green arrow" data-tip-keys="2">
          2
        </button>
      )}
      <button type="button" data-testid="named" aria-label="Settings" aria-describedby="hint" data-tip="Settings">
        <svg aria-hidden="true" />
      </button>
      <span id="hint">Opens in its own window</span>
      <label data-testid="auto" data-tip="Apply AI enrichment automatically when ready">
        <input type="checkbox" data-testid="auto-box" aria-label="Auto-apply" />
        Auto
      </label>
      <button type="button" data-testid="untipped" data-tip="">
        Plain
      </button>
      <span data-testid="gap">gap</span>
      {createPortal(
        <button type="button" data-testid="portaled" aria-label="Close" data-tip="Close" data-tip-keys="Esc" />,
        document.body
      )}
      {tooltip}
    </div>
  );
}

function el(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`missing ${id}`);
  return found;
}

function tooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="fast-tooltip"]');
}

function pointer(type: "pointerover" | "pointerout", target: Element, related: Element | null): void {
  // jsdom has no PointerEvent constructor; a MouseEvent of the same type
  // reaches the same listeners.
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: related }));
  });
}

function hoverUntilShown(target: Element): void {
  pointer("pointerover", target, el("gap"));
  act(() => vi.advanceTimersByTime(400));
}

/** jsdom has no `:focus-visible`; pretend focus came from the keyboard. */
function stubFocusVisible(visible: boolean): void {
  const real = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    if (selector === ":focus-visible") return visible && document.activeElement === this;
    return real.call(this, selector);
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useFastTooltip", () => {
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
    hoverUntilShown(el("one"));
    pointer("pointerout", el("one"), el("one-glyph"));
    pointer("pointerover", el("one-glyph"), el("one"));
    expect(tooltip()?.textContent).toContain("Red arrow");
  });

  test("once one is up, the next button's shows at once", () => {
    hoverUntilShown(el("one"));
    pointer("pointerout", el("one"), el("gap"));
    expect(tooltip()).toBeNull();
    pointer("pointerover", el("two"), el("gap"));
    expect(tooltip()?.textContent).toContain("Green arrow");
    expect(el("one").hasAttribute("aria-describedby")).toBe(false);
  });

  test("a key press hides it and is not consumed", () => {
    hoverUntilShown(el("one"));
    const event = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(tooltip()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test("its keydown listener is on document capture, never window capture", () => {
    // The focus hooks' Escape listener must stay the first window-capture
    // keydown listener (lib/AGENTS.md). Remount and watch what is added.
    act(() => root.unmount());
    const windowAdd = vi.spyOn(window, "addEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    root = createRoot(host);
    act(() => root.render(<Harness />));
    expect(windowAdd.mock.calls.filter(([type]) => type === "keydown")).toEqual([]);
    expect(documentAdd.mock.calls.some(([type, , opts]) => type === "keydown" && opts === true)).toBe(true);
  });

  test("a press hides it, and a pending one never appears", () => {
    pointer("pointerover", el("one"), el("gap"));
    act(() => {
      el("one").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(tooltip()).toBeNull();
  });

  test("covers every surface in the window, including content portaled to <body>", () => {
    hoverUntilShown(el("portaled"));
    expect(tooltip()?.textContent).toContain("Close");
    expect(tooltip()?.querySelector("kbd")?.textContent).toBe("Esc");
  });

  test("an empty data-tip is no tip", () => {
    hoverUntilShown(el("untipped"));
    expect(tooltip()).toBeNull();
  });

  test("shows at once on keyboard focus, and not on a focus that came from a click", () => {
    stubFocusVisible(false);
    act(() => el("two").focus());
    expect(tooltip()).toBeNull();
    act(() => el("two").blur());

    vi.restoreAllMocks();
    stubFocusVisible(true);
    act(() => el("two").focus());
    expect(tooltip()?.textContent).toContain("Green arrow");
    act(() => el("two").blur());
    expect(tooltip()).toBeNull();
  });

  test("keyboard focus on a control inside a tipped label shows the label's tip", () => {
    stubFocusVisible(true);
    act(() => el("auto-box").focus());
    expect(tooltip()?.textContent).toContain("Apply AI enrichment automatically");
  });

  test("adds to an existing aria-describedby and puts it back", () => {
    hoverUntilShown(el("one"));
    pointer("pointerout", el("one"), el("gap"));
    act(() => vi.advanceTimersByTime(1000));
    // `named` already carries a description, and its tip only repeats
    // its name — so it is not linked, and the original is untouched.
    hoverUntilShown(el("named"));
    expect(tooltip()?.textContent).toContain("Settings");
    expect(el("named").getAttribute("aria-describedby")).toBe("hint");
  });

  test("a tip that says more than the name is appended to the existing description", () => {
    el("named").setAttribute("data-tip-keys", "Ctrl+,");
    hoverUntilShown(el("named"));
    expect(el("named").getAttribute("aria-describedby")).toBe(`hint ${tooltip()?.id}`);
    pointer("pointerout", el("named"), el("gap"));
    expect(el("named").getAttribute("aria-describedby")).toBe("hint");
  });

  test("an anchor that leaves the document takes its tooltip with it", async () => {
    hoverUntilShown(el("two"));
    expect(tooltip()).not.toBeNull();
    await act(async () => {
      setShowTwo(false);
    });
    // MutationObserver callbacks run as a microtask after the commit.
    await act(async () => {
      await Promise.resolve();
    });
    expect(tooltip()).toBeNull();
  });

  test("follows its anchor on scroll instead of hiding", () => {
    let anchorRect = rect(100, 300, 24, 24);
    vi.spyOn(el("two"), "getBoundingClientRect").mockImplementation(() => anchorRect);
    hoverUntilShown(el("two"));
    const before = tooltip()?.style.top;
    anchorRect = rect(100, 200, 24, 24);
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(tooltip()).not.toBeNull();
    expect(tooltip()?.style.top).not.toBe(before);
  });

  test("a second instance in the same window stays inert", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Second(): ReactElement | null {
      return useFastTooltip();
    }
    const extraHost = document.createElement("div");
    document.body.appendChild(extraHost);
    const extra = createRoot(extraHost);
    act(() => extra.render(<Second />));
    hoverUntilShown(el("one"));
    expect(document.querySelectorAll('[data-testid="fast-tooltip"]')).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    act(() => extra.unmount());
    extraHost.remove();
  });
});

describe("placeTooltip never covers the focus ring of the control it describes", () => {
  const tip = { width: 120, height: 40 };
  const viewport = { width: 800, height: 600 };

  function clearsRing(
    anchor: { top: number; bottom: number; left: number; width: number },
    at: { left: number; top: number }
  ): boolean {
    const ringTop = anchor.top - RING_REACH_PX;
    const ringBottom = anchor.bottom + RING_REACH_PX;
    return at.top + tip.height <= ringTop || at.top >= ringBottom;
  }

  test("the gap is wider than the ring reaches", () => {
    expect(GAP_PX).toBeGreaterThan(RING_REACH_PX);
  });

  test.each([
    ["mid-window: above", { top: 300, bottom: 324, left: 380, width: 24 }, "above"],
    ["at the top edge: flipped below", { top: 10, bottom: 34, left: 380, width: 24 }, "below"],
    ["at the bottom edge: above", { top: 570, bottom: 594, left: 380, width: 24 }, "above"],
    // A tall control in a short window (the tray popover, a float-over
    // row) leaves room on neither side: it takes the roomier side and
    // runs off the edge rather than sliding back over the ring.
    ["no room either side: the roomier side", { top: 20, bottom: 560, left: 380, width: 24 }, "below"]
  ] as const)("%s", (_name, anchor, side) => {
    const at = placeTooltip(anchor, tip, viewport);
    expect(clearsRing(anchor, at)).toBe(true);
    expect(at.top < anchor.top ? "above" : "below").toBe(side);
  });

  test("clamped sideways to the viewport", () => {
    expect(placeTooltip({ top: 300, bottom: 324, left: 0, width: 24 }, tip, viewport).left).toBe(8);
    expect(placeTooltip({ top: 300, bottom: 324, left: 790, width: 10 }, tip, viewport).left).toBe(800 - 120 - 8);
  });
});
