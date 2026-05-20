// Single toolbar button + popover menu for zoom controls. Replaces
// the historical two-button "100% | 1:1" pair which was confusing
// (clicking "100%" did Fit, clicking "1:1" did 100%, both buttons
// changed their own label after the click).
//
// Label semantics:
//   • mode === "fit"    → "Fit (62%)" — the user explicitly clicked
//                          Fit; the parenthetical pct is informational
//                          (Retina captures look ~50% at fit).
//   • mode === "actual" → "100%" — the user explicitly clicked 100%.
//                          On wrap resize the scale tracks 100%
//                          (handled inside useZoomPan).
//   • mode === "custom" → "150%" — the user typed a value, clicked
//                          +/−, or pinch-zoomed.
//
// The popover contains: Fit row, 100% row, and a custom-pct row with
// −20% / text input / +20% buttons. Selected row gets a checkmark.

import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { ZoomApi } from "./Editor";
import "./ZoomMenu.css";

const ZOOM_STEP = 1.2; // 20% relative

export function ZoomMenu({ zoom }: { zoom: NonNullable<ZoomApi> }): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const labelId = useId();

  // Input lives in its own draft state while focused so digit-by-digit
  // typing doesn't update the canvas mid-type ("1" → 1%, "10" → 10%
  // would be jarring). When the input loses focus or the user hits
  // Enter, the draft is committed via zoom.setCustomPct.
  const [draft, setDraft] = useState<string | null>(null);
  const draftValue = draft !== null
    ? draft
    : zoom.displayPct === null
      ? ""
      : Math.round(zoom.displayPct).toString();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent | TouchEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // When the popover opens, focus the input + select its contents so
  // the user can immediately start typing a new pct.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.select();
      });
    } else {
      // Discard any unfocused draft so the next open reads fresh.
      setDraft(null);
    }
  }, [open]);

  const commitDraft = useCallback((): void => {
    if (draft === null) return;
    const pct = parseFloat(draft);
    if (Number.isFinite(pct) && pct > 0) {
      zoom.setCustomPct(pct);
    }
    setDraft(null);
  }, [draft, zoom]);

  const label = formatLabel(zoom);
  const title =
    "Zoom · click for Fit / 100% / custom · ⌘0 fit · ⌘1 100% · ⌘+/⌘- step · ⌘+scroll cursor zoom · two-finger scroll pans";

  return (
    <div className="ed-zoom" ref={rootRef}>
      <button
        type="button"
        className={"ed-zoom-btn" + (open ? " is-open" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => setOpen((o) => !o)}
        title={title}
      >
        <span id={labelId}>{label}</span>
        <svg width="9" height="6" viewBox="0 0 9 6" fill="currentColor" aria-hidden="true">
          <path d="M4.5 6 0 0h9z" />
        </svg>
      </button>
      {open && (
        <div className="ed-zoom-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={zoom.mode === "fit"}
            className={"ed-zoom-row" + (zoom.mode === "fit" ? " is-selected" : "")}
            onClick={() => {
              zoom.resetToFit();
              setOpen(false);
            }}
          >
            <Check show={zoom.mode === "fit"} />
            <span>Fit</span>
            <span className="ed-zoom-row-meta">
              {zoom.fitPct === null ? "" : `${Math.round(zoom.fitPct)}%`}
            </span>
            <span className="ed-zoom-row-key">⌘0</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={zoom.mode === "actual"}
            className={"ed-zoom-row" + (zoom.mode === "actual" ? " is-selected" : "")}
            onClick={() => {
              zoom.actualSize();
              setOpen(false);
            }}
          >
            <Check show={zoom.mode === "actual"} />
            <span>100%</span>
            <span className="ed-zoom-row-meta" />
            <span className="ed-zoom-row-key">⌘1</span>
          </button>
          <div className="ed-zoom-custom">
            <button
              type="button"
              className="ed-zoom-step"
              onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}
              aria-label="Zoom out 20%"
              title="−20%"
            >
              −
            </button>
            <div className="ed-zoom-input">
              <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                value={draftValue}
                onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
                onFocus={() => {
                  if (draft === null && zoom.displayPct !== null) {
                    setDraft(Math.round(zoom.displayPct).toString());
                  }
                }}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitDraft();
                    setOpen(false);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setDraft(null);
                    setOpen(false);
                  }
                }}
              />
              <span className="ed-zoom-input-pct">%</span>
            </div>
            <button
              type="button"
              className="ed-zoom-step"
              onClick={() => zoom.zoomBy(ZOOM_STEP)}
              aria-label="Zoom in 20%"
              title="+20%"
            >
              +
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Check({ show }: { show: boolean }): ReactElement {
  return (
    <span className="ed-zoom-check" aria-hidden="true">
      {show ? (
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m1 4 3 3 5-6" />
        </svg>
      ) : null}
    </span>
  );
}

function formatLabel(zoom: NonNullable<ZoomApi>): string {
  if (zoom.displayPct === null) return "—";
  const pct = Math.round(zoom.displayPct);
  if (zoom.mode === "fit") {
    return `Fit (${pct}%)`;
  }
  return `${pct}%`;
}
