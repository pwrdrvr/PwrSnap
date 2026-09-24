// useDismissable — one Escape, one overlay.
//
// The owner is whichever registered overlay holds focus (deepest wins, its
// trigger counts), else the newest when focus is nowhere in particular. And
// a claimed Escape is STOPPED, because PwrSnap's own Escape handlers — the
// Library's "leave Focus / collapse the rail", the editor's "clear the
// selection" — are window listeners that never check `defaultPrevented`.

import { act, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { useDismissable } from "../useDismissable";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const cleanups: Array<() => void> = [];

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  for (const undo of cleanups.splice(0)) undo();
  document.body.innerHTML = "";
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

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(e);
  });
  return e;
}

/** A listener shaped like the app's own: registered by a component AFTER
 *  this module was imported, not checking `defaultPrevented`. */
function appListener(capture: boolean): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  const fn = (e: KeyboardEvent): void => {
    if (e.key === "Escape") spy();
  };
  window.addEventListener("keydown", fn, capture);
  cleanups.push(() => window.removeEventListener("keydown", fn, capture));
  return spy;
}

function Overlay({
  id,
  onDismiss,
  children,
  trigger
}: {
  id: string;
  onDismiss: () => void;
  children?: ReactNode;
  /** Label of a trigger button rendered before the surface. */
  trigger?: string;
}): ReactElement {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismissable({
    open: true,
    onDismiss,
    surfaceRef,
    ...(trigger === undefined ? {} : { triggerRef })
  });
  return (
    <>
      {trigger === undefined ? null : (
        <button id="trigger" ref={triggerRef}>
          {trigger}
        </button>
      )}
      <div id={id} ref={surfaceRef}>
        {children}
      </div>
    </>
  );
}

describe("useDismissable — which overlay answers", () => {
  test("a menu open inside a dialog: Escape closes the menu only", async () => {
    const dialog = vi.fn();
    const menu = vi.fn();
    await render(
      <Overlay id="dialog" onDismiss={dialog}>
        <button id="in-dialog">x</button>
        <Overlay id="menu" onDismiss={menu}>
          <button id="item">Copy</button>
        </Overlay>
      </Overlay>
    );
    byId("item").focus();
    await press("Escape");
    expect(menu).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveBeenCalled();
  });

  test("siblings: the one holding focus wins, whatever order they opened in", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await render(
      <>
        <Overlay id="first" onDismiss={first}>
          <button id="in-first">x</button>
        </Overlay>
        <Overlay id="second" onDismiss={second}>
          <button id="in-second">y</button>
        </Overlay>
      </>
    );
    byId("in-first").focus();
    await press("Escape");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  test("focus nowhere in particular (<body>) falls to the newest overlay", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await render(
      <>
        <Overlay id="first" onDismiss={first} />
        <Overlay id="second" onDismiss={second} />
      </>
    );
    (document.activeElement as HTMLElement | null)?.blur();
    await press("Escape");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  test("focus in something that is not a registered overlay claims nothing", async () => {
    const onDismiss = vi.fn();
    const bubble = appListener(false);
    await render(
      <>
        <input id="search" />
        <Overlay id="popover" onDismiss={onDismiss} />
      </>
    );
    byId("search").focus();
    const e = await press("Escape");
    expect(onDismiss).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(bubble).toHaveBeenCalledTimes(1);
  });

  test("the trigger counts as inside, and focus returns to it", async () => {
    const onDismiss = vi.fn();
    await render(
      <Overlay id="popover" onDismiss={onDismiss} trigger="Storage">
        <button id="clear">Clear</button>
      </Overlay>
    );
    byId("trigger").focus();
    await press("Escape");
    expect(onDismiss).toHaveBeenCalledTimes(1);

    byId("clear").focus();
    await press("Escape");
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(byId("trigger"));
  });

  test("an Escape that ends an IME composition is the field's, not the overlay's", async () => {
    const onDismiss = vi.fn();
    await render(
      <Overlay id="dialog" onDismiss={onDismiss}>
        <input id="field" />
      </Overlay>
    );
    byId("field").focus();
    await press("Escape", { isComposing: true });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("useDismissable — a claimed Escape goes no further", () => {
  test("app handlers on window, capture AND bubble, never see it", async () => {
    // The editor listens on window-capture and the Library on window-bubble,
    // both registered by components that mounted after this module loaded.
    const editorLike = appListener(true);
    const libraryLike = appListener(false);
    const onDismiss = vi.fn();
    await render(
      <Overlay id="menu" onDismiss={onDismiss}>
        <button id="item">Copy</button>
      </Overlay>
    );
    byId("item").focus();
    const e = await press("Escape");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(editorLike).not.toHaveBeenCalled();
    expect(libraryLike).not.toHaveBeenCalled();
  });

  test("with no overlay open, Escape reaches the app untouched", async () => {
    const libraryLike = appListener(false);
    await render(<button id="plain">plain</button>);
    byId("plain").focus();
    const e = await press("Escape");
    expect(e.defaultPrevented).toBe(false);
    expect(libraryLike).toHaveBeenCalledTimes(1);
  });

  test("a closed overlay has unregistered", async () => {
    const onDismiss = vi.fn();
    function Toggle(): ReactElement {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button id="close" onClick={() => setOpen(false)}>
            close
          </button>
          {open ? <Overlay id="menu" onDismiss={onDismiss} /> : null}
        </>
      );
    }
    await render(<Toggle />);
    await act(async () => byId("close").click());
    (document.activeElement as HTMLElement | null)?.blur();
    await press("Escape");
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("useDismissable — dismissOnFocusLeave", () => {
  function Popover({ onDismiss }: { onDismiss: () => void }): ReactElement {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    useDismissable({ open: true, onDismiss, surfaceRef, triggerRef, dismissOnFocusLeave: true });
    return (
      <>
        <button id="trigger" ref={triggerRef}>
          Zoom
        </button>
        <div id="popover" ref={surfaceRef}>
          <button id="fit">Fit</button>
          <button id="plus">+</button>
        </div>
        <button id="next">next tool</button>
      </>
    );
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  test("focus moving to a real element outside closes it — after the move has landed", async () => {
    const onDismiss = vi.fn();
    await render(<Popover onDismiss={onDismiss} />);
    byId("plus").focus();
    byId("next").focus();
    // Not synchronously: closing mid-move would unmount the popover while
    // focus is on <body>, and a focus return would pull it back.
    expect(onDismiss).not.toHaveBeenCalled();
    await settle();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("moving within the popover, or back onto its trigger, keeps it open", async () => {
    const onDismiss = vi.fn();
    await render(<Popover onDismiss={onDismiss} />);
    byId("plus").focus();
    byId("fit").focus();
    byId("trigger").focus();
    await settle();
    expect(onDismiss).not.toHaveBeenCalled();
    // …and leaving from the trigger counts as leaving.
    byId("next").focus();
    await settle();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("losing focus to nothing (a click on padding, the window blurring) does not close it", async () => {
    const onDismiss = vi.fn();
    await render(<Popover onDismiss={onDismiss} />);
    byId("plus").focus();
    byId("plus").blur();
    await settle();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
