import { useEffect, useRef, useState } from "react";
import type { CaptureEnrichment } from "@pwrsnap/shared";
import { PwrSnapMark } from "../shared/BrandMark";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
import { CodexStatusPill } from "../shared/CodexStatusPill";
import { AiConsentDialog } from "../shared/AiConsentDialog";
import { useFieldEditor } from "../shared/useFieldEditor";
import { HoverAutoplayVideo } from "../shared/HoverAutoplayVideo";
import type { PresetMetricMap } from "../shared/usePresetRenderMetrics";
import { VideoExportPresetsPanel } from "../shared/VideoExportPresetsPanel";
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
  onAcceptSuggest,
  onRejectSuggest
}: {
  tags: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
  suggestions?: Array<{ id: string; label: string }>;
  onAcceptSuggest: (suggestion: { id: string; label: string }) => void;
  onRejectSuggest: (suggestion: { id: string; label: string }) => void;
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
        .filter((s) => !tags.includes(s.label))
        .slice(0, 2)
        .map((s) => (
          <span key={s.id} className="fo__tag is-suggest">
            <button
              type="button"
              className="fo__tag-suggest-label"
              onClick={() => onAcceptSuggest(s)}
              title={`Use ${s.label}`}
            >
              + {s.label}
            </button>
            <button
              type="button"
              className="fo__tag-x"
              onClick={() => onRejectSuggest(s)}
              aria-label={`reject ${s.label}`}
            >
              ×
            </button>
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
      /** Video capture id. Threads into the 6-card export grid
       *  (`VideoExportPresetsPanel`) which owns its own hooks for
       *  per-(format, preset) copy / drag / state — matching the
       *  library DetailRail's chrome exactly. */
      captureId: string;
      /** Encoded duration (sec). Surfaced in the preview-size chip
       *  AND drives the short-clip warning banner (clips under 1.5s
       *  are usually an accidental Stop press right after Start). */
      durationSec: number;
      /** Discard the just-saved recording. Wired by the host to
       *  `library:delete` + `library:purge` + `float-over:dismiss`
       *  so the Library row, source file, and any cached exports
       *  all disappear. Shown as a destructive footer action. */
      onDiscard?: () => void;
    };

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
  initialTitle = "",
  initialDescription = "",
  initialTags = [],
  enrichment,
  codexAvailable = true,
  aiEnabled = false,
  aiConsentAccepted = false,
  aiSafetyDisabled = false,
  autoAcceptSuggestions = false,
  onEnableAi,
  onConfigureAi,
  onSetAutoAccept,
  onAcceptTitle,
  onAcceptDescription,
  onAcceptTag,
  onRejectTag
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
  initialTitle?: string;
  initialDescription?: string;
  initialTags?: string[];
  enrichment?: CaptureEnrichment | null;
  codexAvailable?: boolean;
  aiEnabled?: boolean;
  aiConsentAccepted?: boolean;
  aiSafetyDisabled?: boolean;
  /** Mirrors `settings.ai.autoAcceptSuggestions`. When true, the
   *  toast renders the checkbox in the "checked" state and trusts
   *  main to promote `suggested_*` → `accepted_*` on its own at the
   *  moment the enrichment completes. */
  autoAcceptSuggestions?: boolean;
  onEnableAi?: () => void;
  onConfigureAi?: () => void;
  /** Persist a flip of the auto-accept toggle. Wired to a
   *  `settings:write` dispatch in the host so the change survives
   *  the toast closing and applies to subsequent captures. */
  onSetAutoAccept?: (next: boolean) => void;
  onAcceptTitle?: (title: string) => void;
  onAcceptDescription?: (description: string) => void;
  onAcceptTag?: (tagId: string) => void;
  onRejectTag?: (tagId: string) => void;
}) {
  const cfg = VARIANTS[variant];
  const aiStatus = enrichment?.status ?? null;
  const aiNeedsConsent = !aiEnabled || !aiConsentAccepted;
  const acceptedTitle = enrichment?.acceptedTitle ?? initialTitle;
  const suggestedTitle = enrichment?.suggestedTitle ?? "";
  const acceptedDescription = enrichment?.acceptedDescription ?? initialDescription;
  const suggestedDescription = enrichment?.suggestedDescription ?? "";
  const acceptedTags = enrichment?.acceptedTags ?? initialTags;
  const aiSuggestions =
    enrichment?.suggestedTags
      .filter((tag) => tag.id !== undefined && tag.accepted_at === null && tag.rejected_at === null)
      .map((tag) => ({ id: tag.id!, label: tag.label })) ?? [];
  const thinking = aiStatus === "queued" || aiStatus === "running";
  const aiFailed = aiStatus === "failed";
  const [aiConsentDialogOpen, setAiConsentDialogOpen] = useState<boolean>(false);
  // Derived "has unaccepted drafts" — replaces the one-shot `aiAccepted`
  // flag for the Use-button visibility. Necessary because main-side
  // auto-accept lands acceptedTitle/acceptedDescription without the
  // user clicking anything; the button must hide in that case too.
  const titleDraftMatchesAccepted =
    suggestedTitle.length > 0 && acceptedTitle === suggestedTitle;
  const descriptionDraftMatchesAccepted =
    suggestedDescription.length > 0 && acceptedDescription === suggestedDescription;
  const hasUnacceptedDrafts =
    (suggestedTitle.length > 0 && !titleDraftMatchesAccepted) ||
    (suggestedDescription.length > 0 && !descriptionDraftMatchesAccepted);
  const allDraftsAccepted =
    (suggestedTitle.length > 0 || suggestedDescription.length > 0) && !hasUnacceptedDrafts;
  // Note: the prior `copiedId` / `initiallyCopied` state is gone — the
  // shared CopyButton component now owns its own copied state and the
  // visual is the orange "Copied" overlay (no `is-primary` highlight,
  // no bytes-text swap). See features/shared/CopyButton.tsx.
  //
  // Title / Description provenance is owned by the shared
  // `useFieldEditor` hook so the float-over and the Library DetailRail
  // reason about accepted/suggested/manual the same way. The float-
  // over remounts on capture change (FloatOverHost's `key={record.id}`),
  // so the captureId-reset branch here only fires for in-place
  // enrichment updates — same shape as the sidebar.
  const fieldCaptureId = enrichment?.captureId ?? "fo-pre-capture";
  const [title, titleOrigin, setTitle, commitTitle] = useFieldEditor({
    captureId: fieldCaptureId,
    accepted: acceptedTitle,
    suggested: suggestedTitle
  });
  const [description, descriptionOrigin, setDescription, commitDescription] = useFieldEditor({
    captureId: fieldCaptureId,
    accepted: acceptedDescription,
    suggested: suggestedDescription
  });
  const [tags, setTags] = useState<string[]>(acceptedTags);
  const [hovering, setHovering] = useState(false);
  const [nativeDragging, setNativeDragging] = useState(false);
  const [progress, setProgress] = useState(1);
  const [exiting, setExiting] = useState(false);
  const [aiAccepted, setAiAccepted] = useState(false);
  const [storage, setStorage] = useState({ drive: false, dropbox: false, s3: false });
  const [visibleSrc, setVisibleSrc] = useState(src);
  const [sourceLoaded, setSourceLoaded] = useState(false);

  const isSuggestedDescriptionPreview =
    descriptionOrigin === "suggested" && suggestedDescription.trim().length > 0;
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

  // "Awaiting AI" covers the window between mount and the first
  // aiStatus broadcast — without this, the toast races the codex:enrich
  // dispatch and the countdown can deplete before Codex even queues
  // the run. We trust AI is going to show up when consent is granted;
  // a 3s grace caps the wait so a silent failure (codex never queued)
  // can't keep the toast pinned forever.
  const [awaitingAiTimedOut, setAwaitingAiTimedOut] = useState(false);
  useEffect(() => {
    if (aiNeedsConsent || aiStatus !== null) {
      setAwaitingAiTimedOut(false);
      return undefined;
    }
    setAwaitingAiTimedOut(false);
    const timer = setTimeout(() => setAwaitingAiTimedOut(true), 3000);
    return () => clearTimeout(timer);
  }, [aiNeedsConsent, aiStatus]);
  const awaitingAi = !aiNeedsConsent && aiStatus === null && !awaitingAiTimedOut;

  const hasUserDescription =
    description.trim().length > 0 && descriptionOrigin === "manual";
  const hasUserTitle = title.trim().length > 0 && titleOrigin === "manual";
  const isPaused =
    thinking ||
    awaitingAi ||
    hovering ||
    nativeDragging ||
    hasUserDescription ||
    hasUserTitle ||
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

  // useFieldEditor owns the accepted/suggested sync for title +
  // description. We still mirror `acceptedTags` into local state so the
  // user can add typed tags on top without losing them on enrichment
  // refresh.
  useEffect(() => {
    setTags(acceptedTags);
  }, [acceptedTags.join("\0")]);

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
        // Video export grid — sits in the same slot as the image
        // Low / Med / High copy buttons. Full 6-card chrome (GIF
        // L/M/H + MP4 L/M/H) matching the library DetailRail and
        // the tray popover; each card supports click-to-copy +
        // FILE-chip copy-path + FILE-chip drag-out via
        // `clipboard:copyVideoFile` / `copyVideoPath` /
        // `startVideoDrag`. The panel owns its own hooks (the
        // toast just hands it a captureId).
        //
        // Wrapper is a plain block (NOT `.fo__copy` which imposes
        // a 3-col grid) — the panel renders two
        // `.psl__copy-row-group` children that each impose their
        // own 3-col grid via `.psl__copy-row`. CSS ships from
        // library.css which app.css loads for every stage. The
        // 12px padding mirrors `.fo__copy`'s `padding: 10px 12px
        // 4px` so the grid sits at the same horizontal inset as
        // the image copy row.
        <div className="fo__export-grid">
          <VideoExportPresetsPanel captureId={asset.captureId} />
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
          <input
            className={`fo__title${titleOrigin === "suggested" ? " is-suggested" : ""}`}
            type="text"
            placeholder="Title — short headline"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              const trimmed = title.trim();
              if (
                trimmed.length > 0 &&
                trimmed !== acceptedTitle &&
                titleOrigin === "manual"
              ) {
                onAcceptTitle?.(trimmed);
              }
            }}
          />
          <textarea
            className={`fo__desc${descriptionOrigin === "suggested" ? " is-suggested" : ""}`}
            placeholder="Description — a sentence or two of context"
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => {
              const trimmed = description.trim();
              if (
                trimmed.length > 0 &&
                trimmed !== acceptedDescription &&
                descriptionOrigin === "manual"
              ) {
                onAcceptDescription?.(trimmed);
              }
            }}
            rows={2}
          />
          <FoTags
            tags={tags}
            onAdd={(t) => setTags([...tags, t])}
            onRemove={(t) => setTags(tags.filter((x) => x !== t))}
            suggestions={aiSuggestions}
            onAcceptSuggest={(suggestion) => {
              setTags([...tags, suggestion.label]);
              onAcceptTag?.(suggestion.id);
            }}
            onRejectSuggest={(suggestion) => {
              onRejectTag?.(suggestion.id);
            }}
          />
        </div>
      )}

      {cfg.showAi && (
        <div className="fo__ai-row">
          <CodexStatusPill
            status={aiStatus}
            draftAvailable={
              suggestedTitle.trim().length > 0 || suggestedDescription.trim().length > 0
            }
            accepted={allDraftsAccepted}
            needsConsent={aiNeedsConsent}
            safetyDisabled={aiSafetyDisabled}
            action={
              !thinking && !aiFailed ? (
                suggestedTitle.length === 0 && suggestedDescription.length === 0 && !codexAvailable ? (
                  <button className="fo__ai-accept" onClick={() => onConfigureAi?.()}>
                    Configure AI
                  </button>
                ) : suggestedTitle.length === 0 && suggestedDescription.length === 0 && aiNeedsConsent ? (
                  <button
                    className="fo__ai-accept"
                    onClick={() => {
                      if (aiConsentAccepted) {
                        onEnableAi?.();
                        return;
                      }
                      setAiConsentDialogOpen(true);
                    }}
                  >
                    {aiSafetyDisabled ? "Re-enable" : "Enable"}
                  </button>
                ) : hasUnacceptedDrafts ? (
                  <button
                    className="fo__ai-accept"
                    onClick={() => {
                      if (suggestedTitle.length > 0) {
                        commitTitle(suggestedTitle, "accepted");
                        onAcceptTitle?.(suggestedTitle);
                      }
                      if (suggestedDescription.length > 0) {
                        commitDescription(suggestedDescription, "accepted");
                        onAcceptDescription?.(suggestedDescription);
                      }
                      setTags(
                        Array.from(
                          new Set([
                            ...tags,
                            ...aiSuggestions.slice(0, 2).map((tag) => tag.label)
                          ])
                        )
                      );
                      for (const suggestion of aiSuggestions.slice(0, 2)) {
                        onAcceptTag?.(suggestion.id);
                      }
                      setAiAccepted(true);
                    }}
                  >
                    {isSuggestedDescriptionPreview || titleOrigin === "suggested" ? "Save" : "Use"}
                  </button>
                ) : null
              ) : null
            }
          />
          {!aiNeedsConsent && onSetAutoAccept !== undefined ? (
            <label className="fo__auto-accept" title="Apply Codex drafts automatically when ready">
              <input
                type="checkbox"
                checked={autoAcceptSuggestions}
                onChange={(event) => onSetAutoAccept(event.target.checked)}
              />
              <span>Auto-apply Codex drafts</span>
            </label>
          ) : null}
        </div>
      )}

      {aiConsentDialogOpen ? (
        <AiConsentDialog
          onCancel={() => setAiConsentDialogOpen(false)}
          onAccept={() => {
            setAiConsentDialogOpen(false);
            onEnableAi?.();
          }}
        />
      ) : null}

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
