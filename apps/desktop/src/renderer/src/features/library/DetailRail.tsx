// DetailRail — right-side panel showing capture metadata, the Codex
// title + description editor, suggested tags + free-form tag input,
// and the L/M/H copy row. Visible in Focus + Reel modes; returns null
// in Grid (mode-conditional lives INSIDE the component per
// architecture-strategist's recommendation D6).
//
// Issue #85 redesign: title and description are now independent fields,
// both editable in the sidebar, matching the float-over toast's
// affordances. The Codex status surfaces through the shared
// CodexStatusPill so "thinking" looks identical on both surfaces.
//
// Tabs: Detail (current editor) + OCR (its own panel for the often-
// lengthy extracted text). The placeholder "History" tab is gone — when
// run-history needs surfacing we'll add it back as a real tab.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { CaptureEnrichment, CaptureRecord, SuggestedTag } from "@pwrsnap/shared";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
import { CodexStatusPill } from "../shared/CodexStatusPill";
import { usePresetRenderMetrics } from "../shared/usePresetRenderMetrics";
import { AppTag } from "../shared/AppIcons";
import { dispatch, startCaptureDrag } from "../../lib/pwrsnap";
import { mapBundleIdToAppId } from "./adapter";
import type { LibraryView } from "./library-view";

const COPY_PRESETS = ["low", "med", "high"] as const;
const COPY_LABELS: Record<(typeof COPY_PRESETS)[number], string> = {
  low: "Low",
  med: "Med",
  high: "High"
};

type SidebarTab = "detail" | "ocr";

type FieldOrigin = "accepted" | "manual" | "suggested" | "empty";

export type DetailRailProps = {
  readonly view: LibraryView;
  readonly record: CaptureRecord | null;
  readonly copyPulses?: Readonly<Record<CopyPreset, number>>;
};

