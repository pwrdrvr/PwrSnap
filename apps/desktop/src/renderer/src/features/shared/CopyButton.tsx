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
import type { ExportRung } from "@pwrsnap/shared";
import { FoIcon } from "../float-over/FoIcons";

export type CopyPreset = "low" | "med" | "high";

export type CopyButtonMetric = {
  readonly dim: string;
  readonly bytes: string;
  readonly exact: boolean;
};

/** Small DPI callout shown under a copy card's dimensions when the
 *  experimental DPI-aware export ladder is active. `retina` drives the
 *  accent treatment so the user can see at a glance which rung is the
 *  full Retina image vs. a downscaled one. */
export type CopyTag = {
  readonly label: string;
  readonly retina: boolean;
};

/** Format a rung's on-screen multiple as a compact label (2×, 1×, ½×). */
function formatOnScreenMultiple(m: number): string {
  const fractions: ReadonlyArray<readonly [number, string]> = [
    [0.125, "⅛×"],
    [0.25, "¼×"],
    [0.5, "½×"],
    [0.75, "¾×"]
  ];
  for (const [value, label] of fractions) {
    if (Math.abs(m - value) < 0.02) return label;
  }
  const rounded = Math.round(m * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}×`;
}

/** Derive the DPI callout for a resolved ladder rung. */
export function rungTag(rung: ExportRung): CopyTag {
  return rung.retina
    ? { label: "Retina", retina: true }
    : { label: formatOnScreenMultiple(rung.onScreenMultiple), retina: false };
}

/** Estimate dims + bytes for a resolved ladder rung — used as the
 *  placeholder before main's exact render-cache metrics land, when the
 *  DPI-aware ladder is active (the legacy estimate in `presetMetrics`
 *  hardcodes the 800/1440 widths and would flash a wrong size). Bytes is
 *  the same area-scaling estimate as `presetMetrics` and stays marked
 *  provisional with a `~`. */
export function estimateMetricForRung(
  rung: ExportRung,
  srcW: number,
  srcBytes: number
): CopyButtonMetric {
  const scale = Math.min(1, rung.widthPx / Math.max(1, srcW));
  const bytes = Math.round(srcBytes * scale * scale);
  return {
    dim: `${rung.widthPx} × ${rung.heightPx}`,
    bytes: formatBytes(bytes, true),
    exact: false
  };
}

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
  /** Optional DPI callout (Retina / 1× / ½× …). Rendered under the
   *  dimensions only when the experimental DPI-aware export ladder is
   *  active; `undefined` (legacy mode) keeps the card visually identical
   *  to what normal users see. */
  tag?: CopyTag | undefined;
  /** Fired when the user clicks. Caller chooses whether this copies
   *  raw image bytes or a file-backed export; the overlay animation
   *  runs unconditionally on click. */
  onCopy: (preset: CopyPreset) => void;
  /** Fired on a drag-start gesture to drag this exact preset as a PNG file. */
  onDrag?: (preset: CopyPreset) => void;
  /** Fired on a click of the FILE chip. Caller dispatches
   *  `clipboard:copy-path` so the rendered cache file's POSIX path
   *  lands on the clipboard as text. Drag still hands off the file
   *  itself; this is the keyboardless-mouse equivalent for pasting
   *  the path into a terminal / editor. */
  onCopyPath?: (preset: CopyPreset) => void;
  /** Incremented by parent-owned shortcuts to run the same visual feedback as click. */
  copyPulse?: number;
};

const KBD_DIGIT: Record<CopyPreset, string> = { low: "1", med: "2", high: "3" };

/** How long the "Copied" overlay stays visible after a click.
 *  Matches the float-over's old `is-copied` pulse duration so the
 *  feedback timing feels familiar. */
const COPIED_VISIBLE_MS = 1200;

function splitDimensionLabel(dim: string): readonly [string, string] {
  const match = /^(.+?)\s+×\s+(.+)$/.exec(dim);
  if (match === null) return [dim, ""];
  return [`${match[1]} ×`, match[2]];
}

function splitBytesLabel(bytes: string): readonly [string, string] {
  const match = /^(.+?)\s+([A-Z]+)$/.exec(bytes);
  if (match === null) return [bytes, ""];
  return [match[1], match[2]];
}

export function CopyButton({
  preset,
  label,
  dim,
  bytes,
  tag,
  onCopy,
  onDrag,
  onCopyPath,
  copyPulse = 0
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPulseRef = useRef(copyPulse);

  const showCopied = (): void => {
    setCopied(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_VISIBLE_MS);
  };

  const handleClick = (): void => {
    onCopy(preset);
    showCopied();
  };

  const handleDragStart = (event: React.DragEvent<HTMLAnchorElement>): void => {
    if (onDrag === undefined) return;
    event.preventDefault();
    onDrag(preset);
  };

  const handleFileClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (onCopyPath === undefined) return;
    onCopyPath(preset);
    setPathCopied(true);
    if (pathTimerRef.current !== null) clearTimeout(pathTimerRef.current);
    pathTimerRef.current = setTimeout(() => {
      setPathCopied(false);
      pathTimerRef.current = null;
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
      if (pathTimerRef.current !== null) {
        clearTimeout(pathTimerRef.current);
        pathTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (copyPulse === copyPulseRef.current) return;
    copyPulseRef.current = copyPulse;
    showCopied();
  }, [copyPulse]);

  const [dimLine1, dimLine2] = splitDimensionLabel(dim);
  const [bytesLine1, bytesLine2] = splitBytesLabel(bytes);

  return (
    <div className="fo__copy-card">
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
          <span className="fo__copy-dim">
            <span>{dimLine1}</span>
            {dimLine2.length > 0 ? <span>{dimLine2}</span> : null}
            {tag !== undefined ? (
              <span className={"fo__copy-tag" + (tag.retina ? " is-retina" : "")}>
                {tag.label}
              </span>
            ) : null}
          </span>
          <span className="fo__copy-bytes">
            <span>{bytesLine1}</span>
            {bytesLine2.length > 0 ? <span>{bytesLine2}</span> : null}
          </span>
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
      {onDrag !== undefined || onCopyPath !== undefined ? (
        <a
          className={"fo__copy-file" + (pathCopied ? " is-copied" : "")}
          draggable={onDrag !== undefined}
          href="#"
          title={
            onCopyPath !== undefined
              ? `Click to copy ${label} PNG file path · drag for the file itself`
              : `Drag ${label} PNG file`
          }
          aria-label={
            onCopyPath !== undefined
              ? `Copy ${label} PNG file path to clipboard, or drag for the file`
              : `Drag ${label} PNG file`
          }
          role="button"
          onClick={handleFileClick}
          onDragStart={handleDragStart}
        >
          <FoIcon name="hand" size={10} />
          {pathCopied ? "Copied" : "File"}
        </a>
      ) : null}
    </div>
  );
}
