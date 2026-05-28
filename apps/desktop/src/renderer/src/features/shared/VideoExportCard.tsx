// Per-(format, preset) export card. Renders the same shape as
// `<CopyButton>` (image L/M/H) — preset label + ⌘N kbd hint + dim +
// bytes + click-to-copy overlay + FILE chip — but talks to the
// video-aware bus verbs instead of the image clipboard ones.
//
// Click the card body → encode + `clipboard:copyVideoFile` (writes
// `public.file-url` UTI so paste in Slack/Mail drops the binary).
// Click the FILE chip → `clipboard:copyVideoPath` (writes the POSIX
// path as text).
// Drag the FILE chip → `startVideoDrag` (main encodes + starts native
// drag with a poster-frame icon).
//
// The card disables itself while encoding (`Encoding…` subtitle
// replaces the dim/bytes meta) so the user knows the click is
// in-flight. Other cards stay clickable — each (format, preset) has
// its own state machine.

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { VideoPreset } from "@pwrsnap/shared";
import type { CopyButtonMetric } from "./CopyButton";
import type { ExportButtonState } from "./useVideoExportPresets";
import { FoIcon } from "../float-over/FoIcons";

export type VideoExportCardProps = {
  readonly format: "gif" | "mp4";
  readonly preset: VideoPreset;
  /** Display label — "Low" / "Med" / "High" (the format prefix
   *  lives elsewhere; this is just the preset tier). */
  readonly label: string;
  /** Keyboard hint shown in the top-right corner. The card itself
   *  doesn't bind the chord — that's the parent grid's job — but
   *  the visual cue lives here. */
  readonly kbd: string;
  /** Output dimensions string from `useVideoPresetMetrics`. May be
   *  estimated (no cache row yet) or exact (post-encode). */
  readonly dim: string;
  /** Byte-size label, optionally prefixed with "~" when estimated. */
  readonly bytes: string;
  /** Current state from `useVideoExportPresets.states[key]`. */
  readonly state: ExportButtonState;
  /** Triggered by clicking the card body. Parent dispatches
   *  `clipboard:copyVideoFile`. */
  readonly onCopy: () => void;
  /** Triggered by clicking the FILE chip. Parent dispatches
   *  `clipboard:copyVideoPath`. */
  readonly onCopyPath: () => void;
  /** Triggered by dragging the FILE chip. Parent fires
   *  `startVideoDrag` (fire-and-forget). */
  readonly onDrag: () => void;
};

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

export function VideoExportCard({
  format,
  preset,
  label,
  kbd,
  dim,
  bytes,
  state,
  onCopy,
  onCopyPath,
  onDrag
}: VideoExportCardProps): ReactElement {
  // Local "Copied" overlay timer for the card body — fires when the
  // user clicks and the dispatch resolves successfully (state
  // transitions to "done"). Same 1.2s duration as `<CopyButton>` so
  // the feedback timing is consistent across image and video cards.
  const [copiedPulse, setCopiedPulse] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const cardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStateKindRef = useRef<ExportButtonState["kind"]>(state.kind);

  useEffect(() => {
    if (prevStateKindRef.current !== "done" && state.kind === "done") {
      setCopiedPulse(true);
      if (cardTimerRef.current !== null) clearTimeout(cardTimerRef.current);
      cardTimerRef.current = setTimeout(() => {
        setCopiedPulse(false);
        cardTimerRef.current = null;
      }, COPIED_VISIBLE_MS);
    }
    prevStateKindRef.current = state.kind;
  }, [state.kind]);

  useEffect(() => {
    return () => {
      if (cardTimerRef.current !== null) clearTimeout(cardTimerRef.current);
      if (pathTimerRef.current !== null) clearTimeout(pathTimerRef.current);
    };
  }, []);

  const handleCardClick = (): void => {
    if (state.kind === "running") return;
    onCopy();
  };

  const handleFileClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (state.kind === "running") return;
    onCopyPath();
    setPathCopied(true);
    if (pathTimerRef.current !== null) clearTimeout(pathTimerRef.current);
    pathTimerRef.current = setTimeout(() => {
      setPathCopied(false);
      pathTimerRef.current = null;
    }, COPIED_VISIBLE_MS);
  };

  const handleDragStart = (event: React.DragEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    onDrag();
  };

  const isRunning = state.kind === "running";
  const isError = state.kind === "error";

  const [dimLine1, dimLine2] = splitDimensionLabel(dim);
  const [bytesLine1, bytesLine2] = splitBytesLabel(bytes);

  const formatTitle = format === "gif" ? "GIF" : "MP4";
  const cardTitle = isError
    ? `Failed: ${state.message}`
    : `Encode + copy ${label} ${formatTitle} to clipboard · ${kbd}`;

  return (
    <div className="fo__copy-card">
      <button
        type="button"
        className={
          "fo__copy-btn" +
          (copiedPulse ? " is-copied" : "") +
          (isRunning ? " is-running" : "") +
          (isError ? " is-error" : "")
        }
        onClick={handleCardClick}
        disabled={isRunning}
        title={cardTitle}
        aria-label={`Copy ${label} ${formatTitle} to clipboard`}
      >
        <div className="fo__copy-btn-row1">
          <span className="fo__copy-label">{label}</span>
          <span className="fo__copy-kbd">{kbd}</span>
        </div>
        <div className="fo__copy-meta">
          {isRunning ? (
            <span className="fo__copy-dim">
              <span>Encoding</span>
              <span>…</span>
            </span>
          ) : isError ? (
            <span className="fo__copy-dim">
              <span>Failed</span>
              <span>retry?</span>
            </span>
          ) : (
            <>
              <span className="fo__copy-dim">
                <span>{dimLine1}</span>
                {dimLine2.length > 0 ? <span>{dimLine2}</span> : null}
              </span>
              <span className="fo__copy-bytes">
                <span>{bytesLine1}</span>
                {bytesLine2.length > 0 ? <span>{bytesLine2}</span> : null}
              </span>
            </>
          )}
        </div>
        <span className="fo__copy-overlay" aria-hidden="true">
          Copied
        </span>
      </button>
      <a
        className={"fo__copy-file" + (pathCopied ? " is-copied" : "")}
        // Drag becomes legal once we have a preset to drag — which is
        // always, here. Main does the encode-on-demand inside its
        // `video:prepareDrag` handler so we don't need to gate on
        // cache state from the renderer.
        draggable
        href="#"
        title={`Click to copy ${label} ${formatTitle} file path · drag for the file itself`}
        aria-label={`Copy ${label} ${formatTitle} file path to clipboard, or drag for the file`}
        role="button"
        onClick={handleFileClick}
        onDragStart={handleDragStart}
        data-format={format}
        data-preset={preset}
      >
        <FoIcon name="hand" size={10} />
        {pathCopied ? "Copied" : "File"}
      </a>
    </div>
  );
}

/** Helper to extract a label/byte pair from a metrics map. Used by
 *  the grid wrapper to feed each card; exported separately so a
 *  unit test can verify the "no cache row yet" fallback path. */
export function readMetric(
  metric: CopyButtonMetric | undefined,
  fallback: { dim: string; bytes: string }
): { dim: string; bytes: string } {
  if (metric === undefined) return fallback;
  return { dim: metric.dim, bytes: metric.bytes };
}
