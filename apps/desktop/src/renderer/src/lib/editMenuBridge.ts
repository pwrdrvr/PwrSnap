// Edit ▸ Undo / Edit ▸ Redo bridge — connects the native app menu AND
// renderer-level keyboard shortcuts to the right undo system, focus-aware.
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
// (`webContents.undo()` / `.redo()`); they have NO connection to #1. So
// before this bridge the menu's Undo/Redo did nothing for canvas edits.
//
// This module owns BOTH input paths for one window, mounted once at the
// `App` root via `useEditMenuBridge` so it works in EVERY window —
// including library-without-an-open-editor (the search box) and the
// Settings / Sizzle windows, where only the native text-field arm is
// relevant. The editor registers its undo/redo via `registerEditorUndoRedo`
// while it is mounted.
//
//   • Keyboard (⌘Z / ⌘⇧Z, plus Ctrl+Y on Windows/Linux) is handled by a
//     renderer `keydown` listener here. This stays renderer-level on
//     purpose: a key event must drive undo even when the native menu
//     accelerator can't be reached — Playwright/CDP key injection in E2E
//     never fires native accelerators, and some windows/platforms may not
//     either. (Library Focus mode is keyboard-driven; the standalone
//     undo/redo toolbar was retired.)
//   • The native menu's Undo/Redo items (see apps/desktop/src/main/index.ts)
//     send `editUndo` / `editRedo` here. This covers the MENU CLICK and,
//     on platforms where a menu accelerator fires instead of (or in
//     addition to) the page keydown, the accelerator too.
//
// Focus rule (applied to both paths):
//   • ⌘Z / ⌘⇧Z with an editable field focused → `document.execCommand`.
//     These are registered menu accelerators, so the browser's own
//     editing default is suppressed (the reason `role: "undo"` never
//     double-undoes a text field) — we must perform the text undo
//     ourselves.
//   • Otherwise → drive the registered editor undo/redo (no-op when no
//     editor is mounted).
//   • Ctrl+Y is NOT a registered menu accelerator, so the browser default
//     is NOT suppressed: in a text field we leave the field's native
//     Ctrl+Y alone (redo on Windows/Linux, emacs "yank" on macOS); only
//     outside a text field does it drive editor redo.
//
// Double-fire guard: ⌘Z / ⌘⇧Z are registered menu accelerators AND handled
// by the keydown listener. On platforms where BOTH fire for one keypress
// the editor would undo twice. The keydown stamps the time it handled a
// direction; an ACCELERATOR-triggered menu IPC (`viaAccelerator: true`)
// arriving within `KEYBOARD_DEDUP_MS` is dropped. Menu MOUSE clicks
// (`viaAccelerator: false`) are never dropped. If the keydown never fires
// (a platform where the accelerator alone fires), no stamp is set and the
// IPC performs — single undo either way.
//
// See docs/solutions/2026-06-13-edit-menu-undo-redo-bridge.md.

import { useEffect } from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { subscribe } from "./pwrsnap";

export type EditorUndoRedoHandlers = {
  undo: () => void;
  redo: () => void;
  /** Optional capability probes. When present and a probe returns `false`,
   *  the bridge treats the editor stack as exhausted for that direction and
   *  delegates to the capture-level fallback (see
   *  `registerCaptureUndoFallback`) — so ⌘Z restores the last-deleted
   *  capture once the canvas history is empty, or immediately on a freshly
   *  opened image with nothing to undo. Omit to preserve the previous
   *  "editor always handles" behavior. */
  canUndo?: () => boolean;
  canRedo?: () => boolean;
};

/** Capture-level (library) undo fallback. Restores the most recently
 *  trashed capture when no editor history is available to consume the
 *  ⌘Z / Edit ▸ Undo. This is the grid-mode path (no editor mounted) AND
 *  the focus-mode tail (editor mounted but its stack is empty). */
export type CaptureUndoFallback = {
  undo: () => void;
  redo: () => void;
  canUndo?: () => boolean;
  canRedo?: () => boolean;
};

// Module-level singletons. Each BrowserWindow is its own renderer process
// (separate JS realm), so these are effectively per-window — no cross-window
// leakage. At most one editor is mounted per window, so a single slot is
// sufficient; "last registration wins" + identity-checked cleanup keeps
// remounts correct.
let registeredEditor: EditorUndoRedoHandlers | null = null;
let registeredCaptureFallback: CaptureUndoFallback | null = null;

