import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CaptureEnrichment,
  CapturesLocation,
  ExportStrategy,
  PwrSnapError,
  Result,
  VideoRange
} from "@pwrsnap/shared";
import {
  normalizeTagLabel,
  desktopFileManagerName,
  capturesFolderDisplayPath,
  resolveExportLadder,
  rungForPreset
} from "@pwrsnap/shared";
import { PwrSnapMark } from "../shared/BrandMark";
import {
  CopyButton,
  presetMetrics,
  rungTag,
  estimateMetricForRung,
  type CopyPreset
} from "../shared/CopyButton";
import { CodexStatusPill } from "../shared/CodexStatusPill";
import { AiConsentDialog } from "../shared/AiConsentDialog";
import { useFieldEditor } from "../shared/useFieldEditor";
import { HoverAutoplayVideo } from "../shared/HoverAutoplayVideo";
import type { PresetMetricMap } from "../shared/usePresetRenderMetrics";
import { VideoExportPresetsPanel } from "../shared/VideoExportPresetsPanel";
import { VideoTimeline } from "../shared/VideoTimeline";
import { useVideoTimelineAssets } from "../shared/useVideoTimelineAssets";
import { useVideoTrimRange } from "../shared/useVideoTrimRange";
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

/** Preview-size badge text from the capture's scale factor. Reads the
 *  real `device_pixel_ratio` instead of the old hardcoded "2× retina" so
 *  1× / 3× / fractional-DPI captures are labeled honestly. */
function dprBadgeLabel(dpr: number, platform?: string): string {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const rounded = Math.round(scale * 10) / 10;
  const num = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  if (platform === "darwin" && scale >= 2) return `${num}× retina`;
  if (platform !== "darwin" && scale > 1) return `${num}× High DPI`;
  return `${num}×`;
}

function fmtDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = (seconds - mins * 60).toFixed(1);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

type TagMutationAction = "add" | "remove";

type TagMutation = {
  id: number;
  action: TagMutationAction;
  label: string;
  normalizedLabel: string;
};

type TagMutationFailure = Pick<TagMutation, "action" | "label"> & {
  message: string;
};

export type FloatOverTagMutationHandler = (
  label: string
) => Promise<Result<CaptureEnrichment, PwrSnapError>>;

function tagsWithMutation(tags: readonly string[], mutation: TagMutation | null): string[] {
  if (mutation === null) return [...tags];
  if (mutation.action === "remove") {
    return tags.filter((tag) => normalizeTagLabel(tag) !== mutation.normalizedLabel);
  }
  if (tags.some((tag) => normalizeTagLabel(tag) === mutation.normalizedLabel)) {
    return [...tags];
  }
  return [...tags, mutation.label];
}

