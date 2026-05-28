// Main-process clipboard-write event bus.
//
// PURPOSE
// ───────
// Issue #139 — clicking "Copy MED" on a capture wrote bytes to the OS
// clipboard, but the "File > New > Paste from Clipboard" menu item
// stayed disabled. The menu refreshed via Electron's `menu-will-show`,
// which only fires when the user opens the menu — and on macOS the
// app-menu state visibly lags even after the listener runs.
//
// Fix: any code path in the main process that writes an image to the
// clipboard fires `notifyClipboardChanged()`. Subscribers (the menu
// refresh, the renderer broadcast) react immediately. The menu is
// already enabled by the time the user opens the File menu.
//
// CONTRACT
// ────────
// Fire AFTER the `clipboard.write*` call returns. Listeners may
// re-read the clipboard (e.g. `clipboard.readImage()`); they must see
// the write that triggered the event.
//
// Synchronous: handlers run on the same tick as `emit`. Don't do
// blocking work inside a handler — schedule it.
//
// SCOPE
// ─────
// Covers OUR writes only. Writes from other apps still surface
// through the existing `menu-will-show` listener (re-reads clipboard
// on open) and through the BrowserWindow focus handler. A future
// improvement would poll NSPasteboard's changeCount on focus to
// cover the external-write case more aggressively.

import { EventEmitter } from "node:events";

// One slot, one event type. Strong-type the listener signature so a
// future kind: "wrote-image" | "wrote-text" expansion gets compile-
// time coverage at the call sites.
type ClipboardEventKind = "changed";

class TypedClipboardEmitter extends EventEmitter {
  // Accept `(...args: any[]) => void` (Node's EventEmitter listener
  // signature) rather than `() => void` so vitest mocks + spies work
  // without per-call casts. The kind itself is the signal — listeners
  // ignore any args.
  on(event: ClipboardEventKind, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
  off(event: ClipboardEventKind, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
  emit(event: ClipboardEventKind): boolean {
    return super.emit(event);
  }
}

/** Module-level singleton. Subscribers register at startup; writers
 *  emit after each successful clipboard write. */
export const clipboardEvents = new TypedClipboardEmitter();
// Default Node max-listeners is 10; raise here in case future
// renderers / features hook in. Each window adds one subscription
// for the renderer broadcast, plus the menu refresh, plus any test
// listeners.
clipboardEvents.setMaxListeners(50);

/** Idiomatic shorthand — saves callers from importing EventEmitter
 *  semantics. */
export function notifyClipboardChanged(): void {
  clipboardEvents.emit("changed");
}
