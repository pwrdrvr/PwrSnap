// Tests the Edit ▸ Undo / Edit ▸ Redo renderer bridge: the menu sends
// `editUndo` / `editRedo`, and the bridge routes to native text undo
// (editable field focused) vs the registered editor undo (otherwise).
// Also covers the Windows/Linux Ctrl+Y redo keydown path.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { registerEditorUndoRedo, useEditMenuBridge } from "../editMenuBridge";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;
/** channel → set of subscriber handlers, populated by the mocked
 *  `window.pwrsnapApi.on`. */
const handlers = new Map<string, Set<(payload: unknown) => void>>();

function emit(channel: string): void {
  for (const handler of handlers.get(channel) ?? []) {
    handler(undefined);
  }
}

beforeEach(() => {
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
});

function Harness(): null {
  useEditMenuBridge();
  return null;
}

function mount(): void {
  act(() => {
    root.render(createElement(Harness));
  });
}

describe("useEditMenuBridge", () => {
  test("editUndo drives the registered editor undo when no editable is focused", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    registerEditorUndoRedo({ undo, redo });
    mount();

    act(() => emit(EVENT_CHANNELS.editUndo));

    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test("editRedo drives the registered editor redo when no editable is focused", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    registerEditorUndoRedo({ undo, redo });
    mount();

    act(() => emit(EVENT_CHANNELS.editRedo));

    expect(redo).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });

  test("editUndo performs native text undo (execCommand) when an input is focused, NOT editor undo", () => {
    const undo = vi.fn();
    registerEditorUndoRedo({ undo, redo: vi.fn() });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    mount();

    act(() => emit(EVENT_CHANNELS.editUndo));

    expect(document.execCommand).toHaveBeenCalledWith("undo");
    expect(undo).not.toHaveBeenCalled();
  });

  test("Ctrl+Y keydown drives editor redo (Windows/Linux convention)", () => {
    const redo = vi.fn();
    registerEditorUndoRedo({ undo: vi.fn(), redo });
    mount();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "y",
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(redo).toHaveBeenCalledTimes(1);
  });

  test("Ctrl+Y in a text field is left to native handling — no editor redo, no preventDefault", () => {
    const redo = vi.fn();
    registerEditorUndoRedo({ undo: vi.fn(), redo });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    mount();

    const event = new KeyboardEvent("keydown", {
      key: "y",
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(redo).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
    // Native Ctrl+Y (Windows/Linux redo, macOS yank) must survive.
    expect(event.defaultPrevented).toBe(false);
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
