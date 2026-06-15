// Tests the Edit ▸ Undo / Edit ▸ Redo renderer bridge: keyboard and the
// menu (`editUndo` / `editRedo` IPC) both route to native text undo
// (editable field focused) vs the registered editor undo (otherwise),
// with an accelerator-vs-keydown double-fire guard. Also covers the
// Windows/Linux Ctrl+Y redo keydown path.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import {
  __resetEditMenuBridgeForTests,
  registerCaptureUndoFallback,
  registerEditorUndoRedo,
  useEditMenuBridge
} from "../editMenuBridge";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;
let unregisterEditor: (() => void) | null = null;
let unregisterFallback: (() => void) | null = null;
/** channel → set of subscriber handlers, populated by the mocked
 *  `window.pwrsnapApi.on`. */
const handlers = new Map<string, Set<(payload: unknown) => void>>();

/** Simulate a main → renderer `editUndo`/`editRedo` send. `viaAccelerator`
 *  mirrors what the menu item's `click` forwards (true = keyboard
 *  accelerator, false/absent = mouse click). */
function emit(channel: string, viaAccelerator?: boolean): void {
  const payload = viaAccelerator === undefined ? undefined : { viaAccelerator };
  for (const handler of handlers.get(channel) ?? []) {
    handler(payload);
  }
}

/** Register a spy editor and track it for afterEach cleanup so the
 *  module singleton doesn't leak across tests. */
function registerSpyEditor(editor: {
  undo: () => void;
  redo: () => void;
  canUndo?: () => boolean;
  canRedo?: () => boolean;
}): void {
  unregisterEditor = registerEditorUndoRedo(editor);
}

/** Register a spy capture-level fallback, tracked for afterEach cleanup. */
function registerSpyFallback(fallback: {
  undo: () => void;
  redo: () => void;
  canUndo?: () => boolean;
  canRedo?: () => boolean;
}): void {
  unregisterFallback = registerCaptureUndoFallback(fallback);
}

