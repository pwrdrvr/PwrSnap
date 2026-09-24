// useMenuNavigation — what role="menu" promises: arrow keys, Home/End and
// typeahead between enabled items; ONE Tab stop; Tab closes the menu; focus
// in on open and back out on close.

import { act, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
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
});

async function render(el: ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(el));
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} not rendered`);
  return el;
}

async function press(key: string, shiftKey = false): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(e);
  });
  return e;
}

function Menu({ onClose }: { onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useMenuNavigation({ open: true, menuRef: ref, onClose });
  return (
    <div id="menu" ref={ref} role="menu" tabIndex={-1}>
      <button role="menuitem" id="cut">
        Cut
      </button>
      <button role="menuitem" id="copy">
        Copy
      </button>
      <button role="menuitem" id="paste" aria-disabled="true" tabIndex={-1}>
        Paste
      </button>
      <div role="separator" />
      <button role="menuitem" id="delete">
        Delete
      </button>
    </div>
  );
}

function Harness(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" onClick={() => setOpen(true)}>
        Canvas
      </button>
      {open ? <Menu onClose={() => setOpen(false)} /> : null}
    </>
  );
}

async function openMenu(): Promise<void> {
  await render(<Harness />);
  byId("opener").focus();
  await act(async () => byId("opener").click());
}

describe("useMenuNavigation", () => {
  test("focus lands on the first enabled item and the menu is one Tab stop", async () => {
    await openMenu();
    expect(document.activeElement).toBe(byId("cut"));
    const stops = [...byId("menu").querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
      (el) => el.tabIndex === 0
    );
    expect(stops.map((el) => el.id)).toEqual(["cut"]);
  });

  test("ArrowDown/ArrowUp move between enabled items, wrapping, and skip disabled ones", async () => {
    await openMenu();
    await press("ArrowDown");
    expect(document.activeElement).toBe(byId("copy"));
    await press("ArrowDown");
    expect(document.activeElement).toBe(byId("delete"));
    await press("ArrowDown");
    expect(document.activeElement).toBe(byId("cut"));
    await press("ArrowUp");
    expect(document.activeElement).toBe(byId("delete"));
    // The tab stop follows focus.
    expect(byId("delete").tabIndex).toBe(0);
    expect(byId("cut").tabIndex).toBe(-1);
  });

  test("Home and End jump to the first and last enabled item", async () => {
    await openMenu();
    await press("End");
    expect(document.activeElement).toBe(byId("delete"));
    await press("Home");
    expect(document.activeElement).toBe(byId("cut"));
  });

  test("typeahead moves to the next item starting with the typed letter", async () => {
    await openMenu();
    await press("d");
    expect(document.activeElement).toBe(byId("delete"));
    // Disabled Paste is not a match.
    await press("p");
    expect(document.activeElement).toBe(byId("delete"));
  });

  test("the menu's arrows claim the key; with focus elsewhere they are left alone", async () => {
    await openMenu();
    expect((await press("ArrowDown")).defaultPrevented).toBe(true);
    byId("opener").focus();
    expect((await press("ArrowDown")).defaultPrevented).toBe(false);
  });

  test("Tab closes the menu and hands focus back to the opener, for the browser's step on", async () => {
    await openMenu();
    const e = await press("Tab");
    expect(document.getElementById("menu")).toBeNull();
    // Not claimed: the browser's own Tab, taken from the opener, is the
    // "moves on" that APG asks for.
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("opener"));
  });

  test("Shift+Tab closes it too", async () => {
    await openMenu();
    await press("Tab", true);
    expect(document.getElementById("menu")).toBeNull();
  });

  test("an item that closes the menu returns focus to the opener, not <body>", async () => {
    function ActingMenu({ onClose }: { onClose: () => void }): ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useMenuNavigation({ open: true, menuRef: ref, onClose });
      return (
        <div ref={ref} role="menu" tabIndex={-1}>
          <button role="menuitem" id="act" onClick={onClose}>
            Act
          </button>
        </div>
      );
    }
    function ActingHarness(): ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button id="opener" onClick={() => setOpen(true)}>
            open
          </button>
          {open ? <ActingMenu onClose={() => setOpen(false)} /> : null}
        </>
      );
    }
    await render(<ActingHarness />);
    byId("opener").focus();
    await act(async () => byId("opener").click());
    expect(document.activeElement).toBe(byId("act"));
    await act(async () => byId("act").click());
    expect(document.activeElement).toBe(byId("opener"));
  });

  test("a menu whose items are all disabled focuses itself, so Escape still has an owner", async () => {
    function EmptyMenu(): ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useMenuNavigation({ open: true, menuRef: ref, onClose: () => undefined });
      return (
        <div id="menu" ref={ref} role="menu" tabIndex={-1}>
          <button role="menuitem" aria-disabled="true" tabIndex={-1}>
            Paste
          </button>
        </div>
      );
    }
    await render(<EmptyMenu />);
    expect(document.activeElement).toBe(byId("menu"));
  });

  test("while focus is in the menu, app key handlers never see its keys — Escape and Tab still pass", async () => {
    // Shaped like the editor's handler: window CAPTURE, registered by a
    // component after this module loaded. It nudged the right-clicked
    // layer on ArrowDown and stopped the event, so the menu never moved.
    const seen: string[] = [];
    const editorLike = (e: KeyboardEvent): void => {
      seen.push(e.key);
      if (e.key === "ArrowDown") e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", editorLike, true);
    try {
      await openMenu();
      await press("ArrowDown");
      expect(document.activeElement).toBe(byId("copy"));
      await press("d");
      await press("Enter");
      await press("Delete");
      expect(seen).toEqual([]);
      // Outside the menu the app gets its keys back.
      byId("opener").focus();
      await press("ArrowDown");
      expect(seen).toEqual(["ArrowDown"]);
    } finally {
      window.removeEventListener("keydown", editorLike, true);
    }
  });

  test("Escape and Tab are not the menu's to stop", async () => {
    const seen = vi.fn();
    const appLike = (e: KeyboardEvent): void => seen(e.key);
    window.addEventListener("keydown", appLike, true);
    try {
      await openMenu();
      await press("Escape");
      await press("Tab");
      expect(seen.mock.calls.map(([k]) => k)).toEqual(["Escape", "Tab"]);
    } finally {
      window.removeEventListener("keydown", appLike, true);
    }
  });
});
