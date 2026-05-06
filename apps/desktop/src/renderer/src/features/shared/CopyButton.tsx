// Shared Low/Med/High copy button used by the post-capture float-over
// toast AND the tray popover's "Last snap" section. Single source of
// truth for the visual treatment + the "Copied" feedback so both
// surfaces stay in lockstep — fixing a copy-related visual bug in
// one place fixes it everywhere.
//
// Click feedback is an orange overlay that covers the button content
// for ~1.2s after a successful copy, then fades back. Using an
// absolutely-positioned overlay (not a fill swap) means zero layout
// shift in the surrounding grid — the rest of the popover doesn't
// twitch when you click.

import { useEffect, useRef, useState } from "react";

export type CopyPreset = "low" | "med" | "high";

export type CopyButtonProps = {
  /** Which preset this button represents — drives the kbd shortcut
   *  hint (⌘1 / ⌘2 / ⌘3) and is passed to onCopy on click. */
  preset: CopyPreset;
  /** Display label, e.g. "Low" / "Med" / "High". */
  label: string;
  /** Output dimensions string, e.g. "800 × 408". Pre-computed by the
   *  caller against the source capture's actual width/height. */
  dim: string;
  /** Estimated output bytes, e.g. "36 KB". Same source. */
  bytes: string;
  /** Fired when the user clicks. Caller is responsible for
   *  dispatching `clipboard:copy`; the overlay animation runs
   *  unconditionally on click. */
  onCopy: (preset: CopyPreset) => void;
};

const KBD_DIGIT: Record<CopyPreset, string> = { low: "1", med: "2", high: "3" };

/** How long the "Copied" overlay stays visible after a click.
 *  Matches the float-over's old `is-copied` pulse duration so the
 *  feedback timing feels familiar. */
const COPIED_VISIBLE_MS = 1200;

export function CopyButton({ preset, label, dim, bytes, onCopy }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = (): void => {
    onCopy(preset);
    setCopied(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_VISIBLE_MS);
  };

  // Clear the timer on unmount so a button-overlay timeout doesn't
  // fire after the float-over toast or tray popover hides. Without
  // this, `setCopied(false)` would fire on an unmounted component
  // and React would log a warning in dev.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return (
    <button
      type="button"
      className={"fo__copy-btn" + (copied ? " is-copied" : "")}
      onClick={handleClick}
    >
      <div className="fo__copy-btn-row1">
        <span className="fo__copy-label">{label}</span>
        <span className="fo__copy-kbd">⌘{KBD_DIGIT[preset]}</span>
      </div>
      <div className="fo__copy-meta">
        <span className="fo__copy-dim">{dim}</span>
        <span className="fo__copy-bytes">{bytes}</span>
      </div>
      {/* Orange overlay — covers button content while `is-copied` is
          set. position:absolute + inset:0 keeps it inside the button
          bounds without affecting layout of the row1 / meta children
          underneath, so the surrounding 3-column grid never reflows.
          aria-hidden because the ARIA story for click feedback is
          covered by the live region of the underlying clipboard API,
          not by visual chrome. */}
      <span className="fo__copy-overlay" aria-hidden="true">
        Copied
      </span>
    </button>
  );
}
