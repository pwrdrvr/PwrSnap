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
//
// It is a non-modal DIALOG, not a menu. It used to say role="menu", which
// promises arrow keys between menu items — and a menu cannot hold a text
// field or step buttons, so the promise could not be kept (measured: every
// arrow key went to the input, and Tab walked out with the popover still
// open). As a popover it sits right after its trigger in the DOM, so Tab
// order is the visual order; Escape closes it and returns focus to the
// trigger; and focus leaving it closes it rather than leaving it open over
// the toolbar.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement
} from "react";
import {
  acceleratorToDisplayKeys,
  acceleratorToDisplayText,
  type ShortcutPlatform
} from "@pwrsnap/shared";
import { useDismissable } from "../../lib/useDismissable";
import { useFocusReturn } from "../../lib/useFocusReturn";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import type { ZoomApi } from "./Editor";
import "./ZoomMenu.css";

const ZOOM_STEP = 1.2; // 20% relative

export function ZoomMenu({
  zoom,
  shortcutPlatform = rendererShortcutPlatform()
}: {
  zoom: NonNullable<ZoomApi>;
  shortcutPlatform?: ShortcutPlatform;
}): ReactElement {
  const primaryModifier =
    acceleratorToDisplayKeys("CommandOrControl", shortcutPlatform)[0] ?? "Ctrl";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
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

  // Set by Escape so the blur that follows cannot commit what Escape threw
  // away. A ref, not the draft state: focus leaves the field synchronously,
  // before React re-renders, and onBlur still holds the typed draft.
  const discardRef = useRef(false);

  // Escape discards any typed draft and closes. The claim is made on window
  // before the editor's own listener, so Escape here never ALSO clears the
  // canvas selection — which it did from any row other than the input.
  useDismissable({
    open,
    onDismiss: () => {
      discardRef.current = true;
      setDraft(null);
      setOpen(false);
    },
    surfaceRef: popoverRef,
    triggerRef,
    dismissOnFocusLeave: true
  });
  // Closing from a row (Fit, 100%, Enter in the field) unmounts the control
  // holding focus; put it back on the trigger instead of <body>.
  useFocusReturn({ open, containerRef: popoverRef, returnFocusRef: triggerRef });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent | TouchEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  // When the popover opens, focus the input + select its contents so
  // the user can immediately start typing a new pct.
  useEffect(() => {
    if (open) {
      discardRef.current = false;
      requestAnimationFrame(() => {
        inputRef.current?.select();
      });
    } else {
      // Discard any unfocused draft so the next open reads fresh.
      setDraft(null);
    }
  }, [open]);

  const commitDraft = useCallback((): void => {
    if (draft === null || discardRef.current) return;
    const pct = parseFloat(draft);
    if (Number.isFinite(pct) && pct > 0) {
      zoom.setCustomPct(pct);
    }
    setDraft(null);
  }, [draft, zoom]);

  const label = formatLabel(zoom);
  // Short title — the open menu surfaces every shortcut inline (see
  // .ed-zoom-step-key + .ed-zoom-hint). A long native title is unreadable
  // anyway because the OS renderer wraps it into a multi-line tooltip.
  const title = "Zoom";

  return (
    <div className="ed-zoom" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={"ed-zoom-btn" + (open ? " is-open" : "")}
        aria-haspopup="dialog"
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
        <div
          ref={popoverRef}
          className="ed-zoom-menu"
          role="dialog"
          aria-label="Zoom"
        >
          <button
            type="button"
            aria-pressed={zoom.mode === "fit"}
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
            <span className="ed-zoom-row-key">
              {acceleratorToDisplayText("CommandOrControl+0", shortcutPlatform)}
            </span>
          </button>
          <button
            type="button"
            aria-pressed={zoom.mode === "actual"}
            className={"ed-zoom-row" + (zoom.mode === "actual" ? " is-selected" : "")}
            onClick={() => {
              zoom.actualSize();
              setOpen(false);
            }}
          >
            <Check show={zoom.mode === "actual"} />
            <span>100%</span>
            <span className="ed-zoom-row-meta" />
          </button>
          <div className="ed-zoom-custom">
            <button
              type="button"
              className="ed-zoom-step"
              onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}
              aria-label="Zoom out 20%"
            >
              <span aria-hidden="true">−</span>
              <span className="ed-zoom-step-key">
                {acceleratorToDisplayText("CommandOrControl+-", shortcutPlatform)}
              </span>
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
                  // Escape never reaches here: useDismissable claims it.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitDraft();
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
            >
              <span aria-hidden="true">+</span>
              <span className="ed-zoom-step-key">
                {acceleratorToDisplayText("CommandOrControl+Plus", shortcutPlatform)}
              </span>
            </button>
          </div>
          <div className="ed-zoom-hint">
            <span><kbd>{primaryModifier}</kbd>+scroll cursor zoom</span>
            <span>· two-finger scroll pans</span>
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
