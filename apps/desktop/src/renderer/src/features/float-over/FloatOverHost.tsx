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
import { EVENT_CHANNELS, type CaptureRecord, type FloatOverEvent, type RenderPreset } from "@pwrsnap/shared";
import { FloatOver } from "./FloatOver";
import { usePresetRenderMetrics } from "../shared/usePresetRenderMetrics";
import { cacheUrl, captureSrcUrl, dispatch, startCaptureDrag } from "../../lib/pwrsnap";

type HostState =
  | { kind: "idle" }
  | { kind: "loading"; captureId: string }
  | { kind: "loaded"; record: CaptureRecord }
  | { kind: "error"; captureId: string; message: string };

const INITIAL_COPY_PULSES: Record<RenderPreset, number> = {
  low: 0,
  med: 0,
  high: 0
};

export function FloatOverHost(): React.ReactElement {
  const [state, setState] = useState<HostState>({ kind: "idle" });
  const [copyPulses, setCopyPulses] = useState(INITIAL_COPY_PULSES);
  const copyMetrics = usePresetRenderMetrics(
    state.kind === "loaded" ? state.record.id : null,
    state.kind === "loaded" ? state.record.overlays_version : null
  );

  // ResizeObserver → main: shrink the BrowserWindow to fit the visible
  // toast. Same pattern as TrayMenu.tsx's `pwrsnap:tray:resize`
  // plumbing: post the wrapper's natural height only. Do not add
  // transparent shadow padding here — BrowserWindow hit testing uses
  // the full rectangular window bounds, so extra invisible content
  // below the toast blocks clicks on whatever sits under it.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el === null) return;
    const post = (): void => {
      const rect = el.getBoundingClientRect();
      window.pwrsnapApi?.requestFloatOverResize?.({
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height)
      });
    };
    post();
    const ro = new ResizeObserver(post);
    ro.observe(el);
    // Main pings us on `webContents.zoom-changed` so the toast
    // resizes correctly when the session zoom factor changes —
    // ResizeObserver alone doesn't reliably catch zoom-only layout
    // changes, and main's CSS→DIP conversion needs us to re-post
    // through it so the new zoomFactor lands.
    const unsubRemeasure = window.pwrsnapApi?.on(
      "events:popover:remeasure",
      () => post()
    );
    return () => {
      ro.disconnect();
      unsubRemeasure?.();
    };
  }, [state.kind]);

  // Subscribe to main → renderer state events. One listener for the
  // life of the renderer; main re-emits its last event on
  // `did-finish-load` so the first capture-of-session doesn't miss
  // the IPC.
  useEffect(() => {
    const unsubscribe = window.pwrsnapApi?.on(EVENT_CHANNELS.floatOverState, (payload) => {
      const event = payload as FloatOverEvent;
      switch (event.kind) {
        case "show-idle":
          setState({ kind: "idle" });
          return;
        case "show-loaded":
          if (event.record !== undefined) {
            setState({ kind: "loaded", record: event.record });
          } else {
            setState({ kind: "loading", captureId: event.captureId });
          }
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

  useEffect(() => {
    const unsubscribe = window.pwrsnapApi?.on(EVENT_CHANNELS.floatOverCopyPulse, (payload) => {
      const preset = (payload as { preset?: unknown }).preset;
      if (preset !== "low" && preset !== "med" && preset !== "high") return;
      setCopyPulses((current) => ({ ...current, [preset]: current[preset] + 1 }));
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
      setCopyPulses((current) => ({ ...current, [preset]: current[preset] + 1 }));
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
    const previewSrc = captureSrcUrl(record.id);
    // Source PNG paints immediately after capture. Keep the 1440px
    // rendered WebP as a progressive enhancement so cache-miss
    // compose work cannot leave the visible preview blank.
    const enhancedPreviewSrc = cacheUrl(record.id, 1440, "webp", record.overlays_version);
    body = (
      <FloatOver
        key={record.id}
        src={previewSrc}
        enhancedSrc={enhancedPreviewSrc}
        onCopy={(preset) => {
          void dispatch("clipboard:copy", { captureId: record.id, preset });
        }}
        onCopyPath={(preset) => {
          void dispatch("clipboard:copy-path", { captureId: record.id, preset });
        }}
        srcW={record.width_px}
        srcH={record.height_px}
        srcBytes={record.byte_size}
        copyMetrics={copyMetrics}
        copyPulses={copyPulses}
        onDragFile={() => startCaptureDrag(record.id, "high")}
        onDragPreset={(preset) => startCaptureDrag(record.id, preset)}
        onDismiss={() => {
          // User dismissed via the X / countdown / Esc-on-toast. Tell
          // main to hide; main flips state HIDDEN and the IPC echo
          // resets us to IDLE.
          void dispatch("float-over:dismiss", {});
        }}
        onEdit={() => {
          // Hand off to the Library window's inline editor (Focus mode
          // + Stage), not the standalone Edit Window. Library:open
          // brings the Library forward and tells its renderer to
          // navigate to this capture in Focus. Dismiss the toast as
          // attention transfers — keeping it open behind the Library
          // would be visual noise.
          void dispatch("library:openInLibrary", { captureId: record.id });
          void dispatch("float-over:dismiss", {});
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
