// Chord-capture input for Settings → Hotkeys. Two states:
//   - idle: renders the current accelerator as glyphs (or "Not set"
//     when the binding is unbound / empty), plus a small "X" to
//     clear and a click-to-record affordance.
//   - recording: renders "Press a chord…" + Cancel, listens for the
//     next real keydown, builds the Electron accelerator string,
//     calls `onCommit`. Escape cancels without saving.
//
// We deliberately keep the keyboard listener attached only while
// `recording === true` so global page shortcuts (⌘W, ⌘Z, etc.) are
// only suppressed during the brief capture window.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Hk, HkUnset } from "./Hk";
import { acceleratorToDisplayKeys } from "../pages/hotkeys-display";

export type HotkeyCaptureProps = {
  /** The current accelerator (e.g. `CommandOrControl+Shift+C`). Empty
   *  string = unbound. */
  value: string;
  /** Called when the user successfully records a chord. The string is
   *  Electron-accelerator-formatted. */
  onCommit: (next: string) => void | Promise<void>;
  /** Called when the user clicks the "X" next to a bound chord. */
  onUnbind?: () => void | Promise<void>;
};

/** Translate a renderer-side KeyboardEvent into an Electron-canonical
 *  accelerator string. Returns `null` for "modifier-only" events
 *  (Shift held, no real key yet) — the caller keeps listening.
 *
 *  Exported for unit testing.
 */
export function accelFromKeyboardEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  // Modifier-only — wait for a real key.
  if (
    key === "Control" ||
    key === "Alt" ||
    key === "Shift" ||
    key === "Meta" ||
    key === "OS" ||
    key === "Hyper" ||
    key === "Super"
  ) {
    return null;
  }

  const parts: string[] = [];
  // We emit `CommandOrControl` for the platform-cmd modifier so the
  // same accelerator works on both macOS (⌘) and Windows/Linux (Ctrl).
  // `Control` on macOS maps to literal ⌃ — keep it distinct.
  if (event.metaKey || (event.ctrlKey && navigator.platform.startsWith("Mac") === false)) {
    parts.push("CommandOrControl");
  } else if (event.ctrlKey) {
    parts.push("Control");
  }
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const keyPart = normalizeKey(key);
  if (keyPart === null) return null;
  parts.push(keyPart);

  // Reject pure-key chords (no modifiers) — they'd swallow normal
  // typing globally. Force the user to include at least one modifier.
  if (parts.length < 2) return null;
  return parts.join("+");
}

/** Map a renderer `event.key` value to Electron's accelerator key
 *  token. Returns null for keys we shouldn't accept (modifier-only,
 *  dead keys, etc.). */
function normalizeKey(key: string): string | null {
  if (key.length === 0) return null;
  if (key.length === 1) {
    // Single character — uppercase letters; digits + punctuation pass
    // through as-is. Spaces become the named token "Space".
    if (key === " ") return "Space";
    return key.toUpperCase();
  }
  switch (key) {
    case "Enter":
      return "Return";
    case "Escape":
      return "Escape";
    case "Tab":
      return "Tab";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Home":
      return "Home";
    case "End":
      return "End";
    case "PageUp":
      return "PageUp";
    case "PageDown":
      return "PageDown";
    case "Insert":
      return "Insert";
    default:
      // Function keys F1..F24.
      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
      // Anything else (dead keys, Unidentified, IME composition) —
      // reject; the caller keeps listening.
      return null;
  }
}

export function HotkeyCapture({
  value,
  onCommit,
  onUnbind
}: HotkeyCaptureProps): ReactElement {
  const [recording, setRecording] = useState<boolean>(false);

  const stopRecording = useCallback((): void => {
    setRecording(false);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Escape cancels regardless of modifiers.
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        stopRecording();
        return;
      }
      const accel = accelFromKeyboardEvent(event);
      if (accel === null) {
        // Modifier-only / unsupported key — swallow so the chord
        // doesn't trigger something else, but keep listening.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      stopRecording();
      void onCommit(accel);
    };
    // `capture: true` so we win over any other listener on the window
    // (e.g. a future keymap on the Settings shell). The listener is
    // only attached while recording is true; otherwise it's a no-op.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [recording, stopRecording, onCommit]);

  if (recording) {
    return (
      <span className="pss__hk-capture is-recording">
        <span className="pss__hk-capture-hint">Press a chord… (Esc to cancel)</span>
        <button
          type="button"
          className="pss__hk-capture-cancel"
          onClick={stopRecording}
          aria-label="Cancel recording"
        >
          Cancel
        </button>
      </span>
    );
  }

  const glyphs = acceleratorToDisplayKeys(value);
  return (
    <span className="pss__hk-capture">
      <button
        type="button"
        className="pss__hk-capture-trigger"
        onClick={() => setRecording(true)}
        aria-label={value === "" ? "Set hotkey" : `Change hotkey (currently ${value})`}
      >
        {glyphs.length === 0 ? <HkUnset /> : <Hk keys={glyphs} />}
      </button>
      {value !== "" && onUnbind !== undefined ? (
        <button
          type="button"
          className="pss__hk-capture-clear"
          onClick={() => void onUnbind()}
          aria-label="Clear hotkey"
          title="Clear hotkey"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
