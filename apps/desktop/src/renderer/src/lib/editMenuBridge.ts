// Edit ▸ Undo / Edit ▸ Redo bridge — connects the native app menu (and
// the Windows/Linux Ctrl+Y redo accelerator) to the right undo system,
// focus-aware.
//
// Why this exists
// ───────────────
// There are two unrelated "undo" systems in the app:
//
//   1. The editor's renderer-side undo stack (`useUndoRedo`) — crop,
//      arrow, geometry, style, every canvas annotation.
//   2. The browser's native edit-undo for editable DOM (search box,
//      library chat, OCR field, settings inputs).
//
// Electron's `role: "undo"` / `role: "redo"` menu items only reach #2
// (`webContents.undo()` / `.redo()`); they have NO connection to #1.
// So before this bridge, Edit ▸ Undo did nothing for canvas operations.
//
// The fix: the menu's Undo/Redo items are custom items (see
// apps/desktop/src/main/index.ts) that send `editUndo` / `editRedo` to
// the focused window. This module is the single renderer-side receiver,
// mounted once per BrowserWindow at the `App` root so it works in EVERY
// window — including library-without-an-open-editor (the search box) and
// the Settings / Sizzle windows, where only the native text-field arm
// is relevant. The editor registers its undo/redo via
// `registerEditorUndoRedo` while it is mounted.
//
// Focus rule (applied identically on the menu path and the Ctrl+Y path):
//   • editable field focused → `document.execCommand("undo" | "redo")`.
//     The browser's own editing default for ⌘Z/⌘⇧Z is suppressed once
//     those combos are registered as menu accelerators (this is why
//     `role: "undo"` never double-applies in a text field), so we must
//     perform the text undo ourselves here. Same for the Ctrl+Y keydown
//     path, where `preventDefault()` suppresses the native default.
//   • otherwise → drive the registered editor undo/redo (no-op when no
//     editor is mounted).
//
// See docs/solutions/2026-06-13-edit-menu-undo-redo-bridge.md.

import { useEffect } from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { subscribe } from "./pwrsnap";

export type EditorUndoRedoHandlers = {
  undo: () => void;
  redo: () => void;
};

// Module-level singleton. Each BrowserWindow is its own renderer
// process (separate JS realm), so this is effectively per-window — no
// cross-window leakage. At most one editor is mounted per window, so a
// single slot is sufficient; "last registration wins" + identity-checked
// cleanup keeps remounts correct.
let registeredEditor: EditorUndoRedoHandlers | null = null;

/**
 * Register the editor's undo/redo with the edit-menu bridge. Returns an
 * unregister function (call from a `useEffect` cleanup). Re-register
 * when the underlying callbacks change identity — the latest wins.
 */
export function registerEditorUndoRedo(
  handlers: EditorUndoRedoHandlers
): () => void {
  registeredEditor = handlers;
  return () => {
    if (registeredEditor === handlers) {
      registeredEditor = null;
    }
  };
}

function activeElementIsEditable(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el === null) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable === true
  );
}

function runEditUndo(): void {
  if (activeElementIsEditable()) {
    document.execCommand("undo");
    return;
  }
  registeredEditor?.undo();
}

function runEditRedo(): void {
  if (activeElementIsEditable()) {
    document.execCommand("redo");
    return;
  }
  registeredEditor?.redo();
}

/**
 * Install the edit-menu bridge for this window. Call exactly once at the
 * `App` root — it is mounted in every BrowserWindow so native text-field
 * undo keeps working everywhere, not only where the editor lives.
 */
export function useEditMenuBridge(): void {
  useEffect(() => {
    const offUndo = subscribe(EVENT_CHANNELS.editUndo, () => {
      runEditUndo();
    });
    const offRedo = subscribe(EVENT_CHANNELS.editRedo, () => {
      runEditRedo();
    });

    // Windows/Linux Ctrl+Y redo convention. The Edit ▸ Redo menu item
    // carries CmdOrCtrl+Shift+Z — a single menu item can only display
    // (and register) one accelerator — so Ctrl+Y is handled here in the
    // renderer. It is deliberately NOT a registered menu accelerator, so
    // this listener cannot double-fire against the menu.
    //
    // When a text field is focused we DON'T touch it: the field keeps its
    // native Ctrl+Y (redo on Windows/Linux, emacs "yank" on macOS) — this
    // mirrors the editable guard of the keydown listener this bridge
    // replaced, so no key binding regresses. Outside a text field, Ctrl+Y
    // drives the editor redo stack only (never execCommand). The ⌘⇧Z menu
    // accelerator still covers redo inside text fields (via execCommand),
    // so editable redo isn't lost.
    const onKey = (e: KeyboardEvent): void => {
      if (
        !e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.key !== "y" && e.key !== "Y")
      ) {
        return;
      }
      if (activeElementIsEditable()) return;
      e.preventDefault();
      registeredEditor?.redo();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      offUndo();
      offRedo();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
