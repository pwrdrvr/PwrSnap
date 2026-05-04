import { useEffect, useLayoutEffect, useRef } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { Kbd } from "../shared/Primitives";
import { dispatch } from "../../lib/pwrsnap";
import { useLibrary } from "../../lib/useLibrary";

type ModeKind = "region" | "window" | "full" | "all" | "scroll" | "timed";

/** Phase 1 ships only `region`. The other modes show but route to a
 *  no-op + tooltip until Phase 2+. `available` flags drive a disabled
 *  visual treatment so the UI is honest about what works today. */
const MODES: Array<{
  id: ModeKind;
  name: string;
  sub: string;
  hk: string[];
  available: boolean;
}> = [
  { id: "region", name: "Region", sub: "Drag selection", hk: ["⌘", "⇧", "P"], available: true },
  { id: "window", name: "Window", sub: "Coming in Phase 2", hk: ["⌘", "⇧", "W"], available: false },
  { id: "full", name: "Full Screen", sub: "Coming in Phase 2", hk: ["⌘", "⇧", "F"], available: false },
  { id: "all", name: "All Screens", sub: "Coming in Phase 2", hk: ["⌘", "⇧", "A"], available: false },
  { id: "scroll", name: "Scrolling", sub: "Coming later", hk: ["⌘", "⇧", "S"], available: false },
  { id: "timed", name: "Timed (5s)", sub: "Coming later", hk: ["⌘", "⇧", "T"], available: false }
];

function ModeIcon({ kind }: { kind: ModeKind }) {
  switch (kind) {
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function TrayMenu({ activeMode = "region" }: { activeMode?: ModeKind }) {
  const { records } = useLibrary();
  const lastSnap: CaptureRecord | undefined = records[0];

  // Tell main to size the window to our actual content height. Keeps
  // the popover snug — no dead space at the bottom — and re-fires if
  // the content grows (e.g. a long source-app name in the activity
  // card). Main listens on a dedicated ipcRenderer.send channel.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const post = (): void => {
      const { width, height } = el.getBoundingClientRect();
      // electron BrowserWindow.setContentSize takes integers; round
      // up so we never crop a pixel of the bottom row.
      window.dispatchEvent(
        new CustomEvent("pwrsnap:tray:resize", {
          detail: { width: Math.ceil(width), height: Math.ceil(height) }
        })
      );
    };
    post();
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The CustomEvent above is a renderer-internal hop — TrayMenuShell
  // (below) listens for it and forwards via window.pwrsnapApi.
  // Splitting keeps the JSX tree easy to read while letting the
  // forwarding logic sit close to the lifecycle effect.

  const onCaptureRegion = (): void => {
    void dispatch("capture:interactive", {});
  };
  const onOpenLibrary = (): void => {
    void dispatch("library:focus", {});
  };
  const onRevealLastSnap = (): void => {
    if (lastSnap === undefined) return;
    void dispatch("capture:reveal", { captureId: lastSnap.id });
  };

  return (
    <div className="ps-tray" ref={containerRef}>
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

      <div className="ps-tray__hotkey">
        <div className="ps-tray__hotkey-l">
          <span className="ps-tray__hotkey-eyebrow">Quick Capture</span>
          <span style={{ font: "500 11px/1 var(--font-sans)", color: "var(--text-secondary)" }}>
            Press a shortcut from anywhere
          </span>
        </div>
        <div className="ps-tray__hotkey-row">
          <Kbd accent>⌘</Kbd>
          <Kbd accent>⇧</Kbd>
          <Kbd accent>P</Kbd>
        </div>
      </div>

      <div className="ps-tray__modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={
              "ps-mode" +
              (m.id === activeMode ? " is-primary" : "") +
              (m.available ? "" : " is-disabled")
            }
            type="button"
            disabled={!m.available}
            title={m.available ? undefined : "Coming in a later phase"}
            onClick={m.id === "region" ? onCaptureRegion : undefined}
          >
            <div className="ps-mode__row1">
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
            </div>
            <div className="ps-mode__sub">{m.sub}</div>
          </button>
        ))}
      </div>

      {lastSnap !== undefined && (
        <>
          <div className="ps-tray__divider" />
          <button
            className="ps-tray__activity"
            type="button"
            onClick={onRevealLastSnap}
            title="Reveal in Finder"
          >
            <div className="ps-tray__activity-thumb">
              <img
                src={`pwrsnap-cache://${lastSnap.id}/72w.webp`}
                alt="Last snap"
              />
            </div>
            <div className="ps-tray__activity-text">
              <b>Last snap · {relativeTime(lastSnap.captured_at)}</b>
              <small>
                {lastSnap.width_px}×{lastSnap.height_px} · {formatBytes(lastSnap.byte_size)} · region
              </small>
            </div>
            <div className="ps-tray__activity-meta">
              <span className="ps-kbd is-accent">↗</span>
            </div>
          </button>
        </>
      )}

      <button className="ps-tray__row" type="button" onClick={onOpenLibrary}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 3v18" />
        </svg>
        <span className="ps-tray__row-label">Open Library</span>
        <span className="ps-tray__row-kbd">
          <Kbd>⌘</Kbd>
          <Kbd>L</Kbd>
        </span>
      </button>
      <button className="ps-tray__row is-disabled" type="button" disabled title="Coming in Phase 2">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="3" />
          <path d="M19 12a7 7 0 1 0-7 7" />
          <path d="m21 21-3-3" />
        </svg>
        <span className="ps-tray__row-label">Search captures…</span>
        <span className="ps-tray__row-kbd">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <button className="ps-tray__row is-disabled" type="button" disabled title="Coming in Phase 3">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span className="ps-tray__row-label">Preferences…</span>
        <span className="ps-tray__row-kbd">
          <Kbd>⌘</Kbd>
          <Kbd>,</Kbd>
        </span>
      </button>
      <div style={{ height: 8 }} />
    </div>
  );
}

/**
 * Catches the layout-effect resize event and forwards via the
 * window.pwrsnapApi side channel. Sits at the App.tsx root so it
 * survives any TrayMenu re-renders.
 */
export function TrayResizeForwarder(): null {
  useEffect(() => {
    const handler = (event: Event): void => {
      const ce = event as CustomEvent<{ width: number; height: number }>;
      window.pwrsnapApi?.requestTrayResize?.(ce.detail);
    };
    window.addEventListener("pwrsnap:tray:resize", handler as EventListener);
    return () => window.removeEventListener("pwrsnap:tray:resize", handler as EventListener);
  }, []);
  return null;
}