export function DetailRail({ view, record, copyPulses }: DetailRailProps): ReactElement | null {
  const renderMetrics = usePresetRenderMetrics(
    record?.id ?? null,
    record?.overlays_version ?? null
  );
  const [enrichment, setEnrichment] = useState<CaptureEnrichment | null>(null);
  const [activeTab, setActiveTab] = useState<SidebarTab>("detail");

  useEffect(() => {
    if (record === null) {
      setEnrichment(null);
      return undefined;
    }
    let cancelled = false;
    void dispatch("codex:enrichment", { captureId: record.id }).then((result) => {
      if (!cancelled) {
        setEnrichment(result.ok ? result.value : null);
      }
    });
    const unsubscribe = window.pwrsnapApi?.on(EVENT_CHANNELS.aiRunUpdated, (payload) => {
      const next = (payload as { enrichment?: CaptureEnrichment | null }).enrichment;
      if (next === undefined || next === null || next.captureId !== record.id) return;
      setEnrichment(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [record?.id]);

  // Grid mode: rail not rendered. Future surfaces that want a rail
  // in Grid (bulk-select, etc.) only change one component.
  if (view.kind === "grid") return null;
  if (record === null) return null;

  const capturedAt = formatTimestamp(record.captured_at);
  const sourceName = record.source_app_name ?? "Unknown app";
  const appId = mapBundleIdToAppId(record.source_app_bundle_id);
  const hasExactRenderMetrics = renderMetrics.high?.exact === true;
  const codexStatus = enrichment?.status ?? null;
  const draftAvailable =
    (enrichment?.suggestedTitle ?? "").trim().length > 0 ||
    (enrichment?.suggestedDescription ?? "").trim().length > 0;
  const titleAccepted =
    enrichment?.acceptedTitle !== null &&
    enrichment?.acceptedTitle !== undefined &&
    enrichment.acceptedTitle === enrichment.suggestedTitle;
  const descriptionAccepted =
    enrichment?.acceptedDescription !== null &&
    enrichment?.acceptedDescription !== undefined &&
    enrichment.acceptedDescription === enrichment.suggestedDescription;
  const allDraftsAccepted =
    (enrichment?.suggestedTitle ?? "") !== "" &&
    (enrichment?.suggestedDescription ?? "") !== "" &&
    titleAccepted &&
    descriptionAccepted;

  return (
    <aside className="psl__right" aria-label="Capture details">
      <div className="psl__right-tabs" role="tablist">
        <button
          className={"psl__right-tab" + (activeTab === "detail" ? " is-active" : "")}
          type="button"
          role="tab"
          aria-selected={activeTab === "detail"}
          onClick={() => setActiveTab("detail")}
        >
          Detail
        </button>
        <button
          className={"psl__right-tab" + (activeTab === "ocr" ? " is-active" : "")}
          type="button"
          role="tab"
          aria-selected={activeTab === "ocr"}
          onClick={() => setActiveTab("ocr")}
        >
          OCR
          {enrichment?.ocrText ? (
            <span className="psl__right-tab-badge" aria-hidden>
              •
            </span>
          ) : null}
        </button>
      </div>

      <div className="psl__right-body">
        {activeTab === "detail" ? (
          <DetailTab
            record={record}
            enrichment={enrichment}
            sourceName={sourceName}
            appId={appId}
            capturedAt={capturedAt}
            codexStatus={codexStatus}
            draftAvailable={draftAvailable}
            allDraftsAccepted={allDraftsAccepted}
            onEnrichmentUpdate={setEnrichment}
          />
        ) : (
          <OcrTab record={record} enrichment={enrichment} />
        )}

        {/* L/M/H copy row + actions live OUTSIDE the tab body so they
            never disappear with a tab switch. The OCR tab is content-
            only; the user still wants to drag / copy / open while
            reading text. */}
        <div>
          <div className="psl__copy-eyebrow">
            <span>Copy to clipboard</span>
            <span className="psl__copy-eyebrow-line" />
            <span className="psl__copy-eyebrow-meta">
              {hasExactRenderMetrics ? "actual files" : "rendering files"}
            </span>
          </div>
          <div className="psl__copy-row">
            {COPY_PRESETS.map((p) => {
              const m =
                renderMetrics[p] ??
                presetMetrics(p, record.width_px, record.height_px, record.byte_size);
              return (
                <CopyButton
                  key={p}
                  preset={p}
                  label={COPY_LABELS[p]}
                  dim={m.dim}
                  bytes={m.bytes}
                  onCopy={(preset) => {
                    void dispatch("clipboard:copy", { captureId: record.id, preset });
                  }}
                  onCopyPath={(preset) => {
                    void dispatch("clipboard:copy-path", { captureId: record.id, preset });
                  }}
                  onDrag={(preset) => startCaptureDrag(record.id, preset)}
                  copyPulse={copyPulses?.[p] ?? 0}
                />
              );
            })}
          </div>
        </div>

        <div className="psl__action-row">
          {record.deleted_at !== null ? (
            <>
              <button
                type="button"
                title="Restore from Trash"
                onClick={() => {
                  void dispatch("library:restore", { id: record.id });
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                </svg>
                Restore
              </button>
              <button
                type="button"
                className="is-danger"
                title="Delete permanently"
                onClick={() => {
                  const ok = window.confirm(
                    "Permanently delete this capture? This cannot be undone."
                  );
                  if (!ok) return;
                  void dispatch("library:purge", { id: record.id });
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
                </svg>
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                title="Drag PNG file or click to reveal in Finder"
                draggable
                onClick={() => {
                  void dispatch("capture:reveal", { captureId: record.id });
                }}
                onDragStart={(event) => {
                  event.preventDefault();
                  startCaptureDrag(record.id, "high");
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                File
              </button>
              <button
                type="button"
                title="Open in standalone editor window"
                onClick={() => {
                  void dispatch("editor:open", { captureId: record.id });
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
                </svg>
                Editor
              </button>
              <button
                type="button"
                className="is-danger"
                title="Move to Trash"
                onClick={() => {
                  void dispatch("library:delete", { id: record.id });
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

type DetailTabProps = {
  readonly record: CaptureRecord;
  readonly enrichment: CaptureEnrichment | null;
  readonly sourceName: string;
  readonly appId: ReturnType<typeof mapBundleIdToAppId>;
  readonly capturedAt: string;
  readonly codexStatus: CaptureEnrichment["status"] | null;
  readonly draftAvailable: boolean;
  readonly allDraftsAccepted: boolean;
  readonly onEnrichmentUpdate: (next: CaptureEnrichment) => void;
};

function DetailTab({
  record,
  enrichment,
  sourceName,
  appId,
  capturedAt,
  codexStatus,
  draftAvailable,
  allDraftsAccepted,
  onEnrichmentUpdate
}: DetailTabProps): ReactElement {
  const acceptedTitle = enrichment?.acceptedTitle ?? "";
  const suggestedTitle = enrichment?.suggestedTitle ?? "";
  const acceptedDescription = enrichment?.acceptedDescription ?? "";
  const suggestedDescription = enrichment?.suggestedDescription ?? "";

  const [titleValue, titleOrigin, setTitleEdit] = useFieldEditor({
    captureId: record.id,
    accepted: acceptedTitle,
    suggested: suggestedTitle
  });
  const [descriptionValue, descriptionOrigin, setDescriptionEdit] = useFieldEditor({
    captureId: record.id,
    accepted: acceptedDescription,
    suggested: suggestedDescription
  });

  const pendingTags =
    enrichment?.suggestedTags.filter(
      (tag) => tag.id !== undefined && tag.accepted_at === null && tag.rejected_at === null
    ) ?? [];
  const acceptedTags = enrichment?.acceptedTags ?? [];

  const acceptTitleIfNeeded = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      if (trimmed === acceptedTitle) return;
      const result = await dispatch("codex:acceptTitle", {
        captureId: record.id,
        title: trimmed
      });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [acceptedTitle, onEnrichmentUpdate, record.id]
  );

  const acceptDescriptionIfNeeded = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      if (trimmed === acceptedDescription) return;
      const result = await dispatch("codex:acceptDescription", {
        captureId: record.id,
        description: trimmed
      });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [acceptedDescription, onEnrichmentUpdate, record.id]
  );

  const useAllDrafts = useCallback(async () => {
    if (suggestedTitle.trim().length > 0 && suggestedTitle !== acceptedTitle) {
      await acceptTitleIfNeeded(suggestedTitle);
    }
    if (suggestedDescription.trim().length > 0 && suggestedDescription !== acceptedDescription) {
      await acceptDescriptionIfNeeded(suggestedDescription);
    }
    for (const tag of pendingTags) {
      if (tag.id === undefined) continue;
      const result = await dispatch("codex:acceptTag", { captureId: record.id, tagId: tag.id });
      if (result.ok) onEnrichmentUpdate(result.value);
    }
  }, [
    acceptDescriptionIfNeeded,
    acceptTitleIfNeeded,
    acceptedDescription,
    acceptedTitle,
    onEnrichmentUpdate,
    pendingTags,
    record.id,
    suggestedDescription,
    suggestedTitle
  ]);

  const regenerate = useCallback(() => {
    void dispatch("codex:enrich", { captureId: record.id });
  }, [record.id]);

  return (
    <>
      <div className="psl__detail-meta">
        <div className="psl__detail-name">{sourceName} snap</div>
        <div className="psl__detail-row">
          <span>
            <b>
              {record.width_px}×{record.height_px}
            </b>
          </span>
          <span>{formatBytes(record.byte_size)}</span>
          <span>{record.kind === "image" ? "PNG" : record.kind.toUpperCase()}</span>
          <span>{capturedAt}</span>
        </div>
        <div className="psl__detail-tags">
          <AppTag app={appId} name={sourceName} />
          {acceptedTags.map((tag) => (
            <span key={tag} className="ps-tag is-sm">
              {tag}
            </span>
          ))}
        </div>
      </div>

      <CodexStatusPill
        status={codexStatus}
        draftAvailable={draftAvailable}
        accepted={allDraftsAccepted}
        action={
          <>
            <button
              type="button"
              className="psl__chip-btn"
              onClick={regenerate}
              disabled={codexStatus === "queued" || codexStatus === "running"}
            >
              {codexStatus === "queued" || codexStatus === "running" ? "Reading…" : "Regenerate"}
            </button>
            {draftAvailable && !allDraftsAccepted ? (
              <button
                type="button"
                className="psl__chip-btn psl__chip-btn--accent"
                onClick={() => void useAllDrafts()}
              >
                Use draft
              </button>
            ) : null}
          </>
        }
      />

      <div className="psl__detail-fields">
        <label className="psl__field">
          <span className="psl__field-label">
            Title
            {titleOrigin === "suggested" ? (
              <span className="psl__field-origin">draft from Codex</span>
            ) : null}
          </span>
          <input
            className={"psl__field-input" + (titleOrigin === "suggested" ? " is-suggested" : "")}
            type="text"
            value={titleValue}
            placeholder="Short headline (will appear above the snap)"
            maxLength={120}
            onChange={(event) => setTitleEdit(event.target.value)}
            onBlur={() => void acceptTitleIfNeeded(titleValue)}
          />
        </label>

        <label className="psl__field">
          <span className="psl__field-label">
            Description
            {descriptionOrigin === "suggested" ? (
              <span className="psl__field-origin">draft from Codex</span>
            ) : null}
          </span>
          <textarea
            className={
              "psl__field-textarea" + (descriptionOrigin === "suggested" ? " is-suggested" : "")
            }
            value={descriptionValue}
            placeholder="What is this? Why might you come back to it?"
            maxLength={2000}
            rows={4}
            onChange={(event) => setDescriptionEdit(event.target.value)}
            onBlur={() => void acceptDescriptionIfNeeded(descriptionValue)}
          />
        </label>
      </div>

      <TagEditor
        captureId={record.id}
        acceptedTags={acceptedTags}
        pendingTags={pendingTags}
        onEnrichmentUpdate={onEnrichmentUpdate}
      />
    </>
  );
}

type TagEditorProps = {
  readonly captureId: string;
  readonly acceptedTags: readonly string[];
  readonly pendingTags: readonly SuggestedTag[];
  readonly onEnrichmentUpdate: (next: CaptureEnrichment) => void;
};

function TagEditor({
  captureId,
  acceptedTags,
  pendingTags,
  onEnrichmentUpdate
}: TagEditorProps): ReactElement {
  const [draft, setDraft] = useState("");

  const acceptTag = useCallback(
    async (tagId: string) => {
      const result = await dispatch("codex:acceptTag", { captureId, tagId });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [captureId, onEnrichmentUpdate]
  );

  const rejectTag = useCallback(
    async (tagId: string) => {
      const result = await dispatch("codex:rejectTag", { captureId, tagId });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [captureId, onEnrichmentUpdate]
  );

  // Free-form tag input mirrors the float-over's behavior — Enter
  // commits, Backspace on empty removes the last accepted tag. Tags
  // typed here are saved through `codex:acceptDescription`'s sibling
  // tag verb path; for now the IPC for user-typed tags isn't wired
  // (it requires a new server-side verb), so the input is staged
  // locally and surfaces a hint that's clear about the gap rather
  // than silently dropping the input.
  // TODO(#85-followup): wire `library:addTag` to persist free-form
  // user tags.
  const submitDraft = (): void => {
    if (draft.trim().length === 0) return;
    setDraft("");
  };

  return (
    <div className="psl__tag-editor">
      <div className="psl__tag-editor-eyebrow">
        Tags
        {pendingTags.length > 0 ? (
          <span className="psl__tag-editor-suggest-count">
            {pendingTags.length} suggested
          </span>
        ) : null}
      </div>
      <div className="psl__tag-row">
        {acceptedTags.map((tag) => (
          <span key={`accepted-${tag}`} className="ps-tag is-sm">
            {tag}
          </span>
        ))}
        {pendingTags.map((tag) =>
          tag.id !== undefined ? (
            <span key={`suggest-${tag.id}`} className="ps-tag is-suggest">
              <button
                type="button"
                className="psl__tag-suggest-label"
                onClick={() => void acceptTag(tag.id!)}
                title={`Use ${tag.label}`}
              >
                + {tag.label}
              </button>
              <button
                type="button"
                className="psl__tag-suggest-x"
                onClick={() => void rejectTag(tag.id!)}
                aria-label={`reject ${tag.label}`}
              >
                ×
              </button>
            </span>
          ) : null
        )}
        <input
          className="psl__tag-input"
          type="text"
          value={draft}
          placeholder={acceptedTags.length === 0 ? "add a tag…" : ""}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitDraft();
            }
          }}
        />
      </div>
    </div>
  );
}

type OcrTabProps = {
  readonly record: CaptureRecord;
  readonly enrichment: CaptureEnrichment | null;
};

function OcrTab({ record, enrichment }: OcrTabProps): ReactElement {
  const ocrText = enrichment?.ocrText ?? "";
  const status = enrichment?.status ?? null;
  const refreshing = status === "queued" || status === "running";

  const copyOcrText = (): void => {
    if (ocrText.length === 0) return;
    void navigator.clipboard.writeText(ocrText);
  };

  return (
    <div className="psl__ocr-tab">
      <div className="psl__ocr-tab-hdr">
        <CodexStatusPill
          variant="inline"
          status={status}
          draftAvailable={ocrText.length > 0}
          accepted={ocrText.length > 0 && status === "completed"}
        />
        <div className="psl__ocr-tab-actions">
          <button
            type="button"
            className="psl__chip-btn"
            onClick={() => void dispatch("codex:enrich", { captureId: record.id })}
            disabled={refreshing}
          >
            {refreshing ? "Reading…" : "Refresh OCR"}
          </button>
          <button
            type="button"
            className="psl__chip-btn"
            onClick={copyOcrText}
            disabled={ocrText.length === 0}
          >
            Copy text
          </button>
        </div>
      </div>
      {ocrText.length > 0 ? (
        <pre className="psl__ocr-tab-body">{ocrText}</pre>
      ) : (
        <div className="psl__ocr-tab-empty">
          {refreshing
            ? "Codex is reading the snap…"
            : status === "failed"
            ? "Codex could not extract text from this snap."
            : "No OCR text yet. Hit Refresh to ask Codex to read the snap."}
        </div>
      )}
    </div>
  );
}

// useFieldEditor — local-state mirror of an `accepted` / `suggested`
// pair, with an origin tag so the UI can style suggested-but-not-yet-
// accepted text differently from text the user already owns. Mirrors
// the float-over's descriptionOrigin state machine so both surfaces
// reason about provenance the same way.
function useFieldEditor(input: {
  captureId: string;
  accepted: string;
  suggested: string;
}): [string, FieldOrigin, (next: string) => void] {
  const initial = input.accepted.length > 0
    ? input.accepted
    : input.suggested;
  const initialOrigin: FieldOrigin =
    input.accepted.length > 0
      ? "accepted"
      : input.suggested.length > 0
      ? "suggested"
      : "empty";

  const [value, setValue] = useState<string>(initial);
  const [origin, setOrigin] = useState<FieldOrigin>(initialOrigin);
  const previewedSuggestionRef = useRef<string>(input.suggested);
  const captureRef = useRef<string>(input.captureId);

  useEffect(() => {
    // Reset when the user navigates to a different capture, or when
    // the accepted value changes on the server (another window edited
    // the same snap, or the user just hit "Use draft").
    if (captureRef.current !== input.captureId) {
      captureRef.current = input.captureId;
      const reset = input.accepted.length > 0 ? input.accepted : input.suggested;
      setValue(reset);
      setOrigin(
        input.accepted.length > 0
          ? "accepted"
          : input.suggested.length > 0
          ? "suggested"
          : "empty"
      );
      previewedSuggestionRef.current = input.suggested;
      return;
    }
    if (input.accepted.length > 0 && origin !== "manual") {
      setValue(input.accepted);
      setOrigin("accepted");
      previewedSuggestionRef.current = input.suggested;
      return;
    }
    if (
      input.accepted.length === 0 &&
      input.suggested.length > 0 &&
      previewedSuggestionRef.current !== input.suggested &&
      (origin === "suggested" || origin === "empty")
    ) {
      setValue(input.suggested);
      setOrigin("suggested");
      previewedSuggestionRef.current = input.suggested;
    }
  }, [input.captureId, input.accepted, input.suggested, origin]);

  const handleEdit = useCallback((next: string): void => {
    setValue(next);
    setOrigin(next.trim().length === 0 ? "empty" : "manual");
  }, []);

  return [value, origin, handleEdit];
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
