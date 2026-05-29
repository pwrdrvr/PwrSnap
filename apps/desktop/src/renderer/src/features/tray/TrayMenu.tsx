import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
import { HoverAutoplayVideo } from "../shared/HoverAutoplayVideo";
import { usePresetRenderMetrics } from "../shared/usePresetRenderMetrics";
import { Kbd } from "../shared/Primitives";
import { useHotkeys } from "../shared/useHotkeys";
import { VideoExportPresetsPanel } from "../shared/VideoExportPresetsPanel";
import { acceleratorToDisplayKeys } from "../../lib/format-hotkey";
import { cacheUrl, captureSrcUrl, dispatch, startCaptureDrag } from "../../lib/pwrsnap";
import { useLibrary } from "../../lib/useLibrary";

function fmtTrayDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = (seconds - mins * 60).toFixed(1);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

type ModeKind = "auto" | "region" | "window" | "full" | "all" | "scroll" | "timed";

/** Phase 1 ships `auto` (the Quick Capture button — promoted out of
 *  the grid), `region`, and `window`. The other four modes are stubbed
 *  with `available: false` so the disabled treatment honestly signals
 *  what works today.
 *
 *  Chord glyphs for `region` / `window` come from the live settings
 *  snapshot (Settings → Hotkeys is editable). When the binding is
 *  unbound (empty string in settings — the default for those two now
 *  that Quick Capture covers both), the chip is omitted entirely. The
 *  preview modes (full / all / scroll / timed) still carry static
 *  placeholder glyphs because they aren't bound to anything in code. */
