// useFocusTrap — the rules a trap has to get right beyond "wrap at the
// edges". Each block below is one of the four bugs PwrGit's trap had
// (pwrdrvr/PwrGit#307), plus the opener capture:
//
//   1. Stacked traps: one owner per Tab (focus holder, deepest first,
//      otherwise the newest) — or two open traps fight over every key.
//   2. Chromium's scroller Tab stops: an overflowing scroller with nothing
//      focusable inside is a stop its `tabIndex` does not report.
//   3. A menu portalled out of a trapped dialog must still close on Tab.
//   4. With focus on the container itself, Shift+Tab walked out backwards.
//
// jsdom has no sequential focus navigation: an unclaimed Tab moves nothing.
// So a test asserts either where the TRAP moved focus, or that the trap
// left the key to the browser (`defaultPrevented === false`).

import { act, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { useFocusTrap } from "../useFocusTrap";
import { useMenuNavigation } from "../useMenuNavigation";

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
  document.body.innerHTML = "";
});

async function render(el: ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(el));
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} not rendered`);
  return el as T;
}

/** Press Tab on whatever holds focus. Returns whether a handler claimed it. */
async function tab(shiftKey = false): Promise<boolean> {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const e = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true
  });
  await act(async () => {
    target.dispatchEvent(e);
  });
  return e.defaultPrevented;
}

function Trap({
  id,
  children,
  open = true
}: {
  id: string;
  children: ReactNode;
  open?: boolean;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ open, containerRef: ref });
  return (
    <div id={id} ref={ref} tabIndex={-1}>
      {children}
    </div>
  );
}

describe("useFocusTrap — edges", () => {
  test("focus moves in on open; Tab wraps last→first and Shift+Tab first→last", async () => {
    await render(
      <>
        <button id="before">before</button>
        <Trap id="dlg">
          <button id="a">a</button>
          <button id="b">b</button>
        </Trap>
        <button id="after">after</button>
      </>
    );
    expect(document.activeElement).toBe(byId("a"));
    byId("b").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("a"));
    expect(await tab(true)).toBe(true);
    expect(document.activeElement).toBe(byId("b"));
    // A middle step is the browser's, not the trap's.
    byId("a").focus();
    expect(await tab()).toBe(false);
  });

  test("focus pulled outside (programmatically) comes back to the near edge", async () => {
    await render(
      <>
        <button id="before">before</button>
        <Trap id="dlg">
          <button id="a">a</button>
          <button id="b">b</button>
        </Trap>
      </>
    );
    byId("before").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("a"));
    byId("before").focus();
    expect(await tab(true)).toBe(true);
    expect(document.activeElement).toBe(byId("b"));
  });

  test("disabled, hidden and tabindex=-1 controls are not stops", async () => {
    await render(
      <Trap id="dlg">
        <button id="a">a</button>
        <button id="b">b</button>
        <button id="disabled" disabled>
          x
        </button>
        <button id="roving" tabIndex={-1}>
          y
        </button>
        <button id="hidden" style={{ visibility: "hidden" }}>
          z
        </button>
      </Trap>
    );
    byId("b").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("a"));
  });
});

describe("useFocusTrap — the container itself (PwrGit fix 4)", () => {
  test("Shift+Tab from the focused container goes to the LAST stop, Tab to the first", async () => {
    await render(
      <>
        <button id="before">before</button>
        <Trap id="dlg">
          <button id="a">a</button>
          <button id="b">b</button>
        </Trap>
      </>
    );
    // A click on blank space, or a dialog whose controls are all disabled,
    // leaves focus on the tabIndex=-1 container: inside, but on no edge.
    byId("dlg").focus();
    expect(await tab(true)).toBe(true);
    expect(document.activeElement).toBe(byId("b"));
    byId("dlg").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("a"));
  });

  test("with nothing to cycle through, focus holds on the container", async () => {
    await render(
      <Trap id="dlg">
        <button id="a" disabled>
          a
        </button>
      </Trap>
    );
    expect(document.activeElement).toBe(byId("dlg"));
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("dlg"));
  });
});

describe("useFocusTrap — Chromium's scroller stops (PwrGit fix 2)", () => {
  /** jsdom does no layout: give the element the geometry of a scroller
   *  that overflows, and the overflow style Chromium would compute. */
  function makeScroller(el: HTMLElement): void {
    el.style.overflowY = "auto";
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 240 });
  }

  function focusScroller(el: HTMLElement): void {
    el.setAttribute("tabindex", "-1");
    el.focus();
    el.removeAttribute("tabindex");
    expect(document.activeElement).toBe(el);
  }

  test("a trailing scroller is part of the cycle: Tab from the last control reaches it", async () => {
    await render(
      <Trap id="dlg">
        <button id="a">a</button>
        <button id="b">b</button>
        <pre id="log">a long command</pre>
      </Trap>
    );
    makeScroller(byId("log"));
    byId("b").focus();
    // Not claimed: Chromium steps onto the scroller itself.
    expect(await tab()).toBe(false);
    // From the scroller — the real last stop — the trap wraps. jsdom cannot
    // focus an element with no tabindex, so put focus there the way
    // Chromium's Tab would have, then drop the attribute again: the
    // scroller's markup declares none.
    focusScroller(byId("log"));
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("a"));
  });

  test("a leading scroller is the cycle's first stop: Shift+Tab from the first control is not claimed", async () => {
    await render(
      <Trap id="dlg">
        <pre id="log">a long command</pre>
        <button id="a">a</button>
        <button id="b">b</button>
      </Trap>
    );
    makeScroller(byId("log"));
    byId("a").focus();
    expect(await tab(true)).toBe(false);
    // Tab from the last control wraps to the scroller, not to "a". (Chromium
    // focuses a keyboard-focusable scroller from script; jsdom will not, so
    // assert the trap aimed there.)
    const focusLog = vi.spyOn(byId("log"), "focus");
    byId("b").focus();
    expect(await tab()).toBe(true);
    expect(focusLog).toHaveBeenCalled();
    expect(document.activeElement).not.toBe(byId("a"));
  });

  test("a scroller that holds a focusable control is not a stop itself", async () => {
    await render(
      <Trap id="dlg">
        <button id="a">a</button>
        <div id="list">
          <button id="b">b</button>
        </div>
      </Trap>
    );
    makeScroller(byId("list"));
    byId("b").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("a"));
  });

  test("initial focus skips a leading scroller and lands on a control", async () => {
    const proto = HTMLPreElement.prototype;
    Object.defineProperty(proto, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, value: 240 });
    function ScrollerFirst(): ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap({ open: true, containerRef: ref });
      return (
        <div id="dlg" ref={ref} tabIndex={-1}>
          <pre id="log" style={{ overflowY: "auto" }}>
            text
          </pre>
          <button id="a">a</button>
        </div>
      );
    }
    try {
      await render(<ScrollerFirst />);
      expect(document.activeElement).toBe(byId("a"));
    } finally {
      delete (proto as unknown as Record<string, unknown>).scrollHeight;
      delete (proto as unknown as Record<string, unknown>).clientHeight;
    }
  });
});

describe("useFocusTrap — stacked traps resolve one owner (PwrGit fix 1)", () => {
  test("a second trap's Tab stays in the second trap; the first does not drag focus behind it", async () => {
    await render(
      <>
        <Trap id="lower">
          <button id="l1">l1</button>
          <button id="l2">l2</button>
        </Trap>
        <Trap id="upper">
          <button id="u1">u1</button>
          <button id="u2">u2</button>
        </Trap>
      </>
    );
    // The newer trap took focus on open.
    expect(document.activeElement).toBe(byId("u1"));
    byId("u2").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("u1"));
    expect(await tab(true)).toBe(true);
    expect(document.activeElement).toBe(byId("u2"));
    // A middle step inside the upper trap is not claimed by the lower one
    // (which, blind to ownership, saw focus "outside" itself and pulled it).
    byId("u1").focus();
    expect(await tab()).toBe(false);
    expect(document.activeElement).toBe(byId("u1"));
  });

  test("focus in the older trap is the older trap's; focus in neither falls to the newest", async () => {
    await render(
      <>
        <Trap id="lower">
          <button id="l1">l1</button>
          <button id="l2">l2</button>
        </Trap>
        <Trap id="upper">
          <button id="u1">u1</button>
          <button id="u2">u2</button>
        </Trap>
        <button id="outside">outside</button>
      </>
    );
    byId("l2").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("l1"));
    byId("outside").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("u1"));
  });

  test("nested traps: the deepest container holding focus wins", async () => {
    await render(
      <Trap id="outer">
        <button id="o1">o1</button>
        <Trap id="inner">
          <button id="i1">i1</button>
          <button id="i2">i2</button>
        </Trap>
        <button id="o2">o2</button>
      </Trap>
    );
    byId("i2").focus();
    expect(await tab()).toBe(true);
    expect(document.activeElement).toBe(byId("i1"));
  });
});

describe("useFocusTrap — a menu inside or portalled out of the trap (PwrGit fix 3)", () => {
  function Menu({ onClose, portal }: { onClose: () => void; portal: boolean }): ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    useMenuNavigation({ open: true, menuRef: ref, onClose });
    const menu = (
      <div id="menu" ref={ref} role="menu" tabIndex={-1}>
        <button role="menuitem" id="m1">
          Copy
        </button>
        <button role="menuitem" id="m2">
          Paste
        </button>
      </div>
    );
    return portal ? createPortal(menu, document.body) : menu;
  }

  function DialogWithMenu({ portal }: { portal: boolean }): ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    useFocusTrap({ open: true, containerRef: ref });
    return (
      <div id="dlg" ref={ref} tabIndex={-1}>
        <button id="first">first</button>
        <button id="opener" onClick={() => setMenuOpen(true)}>
          More…
        </button>
        {menuOpen ? <Menu portal={portal} onClose={() => setMenuOpen(false)} /> : null}
      </div>
    );
  }

  for (const portal of [true, false]) {
    test(`${portal ? "portalled" : "inline"} menu: Tab closes it and focus stays in the dialog`, async () => {
      await render(<DialogWithMenu portal={portal} />);
      await act(async () => byId("opener").click());
      expect(document.getElementById("menu")).not.toBeNull();
      // useMenuNavigation moved focus onto the first item. For the portalled
      // menu that is OUTSIDE the trap's container, which the trap would
      // otherwise treat as stray focus and pull back before the menu's own
      // handler could close it.
      byId("m2").focus();
      expect(await tab()).toBe(true);
      expect(document.getElementById("menu")).toBeNull();
      expect(byId("dlg").contains(document.activeElement)).toBe(true);
    });
  }
});

describe("useFocusTrap — the opener", () => {
  test("is captured during render, so an autoFocused field does not become the restore target", async () => {
    function Opener(): ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button id="opener" onClick={() => setOpen(true)}>
            open
          </button>
          {open ? <AutoFocusDialog onClose={() => setOpen(false)} /> : null}
        </>
      );
    }
    function AutoFocusDialog({ onClose }: { onClose: () => void }): ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap({ open: true, containerRef: ref });
      return (
        <div id="dlg" ref={ref} tabIndex={-1}>
          {/* autoFocus runs during commit — before any effect could look. */}
          <input id="field" autoFocus />
          <button id="close" onClick={onClose}>
            close
          </button>
        </div>
      );
    }
    await render(<Opener />);
    byId("opener").focus();
    await act(async () => byId("opener").click());
    expect(document.activeElement).toBe(byId("field"));
    await act(async () => byId("close").click());
    expect(document.activeElement).toBe(byId("opener"));
  });

  test("focus the user moved elsewhere on purpose is left there on close", async () => {
    function Harness(): ReactElement {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button id="elsewhere" onClick={() => setOpen(false)}>
            elsewhere
          </button>
          <Trap id="dlg" open={open}>
            <button id="a">a</button>
          </Trap>
        </>
      );
    }
    await render(<Harness />);
    byId("elsewhere").focus();
    await act(async () => byId("elsewhere").click());
    expect(document.activeElement).toBe(byId("elsewhere"));
  });
});
