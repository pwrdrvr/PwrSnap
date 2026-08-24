// Keyboard model for the video stage — a pure `KeyboardEvent`-shape →
// `TransportIntent` mapper so the bindings are unit-testable without
// mounting a <video>. `VideoStage.tsx` runs the resulting intent
// against the element.
//
// Bindings (viewer focused, no text input focused, no ⌘/⌃/⌥):
//   space        toggle play / pause
//   J / K / L    shuttle back · pause · shuttle forward (repeat = faster)
//   ← / →        step one frame (1/fps; 1/30 s fallback)
//   ⇧← / ⇧→      step one second
//   I / O        set trim in / out at the playhead
//   Home / End   seek to start / end
//
// ←/→ deliberately shadow the Library's prev/next-capture navigation
// while the viewer has focus — the stage stops propagation so the
// window-level handler never sees them. Everything else (Esc, ⌘F,
// ⌘[ / ⌘]) falls through untouched.
//
// "while the viewer has focus" is load-bearing: Focus mode autofocuses
// the stage on mount, Reel mode does NOT (Reel's ←/→ walk the
// filmstrip between captures until the user clicks into the video).
// See `VideoStage.tsx`'s focus effect.

import { acceleratorToDisplayKeys, type ShortcutPlatform } from "@pwrsnap/shared";

export type TransportIntent =
  | { type: "togglePlay" }
  | { type: "pause" }
  | { type: "shuttle"; direction: -1 | 1 }
  | { type: "step"; frames: number }
  | { type: "seekBy"; seconds: number }
  | { type: "setIn" }
  | { type: "setOut" }
  | { type: "seekStart" }
  | { type: "seekEnd" };

export type KeyLike = {
  key: string;
  code?: string | undefined;
  shiftKey?: boolean | undefined;
  metaKey?: boolean | undefined;
  ctrlKey?: boolean | undefined;
  altKey?: boolean | undefined;
  repeat?: boolean | undefined;
};

/** True when a text-entry element owns focus — the transport must not
 *  eat keystrokes typed into the search box, a title field, etc. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as Partial<HTMLElement> & { tagName?: string; isContentEditable?: boolean };
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/**
 * Map a key event to a transport intent, or `null` when the key is not
 * ours (caller lets it propagate). Modifier keys other than shift on
 * the arrows disqualify — those combos belong to the app / OS.
 */
export function transportIntentForKey(event: KeyLike): TransportIntent | null {
  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) return null;
  const key = event.key;
  switch (key) {
    case " ":
    case "Spacebar":
      return { type: "togglePlay" };
    case "ArrowLeft":
      return event.shiftKey === true ? { type: "seekBy", seconds: -1 } : { type: "step", frames: -1 };
    case "ArrowRight":
      return event.shiftKey === true ? { type: "seekBy", seconds: 1 } : { type: "step", frames: 1 };
    case "Home":
      return { type: "seekStart" };
    case "End":
      return { type: "seekEnd" };
    default:
      break;
  }
  if (event.shiftKey === true) return null;
  switch (key.toLowerCase()) {
    case "j":
      return { type: "shuttle", direction: -1 };
    case "k":
      return { type: "pause" };
    case "l":
      return { type: "shuttle", direction: 1 };
    case "i":
      return { type: "setIn" };
    case "o":
      return { type: "setOut" };
    default:
      return null;
  }
}

/** Shuttle rate ladder for repeated J / L presses. */
export const SHUTTLE_RATES: readonly number[] = [1, 2, 4, 8];

/** Next shuttle rate: same direction advances the ladder (capped);
 *  opposite direction or from-pause restarts at 1×. */
export function nextShuttleRate(
  current: { direction: -1 | 1; rate: number } | null,
  direction: -1 | 1
): number {
  if (current === null || current.direction !== direction) return SHUTTLE_RATES[0]!;
  const idx = SHUTTLE_RATES.indexOf(current.rate);
  return SHUTTLE_RATES[Math.min(idx + 1, SHUTTLE_RATES.length - 1)]!;
}

/** Hover hints for the transport buttons' `title`s. */
export function videoTransportKeyHints(platform: ShortcutPlatform) {
  const shift = acceleratorToDisplayKeys("Shift", platform)[0] ?? "Shift";
  return {
    play: "Play / pause (space) · J shuttle back · K pause · L shuttle forward",
    step: `← / → step one frame · ${shift}← / ${shift}→ step one second · Home / End`,
    trim: "I set in · O set out at the playhead",
    loop: "Loop playback inside the trim range",
    mute: "Mute / unmute",
    fullscreen: "Fullscreen"
  } as const;
}
