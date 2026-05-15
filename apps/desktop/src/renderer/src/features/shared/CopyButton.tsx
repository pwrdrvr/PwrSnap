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

export type CopyButtonMetric = {
  readonly dim: string;
  readonly bytes: string;
  readonly exact: boolean;
};

/** Estimated output dimensions + bytes for a given preset against a
 *  source capture's actual width × height × byte size — surfaced on
 *  each copy button only until the real render-cache metrics arrive
 *  from main. Mirrors the bake-time preset widths in main's render
 *  path (low=800, med=1440, high=source). Bytes is an estimate:
 *  scale shrinks linearly with preset width, so byte count shrinks
 *  with scale² (image area).
 *
 *  Originally lived in TrayMenu.tsx; moved here in Phase C.5 of the
 *  library three-state plan so the library's DetailRail can use the
 *  same function without duplication. */
export function presetMetrics(
  preset: CopyPreset,
  srcW: number,
  srcH: number,
  srcBytes: number
): CopyButtonMetric {
  const targetW = preset === "low" ? 800 : preset === "med" ? 1440 : srcW;
  const scale = Math.min(1, targetW / Math.max(1, srcW));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const bytes = Math.round(srcBytes * scale * scale);
  return { dim: `${w} × ${h}`, bytes: formatBytes(bytes, true), exact: false };
}

export function exactPresetMetrics(input: {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly byteSize: number;
}): CopyButtonMetric {
  return {
    dim: `${input.widthPx} × ${input.heightPx}`,
    bytes: formatBytes(input.byteSize, false),
    exact: true
  };
}

function formatBytes(n: number, estimated: boolean): string {
  const prefix = estimated ? "~" : "";
  if (n < 1024) return `${prefix}${n} B`;
  if (n < 1024 * 1024) return `${prefix}${Math.round(n / 1024)} KB`;
  return `${prefix}${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export type CopyButtonProps = {
  /** Which preset this button represents — drives the kbd shortcut
   *  hint (⌘1 / ⌘2 / ⌘3) and is passed to onCopy on click. */
  preset: CopyPreset;
  /** Display label, e.g. "Low" / "Med" / "High". */
  label: string;
  /** Output dimensions string, e.g. "800 × 408". Pre-computed by the
   *  caller against the source capture's actual width/height. */
  dim: string;
  /** Output bytes label, exact once render-cache metrics load. */
  bytes: string;
  /** Fired when the user clicks. Caller is responsible for
   *  dispatching `clipboard:copy`; the overlay animation runs
   *  unconditionally on click. */
  onCopy: (preset: CopyPreset) => void;
  /** Fired on a drag-start gesture to drag this exact preset as a PNG file. */
  onDrag?: (preset: CopyPreset) => void;
};

const KBD_DIGIT: Record<CopyPreset, string> = { low: "1", med: "2", high: "3" };

/** How long the "Copied" overlay stays visible after a click.
 *  Matches the float-over's old `is-copied` pulse duration so the
 *  feedback timing feels familiar. */
const COPIED_VISIBLE_MS = 1200;

export function CopyButton({ preset, label, dim, bytes, onCopy, onDrag }: CopyButtonProps) {
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

  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>): void => {
    if (onDrag === undefined) return;
    event.preventDefault();
    onDrag(preset);
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
      draggable={onDrag !== undefined}
      onDragStart={handleDragStart}
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
