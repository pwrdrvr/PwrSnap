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
// Tabs are now vertical (VS-Code-style activity bar on the right edge)
// with three surfaces: Info (the prior "Detail" panel), OCR, and Chat
// (placeholder for the upcoming Codex dynamic-tools wiring). The bar
// can be pinned open or auto-hidden — same hover-pop pattern the
// editor's chrome uses. The L/M/H copy row + secondary action row sit
// in a persistent footer beneath the bar so a tab switch (or a hover-
// pop closing) never strands the user without copy/file/trash access.
//
// Pinned + last-selected state is per-window local state — settings
// persistence can land later if cross-window memory becomes desirable.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  CaptureEnrichment,
  CaptureRecord,
  LibrarySidebarTab,
  Settings,
  SuggestedTag
} from "@pwrsnap/shared";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
import { CodexStatusPill } from "../shared/CodexStatusPill";
import { useFieldEditor } from "../shared/useFieldEditor";
import { usePresetRenderMetrics } from "../shared/usePresetRenderMetrics";
import { AppTag } from "../shared/AppIcons";
import {
  RightActivityBar,
  type RightActivityTab
} from "../shared/RightActivityBar";
import "../shared/RightActivityBar.css";
import { ChatPanel } from "../editor/panels/ChatPanel";
import { dispatch, startCaptureDrag } from "../../lib/pwrsnap";
import { mapBundleIdToAppId } from "./adapter";
import type { LibraryView } from "./library-view";

const COPY_PRESETS = ["low", "med", "high"] as const;
const COPY_LABELS: Record<(typeof COPY_PRESETS)[number], string> = {
  low: "Low",
  med: "Med",
  high: "High"
};

type SidebarTab = LibrarySidebarTab;

export type DetailRailProps = {
  readonly view: LibraryView;
  readonly record: CaptureRecord | null;
  readonly copyPulses?: Readonly<Record<CopyPreset, number>>;
};