beforeEach(() => {
  __resetEditMenuBridgeForTests();
  handlers.clear();
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch: vi.fn(),
    on: (channel: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  // jsdom's execCommand is a no-op returning false; replace with a spy.
  document.execCommand = vi.fn(() => true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  unregisterEditor?.();
  unregisterEditor = null;
  unregisterFallback?.();
  unregisterFallback = null;
});

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function Harness(): null {
  useEditMenuBridge();
  return null;
}

function mount(): void {
  act(() => {
    root.render(createElement(Harness));
  });
}

describe("useEditMenuBridge — menu IPC path", () => {
  test("editUndo drives the registered editor undo when no editable is focused", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    registerSpyEditor({ undo, redo });
    mount();

    act(() => emit(EVENT_CHANNELS.editUndo));

    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test("editRedo drives the registered editor redo when no editable is focused", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    registerSpyEditor({ undo, redo });
    mount();

    act(() => emit(EVENT_CHANNELS.editRedo));

    expect(redo).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });

  test("editUndo performs native text undo (execCommand) when an input is focused, NOT editor undo", () => {
    const undo = vi.fn();
    registerSpyEditor({ undo, redo: vi.fn() });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    mount();

    act(() => emit(EVENT_CHANNELS.editUndo));

    expect(document.execCommand).toHaveBeenCalledWith("undo");
    expect(undo).not.toHaveBeenCalled();
  });

  test("after unregister, editUndo is a no-op (no editor) and doesn't throw", () => {
    const undo = vi.fn();
    const unregister = registerEditorUndoRedo({ undo, redo: vi.fn() });
    unregister();
    mount();

    act(() => emit(EVENT_CHANNELS.editUndo));

    expect(undo).not.toHaveBeenCalled();
  });
});

describe("useEditMenuBridge — keyboard path", () => {
  test("⌘Z / Ctrl+Z keydown drives editor undo (renderer-level, E2E path)", () => {
    const undo = vi.fn();
    registerSpyEditor({ undo, redo: vi.fn() });
    mount();

    const meta = pressKey({ key: "z", metaKey: true });
    const ctrl = pressKey({ key: "z", ctrlKey: true });

    expect(undo).toHaveBeenCalledTimes(2);
    expect(meta.defaultPrevented).toBe(true);
    expect(ctrl.defaultPrevented).toBe(true);
  });

  test("⌘⇧Z keydown drives editor redo", () => {
    const redo = vi.fn();
    registerSpyEditor({ undo: vi.fn(), redo });
    mount();

    pressKey({ key: "z", metaKey: true, shiftKey: true });

    expect(redo).toHaveBeenCalledTimes(1);
  });

  test("⌘Z keydown in a text field does native text undo, not editor undo", () => {
    const undo = vi.fn();
    registerSpyEditor({ undo, redo: vi.fn() });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    mount();

    pressKey({ key: "z", metaKey: true });

    expect(document.execCommand).toHaveBeenCalledWith("undo");
    expect(undo).not.toHaveBeenCalled();
  });

  test("Ctrl+Y keydown drives editor redo outside a text field", () => {
    const redo = vi.fn();
    registerSpyEditor({ undo: vi.fn(), redo });
    mount();

    pressKey({ key: "y", ctrlKey: true });

    expect(redo).toHaveBeenCalledTimes(1);
  });

  test("Ctrl+Y in a text field is left to native handling — no editor redo, no preventDefault", () => {
    const redo = vi.fn();
    registerSpyEditor({ undo: vi.fn(), redo });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    mount();

    const event = pressKey({ key: "y", ctrlKey: true });

    expect(redo).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
    // Native Ctrl+Y (Windows/Linux redo, macOS yank) must survive.
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("useEditMenuBridge — capture-level undo fallback", () => {
  test("⌘Z restores the last-deleted capture when no editor is mounted (grid mode)", () => {
    const undo = vi.fn();
    registerSpyFallback({ undo, redo: vi.fn(), canUndo: () => true, canRedo: () => false });
    mount();

    pressKey({ key: "z", metaKey: true });

    expect(undo).toHaveBeenCalledTimes(1);
  });

  test("⌘Z is a no-op when the fallback reports nothing to restore", () => {
    const undo = vi.fn();
    registerSpyFallback({ undo, redo: vi.fn(), canUndo: () => false, canRedo: () => false });
    mount();

    pressKey({ key: "z", metaKey: true });

    expect(undo).not.toHaveBeenCalled();
  });

  test("editor undo wins while its stack has entries; fallback is untouched", () => {
    const editorUndo = vi.fn();
    const fallbackUndo = vi.fn();
    registerSpyEditor({ undo: editorUndo, redo: vi.fn(), canUndo: () => true, canRedo: () => true });
    registerSpyFallback({
      undo: fallbackUndo,
      redo: vi.fn(),
      canUndo: () => true,
      canRedo: () => false
    });
    mount();

    pressKey({ key: "z", metaKey: true });

    expect(editorUndo).toHaveBeenCalledTimes(1);
    expect(fallbackUndo).not.toHaveBeenCalled();
  });

  test("⌘Z delegates to the capture fallback once the editor stack is empty", () => {
    const editorUndo = vi.fn();
    const fallbackUndo = vi.fn();
    registerSpyEditor({ undo: editorUndo, redo: vi.fn(), canUndo: () => false, canRedo: () => false });
    registerSpyFallback({
      undo: fallbackUndo,
      redo: vi.fn(),
      canUndo: () => true,
      canRedo: () => false
    });
    mount();

    pressKey({ key: "z", metaKey: true });

    expect(editorUndo).not.toHaveBeenCalled();
    expect(fallbackUndo).toHaveBeenCalledTimes(1);
  });

  test("a focused text field still takes native undo over the capture fallback", () => {
    const fallbackUndo = vi.fn();
    registerSpyFallback({ undo: fallbackUndo, redo: vi.fn(), canUndo: () => true, canRedo: () => false });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    mount();

    pressKey({ key: "z", metaKey: true });

    expect(document.execCommand).toHaveBeenCalledWith("undo");
    expect(fallbackUndo).not.toHaveBeenCalled();
  });

  test("⌘⇧Z does not re-delete via the fallback (redo is disabled)", () => {
    const fallbackRedo = vi.fn();
    registerSpyFallback({
      undo: vi.fn(),
      redo: fallbackRedo,
      canUndo: () => true,
      canRedo: () => false
    });
    mount();

    pressKey({ key: "z", metaKey: true, shiftKey: true });

    expect(fallbackRedo).not.toHaveBeenCalled();
  });
});

describe("useEditMenuBridge — double-fire guard", () => {
  test("an accelerator editUndo IPC right after a keyboard ⌘Z is dropped (single undo)", () => {
    const undo = vi.fn();
    registerSpyEditor({ undo, redo: vi.fn() });
    mount();

    // The keydown fires first (synchronous), then the menu accelerator's
    // IPC arrives a tick later for the same physical keypress.
    pressKey({ key: "z", metaKey: true });
    act(() => emit(EVENT_CHANNELS.editUndo, true));

    expect(undo).toHaveBeenCalledTimes(1);
  });

  test("a mouse-click editUndo IPC is NOT dropped even right after a keyboard ⌘Z", () => {
    const undo = vi.fn();
    registerSpyEditor({ undo, redo: vi.fn() });
    mount();

    pressKey({ key: "z", metaKey: true });
    act(() => emit(EVENT_CHANNELS.editUndo, false));

    expect(undo).toHaveBeenCalledTimes(2);
  });

  test("an accelerator editUndo IPC with no preceding keydown performs (menu-only platform)", () => {
    const undo = vi.fn();
    registerSpyEditor({ undo, redo: vi.fn() });
    mount();

    act(() => emit(EVENT_CHANNELS.editUndo, true));

    expect(undo).toHaveBeenCalledTimes(1);
  });
});