const MODES: Array<{
  id: Exclude<ModeKind, "auto">;
  name: string;
  /** Static fallback for preview modes that aren't wired to settings. */
  hk: string[];
  available: boolean;
}> = [
  // Two-column grid order — keeps the most-used in the top row, less-
  // common modes below. Region top-left because once Quick Capture
  // moves to the prominent button, Region is the highest-frequency
  // explicit-mode choice.
  { id: "region", name: "Region", hk: [], available: true },
  { id: "window", name: "Window", hk: [], available: true },
  { id: "full", name: "Full Screen", hk: [], available: true },
  { id: "all", name: "All Screens", hk: [], available: true },
  { id: "scroll", name: "Scrolling", hk: ["⌘", "⇧", "S"], available: false },
  // Timed (5s) is wired to the tray button only; no global chord yet,
  // so the kbd glyphs stay empty to match the Region / Window pattern
  // ("no chord shown when nothing is bound"). The hotkeys settings
  // page still lists ⌘⇧T as a "preview" placeholder for when a
  // bindable accelerator lands.
  { id: "timed", name: "Timed (5s)", hk: [], available: true }
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
  const hotkeys = useHotkeys();
  const lastSnap: CaptureRecord | undefined = rows[0];
  const lastSnapIsVideo = lastSnap?.kind === "video";
  // Skip the image render-metrics IPC for video captures — the
  // sharp-based preset pipeline returns nothing for `.mp4`, and the
  // tray's video branch uses GIF / MP4 export buttons instead of the
  // Low / Med / High clipboard cards anyway.
  const lastSnapMetrics = usePresetRenderMetrics(
    lastSnap !== undefined && !lastSnapIsVideo ? lastSnap.id : null,
    lastSnap !== undefined && !lastSnapIsVideo ? lastSnap.edits_version : null
  );
  // All-Screens mode: "split" (one capture per display) is the default
  // since most multi-monitor screenshots want separate files. The
  // toggle sits inline on the All Screens tile (replaces the hotkey
  // chips) and persists across tray opens because the tray
  // BrowserWindow is hidden/shown rather than torn down.
  const [allScreensMode, setAllScreensMode] = useState<"split" | "stitched">("split");

  // Live display count drives the `N×` / `1×` label on the toggle.
  // One-shot fetch on mount — the tray window persists for the app's
  // lifetime, but if the user hotplugs a monitor we'd rather show a
  // stale label than ping main on every render. Hotplug accuracy can
  // come back later via a `display-added` / `display-removed`
  // broadcast subscription.
  const [displayCount, setDisplayCount] = useState<number>(1);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await dispatch("system:listDisplays", {});
      if (!cancelled && result.ok) setDisplayCount(result.value.displays.length);
    })();
    return () => { cancelled = true; };
  }, []);

  // Pull live chord glyphs for the two wired explicit-mode hotkeys.
  // Empty array = unbound (default for both today) → the chip is
  // omitted from the mode tile.
  const liveHkFor: Record<Exclude<ModeKind, "auto">, string[]> = {
    region: acceleratorToDisplayKeys(hotkeys.region),
    window: acceleratorToDisplayKeys(hotkeys.window),
    full: MODES[2]!.hk,
    all: MODES[3]!.hk,
    scroll: MODES[4]!.hk,
    timed: MODES[5]!.hk
  };
  const quickHk = acceleratorToDisplayKeys(hotkeys.quickCapture);

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

  const onCapture = (mode: "auto" | "region" | "window" | "timed"): void => {
    void dispatch("capture:interactive", { mode });
  };
  const onCaptureFullScreen = (): void => {
    // Omit displayId so main resolves to the display the cursor is on.
    // Lets the renderer stay ignorant of display geometry — no
    // round-trip to enumerate before clicking.
    void dispatch("capture:fullScreen", {});
  };
  const onCaptureAllScreens = (): void => {
    void dispatch("capture:allScreens", { mode: allScreensMode });
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
        <div className="ps-tray__hdr-actions">
          <button
            className="ps-tray__hdr-btn"
            type="button"
            title="Open Library  (⌘⇧L)"
            onClick={() => { void dispatch("library:focus", {}); }}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5a2 2 0 0 1 2-2h4l1.5 2H18a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
              <path d="M4 9h16" />
            </svg>
            <span className="sr-only">Open Library</span>
          </button>
          <button
            className="ps-tray__hdr-btn"
            type="button"
            title="Settings  (⌘,)"
            onClick={() => { void dispatch("settings:open", {}); }}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
            </svg>
            <span className="sr-only">Open Settings</span>
          </button>
          <span className="ps-tray__hdr-sep" aria-hidden="true" />
          <div className="ps-tray__status">
            <span className="ps-tray__status-dot" />
            IDLE
          </div>
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
          {quickHk.length > 0
            ? quickHk.map((k, i) => <Kbd key={`${k}-${i}`}>{k}</Kbd>)
            : null}
        </span>
      </button>

      <div className="ps-tray__modes">
        {MODES.map((m) => {
          const hk = liveHkFor[m.id];
          const tileClick = (() => {
            if (m.id === "region") return () => onCapture("region");
            if (m.id === "window") return () => onCapture("window");
            if (m.id === "full") return onCaptureFullScreen;
            if (m.id === "all") return onCaptureAllScreens;
            if (m.id === "timed") return () => onCapture("timed");
            return undefined;
          })();
          return (
            <button
              key={m.id}
              className={"ps-mode" + (m.available ? "" : " is-disabled")}
              type="button"
              disabled={!m.available}
              title={m.available ? undefined : "Coming in a later phase"}
              onClick={tileClick}
            >
              <span className="ps-mode__icon">
                <ModeIcon kind={m.id} />
              </span>
              <span className="ps-mode__name">{m.name}</span>
              {m.id === "all" ? (
                // Segmented toggle: `N×` (one capture per display) /
                // `1×` (single stitched composite). Span-based (not
                // nested <button>) because we sit inside the tile's
                // outer <button> — clicking either segment changes
                // mode but does NOT fire the capture; the user still
                // clicks the tile body for that. stopPropagation
                // keeps the toggle "sticky".
                <span
                  className="ps-mode__seg"
                  role="group"
                  aria-label="All Screens output mode"
                >
                  <span
                    role="radio"
                    aria-checked={allScreensMode === "split"}
                    tabIndex={-1}
                    className={
                      "ps-mode__seg-opt" +
                      (allScreensMode === "split" ? " is-on" : "")
                    }
                    title={
                      displayCount > 1
                        ? `One capture per display (${displayCount} images)`
                        : "One capture per display"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      setAllScreensMode("split");
                    }}
                  >
                    {displayCount}×
                  </span>
                  <span
                    role="radio"
                    aria-checked={allScreensMode === "stitched"}
                    tabIndex={-1}
                    className={
                      "ps-mode__seg-opt" +
                      (allScreensMode === "stitched" ? " is-on" : "")
                    }
                    title="Single stitched image spanning all displays"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAllScreensMode("stitched");
                    }}
                  >
                    1×
                  </span>
                </span>
              ) : (
                <span className="ps-mode__hk">
                  {hk.map((k, i) => (
                    <span key={i} className="ps-kbd">
                      {k}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
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
                {lastSnapIsVideo ? "Last recording" : "Last snap"} · {relativeTime(lastSnap.captured_at)}
              </span>
              <span className="ps-tray__last-meta">
                {lastSnap.width_px}×{lastSnap.height_px}
                {lastSnapIsVideo && lastSnap.video !== null && lastSnap.video !== undefined
                  ? ` · ${fmtTrayDuration(lastSnap.video.durationSec)}`
                  : ""}
              </span>
            </div>
            <div className="ps-tray__last-preview">
              {lastSnapIsVideo ? (
                /* Video preview — hover-autoplay on top of native
                   controls (matches the Library card UX). `muted`
                   is required for `<video>.play()` to succeed
                   without a prior user gesture; the user can
                   click the volume control to hear sound. */
                <HoverAutoplayVideo
                  key={lastSnap.id}
                  src={captureSrcUrl(lastSnap.id)}
                />
              ) : (
                <img
                  src={cacheUrl(lastSnap.id, 800, "webp", lastSnap.edits_version)}
                  alt="Last snap"
                />
              )}
              {/* Edit button — hands off to the Library window's inline
                  editor (Focus mode + Stage), same verb the float-over
                  toast uses for its Edit affordance. The tray popover
                  auto-hides when the Library takes focus. */}
              <button
                className="ps-tray__last-edit"
                type="button"
                title="Edit in Library"
                onClick={() => {
                  void dispatch("library:openInLibrary", { captureId: lastSnap.id });
                }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                Edit
              </button>
            </div>
            {lastSnapIsVideo && lastSnap.video !== null && lastSnap.video !== undefined ? (
              /* Video export grid — same 6-card chrome (GIF L/M/H +
                 MP4 L/M/H) the library DetailRail renders. Each card
                 supports click-to-copy + FILE-chip copy-path + FILE-
                 chip drag-out via `clipboard:copyVideoFile` /
                 `copyVideoPath` / `startVideoDrag`. The panel owns
                 its own hooks; we just hand it a captureId.

                 Wrapper is a plain block (NOT `.ps-tray__last-copy`
                 which imposes a 3-col grid) — the grid component
                 renders two `.psl__copy-row-group` children that
                 each impose their own 3-col grid via
                 `.psl__copy-row`. The CSS module ships from
                 library.css and is loaded by app.css for every
                 stage. */
              <div className="ps-tray__last-export">
                <VideoExportPresetsPanel captureId={lastSnap.id} />
              </div>
            ) : (
              <div className="ps-tray__last-copy">
                {COPY_PRESETS.map((p) => {
                  const m =
                    lastSnapMetrics[p.id] ??
                    presetMetrics(p.id, lastSnap.width_px, lastSnap.height_px, lastSnap.byte_size);
                  return (
                    <CopyButton
                      key={p.id}
                      preset={p.id}
                      label={p.label}
                      dim={m.dim}
                      bytes={m.bytes}
                      onCopy={onCopyLastSnap}
                      onCopyPath={(preset) => {
                        void dispatch("clipboard:copy-path", { captureId: lastSnap.id, preset });
                      }}
                      onDrag={(preset) => startCaptureDrag(lastSnap.id, preset)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
      <div style={{ height: 8 }} />
    </div>
    </div>
  );
}