export function DetailRail({ view, record, copyPulses }: DetailRailProps): ReactElement | null {
  const renderMetrics = usePresetRenderMetrics(
    record?.id ?? null,
    record?.edits_version ?? null
  );
  const [enrichment, setEnrichment] = useState<CaptureEnrichment | null>(null);
  // Active tab + pin state — seeded from Settings on first mount,
  // then user-driven. Each user write also fires `settings:write` so
  // the choice survives relaunches. Same per-window source-of-truth
  // pattern EditorChrome uses (cross-window broadcasts are
  // deliberately ignored so Window B can't stomp Window A mid-edit).
  const [activeTab, setActiveTab] = useState<SidebarTab>("info");
  const [pinned, setPinned] = useState<boolean>(true);
  const initialReadDoneRef = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void dispatch("settings:read", {}).then((result) => {
      if (cancelled) return;
      if (initialReadDoneRef.current) return; // user already touched it
      if (!result.ok) return;
      const settings = result.value as Settings | undefined;
      const rail = settings?.library?.detailRail;
      if (rail === undefined) return;
      setPinned(rail.pinned);
      setActiveTab(rail.lastSelectedTab);
      initialReadDoneRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const writePinned = useCallback((next: boolean): void => {
    initialReadDoneRef.current = true;
    setPinned(next);
    void dispatch("settings:write", {
      library: { detailRail: { pinned: next } }
    });
  }, []);

  const writeActiveTab = useCallback((next: SidebarTab): void => {
    initialReadDoneRef.current = true;
    setActiveTab(next);
    void dispatch("settings:write", {
      library: { detailRail: { lastSelectedTab: next } }
    });
  }, []);

  useEffect(() => {
    if (record === null) {
      setEnrichment(null);
      return undefined;
    }
    // Clear synchronously so child `useFieldEditor` instances snapshot
    // EMPTY accepted/suggested for the new capture instead of the
    // previous capture's stale values. The dispatch below repopulates
    // within ms. Without this clear, navigating between captures in
    // Reel mode briefly leaked the prior capture's text into the new
    // capture's inputs.
    setEnrichment(null);
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

  const hasOcrText = (enrichment?.ocrText ?? "").length > 0;

  const tabs: ReadonlyArray<RightActivityTab<SidebarTab>> = [
    {
      id: "info",
      label: "Info",
      title: "Info",
      icon: INFO_ICON
    },
    {
      id: "ocr",
      label: "OCR",
      title: hasOcrText ? "OCR — extracted text ready" : "OCR",
      badge: hasOcrText,
      icon: OCR_ICON
    },
    {
      id: "chat",
      label: "Chat",
      title: "Chat with Codex",
      icon: CHAT_ICON
    }
  ];

  const renderPanel = (id: SidebarTab): ReactElement => {
    if (id === "info") {
      return (
        <div
          className="psl__right-body"
          role="tabpanel"
          aria-label="Info"
        >
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
        </div>
      );
    }
    if (id === "ocr") {
      return (
        <div className="psl__right-body" role="tabpanel" aria-label="OCR">
          <OcrTab record={record} enrichment={enrichment} />
        </div>
      );
    }
    return (
      <div className="psl__right-body psl__right-body--chat" role="tabpanel" aria-label="Chat">
        <ChatPanel captureId={record.id} />
      </div>
    );
  };

  return (
    <aside className="psl__right psl__right--vertical" aria-label="Capture details">
      <div className="psl__right-content">
        <RightActivityBar
          tabs={tabs}
          activeTab={activeTab}
          pinned={pinned}
          onTabChange={writeActiveTab}
          onPinChange={writePinned}
          renderPanel={renderPanel}
          testIdPrefix="psl-right"
          pinnedWidthPx={320}
        />
      </div>

      <div className="psl__right-footer" data-testid="psl-right-footer">
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
              {view.kind !== "focus" && view.kind !== "reel" && (
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
              )}
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

const INFO_ICON: ReactElement = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8h0M11 12h1v5h1" />
  </svg>
);

const OCR_ICON: ReactElement = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 7V5h4M20 7V5h-4M4 17v2h4M20 17v2h-4" />
    <path d="M7 9h10M7 13h10M7 17h6" />
  </svg>
);

const CHAT_ICON: ReactElement = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 5h16v11H8l-4 4z" />
  </svg>
);

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
  const acceptedFilenameStem = enrichment?.acceptedFilenameStem ?? "";
  const suggestedFilenameStem = enrichment?.suggestedFilenameStem ?? "";

  const [titleValue, titleOrigin, setTitleEdit, commitTitle] = useFieldEditor({
    captureId: record.id,
    accepted: acceptedTitle,
    suggested: suggestedTitle
  });
  const [descriptionValue, descriptionOrigin, setDescriptionEdit, commitDescription] =
    useFieldEditor({
      captureId: record.id,
      accepted: acceptedDescription,
      suggested: suggestedDescription
    });
  const [filenameValue, filenameOrigin, setFilenameEdit, commitFilename] = useFieldEditor({
    captureId: record.id,
    accepted: acceptedFilenameStem,
    suggested: suggestedFilenameStem
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

  const acceptFilenameIfNeeded = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      if (trimmed === acceptedFilenameStem) return;
      const result = await dispatch("codex:acceptFilenameStem", {
        captureId: record.id,
        filenameStem: trimmed
      });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [acceptedFilenameStem, onEnrichmentUpdate, record.id]
  );

  // Per-field draft acceptance — the prior bulk "Use draft" button
  // accepted title + description + every pending tag in one click,
  // which surprised users in two ways:
  //   1. Pending tags they'd ignored on the float-over (e.g., `github`)
  //      got applied along with the text drafts.
  //   2. The accepted title/description got overwritten with no
  //      preview of what they were about to lose.
  // Now: each field's drafted text is previewed below the input with
  // an inline "Use" button. Tags continue to live in <TagEditor/>
  // with their own +/× per-suggestion controls.
  // Per-field Use callbacks both commit() locally AND dispatch the
  // accept verb. Without the commit, a user mid-edit (origin=manual)
  // would click Use and only see their typed text — the sync effect
  // deliberately leaves manual edits alone, so the broadcast that
  // lands back from the server wouldn't replace the textarea value.
  // Commit forces a local override so the click feels instant; the
  // server broadcast that lands moments later is a no-op (same
  // value + origin).
  // Per-field Use callbacks: commit() locally (instant feedback even
  // when origin=manual), dispatch the accept verb, roll back the
  // commit on failure so the UI doesn't lie about what's persisted.
  // "Roll back" means setting the field back to the prior server-side
  // state — if there was an accepted value before, it returns to
  // "accepted" with that value; otherwise it falls back to the
  // suggested italic preview. Mid-typing manual text is lost on
  // failure, but a Use-button dispatch failure is a rare edge case.
  const useTitleDraft = useCallback(async () => {
    if (suggestedTitle.trim().length === 0) return;
    commitTitle(suggestedTitle, "accepted");
    const result = await dispatch("codex:acceptTitle", {
      captureId: record.id,
      title: suggestedTitle
    });
    if (result.ok) {
      onEnrichmentUpdate(result.value);
    } else {
      commitTitle(acceptedTitle, acceptedTitle.length > 0 ? "accepted" : "suggested");
    }
  }, [acceptedTitle, commitTitle, onEnrichmentUpdate, record.id, suggestedTitle]);

  const useDescriptionDraft = useCallback(async () => {
    if (suggestedDescription.trim().length === 0) return;
    commitDescription(suggestedDescription, "accepted");
    const result = await dispatch("codex:acceptDescription", {
      captureId: record.id,
      description: suggestedDescription
    });
    if (result.ok) {
      onEnrichmentUpdate(result.value);
    } else {
      commitDescription(
        acceptedDescription,
        acceptedDescription.length > 0 ? "accepted" : "suggested"
      );
    }
  }, [
    acceptedDescription,
    commitDescription,
    onEnrichmentUpdate,
    record.id,
    suggestedDescription
  ]);

  const useFilenameDraft = useCallback(async () => {
    if (suggestedFilenameStem.trim().length === 0) return;
    commitFilename(suggestedFilenameStem, "accepted");
    const result = await dispatch("codex:acceptFilenameStem", {
      captureId: record.id,
      filenameStem: suggestedFilenameStem
    });
    if (result.ok) {
      onEnrichmentUpdate(result.value);
    } else {
      commitFilename(
        acceptedFilenameStem,
        acceptedFilenameStem.length > 0 ? "accepted" : "suggested"
      );
    }
  }, [
    acceptedFilenameStem,
    commitFilename,
    onEnrichmentUpdate,
    record.id,
    suggestedFilenameStem
  ]);

  const titleDraftDiverged =
    suggestedTitle.trim().length > 0 && suggestedTitle !== acceptedTitle;
  const descriptionDraftDiverged =
    suggestedDescription.trim().length > 0 && suggestedDescription !== acceptedDescription;
  const filenameDraftDiverged =
    suggestedFilenameStem.trim().length > 0 &&
    suggestedFilenameStem !== acceptedFilenameStem;

  const regenerate = useCallback(() => {
    void dispatch("codex:enrich", { captureId: record.id });
  }, [record.id]);

  // Bulk "Use draft" — applies title + description + filename atomically
  // in one server transaction via `codex:acceptAllDrafts`. Optimistic
  // local commits for instant feedback; the server broadcast that
  // lands moments later is a no-op. Tags stay user-driven (their own
  // +/× chip controls) to avoid surprise-accepts.
  const useAllTextDrafts = useCallback(async () => {
    const wantTitle = titleDraftDiverged;
    const wantDescription = descriptionDraftDiverged;
    const wantFilename = filenameDraftDiverged;
    if (!wantTitle && !wantDescription && !wantFilename) return;

    if (wantTitle) commitTitle(suggestedTitle, "accepted");
    if (wantDescription) commitDescription(suggestedDescription, "accepted");
    if (wantFilename) commitFilename(suggestedFilenameStem, "accepted");

    const payload: {
      captureId: string;
      title?: string;
      description?: string;
      filenameStem?: string;
    } = { captureId: record.id };
    if (wantTitle) payload.title = suggestedTitle;
    if (wantDescription) payload.description = suggestedDescription;
    if (wantFilename) payload.filenameStem = suggestedFilenameStem;

    const result = await dispatch("codex:acceptAllDrafts", payload);
    if (result.ok) {
      onEnrichmentUpdate(result.value);
    } else {
      // Roll back the optimistic commits so the UI doesn't lie about
      // what the server accepted. Re-derive origin from the
      // server-side state we last had.
      if (wantTitle) commitTitle(acceptedTitle, acceptedTitle.length > 0 ? "accepted" : "suggested");
      if (wantDescription)
        commitDescription(
          acceptedDescription,
          acceptedDescription.length > 0 ? "accepted" : "suggested"
        );
      if (wantFilename)
        commitFilename(
          acceptedFilenameStem,
          acceptedFilenameStem.length > 0 ? "accepted" : "suggested"
        );
    }
  }, [
    acceptedDescription,
    acceptedFilenameStem,
    acceptedTitle,
    commitDescription,
    commitFilename,
    commitTitle,
    descriptionDraftDiverged,
    filenameDraftDiverged,
    onEnrichmentUpdate,
    record.id,
    suggestedDescription,
    suggestedFilenameStem,
    suggestedTitle,
    titleDraftDiverged
  ]);

  const hasAnyDraft = titleDraftDiverged || descriptionDraftDiverged || filenameDraftDiverged;
  const codexBusy = codexStatus === "queued" || codexStatus === "running";

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
        {/* Header only carries the source-app chip — accepted content
            tags render below in <TagEditor/> so they aren't duplicated.
            Used to also mirror `acceptedTags` here, which produced two
            "live" tag rows in the sidebar (the user-reported goof). */}
        <div className="psl__detail-tags">
          <AppTag
            app={appId}
            name={sourceName}
            bundleId={record.source_app_bundle_id ?? undefined}
          />
        </div>
      </div>

      <CodexStatusPill
        status={codexStatus}
        draftAvailable={draftAvailable}
        accepted={allDraftsAccepted}
        action={
          <>
            {/* Prominent bulk Use — the common case. Covers title +
                description + filename in one click. Tags stay separate
                (per-chip +/× controls in the TagEditor) so suggestions
                a user ignored don't sneak in. */}
            {hasAnyDraft && !codexBusy ? (
              <button
                type="button"
                className="psl__chip-btn psl__chip-btn--accent"
                onClick={() => void useAllTextDrafts()}
              >
                Use draft
              </button>
            ) : null}
            {/* Regenerate de-emphasized — text-link weight. Hidden
                while Codex is mid-run; the per-pill status already
                communicates "reading…". */}
            {!codexBusy ? (
              <button
                type="button"
                className="psl__chip-link"
                onClick={regenerate}
                title="Ask Codex for a fresh draft"
              >
                Regenerate
              </button>
            ) : null}
          </>
        }
      />

      <div className="psl__detail-fields">
        <label className="psl__field">
          <span className="psl__field-label">
            <span>Title</span>
            {titleOrigin === "suggested" ? (
              <>
                <span className="psl__field-origin">draft from Codex</span>
                <button
                  type="button"
                  className="psl__field-use"
                  onClick={() => void useTitleDraft()}
                  title="Save this Codex draft as your title"
                >
                  Use
                </button>
              </>
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
          {titleDraftDiverged && titleOrigin !== "suggested" ? (
            <DraftPreview
              label="Codex draft"
              text={suggestedTitle}
              onUse={() => void useTitleDraft()}
            />
          ) : null}
        </label>

        <label className="psl__field">
          <span className="psl__field-label">
            <span>Description</span>
            {descriptionOrigin === "suggested" ? (
              <>
                <span className="psl__field-origin">draft from Codex</span>
                <button
                  type="button"
                  className="psl__field-use"
                  onClick={() => void useDescriptionDraft()}
                  title="Save this Codex draft as your description"
                >
                  Use
                </button>
              </>
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
          {descriptionDraftDiverged && descriptionOrigin !== "suggested" ? (
            <DraftPreview
              label="Codex draft"
              text={suggestedDescription}
              onUse={() => void useDescriptionDraft()}
            />
          ) : null}
        </label>

        <label className="psl__field">
          <span className="psl__field-label">
            <span>Export filename</span>
            {filenameOrigin === "suggested" ? (
              <>
                <span className="psl__field-origin">draft from Codex</span>
                <button
                  type="button"
                  className="psl__field-use"
                  onClick={() => void useFilenameDraft()}
                  title="Save this Codex draft as the export filename"
                >
                  Use
                </button>
              </>
            ) : filenameValue.length > 0 ? (
              <button
                type="button"
                className="psl__field-use"
                onClick={() => {
                  void dispatch("clipboard:copyText", { text: filenameValue });
                }}
                title="Copy the export filename stem to the clipboard"
              >
                Copy
              </button>
            ) : null}
          </span>
          <input
            className={
              "psl__field-input psl__field-input--mono" +
              (filenameOrigin === "suggested" ? " is-suggested" : "")
            }
            type="text"
            value={filenameValue}
            placeholder="kebab-case stem for File / drag-out exports"
            maxLength={120}
            onChange={(event) => setFilenameEdit(event.target.value)}
            onBlur={() => void acceptFilenameIfNeeded(filenameValue)}
          />
          {filenameDraftDiverged && filenameOrigin !== "suggested" ? (
            <DraftPreview
              label="Codex draft"
              text={suggestedFilenameStem}
              onUse={() => void useFilenameDraft()}
            />
          ) : null}
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

  // Remove an already-accepted tag. Server normalizes the label, so
  // there's no need to track tag ids on the client.
  const removeTag = useCallback(
    async (label: string) => {
      const result = await dispatch("library:removeTag", { captureId, label });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [captureId, onEnrichmentUpdate]
  );

  // Free-form tag input — Enter commits via `library:addTag`. The
  // verb normalizes the label, reuses an existing tag row when one
  // matches, and inserts a `capture_tags` row with `source = 'user'`.
  // Idempotent on the server side, so a double-Enter doesn't create
  // duplicates.
  const submitDraft = (): void => {
    const label = draft.trim();
    if (label.length === 0) return;
    setDraft("");
    void dispatch("library:addTag", { captureId, label }).then((result) => {
      if (result.ok) onEnrichmentUpdate(result.value);
    });
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
          <span key={`accepted-${tag}`} className="ps-tag is-sm psl__tag-accepted">
            <span>{tag}</span>
            <button
              type="button"
              className="psl__tag-remove"
              onClick={() => void removeTag(tag)}
              aria-label={`remove ${tag}`}
              title="Remove tag"
            >
              ×
            </button>
          </span>
        ))}
        {pendingTags.map((tag) => {
          const tagId = tag.id;
          if (tagId === undefined) return null;
          return (
            <span key={`suggest-${tagId}`} className="ps-tag is-suggest">
              <button
                type="button"
                className="psl__tag-suggest-label"
                onClick={() => void acceptTag(tagId)}
                title={`Use ${tag.label}`}
              >
                + {tag.label}
              </button>
              <button
                type="button"
                className="psl__tag-suggest-x"
                onClick={() => void rejectTag(tagId)}
                aria-label={`reject ${tag.label}`}
              >
                ×
              </button>
            </span>
          );
        })}
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
    void dispatch("clipboard:copyText", { text: ocrText });
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

type DraftPreviewProps = {
  readonly label: string;
  readonly text: string;
  readonly onUse: () => void;
};

// DraftPreview — small banner shown under a field when Codex has a
// suggestion that diverges from the value the user has accepted. The
// prior bulk-overwrite button gave the user no visibility into what
// they were about to lose; this surfaces the alternative text so the
// "Use" click is informed, not a leap of faith.
function DraftPreview({ label, text, onUse }: DraftPreviewProps): ReactElement {
  return (
    <div className="psl__draft-preview" role="group" aria-label={label}>
      <div className="psl__draft-preview-hdr">
        <span className="psl__draft-preview-label">{label}</span>
        <button
          type="button"
          className="psl__draft-preview-use"
          onClick={onUse}
          title="Replace current text with this Codex draft"
        >
          Use this
        </button>
      </div>
      <p className="psl__draft-preview-text">{text}</p>
    </div>
  );
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
