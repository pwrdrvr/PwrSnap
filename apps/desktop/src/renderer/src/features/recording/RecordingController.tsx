// Floating HUD shown while the recording service is non-idle.
// Lives in its own BrowserWindow (`createRecordingControllerWindow`
// in main/window.ts); subscribes to `events:recording:state` and
// flips between two visuals:
//
//   countdown phase  →  "Starting in 3…"  (big number)
//   recording phase  →  ●  00:00:00   [Stop]   [Cancel]
//
// The window is hidden when state.phase === 'idle' / 'ready' /
// 'failed' so the user only sees it while something is happening.
// Recording phase shows a live duration timer driven from
// state.startedAt.

import { useEffect, useState, type ReactElement } from "react";
import { EVENT_CHANNELS, type RecordingState } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

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
  const [elapsedSec, setElapsedSec] = useState(0);

  // Snapshot on mount, then subscribe.
  useEffect(() => {
    let cancelled = false;
    void dispatch("recording:state", {}).then((res) => {
      if (cancelled) return;
      if (res.ok) setState(res.value);
    });
    const off = window.pwrsnapApi?.on(EVENT_CHANNELS.recordingState, (payload) => {
      setState(payload as RecordingState);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

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

  const isCountdown = state.phase === "countdown";
  const isPreCapture =
    state.phase === "preflight" || state.phase === "countdown" || state.phase === "starting";
  const isRecording = state.phase === "recording";
  const isStopping = state.phase === "stopping" || state.phase === "processing";

  if (state.phase === "idle" || state.phase === "ready" || state.phase === "failed") {
    return <div data-recording-phase={state.phase} />;
  }

  // Pre-capture phases (preflight / countdown / starting): transparent
  // overlay that fills the recorded rect (main.ts/recording-controller
  // sizes the BrowserWindow to match the rect). User's content is
  // visible underneath; click-through is enabled via setIgnoreMouseEvents
  // so they can interact with the surface they're about to record.
  return (
    <div
      data-recording-phase={state.phase}
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        background: isPreCapture ? "transparent" : "rgba(0, 0, 0, 0.86)",
        color: "#fff",
        borderRadius: isPreCapture ? 0 : 12,
        padding: isPreCapture ? 0 : "10px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: isPreCapture ? "center" : "space-between",
        gap: 12,
        font: "500 13px/1 'Geist', system-ui, sans-serif",
        WebkitAppRegion: isPreCapture ? "no-drag" : "drag",
        userSelect: "none",
        pointerEvents: isPreCapture ? "none" : "auto",
        position: "relative"
      } as React.CSSProperties}
    >
      {isCountdown && <CountdownLeader value={state.secondsRemaining} />}
      {state.phase === "starting" && <StartingIndicator />}

      {isRecording && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 4,
            width: "100%"
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                data-recording-dot
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: "#ef4444",
                  boxShadow: "0 0 10px rgba(239, 68, 68, 0.6)",
                  animation: "ps-rec-pulse 1.2s ease-in-out infinite"
                }}
              />
              <span style={{ font: "500 12px/1 'Geist Mono', monospace" }}>
                {formatHMS(elapsedSec)}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
              <button
                type="button"
                data-recording-action="stop"
                onClick={() => void dispatch("recording:stop", {})}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #ef4444",
                  background: "#ef4444",
                  color: "#fff",
                  font: "600 12px/1 'Geist', system-ui, sans-serif",
                  cursor: "pointer"
                }}
              >
                Stop
              </button>
              <button
                type="button"
                data-recording-action="restart"
                title="Discard the current take and start over"
                onClick={() => {
                  if (
                    typeof window !== "undefined" &&
                    !window.confirm(
                      "Discard the current recording and start over? The clip in progress will be deleted."
                    )
                  ) {
                    return;
                  }
                  void dispatch("recording:restart", {});
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid rgba(255, 138, 31, 0.6)",
                  background: "transparent",
                  color: "#ff8a1f",
                  font: "500 12px/1 'Geist', system-ui, sans-serif",
                  cursor: "pointer"
                }}
              >
                Restart
              </button>
              <button
                type="button"
                data-recording-action="cancel"
                title="Cancel the recording — clip will be discarded"
                onClick={() => {
                  if (
                    typeof window !== "undefined" &&
                    !window.confirm(
                      "Cancel recording? The clip will be discarded. Press Stop instead if you want to keep it."
                    )
                  ) {
                    return;
                  }
                  void dispatch("recording:cancel", {});
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "transparent",
                  color: "#fff",
                  font: "500 12px/1 'Geist', system-ui, sans-serif",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
            </div>
          </div>
          {/* Reassurance caption — the HUD window's BrowserWindow PID
              is in the recorder's `excludePids` list, so anything
              painted here is invisible to the recorded pixels.
              Users worry the Stop pill is in their shot. */}
          <div
            data-recording-caption
            style={{
              textAlign: "center",
              font: "500 10px/1 'Geist', system-ui, sans-serif",
              color: "rgba(255, 255, 255, 0.55)",
              letterSpacing: "0.04em",
              pointerEvents: "none",
              marginTop: 2
            }}
          >
            this controller is not visible in the recording
          </div>
        </div>
      )}

      {isStopping && (
        <div style={{ width: "100%", textAlign: "center", color: "rgba(255,255,255,0.7)" }}>
          {state.phase === "stopping" ? "Finalizing…" : "Processing…"}
        </div>
      )}

      <style>{`@keyframes ps-rec-pulse {
        0% { opacity: 1; }
        50% { opacity: 0.45; }
        100% { opacity: 1; }
      }`}</style>
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
  const brandSolid = "#ff8a1f";
  const brandSoft = "rgba(255, 138, 31, 0.55)";
  const brandFaint = "rgba(255, 138, 31, 0.35)";
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
          <circle cx="100" cy="100" r="62" fill="none" stroke={brandSoft} strokeWidth="2" />
          <circle cx="100" cy="100" r="48" fill="none" stroke={brandFaint} strokeWidth="1.5" />

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
            stroke={brandSolid}
            strokeWidth="4"
            strokeLinecap="round"
            style={{
              transformOrigin: "100px 100px",
              animation: "ps-leader-sweep 1s linear forwards"
            }}
          />

          {/* Center hub */}
          <circle cx="100" cy="100" r="5" fill={brandSolid} />

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
          background: conic-gradient(
            rgba(255, 138, 31, 0.42) var(--ps-sweep-angle),
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
          border: "4px solid rgba(255, 138, 31, 0.25)",
          borderTopColor: "#ff8a1f",
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
