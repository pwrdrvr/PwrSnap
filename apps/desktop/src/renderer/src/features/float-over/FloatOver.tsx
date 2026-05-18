import { useEffect, useRef, useState } from "react";
import { PwrSnapMark } from "../shared/BrandMark";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
import { HoverAutoplayVideo } from "../shared/HoverAutoplayVideo";
import type { PresetMetricMap } from "../shared/usePresetRenderMetrics";
import { FoIcon } from "./FoIcons";

const RES_PRESETS = [
  { id: "low", label: "Low" },
  { id: "med", label: "Med" },
  { id: "high", label: "High" }
] as const satisfies ReadonlyArray<{
  id: CopyPreset;
  label: string;
}>;

const VARIANTS = {
  compact: { showAnnotate: false, showAi: false, showFooter: false, showStorage: false, autoMs: 4000 },
  standard: { showAnnotate: true, showAi: true, showFooter: true, showStorage: false, autoMs: 6000 },
  full: { showAnnotate: true, showAi: true, showFooter: true, showStorage: true, autoMs: 8000 }
} as const;

type VariantId = keyof typeof VARIANTS;

function dimText(w: number, h: number) {
  return `${w.toLocaleString()} × ${h.toLocaleString()}`;
}

function fmtDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = (seconds - mins * 60).toFixed(1);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function FoTags({
  tags,
  onAdd,
  onRemove,
  suggestions = [],
  onAcceptSuggest
}: {
  tags: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
  suggestions?: string[];
  onAcceptSuggest: (t: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="fo__tags">
      {tags.map((t) => (
        <span key={t} className="fo__tag">
          {t}
          <button className="fo__tag-x" onClick={() => onRemove(t)} aria-label={`remove ${t}`}>
            ×
          </button>
        </span>
      ))}
      {suggestions
        .filter((s) => !tags.includes(s))
        .slice(0, 2)
        .map((s) => (
          <span key={s} className="fo__tag is-suggest" onClick={() => onAcceptSuggest(s)}>
            + {s}
          </span>
        ))}
      <input
        className="fo__tag-input"
        placeholder={tags.length ? "" : "tag…"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            onAdd(draft.trim());
            setDraft("");
            e.preventDefault();
          } else if (e.key === "Backspace" && !draft && tags.length) {
            onRemove(tags[tags.length - 1]!);
          }
        }}
      />
    </div>
  );
}

/** Discriminated asset mode the toast renders.
 *
 *  - `image` (default): the existing screenshot flow — `<img>` preview
 *    with Low / Med / High clipboard buttons, drag-to-file, etc. No
 *    new behavior; the asset object passes through unchanged.
 *  - `video`: same chrome (header / scanner / annotate / AI / footer /
 *    Edit) but the preview element is a native `<video>` and the
 *    Low / Med / High clipboard row is replaced by GIF / MP4
 *    full-clip export buttons that hit `video:export`. The toast
 *    stays cheap because `<video preload="metadata">` only loads
 *    the moov atom + first frame until the user actually plays.
 */
export type FloatOverAsset =
  | {
      kind: "image";
      src: string;
      enhancedSrc?: string | undefined;
      onCopy?: (preset: "low" | "med" | "high") => void;
      onCopyPath?: (preset: "low" | "med" | "high") => void;
      onDragFile?: () => void;
      onDragPreset?: (preset: "low" | "med" | "high") => void;
    }
  | {
      kind: "video";
      /** Source URL the `<video>` element loads. Typically
       *  `pwrsnap-capture://r/<id>` — the Range-aware custom
       *  protocol handler streams the requested byte range. */
      src: string;
      /** Encoded duration (sec). Surfaced in the preview-size chip
       *  AND drives the short-clip warning banner (clips under 1.5s
       *  are usually an accidental Stop press right after Start). */
      durationSec: number;
      /** Whether the source recording contains either audio track —
       *  drives the MP4 button's subtitle copy. */
      hasSystemAudio: boolean;
      hasMicrophoneAudio: boolean;
      /** Fired when the user clicks GIF / MP4. Parent dispatches
       *  `video:export` and surfaces progress / result. */
      onExport: (format: "gif" | "mp4") => void;
      /** Result of the most recent (or in-flight) export. The toast
       *  reflects this on the button labels so the user can tell what
       *  finished, what's running, what failed. */
      exportState?: FloatOverExportState;
      /** Discard the just-saved recording. Wired by the host to
       *  `library:delete` + `library:purge` + `float-over:dismiss`
       *  so the Library row, source file, and any cached exports
       *  all disappear. Shown as a destructive footer action. */
      onDiscard?: () => void;
    };

