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
import {
  acceleratorToDisplayText,
  type ExportRung,
  type ShortcutPlatform
} from "@pwrsnap/shared";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import { FoIcon } from "../float-over/FoIcons";

export type CopyPreset = "low" | "med" | "high";

export type CopyButtonMetric = {
  readonly dim: string;
  readonly bytes: string;
  readonly exact: boolean;
};

/** Small DPI callout shown under a copy card's dimensions when the
 *  experimental DPI-aware export ladder is active. `highDensity` drives
 *  the accent treatment for macOS Retina and cross-platform High DPI. */
export type CopyTag = {
  readonly label: string;
  readonly highDensity: boolean;
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
export function rungTag(rung: ExportRung, platform?: string): CopyTag {
  if (platform === "darwin" && rung.retina) {
    return { label: "Retina", highDensity: true };
  }
  if (platform !== "darwin" && rung.highDensity) {
    return { label: "High DPI", highDensity: true };
  }
  return {
    label: formatOnScreenMultiple(rung.onScreenMultiple),
    highDensity: false
  };
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

/** What a copy reports back. A dispatch `Result` fits as-is. */
export type CopyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly message: string } };

/** A copy callback may return its outcome. When it does, the card says
 *  "Copied" only once the copy succeeded, and "Failed" when it did not.
 *  A callback that returns nothing keeps the old click-time flash. */
