// Floating HUD shown while the recording service is non-idle.
// Lives in its own BrowserWindow (`createRecordingControllerWindow`
// in main/window.ts); subscribes to `events:recording:state` and
// flips between two visuals:
//
//   countdown phase  →  "Starting in 3…"  (big number)
//   recording phase  →  ●  00:00:00   [Stop]   [Cancel]
//
// The window is hidden for idle/ready. A failed session remains as
// a safe, actionable card until the user retries or dismisses it.
// Recording phase shows a live duration timer driven from state.startedAt.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  recordingFailureSummary,
  type RecordingBackendCapabilities,
  type RecordingCapabilities,
  type RecordingControllerArmEvent,
  type RecordingState
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { SourceChip } from "../shared/SourceChip";
import "./RecordingController.css";

function formatHMS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (hh > 0) {
    return `${hh}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  }
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

export function RecordingController(): ReactElement {
  const [state, setState] = useState<RecordingState>({ phase: "idle" });
  const [backend, setBackend] = useState<RecordingBackendCapabilities | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [armedAction, setArmedAction] = useState<"restart" | "cancel" | null>(null);
  const [busyAction, setBusyAction] = useState<"stop" | "restart" | "cancel" | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Snapshot on mount, then subscribe.
  useEffect(() => {
    let cancelled = false;
    void dispatch("recording:state", {}).then((res) => {
      if (cancelled) return;
      if (res.ok) setState(res.value);
    });
    void dispatch("recording:capabilities", {})
      .then((res) => {
        if (cancelled || !res.ok) return;
        setBackend(res.value);
      })
      // A failed or never-resolving capabilities fetch must not leave the
      // running take with no Stop button. Capabilities are a pure,
      // platform-derived table, so the honest fallback for "we could not
      // ask" is "assume the controls exist" — main re-checks every control
      // against the real backend anyway (`canRunRecordingControl`) and
      // returns `control_unavailable` for one that does not. Showing a
      // button that might be refused is strictly better than showing no way
      // to stop a recording.
      .catch(() => {
        if (!cancelled) setBackend(null);
      });
    const off = window.pwrsnapApi?.on(EVENT_CHANNELS.recordingState, (payload) => {
      setState(payload as RecordingState);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let posted = "";
    const post = (force = false): void => {
      const rect = el.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      const next = `${width}x${height}`;
      if (!force && next === posted) return;
      posted = next;
      window.pwrsnapApi?.requestRecordingControllerResize?.({ width, height });
    };
    post();
    const observer = new ResizeObserver(() => post());
    observer.observe(el);
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = (): void => {
      armDprQuery();
      post(true);
    };
    const armDprQuery = (): void => {
      if (state.phase !== "recording" || typeof window.matchMedia !== "function") return;
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDprChange);
    };
    armDprQuery();
    return () => {
      observer.disconnect();
      dprQuery?.removeEventListener("change", onDprChange);
    };
  }, [state.phase]);

  // Tick the duration timer once per second while recording. We don't
  // tick during countdown — the countdown phase carries its own
  // `secondsRemaining` value in the state event.
  useEffect(() => {
    if (state.phase !== "recording") {
      setElapsedSec(0);
      return;
    }
    const startedAtMs = new Date(state.startedAt).getTime();
    const update = (): void => {
      setElapsedSec((Date.now() - startedAtMs) / 1000);
    };
    update();
    const handle = setInterval(update, 500);
    return () => clearInterval(handle);
  }, [state]);

  useEffect(() => {
    setArmedAction(null);
    setBusyAction(null);
  }, [state.phase, "sessionId" in state ? state.sessionId : null]);

  useEffect(() => {
    if (armedAction === null) return;
    const handle = setTimeout(() => setArmedAction(null), 5_000);
    return () => clearTimeout(handle);
  }, [armedAction]);

  // This window is deliberately non-activating (`focusable: false` +
  // showInactive() in main), so it never receives a keydown and there
  // is no Escape-to-disarm here: making it focusable so a key handler
  // could fire would activate PwrSnap mid-take, and the recorded app
  // visibly losing focus IS captured. The 5s timeout above and the
  // other button are the ways out of an armed state.
  //
  // The same non-activating property is why the tray's destructive
  // recording items arm this HUD instead of raising a native dialog —
  // a dialog is not content-protected and lands in the file. Main
  // sends the nudge; the armed state and its timeout stay owned here,
  // so there is exactly one of them.
  const armGateRef = useRef<{ phase: RecordingState["phase"]; busy: boolean }>({
    phase: state.phase,
    busy: busyAction !== null
  });
  useEffect(() => {
    armGateRef.current = { phase: state.phase, busy: busyAction !== null };
  }, [state.phase, busyAction]);

  useEffect(() => {
    const off = window.pwrsnapApi?.on(EVENT_CHANNELS.recordingControllerArm, (payload) => {
      const action = (payload as Partial<RecordingControllerArmEvent> | null)?.action;
      if (action !== "restart" && action !== "cancel") return;
      // A nudge that lost a race with the take ending, or with an
      // action already in flight, must not resurrect a confirm for a
      // control that is no longer live.
      const gate = armGateRef.current;
      if (gate.phase !== "recording" || gate.busy) return;
      setArmedAction(action);
    });
    return () => off?.();
  }, []);

  const runAction = async (action: "stop" | "restart" | "cancel"): Promise<void> => {
    if (busyAction !== null) return;
    if ((action === "restart" || action === "cancel") && armedAction !== action) {
      setArmedAction(action);
      return;
    }
    setBusyAction(action);
    setArmedAction(null);
    try {
      const result =
        action === "stop"
          ? await dispatch("recording:stop", {})
          : action === "restart"
            ? await dispatch("recording:restart", {})
            : await dispatch("recording:cancel", {});
      // Durable failed state owns recorder/process failures. A rejected local
      // action only re-enables controls if no authoritative transition arrived.
      if (!result.ok) setBusyAction(null);
    } catch {
      setBusyAction(null);
    }
  };

  const isCountdown = state.phase === "countdown";
  const isPreCapture =
    state.phase === "preflight" || state.phase === "countdown" || state.phase === "starting";
  const isRecording = state.phase === "recording";
  const isStopping = state.phase === "stopping" || state.phase === "processing";

  if (state.phase === "failed") {
    return <RecordingFailureCard state={state} />;
  }

  if (state.phase === "idle" || state.phase === "ready") {
    return <div data-recording-phase={state.phase} />;
  }

  // Pre-capture phases (preflight / countdown / starting): transparent
  // overlay that fills the recorded rect (main.ts/recording-controller
  // sizes the BrowserWindow to match the rect). User's content is
  // visible underneath; click-through is enabled via setIgnoreMouseEvents
  // so they can interact with the surface they're about to record.
  return (
    <div
      ref={containerRef}
      className="rc-root"
      data-precapture={isPreCapture}
    >
      <div
        className="rc"
        data-precapture={isPreCapture}
        data-recording-phase={state.phase}
        role={isPreCapture ? "status" : "region"}
        aria-label={isPreCapture ? "Recording lead-in" : "Recording controls"}
      >
        {isCountdown && <CountdownLeader value={state.secondsRemaining} />}
        {state.phase === "starting" && <StartingIndicator />}

        {isRecording && (
          <div className="rc__stack">
            <div className="rc__row">
              <div className="rc__left">
                <span data-recording-dot className="rc__dot" />
                <span
                  role="timer"
                  aria-label={`Recording duration ${formatHMS(elapsedSec)}`}
                  className="rc__timer"
                >
                  {formatHMS(elapsedSec)}
                </span>
                {/* What this take is capturing, in the same chips the
                    selector offered and the float-over will confirm.
                    These are the REQUESTED sources: neither shipped
                    backend reports live levels
                    (`backend.sources.liveAudioLevels`), so a moving
                    meter here would be a fiction. Rendering them as
                    `live` with a static full meter states "this source
                    is part of the take" and nothing more. */}
                {recordingSourceChips(state.capabilities).length > 0 && (
                  <>
                    <span className="rc__sep" aria-hidden="true" />
                    <div
                      className="rc__sources"
                      data-testid="rc-sources"
                      role="group"
                      aria-label="Recording sources"
                    >
                      {recordingSourceChips(state.capabilities).map((source) => (
                        <SourceChip
                          key={source}
                          source={source}
                          state="live"
                          density="dense"
                          onScrim
                          meterTone="recorded"
                          testId={`rc-source-${source}`}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
              <div className="rc__actions">
                {(backend?.controls.stop ?? true) && (
                  <button
                    type="button"
                    className="rc__btn rc__btn--stop"
                    data-recording-action="stop"
                    aria-label="Stop and save recording"
                    disabled={busyAction !== null}
                    onClick={() => void runAction("stop")}
                  >
                    {busyAction === "stop" ? "Stopping…" : "Stop"}
                  </button>
                )}
                {(backend?.controls.restart ?? true) && (
                  <button
                    type="button"
                    className="rc__btn rc__btn--restart"
                    data-recording-action="restart"
                    title="Discard the current take and start over"
                    aria-label={
                      armedAction === "restart" ? "Confirm restart recording" : "Restart recording"
                    }
                    aria-pressed={armedAction === "restart"}
                    disabled={busyAction !== null}
                    onClick={() => void runAction("restart")}
                  >
                    {busyAction === "restart"
                      ? "Restarting…"
                      : armedAction === "restart"
                        ? "Confirm restart"
                        : "Restart"}
                  </button>
                )}
                {(backend?.controls.cancel ?? true) && (
                  <button
                    type="button"
                    className="rc__btn rc__btn--cancel"
                    data-recording-action="cancel"
                    title="Cancel the recording — clip will be discarded"
                    aria-label={
                      armedAction === "cancel"
                        ? "Confirm cancel and discard recording"
                        : "Cancel recording"
                    }
                    aria-pressed={armedAction === "cancel"}
                    disabled={busyAction !== null}
                    onClick={() => void runAction("cancel")}
                  >
                    {busyAction === "cancel"
                      ? "Cancelling…"
                      : armedAction === "cancel"
                        ? "Confirm cancel"
                        : "Cancel"}
                  </button>
                )}
              </div>
            </div>
            {armedAction !== null && (
              <div role="status" aria-live="polite" className="rc__armed">
                {armedAction === "restart"
                  ? "Restart discards this take. Press Confirm restart again."
                  : "Cancel discards this take. Press Confirm cancel again."}
              </div>
            )}
            <div data-recording-caption className="rc__caption">
              {backend === null
                ? "Checking recorder capabilities…"
                : backend.controllerExcludedFromCapture
                  ? "this controller is not visible in the recording"
                  : state.rect.w === 0 && state.rect.h === 0
                    ? "Windows full-display recordings may include this controller"
                    : "PwrSnap keeps this controller outside the recorded region when space allows"}
            </div>
          </div>
        )}

        {isStopping && (
          <div className="rc__finalizing">
            {state.phase === "stopping" ? "Finalizing…" : "Processing…"}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Which source chips the in-recording HUD shows.
 *
 * Screen is deliberately omitted here, unlike the post-capture receipt.
 * During the take the user is looking at a bar pinned over the region
 * they just selected, with a live red dot on it — that screen is being
 * recorded is the one thing the surface already says unambiguously. A
 * "Screen" chip would spend width the HUD cannot afford (it has to fit
 * outside the recorded region) restating it.
 */
export function recordingSourceChips(
  capabilities: RecordingCapabilities
): ReadonlyArray<"microphone" | "systemAudio"> {
  const chips: Array<"microphone" | "systemAudio"> = [];
  if (capabilities.microphone) chips.push("microphone");
  if (capabilities.systemAudio) chips.push("systemAudio");
  return chips;
}

function RecordingFailureCard({
  state
}: {
  state: Extract<RecordingState, { phase: "failed" }>;
}): ReactElement {
  const [pending, setPending] = useState<"retry" | "dismiss" | "logs" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el === null) return;
    let postedHeight = -1;
    const post = (force = false): void => {
      const rect = el.getBoundingClientRect();
      const height = Math.ceil(rect.height);
      if (!force && height === postedHeight) return;
      postedHeight = height;
      window.pwrsnapApi?.requestRecordingControllerResize?.({ height });
    };
    post();
    const observer = new ResizeObserver(() => post());
    observer.observe(el);

    // Page zoom is shared by origin, so a View-menu zoom change in the
    // Library also changes this renderer. ResizeObserver can stay silent when
    // the CSS dimensions do not move; devicePixelRatio is the reliable page-
    // visible signal, matching the tray and float-over sizing machinery.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = (): void => {
      armDprQuery();
      post(true);
    };
    const armDprQuery = (): void => {
      if (typeof window.matchMedia !== "function") return;
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDprChange);
    };
    armDprQuery();
    return () => {
      observer.disconnect();
      dprQuery?.removeEventListener("change", onDprChange);
    };
  }, []);

  const run = async (action: "retry" | "dismiss" | "logs"): Promise<void> => {
    if (pending !== null) return;
    setPending(action);
    setActionError(null);
    try {
      const result =
        action === "retry"
          ? await dispatch("recording:retry", { sessionId: state.sessionId })
          : action === "dismiss"
            ? await dispatch("recording:dismissFailure", { sessionId: state.sessionId })
            : await dispatch("logs:openWindow", {});
      if (!result.ok) throw new Error("recovery_action_failed");
    } catch {
      setActionError(
        action === "logs"
          ? "PwrSnap couldn't open Logs."
          : "That recovery action couldn't be completed."
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <div ref={contentRef} className="rc-fail-root">
      <div role="alert" data-recording-phase="failed" className="rc-fail">
        <div>
          <div className="rc-fail__title">Recording failed</div>
          <div>{recordingFailureSummary(state.code)}</div>
          {actionError !== null && (
            <div data-recording-action-error className="rc-fail__error">
              {actionError}
            </div>
          )}
        </div>
        <div className="rc-fail__actions">
          {state.canRetry && (
            <button
              ref={primaryRef}
              type="button"
              className="rc-fail__btn rc-fail__btn--retry"
              data-recording-action="retry"
              disabled={pending !== null}
              onClick={() => void run("retry")}
            >
              {pending === "retry" ? "Retrying…" : "Retry"}
            </button>
          )}
          <button
            ref={state.canRetry ? undefined : primaryRef}
            type="button"
            className="rc-fail__btn"
            data-recording-action="reveal-logs"
            disabled={pending !== null}
            onClick={() => void run("logs")}
          >
            {pending === "logs" ? "Opening…" : "Open Logs"}
          </button>
          <button
            type="button"
            className="rc-fail__btn"
            data-recording-action="dismiss"
            disabled={pending !== null}
            onClick={() => void run("dismiss")}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Film-leader countdown overlay. Fills the entire recorded rect
 * (the BrowserWindow is sized to match the rect — see
 * recording-controller.ts/fillRect). Composition:
 *
 *   • A translucent dark backdrop on the whole rect so the user
 *     sees the recording surface "freeze" during the pre-roll.
 *   • A single white ring (no inner bullseye).
 *   • 12 hour-style tick marks on the ring.
 *   • A PwrSnap-brand-orange wedge sweeping clockwise from 12
 *     o'clock, filling the ring over 1 second — the classic
 *     "intro lead" pie fill.
 *   • A thin orange hand drawn on top of the sweep's leading edge.
 *   • The big numeral (3 / 2 / 1) centered exactly with
 *     dominantBaseline so it lands in the geometric middle.
 *
 * `key={value}` on the wrapper forces React to remount each tick;
 * the wedge + hand animations restart cleanly. The wedge is drawn
 * with `stroke-dasharray` on a circle (radius half of stroke
 * width), giving a perfect 360° fill in one second using only CSS
 * keyframes — no JS animation loop required.
 */
function CountdownLeader({ value }: { value: number }): ReactElement {
  // SVG presentation ATTRIBUTES (`stroke="…"`) do not resolve CSS
  // custom properties, so the brand tint is applied through `style`
  // instead — the escape hatch the repo's token rule names for exactly
  // this case. Keeping it on `var(--accent)` means the leader retints
  // with the palette instead of pinning a stale hex.
  const brandSolid = { stroke: "var(--accent)" } as const;
  const brandSolidFill = { fill: "var(--accent)" } as const;
  const brandSoft = {
    stroke: "color-mix(in srgb, var(--accent) 55%, transparent)"
  } as const;
  const brandFaint = {
    stroke: "color-mix(in srgb, var(--accent) 35%, transparent)"
  } as const;
  // Structural color for the outer ring + 12 tick marks. Light gray
  // with reduced opacity so the framing reads as "film leader chrome"
  // rather than a bold white outline competing with the numeral.
  // The numeral keeps its own pure-white fill below, so contrast
  // with the digit isn't affected.
  const chrome = "rgba(220, 220, 220, 0.72)";
  return (
    <div
      key={value}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      {/* Full-rect translucent orange wedge — covers the ENTIRE
          recording area as it sweeps clockwise from 12 o'clock over
          1 second. Implemented as a CSS conic-gradient whose
          fill-angle is animated via the @property `--ps-sweep-angle`
          custom property (Chromium supports the spec since 85, and
          we ship Electron 41 so it's safe). At 0° the rect is
          un-tinted; at 360° it's fully tinted orange — the film-
          leader "lead-in wipe" effect across the whole frame, not
          just the inside of the ring. */}
      <div
        className="ps-leader-sweep-bg"
        style={{ position: "absolute", inset: 0 }}
      />

      <svg
        viewBox="0 0 200 200"
        preserveAspectRatio="xMidYMid meet"
        style={{
          // Cap the SVG at a comfortable size relative to the rect
          // but never larger than the rect itself — so tiny capture
          // areas stay legible without spilling beyond their bounds.
          width: "min(70vmin, 320px)",
          height: "min(70vmin, 320px)",
          overflow: "visible",
          position: "relative"
        }}
      >
        <defs>
          <filter id="ps-leader-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2.5" />
            <feOffset dx="0" dy="3" result="off" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.85" />
            </feComponentTransfer>
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g filter="url(#ps-leader-shadow)">
          {/* Outer ring */}
          <circle cx="100" cy="100" r="92" fill="none" stroke={chrome} strokeWidth="3" />

          {/* Two lighter orange concentric rings around the numeral —
              the classic 60s film-leader look. Sized so the numeral
              sits inside the inner ring with breathing room, and
              there's clear visual spacing between the two. */}
          <circle cx="100" cy="100" r="62" fill="none" style={brandSoft} strokeWidth="2" />
          <circle cx="100" cy="100" r="48" fill="none" style={brandFaint} strokeWidth="1.5" />

          {/* 12 hour-style tick marks on the ring */}
          {Array.from({ length: 12 }).map((_, i) => {
            const angle = (i * 30 * Math.PI) / 180;
            const x1 = 100 + Math.sin(angle) * 92;
            const y1 = 100 - Math.cos(angle) * 92;
            const x2 = 100 + Math.sin(angle) * 84;
            const y2 = 100 - Math.cos(angle) * 84;
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={chrome}
                strokeWidth={i === 0 ? 4 : i % 3 === 0 ? 2.5 : 1.5}
              />
            );
          })}

          {/* Sweep hand — solid orange line from center extending
              well past the SVG viewBox so it always reaches the
              translucent wedge's outer edge regardless of how big
              the recorded rect is. The wedge fills the entire
              BrowserWindow (full-rect conic-gradient) and the SVG
              is capped at 320px, so the line has to overshoot the
              200×200 viewBox by a lot to hit the corner of e.g. a
              1920×1080 capture. `overflow: visible` on the SVG +
              `position: relative` keeps the long line painting
              outside the SVG's CSS box without clipping. */}
          <line
            x1="100"
            y1="100"
            x2="100"
            y2="-2000"
            strokeWidth="4"
            strokeLinecap="round"
            style={{
              ...brandSolid,
              transformOrigin: "100px 100px",
              animation: "ps-leader-sweep 1s linear forwards"
            }}
          />

          {/* Center hub */}
          <circle cx="100" cy="100" r="5" style={brandSolidFill} />

          {/* Big numeral — dominantBaseline=central centers vertically;
              textAnchor=middle centers horizontally. White with a black
              stroke + drop shadow for that film-leader feel. */}
          <text
            x="100"
            y="100"
            textAnchor="middle"
            dominantBaseline="central"
            style={{
              font: "800 96px/1 'Geist', system-ui, sans-serif",
              fill: "#ffffff",
              stroke: "rgba(0, 0, 0, 0.9)",
              strokeWidth: 2,
              paintOrder: "stroke fill"
            }}
          >
            {value}
          </text>
        </g>
      </svg>
      <style>{`
        /* CSS @property registers a custom property that the engine
           knows how to interpolate. Without it, conic-gradient angles
           can't be animated via keyframes — they'd jump from start
           to end. Chromium has shipped @property since version 85. */
        @property --ps-sweep-angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        .ps-leader-sweep-bg {
          --ps-sweep-angle: 0deg;
          /* No "from <angle>" clause: CSS conic-gradient defaults to
             starting at 12 o'clock, which is exactly where the SVG
             sweep line starts. Earlier version used "from -90deg"
             thinking 0° was 3 o'clock, but the spec puts 0° at the
             top -- the result was the gradient origin shifted to 9
             o'clock and the line ended up 90° ahead of the wedge
             edge. Default "from" keeps both anchored at 12 so the
             line rides the leading edge exactly. */
          /* 0.12 alpha — keeps the film-leader "lead-in wipe" cue
             visible while letting the recording surface stay
             readable through the tint. Was 0.42 originally, which
             effectively obscured a PwrSnap window subject during
             the last frames of each 1s tick (the orange becomes
             dominant once the wedge has nearly full-circled).
             0.12 reads as a faint accent over any background. */
          background: conic-gradient(
            color-mix(in srgb, var(--accent) 12%, transparent) var(--ps-sweep-angle),
            transparent var(--ps-sweep-angle)
          );
          animation: ps-leader-sweep-fill 1s linear forwards;
        }
        @keyframes ps-leader-sweep-fill {
          to { --ps-sweep-angle: 360deg; }
        }
        @keyframes ps-leader-sweep {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

/**
 * Starting indicator — shown after the countdown completes but
 * before the Swift recorder reports `started`. Typically only
 * visible on the very first ⌘⇧V of an app launch when the cold
 * SCShareableContent enumeration runs longer than the countdown.
 * Tells the user the system is still working rather than wedged.
 */
function StartingIndicator(): ReactElement {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0, 0, 0, 0.12)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 999,
          border: "4px solid color-mix(in srgb, var(--accent) 25%, transparent)",
          borderTopColor: "var(--accent)",
          animation: "ps-leader-sweep 0.9s linear infinite"
        }}
      />
      <div
        style={{
          color: "#fff",
          font: "700 13px/1 'Geist', system-ui, sans-serif",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          padding: "6px 12px",
          background: "rgba(0, 0, 0, 0.7)",
          borderRadius: 999
        }}
      >
        Starting recorder…
      </div>
    </div>
  );
}