function FoTags({
  tags,
  onAdd,
  onRemove,
  suggestions = [],
  onAcceptSuggest,
  onRejectSuggest,
  pendingMutation,
  failure,
  onRetry
}: {
  tags: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
  suggestions?: Array<{ id: string; label: string }>;
  onAcceptSuggest: (suggestion: { id: string; label: string }) => void;
  onRejectSuggest: (suggestion: { id: string; label: string }) => void;
  pendingMutation: TagMutation | null;
  failure: TagMutationFailure | null;
  onRetry: () => void;
}) {
  const [draft, setDraft] = useState("");
  const busy = pendingMutation !== null;
  return (
    <div className="fo__tags" aria-busy={busy}>
      {tags.map((t) => (
        <span
          key={t}
          className={`fo__tag${
            pendingMutation?.action === "add" &&
            normalizeTagLabel(t) === pendingMutation.normalizedLabel
              ? " is-pending"
              : ""
          }`}
        >
          {t}
          <button
            type="button"
            className="fo__tag-x"
            onClick={() => onRemove(t)}
            aria-label={`remove ${t}`}
            disabled={busy}
          >
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
              disabled={busy}
            >
              + {s.label}
            </button>
            <button
              type="button"
              className="fo__tag-x"
              onClick={() => onRejectSuggest(s)}
              aria-label={`reject ${s.label}`}
              disabled={busy}
            >
              ×
            </button>
          </span>
        ))}
      <input
        className="fo__tag-input"
        placeholder={tags.length ? "" : "tag…"}
        value={draft}
        maxLength={64}
        onChange={(e) => setDraft(e.target.value)}
        disabled={busy}
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
      {pendingMutation !== null ? (
        <span className="fo__tag-status" role="status">
          {pendingMutation.action === "add" ? "Adding" : "Removing"} “
          {pendingMutation.label}”…
        </span>
      ) : null}
      {failure !== null ? (
        <span className="fo__tag-error" role="alert">
          <span>
            Couldn’t {failure.action} “{failure.label}”: {failure.message}
          </span>
          <button type="button" className="fo__tag-retry" onClick={onRetry}>
            Retry
          </button>
        </span>
      ) : null}
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
 *    Low / Med / High clipboard row is replaced by a mini trim strip
 *    (40 px filmstrip + in/out handles bound to the record's
 *    `defaultRange`, persisted via `video:setDefaultRange`) above the
 *    GIF / MP4 L/M/H export cards. Every export / copy / drag call
 *    carries the displayed range explicitly, so the toast and the
 *    Library stage agree on what encodes. The toast stays cheap
 *    because `<video preload="metadata">` only loads the moov atom +
 *    first frame until the user actually plays.
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
      /** Source pixel size — sizes the mini-trim filmstrip cells. */
      widthPx: number;
      heightPx: number;
      /** Persisted trim range (`record.video.defaultRange`) that seeds
       *  the mini-trim handles. Fresh recordings arrive full-clip. */
      defaultRange: VideoRange;
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
  srcDpr = 2,
  exportStrategy = "legacy",
  capturesLocation = "documents",
  capturesRootOverridden = false,
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
  providerAvailable = true,
  aiEnabled = false,
  aiConsentAccepted = false,
  aiSafetyDisabled = false,
  enrichmentProviderLabel,
  enrichmentModelLabel,
  autoAcceptSuggestions = false,
  onEnableAi,
  onConfigureAi,
  onSetAutoAccept,
  onAcceptTitle,
  onAcceptDescription,
  onAddTag,
  onRemoveTag,
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
  /** Capture's display scale factor (`device_pixel_ratio`). Drives the
   *  preview "Retina" badge and the DPI-aware export ladder. Defaults to
   *  2 to match the legacy hardcoded "2× retina" badge. */
  srcDpr?: number;
  /** Active export-preset strategy. `legacy` (default) keeps the cards
   *  visually identical for normal users; the DPI-aware strategies add
   *  the Retina/scale tags + rescale the dim estimates. */
  exportStrategy?: ExportStrategy;
  /** Active durable captures root. */
  capturesLocation?: CapturesLocation;
  /** PWRSNAP_DATA_ROOT controls the real path, which renderer cannot know. */
  capturesRootOverridden?: boolean;
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
   *  platform-native absolute path lands on the clipboard as text. */
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
  /** Whether the selected enrichment backend (Codex or the chosen ACP agent)
   *  is usable. When false the toast offers "Configure AI" instead of Enable. */
  providerAvailable?: boolean;
  aiEnabled?: boolean;
  aiConsentAccepted?: boolean;
  aiSafetyDisabled?: boolean;
  /** Enrichment backend label for the status pill (e.g. "Codex", "Gemini"). */
  enrichmentProviderLabel?: string | undefined;
  /** Optional model id shown in parens in the status pill. */
  enrichmentModelLabel?: string | undefined;
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
  /** Persist a user-typed tag through `library:addTag`. The returned
   *  enrichment is the authoritative tag snapshot used to reconcile
   *  the optimistic chip. */
  onAddTag?: FloatOverTagMutationHandler;
  /** Persist removal through `library:removeTag`. Result failures roll
   *  the optimistic removal back and remain visible with a Retry action. */
  onRemoveTag?: FloatOverTagMutationHandler;
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
  const tagsRef = useRef<string[]>(acceptedTags);
  const confirmedTagsRef = useRef<string[]>(acceptedTags);
  const pendingTagMutationRef = useRef<TagMutation | null>(null);
  const nextTagMutationIdRef = useRef(0);
  const tagMutationMountedRef = useRef(true);
  const [pendingTagMutation, setPendingTagMutation] = useState<TagMutation | null>(null);
  const [tagMutationFailure, setTagMutationFailure] = useState<TagMutationFailure | null>(
    null
  );
  const [hovering, setHovering] = useState(false);
  const [nativeDragging, setNativeDragging] = useState(false);
  // A trim-handle drag on the video strip takes pointer capture, so it
  // keeps running after the pointer leaves the toast — `mouseleave`
  // fires, `hovering` drops, and without this term the countdown would
  // resume and close the toast mid-drag, losing the trim. Cleared by
  // VideoTimeline on release / cancel / lost capture / unmount.
  const [trimDragging, setTrimDragging] = useState(false);
  const [progress, setProgress] = useState(1);
  const [exiting, setExiting] = useState(false);
  const [storage, setStorage] = useState({ drive: false, dropbox: false, s3: false });
  const [visibleSrc, setVisibleSrc] = useState(src);
  const [sourceLoaded, setSourceLoaded] = useState(false);

  const isSuggestedDescriptionPreview =
    descriptionOrigin === "suggested" && suggestedDescription.trim().length > 0;
  const startedAt = useRef(Date.now());
  const elapsedAtPause = useRef(0);
  const rafRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The preview `<video>`, handed to the trim strip so dragging an
  // in/out handle parks the preview on that frame.
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  // Stable ref to `onDismiss` so the countdown effect can call the
  // latest callback without re-subscribing on every parent re-render.
  // Without this, an enrichment-arrived re-render (which creates a
  // fresh `onDismiss` function reference in FloatOverHost) would
  // retrigger the countdown effect mid-tick, reset `startedAt.current`
  // to "now", and effectively halt the countdown's forward progress.
  // See bug vii.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  // Exit-animation timeout handle. Stored in a ref so we can clear it
  // on unmount — without this, an in-flight `setTimeout(..., 220)` from
  // the previous capture's exit animation would survive a renderer
  // re-mount and call `onDismiss` ~220ms after the NEW toast appears,
  // hiding it. That was the "toast flashes for a microsecond" bug.
  // (With the persistent renderer + state machine added in this same
  // phase, re-mount is rare — but defensive cleanup is cheap.)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Counter for tags the USER explicitly added/removed via the input
  // field or the suggestion-accept buttons. Distinct from `tags.length`
  // because enrichment auto-accept lands acceptedTags directly into
  // `tags` via the sync useEffect — that path must NOT pause the
  // countdown (otherwise the toast hangs indefinitely once Codex
  // auto-applies its suggestions). See bug vii.
  const userTagInteractionsRef = useRef(0);
  const [userTagInteractions, setUserTagInteractions] = useState(0);

  const replaceVisibleTags = useCallback((next: readonly string[]): void => {
    const copy = [...next];
    tagsRef.current = copy;
    setTags(copy);
  }, []);

  const runTagMutation = useCallback(
    (action: TagMutationAction, rawLabel: string): void => {
      const label = rawLabel.trim();
      const normalizedLabel = normalizeTagLabel(label);
      if (normalizedLabel.length === 0 || pendingTagMutationRef.current !== null) return;

      const isPresent = tagsRef.current.some(
        (tag) => normalizeTagLabel(tag) === normalizedLabel
      );
      // The persistence layer is idempotent too, but keeping duplicate
      // requests out of IPC prevents full-enrichment responses from racing
      // each other and briefly reverting another tag mutation.
      if ((action === "add" && isPresent) || (action === "remove" && !isPresent)) {
        setTagMutationFailure(null);
        return;
      }

      const handler = action === "add" ? onAddTag : onRemoveTag;
      if (handler === undefined) {
        setTagMutationFailure({
          action,
          label,
          message: "Tag saving is unavailable. Reopen the toast and try again."
        });
        return;
      }

      const mutation: TagMutation = {
        id: ++nextTagMutationIdRef.current,
        action,
        label,
        normalizedLabel
      };
      pendingTagMutationRef.current = mutation;
      setPendingTagMutation(mutation);
      setTagMutationFailure(null);
      replaceVisibleTags(tagsWithMutation(tagsRef.current, mutation));

      // Starting from a resolved Promise also turns a synchronous bridge
      // exception into the same actionable failure path as an invoke rejection.
      void Promise.resolve()
        .then(() => handler(label))
        .then((result) => {
          if (
            !tagMutationMountedRef.current ||
            pendingTagMutationRef.current?.id !== mutation.id
          ) {
            return;
          }
          pendingTagMutationRef.current = null;
          setPendingTagMutation(null);
          if (result.ok) {
            // The handler returns the complete accepted-tag snapshot in
            // canonical DB order/casing. Use it directly; the matching
            // aiRunUpdated broadcast remains the cross-window sync path.
            confirmedTagsRef.current = [...result.value.acceptedTags];
            replaceVisibleTags(result.value.acceptedTags);
            return;
          }
          replaceVisibleTags(confirmedTagsRef.current);
          setTagMutationFailure({ action, label, message: result.error.message });
        })
        .catch((cause: unknown) => {
          if (
            !tagMutationMountedRef.current ||
            pendingTagMutationRef.current?.id !== mutation.id
          ) {
            return;
          }
          pendingTagMutationRef.current = null;
          setPendingTagMutation(null);
          replaceVisibleTags(confirmedTagsRef.current);
          setTagMutationFailure({
            action,
            label,
            message: cause instanceof Error ? cause.message : String(cause)
          });
        });
    },
    [onAddTag, onRemoveTag, replaceVisibleTags]
  );

  useEffect(() => {
    tagMutationMountedRef.current = true;
    return () => {
      tagMutationMountedRef.current = false;
      pendingTagMutationRef.current = null;
    };
  }, []);

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
  // Note: accepting AI drafts (the "Save"/"Use" button) is intentionally
  // NOT a pause condition. It is a terminal action, not in-progress
  // editing — once the pointer leaves the toast the auto-close timer must
  // resume. A prior one-shot `aiAccepted` flag lived here and was never
  // reset, which pinned the toast on screen forever after a single Save.
  const isPaused =
    thinking ||
    awaitingAi ||
    hovering ||
    nativeDragging ||
    trimDragging ||
    hasUserDescription ||
    hasUserTitle ||
    userTagInteractions > 0;

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
  // description. Tags mirror the latest authoritative enrichment, with
  // any single in-flight manual mutation re-applied so an unrelated AI
  // broadcast cannot erase the optimistic chip before its Result lands.
  useEffect(() => {
    confirmedTagsRef.current = [...acceptedTags];
    replaceVisibleTags(tagsWithMutation(acceptedTags, pendingTagMutationRef.current));
  }, [acceptedTags.join("\0"), replaceVisibleTags]);

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
        // Use the ref so we always call the latest onDismiss without
        // requiring the effect to re-subscribe on every parent
        // re-render (which would reset `startedAt.current` mid-tick
        // and stall the countdown — bug vii).
        exitTimerRef.current = setTimeout(() => onDismissRef.current?.(), 220);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    startedAt.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // `onDismiss` is intentionally NOT a dep — it is read via
    // `onDismissRef`. Adding it back would re-run this effect on
    // every parent re-render (e.g., enrichment IPC arrival),
    // resetting startedAt.current and freezing the countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaused, startCountdown, cfg.autoMs]);

  useEffect(() => {
    const finishNativeDrag = (event?: MouseEvent | DragEvent): void => {
      setNativeDragging(false);
      // Backstop for the trim hold. The strip's own pointerup only
      // reaches `VideoTimeline` while pointer capture holds; if capture
      // was never taken (setPointerCapture threw) the release lands on
      // whatever element is under the pointer and the hold would stick,
      // pinning the toast on screen forever. A window-level mouseup
      // means the button is up, so it can never fire mid-drag.
      setTrimDragging(false);
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
          <HoverAutoplayVideo src={asset.src} videoRef={previewVideoRef} />
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
          {asset?.kind === "video"
            ? fmtDurationLabel(asset.durationSec)
            : dprBadgeLabel(srcDpr, window.pwrsnapApi?.platform)}
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
          <FloatOverVideoExport
            asset={asset}
            onTrimDraggingChange={setTrimDragging}
            previewVideoRef={previewVideoRef}
          />
        </div>
      ) : (
        <div className="fo__copy">
          {(() => {
            // Resolve the export ladder once. In legacy mode the cards are
            // unchanged; with DPI-aware export on, each rung supplies the
            // Retina/scale tag + a correct pre-render dim estimate.
            const ladder =
              exportStrategy === "legacy"
                ? null
                : resolveExportLadder(
                    { widthPx: srcW, heightPx: srcH, devicePixelRatio: srcDpr },
                    exportStrategy
                  );
            return RES_PRESETS.map((p) => {
              const rung = ladder === null ? undefined : rungForPreset(ladder, p.id);
              const unavailable = rung !== undefined && !rung.available;
              const estimate = unavailable
                ? { dim: "—", bytes: "—", exact: true }
                : rung === undefined
                  ? presetMetrics(p.id, srcW, srcH, srcBytes)
                  : estimateMetricForRung(rung, srcW, srcBytes);
              const m = unavailable ? estimate : (copyMetrics?.[p.id] ?? estimate);
              return (
                <CopyButton
                  key={p.id}
                  preset={p.id}
                  label={rung?.actual === true ? "Actual" : p.label}
                  dim={m.dim}
                  bytes={m.bytes}
                  tag={
                    rung === undefined || unavailable
                      ? undefined
                      : rungTag(rung, window.pwrsnapApi?.platform)
                  }
                  disabled={unavailable}
                  onCopy={(preset) => onCopy?.(preset)}
                  {...(onCopyPath !== undefined ? { onCopyPath } : {})}
                  {...(onDragPreset !== undefined ? { onDrag: onDragPreset } : {})}
                  copyPulse={copyPulses?.[p.id] ?? 0}
                />
              );
            });
          })()}
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
            onAdd={(t) => {
              runTagMutation("add", t);
              // Bumping the user-interaction counter — not just
              // tags.length — is what keeps the countdown paused on
              // user-added tags WITHOUT being tricked into a permanent
              // pause when Codex's auto-accept lands acceptedTags via
              // the enrichment broadcast. See bug vii.
              userTagInteractionsRef.current += 1;
              setUserTagInteractions(userTagInteractionsRef.current);
            }}
            onRemove={(t) => {
              runTagMutation("remove", t);
              userTagInteractionsRef.current += 1;
              setUserTagInteractions(userTagInteractionsRef.current);
            }}
            suggestions={aiSuggestions}
            onAcceptSuggest={(suggestion) => {
              replaceVisibleTags([...tags, suggestion.label]);
              userTagInteractionsRef.current += 1;
              setUserTagInteractions(userTagInteractionsRef.current);
              onAcceptTag?.(suggestion.id);
            }}
            onRejectSuggest={(suggestion) => {
              onRejectTag?.(suggestion.id);
            }}
            pendingMutation={pendingTagMutation}
            failure={tagMutationFailure}
            onRetry={() => {
              if (tagMutationFailure !== null) {
                runTagMutation(tagMutationFailure.action, tagMutationFailure.label);
              }
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
            error={enrichment?.error}
            {...(enrichmentProviderLabel !== undefined
              ? { providerLabel: enrichmentProviderLabel }
              : {})}
            {...(enrichmentModelLabel !== undefined
              ? { modelLabel: enrichmentModelLabel }
              : {})}
            action={
              !thinking && !aiFailed ? (
                suggestedTitle.length === 0 && suggestedDescription.length === 0 && !providerAvailable ? (
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
                    disabled={pendingTagMutation !== null}
                    onClick={() => {
                      if (suggestedTitle.length > 0) {
                        commitTitle(suggestedTitle, "accepted");
                        onAcceptTitle?.(suggestedTitle);
                      }
                      if (suggestedDescription.length > 0) {
                        commitDescription(suggestedDescription, "accepted");
                        onAcceptDescription?.(suggestedDescription);
                      }
                      replaceVisibleTags(
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
                    }}
                  >
                    {isSuggestedDescriptionPreview || titleOrigin === "suggested" ? "Save" : "Use"}
                  </button>
                ) : null
              ) : null
            }
          />
          {!aiNeedsConsent && onSetAutoAccept !== undefined ? (
            <label className="fo__auto-accept" title="Apply AI enrichment automatically when ready">
              <input
                type="checkbox"
                checked={autoAcceptSuggestions}
                onChange={(event) => onSetAutoAccept(event.target.checked)}
              />
              <span>Auto-apply AI enrichment</span>
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
              <FoIcon name="check" size={11} /> saved ·{" "}
              {capturesFolderDisplayPath(
                window.pwrsnapApi?.platform,
                capturesLocation,
                capturesRootOverridden
              )}
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
            <span className="fo-menubar__active">
              {desktopFileManagerName(window.pwrsnapApi?.platform)}
            </span>
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

/**
 * Video export block for the toast: a compact trim strip (40 px
 * filmstrip + in/out handles, no waveform / playhead) above the
 * 6-card GIF / MP4 grid. The trim range is the same persisted
 * `defaultRange` the Library stage edits — `useVideoTrimRange`
 * persists on handle release (debounced) and the panel receives the
 * displayed range explicitly so what you see is what encodes.
 *
 * `onTrimDraggingChange` forwards the strip's drag state up to the
 * toast's auto-dismiss pause set — the drag holds pointer capture and
 * routinely continues outside the toast's bounds, where hover state
 * can no longer see it.
 *
 * `previewVideoRef` points at the toast's own preview `<video>`, which
 * doubles as the trim strip's scrub monitor: dragging a handle (or
 * pressing the filmstrip) parks it on that frame. Without it you're
 * picking trim points off a 40 px filmstrip blind.
 */
function FloatOverVideoExport({
  asset,
  onTrimDraggingChange,
  previewVideoRef
}: {
  asset: Extract<FloatOverAsset, { kind: "video" }>;
  onTrimDraggingChange: (dragging: boolean) => void;
  previewVideoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const [stripWidth, setStripWidth] = useState(0);
  const seekPreview = useCallback(
    (sec: number): void => {
      const el = previewVideoRef.current;
      if (el === null) return;
      // Hovering the preview autoplays it; a live playhead would fight
      // the scrub and immediately drift off the frame we just parked on.
      el.pause();
      el.currentTime = sec;
    },
    [previewVideoRef]
  );
  const trim = useVideoTrimRange({
    captureId: asset.captureId,
    durationSec: asset.durationSec,
    persistedRange: asset.defaultRange
  });
  const assets = useVideoTimelineAssets({
    captureId: asset.captureId,
    stripWidthPx: stripWidth,
    laneHeightPx: 40,
    sourceWidthPx: asset.widthPx,
    sourceHeightPx: asset.heightPx,
    wantAudio: false,
    hasAudioTrack: false
  });
  return (
    <>
      <div className="fo__trim" data-testid="fo-video-trim">
        <VideoTimeline
          compact
          durationSec={asset.durationSec}
          range={trim.range}
          frames={assets.frames}
          onSeek={seekPreview}
          onRangeChange={trim.setRange}
          onWidthChange={setStripWidth}
          onInteractingChange={onTrimDraggingChange}
          label="Trim recording"
        />
      </div>
      <VideoExportPresetsPanel captureId={asset.captureId} range={trim.range} />
    </>
  );
}