export type FloatOverExportState =
  | { kind: "idle" }
  | { kind: "running"; format: "gif" | "mp4" }
  | { kind: "done"; format: "gif" | "mp4"; path: string }
  | { kind: "error"; format: "gif" | "mp4"; message: string };

export function FloatOver({
  variant = "standard",
  asset,
  src,
  enhancedSrc,
  srcW = 2880,
  srcH = 1800,
  srcBytes = 2.4 * 1024 * 1024,
  copyMetrics,
  copyPulses,
  onDismiss,
  onEdit,
  onCopy,
  onCopyPath,
  onDragFile,
  onDragPreset,
  startCountdown = true,
  initialDescription = "",
  initialTags = [],
  aiSuggestions = ["pwragnt", "ui", "thread-list"],
  aiDescription = "PwrAgnt thread list with selected resume-menu thread",
  thinking = false
}: {
  variant?: VariantId;
  /** Asset descriptor. `image` keeps the existing screenshot toast
   *  unchanged; `video` swaps the preview + clipboard row for the
   *  video player + GIF/MP4 export. Optional for backwards-compat —
   *  call sites that haven't migrated stay on the image flow via
   *  `src` / `onCopy` / etc. */
  asset?: FloatOverAsset;
  src: string;
  enhancedSrc?: string | undefined;
  srcW?: number;
  srcH?: number;
  srcBytes?: number;
  copyMetrics?: PresetMetricMap | undefined;
  copyPulses?: Readonly<Record<CopyPreset, number>> | undefined;
  onDismiss?: () => void;
  onEdit?: () => void;
  /** Fired when the user clicks Low / Med / High in the toast. The
   *  parent dispatches `clipboard:copy` with the preset; this
   *  component just animates the "copied" badge. Without this prop
   *  wired (which was the original bug), the buttons looked
   *  responsive but never actually copied anything. */
  onCopy?: (preset: "low" | "med" | "high") => void;
  /** Fired when the user clicks the FILE chip under a preset. Parent
   *  dispatches `clipboard:copy-path` so the rendered cache file's
   *  POSIX path lands on the clipboard as text. */
  onCopyPath?: (preset: "low" | "med" | "high") => void;
  /** Fired from a drag-start gesture to hand a real PNG file to the OS. */
  onDragFile?: () => void;
  /** Fired from a Low / Med / High drag gesture to hand that preset to the OS. */
  onDragPreset?: (preset: "low" | "med" | "high") => void;
  startCountdown?: boolean;
  initialDescription?: string;
  initialTags?: string[];
  aiSuggestions?: string[];
  aiDescription?: string;
  thinking?: boolean;
}) {
  const cfg = VARIANTS[variant];
  // Note: the prior `copiedId` / `initiallyCopied` state is gone — the
  // shared CopyButton component now owns its own copied state and the
  // visual is the orange "Copied" overlay (no `is-primary` highlight,
  // no bytes-text swap). See features/shared/CopyButton.tsx.
  const [description, setDescription] = useState(initialDescription);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [hovering, setHovering] = useState(false);
  const [nativeDragging, setNativeDragging] = useState(false);
  const [progress, setProgress] = useState(1);
  const [exiting, setExiting] = useState(false);
  const [aiAccepted, setAiAccepted] = useState(false);
  const [storage, setStorage] = useState({ drive: false, dropbox: false, s3: false });
  const [visibleSrc, setVisibleSrc] = useState(src);
  const [sourceLoaded, setSourceLoaded] = useState(false);

  const startedAt = useRef(Date.now());
  const elapsedAtPause = useRef(0);
  const rafRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Exit-animation timeout handle. Stored in a ref so we can clear it
  // on unmount — without this, an in-flight `setTimeout(..., 220)` from
  // the previous capture's exit animation would survive a renderer
  // re-mount and call `onDismiss` ~220ms after the NEW toast appears,
  // hiding it. That was the "toast flashes for a microsecond" bug.
  // (With the persistent renderer + state machine added in this same
  // phase, re-mount is rare — but defensive cleanup is cheap.)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPaused =
    hovering ||
    nativeDragging ||
    description.length > 0 ||
    tags.length > initialTags.length ||
    aiAccepted;

  const syncHoverFromPoint = (clientX: number, clientY: number): void => {
    const root = rootRef.current;
    if (root === null) return;
    const target = document.elementFromPoint(clientX, clientY);
    setHovering(target !== null && root.contains(target));
  };

  useEffect(() => {
    setVisibleSrc(src);
    setSourceLoaded(false);
  }, [src]);

  useEffect(() => {
    if (!sourceLoaded || enhancedSrc === undefined || enhancedSrc === src) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setVisibleSrc(enhancedSrc);
    };
    img.src = enhancedSrc;
    return () => {
      cancelled = true;
    };
  }, [sourceLoaded, src, enhancedSrc]);

  useEffect(() => {
    if (!startCountdown || !cfg.autoMs) return;
    if (isPaused) {
      elapsedAtPause.current += Date.now() - startedAt.current;
      startedAt.current = Date.now();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = () => {
      const elapsed = elapsedAtPause.current + (Date.now() - startedAt.current);
      const p = Math.max(0, 1 - elapsed / cfg.autoMs);
      setProgress(p);
      if (p <= 0) {
        setExiting(true);
        exitTimerRef.current = setTimeout(() => onDismiss?.(), 220);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    startedAt.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPaused, startCountdown, cfg.autoMs, onDismiss]);

  useEffect(() => {
    const finishNativeDrag = (event?: MouseEvent | DragEvent): void => {
      setNativeDragging(false);
      if (event !== undefined) {
        syncHoverFromPoint(event.clientX, event.clientY);
      }
    };

    const handleMouseMove = (event: MouseEvent): void => {
      syncHoverFromPoint(event.clientX, event.clientY);
      if (nativeDragging && event.buttons === 0) {
        setNativeDragging(false);
      }
    };
    const handleMouseOut = (event: MouseEvent): void => {
      if (event.relatedTarget === null) {
        setHovering(false);
        if (nativeDragging && event.buttons === 0) {
          setNativeDragging(false);
        }
      }
    };
    const handleBlur = (): void => {
      setHovering(false);
      setNativeDragging(false);
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setNativeDragging(false);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseout", handleMouseOut);
    window.addEventListener("mouseup", finishNativeDrag);
    window.addEventListener("dragend", finishNativeDrag);
    window.addEventListener("drop", finishNativeDrag);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseout", handleMouseOut);
      window.removeEventListener("mouseup", finishNativeDrag);
      window.removeEventListener("dragend", finishNativeDrag);
      window.removeEventListener("drop", finishNativeDrag);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [nativeDragging]);

  // Clear any pending exit-animation timer on unmount. Prevents a
  // setTimeout from a previous mount firing onDismiss after the NEW
  // toast has appeared (the "microsecond flash" bug).
  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, []);

  const dismissNow = () => {
    setExiting(true);
    exitTimerRef.current = setTimeout(() => onDismiss?.(), 220);
  };

  const dragFile = (event: React.DragEvent): void => {
    if (onDragFile === undefined) return;
    event.preventDefault();
    setNativeDragging(true);
    syncHoverFromPoint(event.clientX, event.clientY);
    onDragFile();
  };

  return (
    <div
      ref={rootRef}
      className={[
        "fo",
        `fo--variant-${variant}`,
        exiting ? "is-exiting" : "is-entering",
        isPaused ? "is-paused" : "",
        thinking ? "is-thinking" : ""
      ]
        .join(" ")
        .trim()}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {startCountdown && cfg.autoMs ? (
        <div className="fo__progress">
          <div className="fo__progress-fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
      ) : null}

      <div className="fo__scanner" />

      <div className="fo__hdr">
        <span className="fo__hdr-mark">
          <PwrSnapMark size={12} />
        </span>
        <div className="fo__hdr-meta">
          <div className="fo__hdr-title">
            {asset?.kind === "video" ? "Recording saved" : "Snap captured"}
          </div>
          <div className="fo__hdr-sub">
            {dimText(srcW, srcH)}
            {asset?.kind === "video" ? ` · ${fmtDurationLabel(asset.durationSec)}` : " · just now"}
          </div>
        </div>
        <div className="fo__hdr-actions">
          {/* Auto-dismiss pauses on hover / typing — no need for a
              separate Pin affordance. The footer Edit button is the
              primary editor entry; an extra pencil here would be
              redundant. */}
          <button className="fo__icon-btn" title="Dismiss" onClick={dismissNow}>
            <FoIcon name="x" size={12} />
          </button>
        </div>
      </div>

      <div className="fo__preview">
        {asset?.kind === "video" ? (
          // Video preview — hover-autoplay on top of native
          // controls. Same component the tray uses for its
          // "last recording" preview, so the surfaces behave
          // consistently.
          <HoverAutoplayVideo src={asset.src} />
        ) : (
          <img
            src={visibleSrc}
            alt="capture preview"
            draggable
            onDragStart={dragFile}
            onLoad={() => {
              if (visibleSrc === src) setSourceLoaded(true);
            }}
          />
        )}
        <div className="fo__preview-dim">
          <FoIcon name="ruler" size={10} style={{ color: "var(--accent)" }} />
          <b>{dimText(srcW, srcH)}</b>
        </div>
        <div className="fo__preview-size">
          {asset?.kind === "video" ? fmtDurationLabel(asset.durationSec) : "2× retina"}
        </div>

        {asset?.kind !== "video" && (
          <div className="fo__preview-actions">
            <div className="fo__preview-actions-l">
              <button
                className="fo__hover-btn"
                title="Drag PNG file"
                draggable={onDragFile !== undefined}
                onDragStart={dragFile}
                disabled={onDragFile === undefined}
              >
                <FoIcon name="hand" size={11} /> Drag
              </button>
            </div>
            <div className="fo__preview-actions-r">
              <button
                className="fo__hover-btn"
                title="Open in editor"
                onClick={() => onEdit?.()}
                disabled={onEdit === undefined}
              >
                <FoIcon name="pen-line" size={11} /> Edit
              </button>
              <button className="fo__hover-btn" title="Reveal in library">
                <FoIcon name="folder-open" size={11} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Short-clip warning — clips under 1.5s are usually an
          accidental Stop right after the countdown ended. Surfaces a
          gentle "you sure?" with a one-tap Discard so users can blow
          the take away without hunting through the Library. Only
          renders for the video asset; image captures don't have a
          notion of "too short". */}
      {asset?.kind === "video" && asset.durationSec < 1.5 && asset.onDiscard !== undefined && (
        <div
          data-fo-warning="short-clip"
          style={{
            margin: "8px 12px 0",
            padding: "8px 10px",
            border: "1px solid rgba(255, 138, 31, 0.5)",
            background: "rgba(255, 138, 31, 0.08)",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            font: "500 11px/1.4 var(--font-sans)",
            color: "var(--text-primary)"
          }}
        >
          <span>
            Very short ({fmtDurationLabel(asset.durationSec)}). Stop pressed too soon?
          </span>
          <button
            type="button"
            onClick={() => asset.onDiscard?.()}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid rgba(239, 68, 68, 0.6)",
              background: "transparent",
              color: "#ef4444",
              font: "600 11px/1 var(--font-sans)",
              cursor: "pointer",
              whiteSpace: "nowrap"
            }}
          >
            Discard
          </button>
        </div>
      )}

      {asset?.kind === "video" ? (
        // Video export row — sits in the same slot as the image
        // Low / Med / High copy buttons. Two cards instead of three:
        // GIF (always silent) + MP4 (carries whatever audio tracks
        // the source recorded). Same `fo__copy-btn` styling so the
        // toast feels like the image variant's cousin, not a
        // different surface. Sub-range selection lives in the
        // editor; this row is the fast-path full-clip export.
        <div className="fo__copy" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          {(["gif", "mp4"] as const).map((format) => {
            const running =
              asset.exportState?.kind === "running" && asset.exportState.format === format;
            const done =
              asset.exportState?.kind === "done" && asset.exportState.format === format;
            const errored =
              asset.exportState?.kind === "error" && asset.exportState.format === format;
            const subtitle = running
              ? "Encoding…"
              : done
              ? "Saved"
              : errored
              ? "Failed — retry"
              : format === "gif"
              ? "Silent · share-friendly"
              : asset.hasSystemAudio || asset.hasMicrophoneAudio
              ? "Full clip · with audio"
              : "Full clip · silent";
            return (
              <button
                key={format}
                type="button"
                className="fo__copy-btn"
                onClick={() => asset.onExport(format)}
                disabled={asset.exportState?.kind === "running"}
              >
                <span className="fo__copy-btn-row1">
                  <span className="fo__copy-label">{format.toUpperCase()}</span>
                </span>
                <span className="fo__copy-meta">
                  <span className="fo__copy-bytes">{subtitle}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="fo__copy">
          {RES_PRESETS.map((p) => {
            const m = copyMetrics?.[p.id] ?? presetMetrics(p.id, srcW, srcH, srcBytes);
            return (
              <CopyButton
                key={p.id}
                preset={p.id}
                label={p.label}
                dim={m.dim}
                bytes={m.bytes}
                onCopy={(preset) => onCopy?.(preset)}
                {...(onCopyPath !== undefined ? { onCopyPath } : {})}
                {...(onDragPreset !== undefined ? { onDrag: onDragPreset } : {})}
                copyPulse={copyPulses?.[p.id] ?? 0}
              />
            );
          })}
        </div>
      )}

      {cfg.showAnnotate && (
        <div className="fo__annotate">
          <textarea
            className="fo__desc"
            placeholder="What is this? (a line of context now saves you 20 minutes later)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
          <FoTags
            tags={tags}
            onAdd={(t) => setTags([...tags, t])}
            onRemove={(t) => setTags(tags.filter((x) => x !== t))}
            suggestions={aiSuggestions}
            onAcceptSuggest={(s) => setTags([...tags, s])}
          />
        </div>
      )}

      {cfg.showAi && (
        <div className="fo__ai">
          <span className="fo__ai-mark">
            <FoIcon name="sparkles" size={12} />
          </span>
          <span className="fo__ai-text">
            {thinking ? (
              <>
                Codex is reading the snap<span className="fo__ai-thinking" />
              </>
            ) : aiAccepted ? (
              <>
                Description filled from <b>Codex</b>.
              </>
            ) : (
              <>
                Codex thinks: <b>{aiDescription}</b>
              </>
            )}
          </span>
          {!thinking && !aiAccepted && (
            <button
              className="fo__ai-accept"
              onClick={() => {
                setDescription(aiDescription);
                setTags(Array.from(new Set([...tags, ...aiSuggestions.slice(0, 2)])));
                setAiAccepted(true);
              }}
            >
              Use
            </button>
          )}
        </div>
      )}

      {cfg.showFooter && (
        <div className="fo__foot">
          {cfg.showStorage ? (
            <div className="fo__dest">
              <button
                className={"fo__dest-btn " + (storage.drive ? "is-on" : "")}
                onClick={() => setStorage({ ...storage, drive: !storage.drive })}
                title="Sync to Google Drive"
              >
                <FoIcon name="hard-drive" size={11} /> Drive
              </button>
              <button
                className={"fo__dest-btn " + (storage.dropbox ? "is-on" : "")}
                onClick={() => setStorage({ ...storage, dropbox: !storage.dropbox })}
                title="Sync to Dropbox"
              >
                <FoIcon name="package" size={11} /> Dropbox
              </button>
              <button
                className={"fo__dest-btn " + (storage.s3 ? "is-on" : "")}
                onClick={() => setStorage({ ...storage, s3: !storage.s3 })}
                title="Upload to S3 / R2"
              >
                <FoIcon name="cloud-upload" size={11} /> S3
              </button>
            </div>
          ) : (
            <div className="fo__dest-saved">
              {/* Path mirrors db.getCapturesRoot() — see that comment
                  for why captures live in Documents instead of
                  Application Support. Hardcoded for now; if a future
                  setting makes this configurable, surface that value
                  through props. */}
              <FoIcon name="check" size={11} /> saved · ~/Documents/PwrSnap
            </div>
          )}
          <div className="fo__foot-actions">
            {/* Discard — video-only. Confirms before destroying the
                just-saved Library row + source file + any cached
                exports. Image captures don't get this (the user
                wanted a snap, the snap is fine). */}
            {asset?.kind === "video" && asset.onDiscard !== undefined && (
              <button
                className="fo__foot-btn"
                type="button"
                title="Discard this recording — Library row + file are removed"
                onClick={() => {
                  if (
                    typeof window !== "undefined" &&
                    !window.confirm(
                      "Discard this recording? The clip will be removed from your Library and the source file deleted."
                    )
                  ) {
                    return;
                  }
                  asset.onDiscard?.();
                }}
                style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.4)" }}
              >
                Discard
              </button>
            )}
            <button className="fo__foot-btn" onClick={dismissNow}>
              Dismiss
            </button>
            <button
              className="fo__foot-btn is-primary"
              type="button"
              onClick={() => onEdit?.()}
              disabled={onEdit === undefined}
              title="Open in Library editor"
            >
              <FoIcon name="pen-line" size={11} /> Edit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function FoDesktopFrame({
  children,
  sampleSrc
}: {
  children?: React.ReactNode;
  sampleSrc: string;
}) {
  return (
    <div className="fo-frame">
      <div className="fo-desktop">
        <div className="fo-menubar">
          <div className="fo-menubar__l">
            <span className="fo-menubar__active">Finder</span>
            <span>File</span>
            <span>Edit</span>
            <span>View</span>
            <span>Go</span>
          </div>
          <div className="fo-menubar__r">
            <span className="fo-menubar__pwr">
              <span className="fo-menubar__pwr-dot" />
              <PwrSnapMark size={11} />
              <span style={{ color: "var(--accent-bright)", fontSize: 10, fontWeight: 600 }}>
                PwrSnap
              </span>
            </span>
            <span>WiFi</span>
            <span>Tue 10:43 PM</span>
          </div>
        </div>

        <div className="fo-window" style={{ left: 60, top: 70, right: 200, bottom: 130 }}>
          <img src={sampleSrc} alt="" />
        </div>

        {children}
      </div>
    </div>
  );
}
