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
import {
  EVENT_CHANNELS,
  type CaptureEnrichment,
  type CaptureRecord,
  type FloatOverEvent,
  type RenderPreset,
  type Settings,
  type SettingsChangedEvent
} from "@pwrsnap/shared";
import { FloatOver, type FloatOverExportState } from "./FloatOver";
import { usePresetRenderMetrics } from "../shared/usePresetRenderMetrics";
import { cacheUrl, captureSrcUrl, dispatch, startCaptureDrag } from "../../lib/pwrsnap";

type HostState =
  | { kind: "idle" }
  | { kind: "loading"; captureId: string }
  | {
      kind: "loaded";
      record: CaptureRecord;
      enrichment: CaptureEnrichment | null;
      settings: Settings | null;
    }
  | { kind: "error"; captureId: string; message: string };

const INITIAL_COPY_PULSES: Record<RenderPreset, number> = {
  low: 0,
  med: 0,
  high: 0
};

type AiRunUpdatedPayload = {
  enrichment?: CaptureEnrichment | null;
};

export function FloatOverHost(): React.ReactElement {
  const [state, setState] = useState<HostState>({ kind: "idle" });
  const [copyPulses, setCopyPulses] = useState(INITIAL_COPY_PULSES);
  // Video toast: tracks the latest GIF / MP4 export dispatched from
  // the toast's two buttons. Surfaced through `asset.exportState` so
  // the buttons render `Encoding…` / `Saved` / `Failed`. Reset per-
  // capture by the `key={record.id}` on <FloatOver/> remounting it
  // when the user takes a new recording.
  const [videoExportState, setVideoExportState] = useState<FloatOverExportState>({ kind: "idle" });
  // capture:presetMetrics returns empty for video captures (the
  // sharp render pipeline is image-only); only request the hook for
  // image-kind captures so we don't fire a no-op IPC on every video
  // load.
  const copyMetrics = usePresetRenderMetrics(
    state.kind === "loaded" && state.record.kind === "image" ? state.record.id : null,
    state.kind === "loaded" && state.record.kind === "image" ? state.record.edits_version : null
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
          setVideoExportState({ kind: "idle" });
          return;
        case "show-loaded":
          // Reset per-capture export state so a new toast doesn't
          // show a stale "Saved" badge from the previous recording.
          setVideoExportState({ kind: "idle" });
          if (event.record !== undefined) {
            setState({
              kind: "loaded",
              record: event.record,
              enrichment: null,
              settings: null
            });
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
          setVideoExportState({ kind: "idle" });
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
      const record = result.value;
      void Promise.all([
        dispatch("codex:enrichment", { captureId }),
        dispatch("settings:read", {})
      ]).then(([enrichmentResult, settingsResult]) => {
        if (cancelled) return;
        setState({
          kind: "loaded",
          record,
          enrichment: enrichmentResult.ok ? enrichmentResult.value : null,
          settings: settingsResult.ok ? settingsResult.value : null
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  useEffect(() => {
    const unsubscribe = window.pwrsnapApi?.on(EVENT_CHANNELS.aiRunUpdated, (payload) => {
      const enrichment = (payload as AiRunUpdatedPayload).enrichment;
      if (enrichment === undefined || enrichment === null) return;
      setState((current) => {
        if (current.kind !== "loaded" || current.record.id !== enrichment.captureId) {
          return current;
        }
        return { ...current, enrichment };
      });
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.pwrsnapApi?.on(EVENT_CHANNELS.settingsChanged, (payload) => {
      const { settings } = payload as SettingsChangedEvent;
      setState((current) => {
        if (current.kind !== "loaded") return current;
        return { ...current, settings };
      });
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

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
    const { enrichment, record, settings } = state;
    const isVideo =
      record.kind === "video" && record.video !== null && record.video !== undefined;
    const previewSrc = captureSrcUrl(record.id);
    // Source PNG paints immediately after capture. Keep the 1440px
    // rendered WebP as a progressive enhancement so cache-miss
    // compose work cannot leave the visible preview blank. The
    // enhanced URL is image-only — videos don't go through the
    // sharp-based render pipeline, so we skip it for that branch.
    //
    // `edits_version` is the unified rename from `overlays_version`
    // (see migration 0008_layers.sql) — the cache key picks up
    // changes whether they originated as v1 overlays or v2 layers.
    const enhancedPreviewSrc = isVideo
      ? undefined
      : cacheUrl(record.id, 1440, "webp", record.edits_version);

    // Build the asset descriptor — `image` for snaps (existing
    // behavior unchanged), `video` for recordings (swaps preview
    // element + Low/Med/High row, keeps everything else).
    const asset = isVideo
      ? ({
          kind: "video",
          src: previewSrc,
          durationSec: record.video!.durationSec,
          hasSystemAudio: record.video!.hasSystemAudio,
          hasMicrophoneAudio: record.video!.hasMicrophoneAudio,
          exportState: videoExportState,
          onExport: (format: "gif" | "mp4") => {
            setVideoExportState({ kind: "running", format });
            void dispatch("video:export", {
              captureId: record.id,
              format,
              audio:
                format === "gif"
                  ? { includeSystemAudio: false, includeMicrophone: false }
                  : {
                      includeSystemAudio: record.video!.hasSystemAudio,
                      includeMicrophone: record.video!.hasMicrophoneAudio
                    }
            }).then((res) => {
              if (res.ok) {
                setVideoExportState({ kind: "done", format, path: res.value.path });
              } else {
                setVideoExportState({ kind: "error", format, message: res.error.message });
              }
            });
          },
          onDiscard: () => {
            // library:delete (soft-delete + trash move) is the only
            // path that updates app_stats correctly; library:purge
            // then removes the row + trash file + cached exports
            // (purgeCacheForCapture in source-store wired into
            // library-handlers). Two-step sequence preserves the
            // SQL invariants the captures-repo asserts on boot.
            void (async () => {
              await dispatch("library:delete", { id: record.id });
              await dispatch("library:purge", { id: record.id });
              await dispatch("float-over:dismiss", {});
            })();
          }
        } as const)
      : ({
          kind: "image" as const,
          src: previewSrc,
          enhancedSrc: enhancedPreviewSrc,
          onCopy: (preset: "low" | "med" | "high") =>
            void dispatch("clipboard:copy", { captureId: record.id, preset }),
          onCopyPath: (preset: "low" | "med" | "high") =>
            void dispatch("clipboard:copy-path", { captureId: record.id, preset }),
          onDragFile: () => startCaptureDrag(record.id, "high"),
          onDragPreset: (preset: "low" | "med" | "high") => startCaptureDrag(record.id, preset)
        });

    body = (
      <FloatOver
        key={record.id}
        asset={asset}
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
        enrichment={enrichment}
        aiEnabled={settings?.ai.enabled ?? false}
        aiConsentAccepted={settings?.ai.consentAcceptedAt !== null && settings !== null}
        autoAcceptSuggestions={settings?.ai.autoAcceptSuggestions ?? false}
        onSetAutoAccept={(next) => {
          void dispatch("settings:write", {
            ai: { autoAcceptSuggestions: next }
          }).then((result) => {
            if (!result.ok) return;
            setState((current) => {
              if (current.kind !== "loaded" || current.record.id !== record.id) return current;
              return { ...current, settings: result.value };
            });
          });
        }}
        onEnableAi={() => {
          void dispatch("settings:write", {
            ai: {
              enabled: true,
              consentAcceptedAt: new Date().toISOString()
            }
          }).then((result) => {
            if (!result.ok) return;
            setState((current) => {
              if (current.kind !== "loaded" || current.record.id !== record.id) return current;
              return { ...current, settings: result.value };
            });
            void dispatch("codex:enrich", { captureId: record.id });
          });
        }}
        onAcceptTitle={(title) => {
          void dispatch("codex:acceptTitle", { captureId: record.id, title });
        }}
        onAcceptDescription={(description) => {
          void dispatch("codex:acceptDescription", { captureId: record.id, description });
        }}
        onAcceptTag={(tagId) => {
          void dispatch("codex:acceptTag", { captureId: record.id, tagId });
        }}
        onRejectTag={(tagId) => {
          void dispatch("codex:rejectTag", { captureId: record.id, tagId });
        }}
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
