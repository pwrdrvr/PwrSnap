import { useLayoutEffect, useRef } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
import { Kbd } from "../shared/Primitives";
import { cacheUrl, dispatch } from "../../lib/pwrsnap";
import { useLibrary } from "../../lib/useLibrary";

type ModeKind = "auto" | "region" | "window" | "full" | "all" | "scroll" | "timed";

/** Phase 1 ships `auto` (the Quick Capture button — promoted out of
 *  the grid), `region`, and `window`. The other four modes are stubbed
 *  with `available: false` so the disabled treatment honestly signals
 *  what works today. */
const MODES: Array<{
  id: Exclude<ModeKind, "auto">;
  name: string;
  hk: string[];
  available: boolean;
}> = [
  // Two-column grid order — keeps the most-used in the top row, less-
  // common modes below. Region top-left because once Quick Capture
  // moves to the prominent button, Region is the highest-frequency
  // explicit-mode choice.
  { id: "region", name: "Region", hk: ["⌘", "⇧", "R"], available: true },
  { id: "window", name: "Window", hk: ["⌘", "⇧", "W"], available: true },
  { id: "full", name: "Full Screen", hk: ["⌘", "⇧", "F"], available: false },
  { id: "all", name: "All Screens", hk: ["⌘", "⇧", "A"], available: false },
  { id: "scroll", name: "Scrolling", hk: ["⌘", "⇧", "S"], available: false },
  { id: "timed", name: "Timed (5s)", hk: ["⌘", "⇧", "T"], available: false }
];

/** Three preset widths matching the float-over Low/Med/High buttons,
 *  intentionally identical so muscle memory carries from the post-
 *  capture toast straight into the tray. ⌘1 / ⌘2 / ⌘3 dispatch the
 *  same `clipboard:copy` command-bus verb. */
const COPY_PRESETS: Array<{ id: CopyPreset; label: string }> = [
  { id: "low", label: "Low" },
  { id: "med", label: "Med" },
  { id: "high", label: "High" }
];

// presetMetrics moved to features/shared/CopyButton.tsx in Phase C.5
// of the library three-state plan so DetailRail can use it too.

function ModeIcon({ kind }: { kind: ModeKind }) {
  switch (kind) {
    case "auto":
      // Sparkle/wand glyph — "let the tool figure out window vs region".
      return (
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "region":
      return (
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 4H4v3M4 17v3h3M17 20h3v-3M20 7V4h-3" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "window":
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="5" width="18" height="14" rx="1.5" />
          <path d="M3 9h18" />
          <circle cx="6" cy="7" r=".7" fill="currentColor" />
          <circle cx="8.5" cy="7" r=".7" fill="currentColor" />
        </svg>
      );
    case "full":
      return (
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="14" rx="1.5" />
          <path d="M9 21h6" />
        </svg>
      );
    case "all":
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="5" width="11" height="9" rx="1" />
          <rect x="11" y="9" width="11" height="9" rx="1" />
        </svg>
      );
    case "scroll":
      // Scrolling-page glyph: a window with horizontal text rules and
      // small vertical "scroll track" hashes on either side, signaling
      // a long page being captured beyond the viewport.
      return (
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="6" y="3" width="12" height="18" rx="1.5" />
          <path d="M9 8h6M9 12h6M9 16h6M3 9v6M21 9v6" />
        </svg>
      );
    case "timed":
      return (
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="13" r="7" />
          <path d="M12 13V9M9 3h6M19 6l-1.5 1.5" />
        </svg>
      );
  }
}

