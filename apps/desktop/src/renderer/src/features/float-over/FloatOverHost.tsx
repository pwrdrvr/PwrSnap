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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

  // ResizeObserver → main: shrink the BrowserWindow to fit the visible
  // toast. The window is constructed at a generous 700px height (we
  // can't know the toast height at create time), but rendering a
  // 580-ish px toast inside it leaves ~120px of empty body below the
  // toast — and that empty region was rendering as a grayish "tail"
  // (the toast's `box-shadow: 0 24px 64px rgba(0,0,0,0.55)` bleeding
  // into transparent body) AND extending the window's bottom edge
  // into the macOS Dock area.
  //
  // Same pattern as TrayMenu.tsx's `pwrsnap:tray:resize` plumbing.
  // Body shadow extends `y_offset + blur ≈ 88px` past the toast's
  // bottom edge; we pad with 96px so the soft shadow doesn't clip
  // against the bottom of the new window bounds.
  const SHADOW_PADDING_PX = 96;
  const contentRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el === null) return;
    const post = (): void => {
      const rect = el.getBoundingClientRect();
      window.pwrsnapApi?.requestFloatOverResize?.({
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height + SHADOW_PADDING_PX)
      });
    };
    post();
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state.kind]);

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

  // Single return path so contentRef wraps every state — the
  // ResizeObserver above always has a stable target it can observe
  // across state transitions. Inside the wrapper we branch on state.
  let body: React.ReactNode;
  if (state.kind === "idle") {
    // IDLE: minimal empty placeholder so the wrapper has a measurable
    // height of ~0. The user never sees this — the selector covers the
    // whole display while we're idle. Keeping a rendered div (rather
    // than `null`) means the BrowserWindow always has a body to
    // compose; some Electron versions get visually weird about a
    // body-less window when shown.
    body = <div data-state="idle" />;
  } else if (state.kind === "loading") {
    // The user can briefly see this on the agent path (no selector to
    // hide behind). Keep it minimal; the LOADED transition replaces
    // it within ~10ms once library:byId resolves.
    body = (
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
  } else if (state.kind === "error") {
    body = (
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
  } else {
    const { record } = state;
    // 1440px medium preset matches the float-over's intended display
    // size and pre-warms the cache for the user's most-likely first
    // ⌘ shortcut.
    const previewSrc = cacheUrl(record.id, 1440, "webp", record.overlays_version);
    body = (
      <FloatOver
        src={previewSrc}
        onCopy={(preset) => {
          void dispatch("clipboard:copy", { captureId: record.id, preset });
        }}
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

  // The wrapper is `display: inline-block` so its bounding rect tracks
  // the natural height of its content (rather than stretching to fill
  // the body's 100% height, which would always report the full window
  // height and defeat the resize-to-fit logic).
  return (
    <div ref={contentRef} style={{ display: "inline-block", width: "100%" }}>
      {body}
    </div>
  );
}
