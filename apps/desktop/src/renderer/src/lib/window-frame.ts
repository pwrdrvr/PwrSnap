// This window's maximize state, shared by everything that draws from it.
//
// Two surfaces need it and neither can ask the DOM: the Linux caption button
// picks its glyph from it, and the window hairline — the edge Electron gives a
// frameless Linux window none of — has to disappear once the frame is flush
// with the screen. The window manager maximizes windows without going through
// our buttons (a double-click on the drag region, Super+Up, a tiling keybind),
// so main pushes the changes and this follows them.
//
// One subscription per window, started from `main.tsx` beside the other
// document-level stamps, because EVERY window kind needs the attribute —
// including the ones that render no title bar of ours. The attribute is how
// library.css reads it; `subscribeWindowFrame` is how components do.
//
// Linux only: nothing else paints from this, and on macOS and Windows the
// subscription would be a per-window IPC round trip feeding a rule that cannot
// match.

import { EVENT_CHANNELS, type WindowFrameState } from "@pwrsnap/shared";

let maximized = false;
let started = false;
/** Set once a push from main has landed. The one-shot initial read must not
 *  overwrite a newer state that arrived while its round trip was in flight —
 *  the same late-resolution rule the settings substrate follows. */
let pushed = false;
const listeners = new Set<() => void>();

function apply(next: boolean): void {
  document.documentElement.dataset["windowFrame"] = next ? "maximized" : "restored";
  if (next === maximized) return;
  maximized = next;
  for (const listener of [...listeners]) listener();
}

/** Call once per window, before the first render. */
export function startWindowFrameSync(
  platform: string | undefined = window.pwrsnapApi?.platform
): void {
  if (started || platform !== "linux") return;
  started = true;
  // Stamp "restored" up front so the hairline paints on the first frame
  // rather than after the round trip below resolves.
  apply(false);
  const api = window.pwrsnapApi;
  if (api === undefined) return;
  void api.readWindowFrameState().then((state) => {
    // Dropped if the window has already told us something newer: a Super+Up
    // during the round trip would otherwise be undone by this stale answer,
    // leaving a Maximize glyph and a painted edge on a maximized window until
    // the next WM event.
    if (state !== null && !pushed) apply(state.maximized);
  });
  api.on(EVENT_CHANNELS.windowFrameState, (payload) => {
    const state = payload as WindowFrameState | null;
    if (state !== null && typeof state === "object") {
      pushed = true;
      apply(state.maximized === true);
    }
  });
}

export function subscribeWindowFrame(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function isWindowMaximized(): boolean {
  return maximized;
}

/** One module instance serves a whole test file; start each test from zero. */
export function __resetWindowFrameForTests(): void {
  started = false;
  maximized = false;
  pushed = false;
  listeners.clear();
  delete document.documentElement.dataset["windowFrame"];
}