export function TrayMenubar() {
  return (
    <div className="tray-menubar">
      <div className="tray-menubar__l">
        <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>Finder</span>
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
        <span>Go</span>
      </div>
      <div className="tray-menubar__r">
        <span>92%</span>
        <span className="tray-menubar__pwrsnap">
          <span className="tray-menubar__pwrsnap-mark">
            <PwrSnapMark size={12} />
          </span>
          <span className="tray-menubar__pwrsnap-dot" />
        </span>
        <span style={{ color: "var(--text-primary)" }}>Tue 9:42</span>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return new Date(then).toLocaleDateString();
}

// formatBytes moved to features/shared/CopyButton.tsx (used internally
// by presetMetrics there; not exported separately).

export function TrayMenu({ activeMode = "auto" }: { activeMode?: ModeKind }) {
  const { rows } = useLibrary();
  const lastSnap: CaptureRecord | undefined = rows[0];

  // Measure the popover's natural content height and tell main to
  // setContentSize the BrowserWindow to match. Mirrors the float-
  // over toast's pattern in FloatOverHost.tsx: an `inline-block`
  // outer wrapper that's content-sized in both axes, observed via
  // ResizeObserver and measured with `getBoundingClientRect`.
  //
  // Why an OUTER inline-block wrapper, not the .ps-tray container
  // itself: `.ps-tray` carries `overflow: hidden` (rounded-corner
  // clipping against the transparent BrowserWindow), so does
  // `body`, and inside that nested overflow:hidden chain Chromium
  // starts returning the *clipped* extent rather than the natural
  // content for both `getBoundingClientRect().height` AND
  // `scrollHeight`. Read it back into the observer and the popover
  // gets stuck at whatever short size we first posted. An
  // `inline-block` wrapper SITTING OUTSIDE the clipped element is
  // content-sized by layout (inline-block sizes to its content in
  // both axes) and isn't affected — the parent's overflow only
  // clips painting, not layout. gBCR on it returns the natural
  // height regardless of how main is currently sizing the window.
  //
  // The float-over uses this same pattern (see FloatOverHost.tsx,
  // `contentRef` on a `display: inline-block; width: 100%` wrapper)
  // and ships without any of the workarounds we'd previously stacked
  // on the tray (font-ready re-measures, image-load handlers,
  // child-coord tricks). Keeping the two surfaces structurally
  // identical means a fix to either flows naturally to the other.
  //
  // Hard floor + ceiling sit in main (`tray.ts` clamps 200–880), so
  // a renderer-side measurement bug can't shrink the popover to
  // nothing or grow it off-screen.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let posted = -1;
    const post = (force = false): void => {
      const rect = el.getBoundingClientRect();
      const target = Math.ceil(rect.height);
      if (!force && target === posted) return;
      posted = target;
      // Direct IPC — same shape as FloatOverHost.tsx. The earlier
      // version of this code dispatched a `pwrsnap:tray:resize`
      // CustomEvent that a sibling `<TrayResizeForwarder/>` (with
      // `useEffect`) listened for and forwarded over IPC. That had
      // a race: `useLayoutEffect` here fires BEFORE `useEffect`
      // anywhere, so the first post was dispatched before the
      // forwarder's listener was attached and got dropped. In
      // production, follow-up ResizeObserver fires usually rescued
      // it; in the E2E harness (faster, more stable layout) the
      // observer didn't re-fire and the popover got stuck at its
      // 440×440 constructor frame. Calling the preload API directly
      // removes the race entirely.
      window.pwrsnapApi?.requestTrayResize?.({ width: 440, height: target });
    };
    post();
    const ro = new ResizeObserver(() => post());
    ro.observe(el);
    // Main pings us on `webContents.zoom-changed` because Chromium's
    // ResizeObserver doesn't reliably fire on zoom-only changes —
    // and even if our CSS-pixel measurement is unchanged, main needs
    // to re-run its CSS→DIP conversion against the new zoomFactor,
    // so we force a post that bypasses the `posted` cache.
    const unsubRemeasure = window.pwrsnapApi?.on(
      "events:popover:remeasure",
      () => post(true)
    );
    return () => {
      ro.disconnect();
      unsubRemeasure?.();
    };
  }, []);

  const onCapture = (mode: "auto" | "region" | "window"): void => {
    void dispatch("capture:interactive", { mode });
  };
  const onCopyLastSnap = (preset: "low" | "med" | "high"): void => {
    if (lastSnap === undefined) return;
    void dispatch("clipboard:copy", { captureId: lastSnap.id, preset });
  };

  return (
    <div ref={containerRef} style={{ display: "inline-block", width: "100%" }}>
    <div className="ps-tray">
      <div className="ps-tray__hdr">
        <div className="ps-tray__brand">
          <PwrSnapMark size={16} />
          <span className="ps-tray__brand-name">
            <PwrSnapWordmark />
          </span>
        </div>
        <div className="ps-tray__status">
          <span className="ps-tray__status-dot" />
          IDLE · LOCAL
        </div>
      </div>

      {/* Quick Capture — the prominent default action. Promoted out
          of the 6-mode grid because it's the single highest-frequency
          path: smart auto-mode that picks region / window / full
          screen based on what the cursor is pointing at when the
          user fires ⌘⇧P. The orange fill + outlined ring make it
          unmistakably the default; explicit modes sit below as
          opt-in specializations. */}
      <button
        className="ps-tray__quick"
        type="button"
        onClick={() => onCapture("auto")}
      >
        <span className="ps-tray__quick-l">
          <span className="ps-tray__quick-eyebrow">Quick Capture</span>
          <span className="ps-tray__quick-sub">
            Smart auto-mode · picks region, window, or full screen
          </span>
        </span>
        <span className="ps-tray__quick-hk">
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>P</Kbd>
        </span>
      </button>

      <div className="ps-tray__modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={"ps-mode" + (m.available ? "" : " is-disabled")}
            type="button"
            disabled={!m.available}
            title={m.available ? undefined : "Coming in a later phase"}
            onClick={(() => {
              if (m.id === "region") return () => onCapture("region");
              if (m.id === "window") return () => onCapture("window");
              return undefined;
            })()}
          >
            <span className="ps-mode__icon">
              <ModeIcon kind={m.id} />
            </span>
            <span className="ps-mode__name">{m.name}</span>
            <span className="ps-mode__hk">
              {m.hk.map((k, i) => (
                <span key={i} className="ps-kbd">
                  {k}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>

      {lastSnap !== undefined && (
        <>
          <div className="ps-tray__divider" />
          {/* Last snap — bigger preview + Low/Med/High copy buttons,
              identical visual treatment to the post-capture float-
              over toast (uses the shared .fo__copy-btn styles). The
              dimensions + bytes update per preset so the user knows
              what they're about to paste; ⌘1/⌘2/⌘3 dispatch the
              same clipboard:copy verb the toast does. */}
          <div className="ps-tray__last">
            <div className="ps-tray__last-hdr">
              <span className="ps-tray__last-eyebrow">
                Last snap · {relativeTime(lastSnap.captured_at)}
              </span>
              <span className="ps-tray__last-meta">
                {lastSnap.width_px}×{lastSnap.height_px}
              </span>
            </div>
            <div className="ps-tray__last-preview">
              <img
                src={cacheUrl(lastSnap.id, 800, "webp", lastSnap.overlays_version)}
                alt="Last snap"
              />
            </div>
            <div className="ps-tray__last-copy">
              {COPY_PRESETS.map((p) => {
                const m = presetMetrics(
                  p.id,
                  lastSnap.width_px,
                  lastSnap.height_px,
                  lastSnap.byte_size
                );
                return (
                  <CopyButton
                    key={p.id}
                    preset={p.id}
                    label={p.label}
                    dim={m.dim}
                    bytes={m.bytes}
                    onCopy={onCopyLastSnap}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}
      <div style={{ height: 8 }} />
    </div>
    </div>
  );
}