/**
 * Register the editor's undo/redo with the edit-menu bridge. Returns an
 * unregister function (call from a `useEffect` cleanup). Re-register when
 * the underlying callbacks change identity — the latest wins.
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

/**
 * Register the capture-level undo fallback (library restore-last-deleted).
 * Consulted only after the editor stack reports nothing to undo/redo (or no
 * editor is registered). Returns an identity-checked unregister function.
 */
export function registerCaptureUndoFallback(
  handlers: CaptureUndoFallback
): () => void {
  registeredCaptureFallback = handlers;
  return () => {
    if (registeredCaptureFallback === handlers) {
      registeredCaptureFallback = null;
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

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Timestamps of the last keyboard-driven undo/redo, used to drop an
// accelerator-triggered menu IPC for the same physical keypress. Init to
// -Infinity so the first menu activation is never mistaken for a dup.
let lastKeyboardUndoAt = Number.NEGATIVE_INFINITY;
let lastKeyboardRedoAt = Number.NEGATIVE_INFINITY;
const KEYBOARD_DEDUP_MS = 250;

/** Reset the dedup stamps. Test-only — module state persists across tests
 *  within a file (vitest isolates per file, not per test). */
export function __resetEditMenuBridgeForTests(): void {
  lastKeyboardUndoAt = Number.NEGATIVE_INFINITY;
  lastKeyboardRedoAt = Number.NEGATIVE_INFINITY;
  registeredEditor = null;
  registeredCaptureFallback = null;
}

function performUndo(): void {
  if (activeElementIsEditable()) {
    document.execCommand("undo");
    return;
  }
  // Editor history first; delegate to the capture fallback only once the
  // editor reports nothing to undo (or no editor is mounted).
  if (registeredEditor !== null && (registeredEditor.canUndo?.() ?? true)) {
    registeredEditor.undo();
    return;
  }
  if (registeredCaptureFallback?.canUndo?.() ?? registeredCaptureFallback !== null) {
    registeredCaptureFallback?.undo();
  }
}

function performRedo(): void {
  if (activeElementIsEditable()) {
    document.execCommand("redo");
    return;
  }
  if (registeredEditor !== null && (registeredEditor.canRedo?.() ?? true)) {
    registeredEditor.redo();
    return;
  }
  if (registeredCaptureFallback?.canRedo?.() ?? registeredCaptureFallback !== null) {
    registeredCaptureFallback?.redo();
  }
}

/**
 * Install the edit-menu bridge for this window. Call exactly once at the
 * `App` root — it is mounted in every BrowserWindow so native text-field
 * undo keeps working everywhere, not only where the editor lives.
 */
export function useEditMenuBridge(): void {
  useEffect(() => {
    const offUndo = subscribe(EVENT_CHANNELS.editUndo, (payload) => {
      const viaAccelerator =
        (payload as { viaAccelerator?: boolean } | undefined)
          ?.viaAccelerator === true;
      if (viaAccelerator && nowMs() - lastKeyboardUndoAt < KEYBOARD_DEDUP_MS) {
        return;
      }
      performUndo();
    });
    const offRedo = subscribe(EVENT_CHANNELS.editRedo, (payload) => {
      const viaAccelerator =
        (payload as { viaAccelerator?: boolean } | undefined)
          ?.viaAccelerator === true;
      if (viaAccelerator && nowMs() - lastKeyboardRedoAt < KEYBOARD_DEDUP_MS) {
        return;
      }
      performRedo();
    });

    const onKey = (e: KeyboardEvent): void => {
      // Ctrl+Y (Windows/Linux redo) — deliberately NOT a menu accelerator.
      // In a text field, leave the field's native Ctrl+Y alone (redo on
      // Windows/Linux, emacs "yank" on macOS). Outside one, editor redo.
      if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.key === "y" || e.key === "Y")
      ) {
        if (activeElementIsEditable()) return;
        e.preventDefault();
        registeredEditor?.redo();
        return;
      }
      // ⌘Z / Ctrl+Z (undo) and ⌘⇧Z / Ctrl+Shift+Z (redo).
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key !== "z" && e.key !== "Z") return;
      e.preventDefault();
      if (e.shiftKey) {
        lastKeyboardRedoAt = nowMs();
        performRedo();
      } else {
        lastKeyboardUndoAt = nowMs();
        performUndo();
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      offUndo();
      offRedo();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