export type CopyAction = (preset: CopyPreset) => void | PromiseLike<CopyOutcome>;

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
  /** Unavailable DPI-aware rung. The card remains in the three-column
   *  layout but cannot copy, drag, or expose a file-path action. */
  disabled?: boolean;
  /** Fired when the user clicks. Caller chooses whether this copies
   *  raw image bytes or a file-backed export; the overlay animation
   *  runs unconditionally on click. */
  onCopy: CopyAction;
  /** Fired on a drag-start gesture to drag this exact preset as a PNG file. */
  onDrag?: (preset: CopyPreset) => void;
  /** Fired on a click of the FILE chip. Caller dispatches
   *  `clipboard:copy-path` so the rendered cache file's native absolute path
   *  lands on the clipboard as text. Drag still hands off the file
   *  itself; this is the keyboardless-mouse equivalent for pasting
   *  the path into a terminal / editor. */
  onCopyPath?: CopyAction;
  /** Incremented by parent-owned shortcuts to run the same visual feedback as click. */
  copyPulse?: number;
  /** Explicit override for deterministic platform-presentation tests. */
  shortcutPlatform?: ShortcutPlatform;
  /** Hide the chord when the embedding surface delegates these keys elsewhere. */
  showShortcutHint?: boolean;
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
  disabled = false,
  onCopy,
  onDrag,
  onCopyPath,
  copyPulse = 0,
  shortcutPlatform = rendererShortcutPlatform(),
  showShortcutHint = true
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  // Only the latest click's outcome may land; an earlier, slower copy
  // must not overwrite it. Bumped on unmount so nothing lands after it.
  const copySeqRef = useRef(0);
  const pathSeqRef = useRef(0);
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
    if (disabled) return;
    setCopyError(null);
    const outcome = onCopy(preset);
    if (outcome === undefined) {
      showCopied();
      return;
    }
    const seq = ++copySeqRef.current;
    setCopyBusy(true);
    void Promise.resolve(outcome).then(
      (result) => {
        if (seq !== copySeqRef.current) return;
        setCopyBusy(false);
        if (result.ok) showCopied();
        else setCopyError(result.error.message);
      },
      (cause: unknown) => {
        if (seq !== copySeqRef.current) return;
        setCopyBusy(false);
        setCopyError(cause instanceof Error ? cause.message : String(cause));
      }
    );
  };

  const handleDragStart = (event: React.DragEvent<HTMLAnchorElement>): void => {
    if (disabled || onDrag === undefined) return;
    event.preventDefault();
    onDrag(preset);
  };

  const showPathCopied = (): void => {
    setPathCopied(true);
    if (pathTimerRef.current !== null) clearTimeout(pathTimerRef.current);
    pathTimerRef.current = setTimeout(() => {
      setPathCopied(false);
      pathTimerRef.current = null;
    }, COPIED_VISIBLE_MS);
  };

  const handleFileClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (disabled || onCopyPath === undefined) return;
    setPathError(null);
    const outcome = onCopyPath(preset);
    if (outcome === undefined) {
      showPathCopied();
      return;
    }
    const seq = ++pathSeqRef.current;
    void Promise.resolve(outcome).then(
      (result) => {
        if (seq !== pathSeqRef.current) return;
        if (result.ok) showPathCopied();
        else setPathError(result.error.message);
      },
      (cause: unknown) => {
        if (seq !== pathSeqRef.current) return;
        setPathError(cause instanceof Error ? cause.message : String(cause));
      }
    );
  };

  // Clear the timer on unmount so a button-overlay timeout doesn't
  // fire after the float-over toast or tray popover hides. Without
  // this, `setCopied(false)` would fire on an unmounted component
  // and React would log a warning in dev.
  useEffect(() => {
    return () => {
      copySeqRef.current += 1;
      pathSeqRef.current += 1;
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
    if (disabled) return;
    showCopied();
  }, [copyPulse, disabled]);

  const [dimLine1, dimLine2] = splitDimensionLabel(dim);
  const [bytesLine1, bytesLine2] = splitBytesLabel(bytes);
  const copyChord = acceleratorToDisplayText(
    `CommandOrControl+${KBD_DIGIT[preset]}`,
    shortcutPlatform
  );

  return (
    <div className={"fo__copy-card" + (disabled ? " is-disabled" : "")}>
      <button
        type="button"
        className={
          "fo__copy-btn" +
          (copied ? " is-copied" : "") +
          (copyBusy ? " is-pending" : "") +
          (copyError !== null ? " is-error" : "")
        }
        disabled={disabled}
        onClick={handleClick}
        aria-busy={copyBusy ? true : undefined}
        // The fast tooltip carries the reason; the card itself has room
        // only for "Failed".
        data-tip={copyError !== null ? `Couldn’t copy: ${copyError}` : undefined}
      >
        <div className="fo__copy-btn-row1">
          <span className="fo__copy-label">{label}</span>
          {disabled || showShortcutHint ? (
            <span className="fo__copy-kbd">{disabled ? "—" : copyChord}</span>
          ) : null}
        </div>
        {copyError !== null ? (
          <div className="fo__copy-meta">
            <span className="fo__copy-dim">
              <span>Failed</span>
              <span>retry?</span>
            </span>
          </div>
        ) : (
        <div className="fo__copy-meta">
          <span className="fo__copy-dim">
            <span>{dimLine1}</span>
            {dimLine2.length > 0 ? <span>{dimLine2}</span> : null}
            {tag !== undefined ? (
              <span
                className={
                  "fo__copy-tag" + (tag.highDensity ? " is-high-density" : "")
                }
              >
                {tag.label}
              </span>
            ) : null}
          </span>
          <span className="fo__copy-bytes">
            <span>{bytesLine1}</span>
            {bytesLine2.length > 0 ? <span>{bytesLine2}</span> : null}
          </span>
        </div>
        )}
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
      {!disabled && (onDrag !== undefined || onCopyPath !== undefined) ? (
        <a
          className={
            "fo__copy-file" +
            (pathCopied ? " is-copied" : "") +
            (pathError !== null ? " is-error" : "")
          }
          draggable={onDrag !== undefined}
          href="#"
          // "File" alone does not say a click copies the path; the fast
          // tooltip does.
          data-tip={
            pathError !== null
              ? `Couldn’t copy the path: ${pathError}`
              : onCopyPath !== undefined
                ? `Copy ${label} PNG file path`
                : `Drag ${label} PNG file`
          }
          data-tip-detail={
            pathError === null && onCopyPath !== undefined ? "Drag for the file itself" : undefined
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
          {pathCopied ? "Copied" : pathError !== null ? "Failed" : "File"}
        </a>
      ) : null}
    </div>
  );
}
