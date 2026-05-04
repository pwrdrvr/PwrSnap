// Renderer-side state machine for the float-over toast. Replaces
// `FloatOverForCapture` (which read `?capture=<id>` from the URL hash
// and depended on `loadURL` reloads to swap captures). The new model:
//
//   - The renderer mounts ONCE per app launch (lazy on first capture
//     when main creates the window).
//   - State transitions arrive via `events:float-over:state` IPC.
//   - We render <FloatOver/> only in the LOADED state; IDLE renders
//     an empty placeholder (the user never sees IDLE — it's hidden
//     under the selector window).
//
// Why this kills the "toast flashes for a microsecond" bug: the prior
// design's `setTimeout(..., 220)` exit-animation timer in FloatOver.tsx
// was created on the page event loop and survived `loadURL` reloads.
// The next capture's renderer would mount, then the orphan timer would
// fire and call onDismiss → main hides the freshly-shown toast. With a
// persistent renderer there's no reload, and the timer cleanup added
// to FloatOver in this same phase clears the timer on unmount.

import { useEffect, useState } from "react";
import type { CaptureRecord, FloatOverEvent } from "@pwrsnap/shared";
import { FloatOver } from "./FloatOver";
import { cacheUrl, dispatch } from "../../lib/pwrsnap";

type HostState =
  | { kind: "idle" }
  | { kind: "loading"; captureId: string }
  | { kind: "loaded"; record: CaptureRecord }
  | { kind: "error"; captureId: string; message: string };

export function FloatOverHost(): React.ReactElement {
  const [state, setState] = useState<HostState>({ kind: "idle" });

  // Subscribe to main → renderer state events. One listener for the
  // life of the renderer; main re-emits its last event on
  // `did-finish-load` so the first capture-of-session doesn't miss
  // the IPC.
  useEffect(() => {
    const unsubscribe = window.pwrsnapApi?.on("events:float-over:state", (payload) => {
      const event = payload as FloatOverEvent;
      switch (event.kind) {
        case "show-idle":
          setState({ kind: "idle" });
          return;
        case "show-loaded":
          setState({ kind: "loading", captureId: event.captureId });
          return;
        case "cancel":
        case "dismiss":
          // Main is hiding the window. Reset to IDLE so a subsequent
          // show-idle re-uses a clean React tree (no stale countdown
          // state from the previous LOADED toast).
          setState({ kind: "idle" });
          return;
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Fetch the capture record when entering LOADING. Cancel-safe: if a
  // new capture arrives mid-fetch, the captureId in `state` changes
  // and the closure's `cancelled` flag prevents the stale fetch from
  // updating React.
  useEffect(() => {
    if (state.kind !== "loading") return undefined;
    const captureId = state.captureId;
    let cancelled = false;
    void dispatch("library:byId", { id: captureId }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setState({ kind: "error", captureId, message: result.error.message });
        return;
      }
      if (result.value === null) {
        setState({ kind: "error", captureId, message: `capture not found: ${captureId}` });
        return;
      }
      setState({ kind: "loaded", record: result.value });
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  // ⌘1 / ⌘2 / ⌘3 → clipboard:copy. Always-mounted listener — no remount-
  // induced gaps where the keystroke is in flight but the listener has
  // detached. Reads the active captureId from a ref so the closure
  // stays stable across state transitions.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.metaKey || event.shiftKey || event.altKey) return;
      let preset: "low" | "med" | "high" | null = null;
      if (event.key === "1") preset = "low";
      else if (event.key === "2") preset = "med";
      else if (event.key === "3") preset = "high";
      if (preset === null) return;
      // Only accept the shortcut when we have a capture loaded —
      // pressing ⌘1 over an idle pre-show is a no-op.
      if (state.kind !== "loaded") return;
      event.preventDefault();
      void dispatch("clipboard:copy", { captureId: state.record.id, preset });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [state]);

  // IDLE: render an empty placeholder. The user never sees this — the
  // selector covers the whole display while we're idle. Keeping the
  // root <div> rendered (rather than `null`) means the BrowserWindow
  // has a body to compose; some Electron versions get visually weird
  // about a body-less window when shown.
  if (state.kind === "idle") {
    return <div data-state="idle" style={{ width: "100%", height: "100%" }} />;
  }
  if (state.kind === "loading") {
    // The user can briefly see this on the agent path (no selector to
    // hide behind). Keep it minimal; the LOADED transition replaces
    // it within ~10ms once library:byId resolves.
    return (
      <div
        data-state="loading"
        style={{
          padding: 20,
          color: "var(--text-secondary)",
          font: "500 12px var(--font-sans)"
        }}
      >
        Loading capture…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        data-state="error"
        style={{
          padding: 20,
          color: "var(--danger-text)",
          font: "500 12px var(--font-sans)"
        }}
      >
        Couldn't load capture: {state.message}
      </div>
    );
  }

  const { record } = state;
  // 1440px medium preset matches the float-over's intended display
  // size and pre-warms the cache for the user's most-likely first
  // ⌘ shortcut.
  const previewSrc = cacheUrl(record.id, 1440);
  return (
    <FloatOver
      src={previewSrc}
      srcW={record.width_px}
      srcH={record.height_px}
      onDismiss={() => {
        // User dismissed via the X / countdown / Esc-on-toast. Tell
        // main to hide; main flips state HIDDEN and the IPC echo
        // resets us to IDLE.
        void dispatch("float-over:dismiss", {});
      }}
      onEdit={() => {
        // Open the editor in a new window. Toast stays put — closing
        // it is independent of opening the editor.
        void dispatch("editor:open", { captureId: record.id });
      }}
    />
  );
}
