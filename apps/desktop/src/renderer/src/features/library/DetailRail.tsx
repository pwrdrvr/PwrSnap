// DetailRail — right-side panel showing capture metadata, Codex
// caption stub, and the L/M/H copy row. Visible in Focus + Reel
// modes; returns null in Grid (mode-conditional lives INSIDE the
// component per architecture-strategist's recommendation D6).
//
// Plan reference:
//   docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md
//   Phase B.2 (shell) + Phase C.5 (body).

import { useEffect, useState, type ReactElement } from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { CaptureEnrichment, CaptureRecord } from "@pwrsnap/shared";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
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
  const acceptedOrSuggestedDescription =
    enrichment?.acceptedDescription ?? enrichment?.suggestedDescription ?? null;
  const hasAcceptedDescription =
    enrichment?.acceptedDescription !== null && enrichment?.acceptedDescription !== undefined;
  const hasSuggestedDescription =
    enrichment?.suggestedDescription !== null && enrichment?.suggestedDescription !== undefined;
  const suggestedDescriptionAccepted =
    hasAcceptedDescription &&
    hasSuggestedDescription &&
    enrichment.acceptedDescription === enrichment.suggestedDescription;
  const pendingTags =
    enrichment?.suggestedTags.filter(
      (tag) => tag.id !== undefined && tag.accepted_at === null && tag.rejected_at === null
    ) ?? [];
  const visiblePendingTags = pendingTags.slice(0, 2);
  const acceptedTags = enrichment?.acceptedTags ?? [];
  const codexStatus = enrichment?.status ?? null;

  return (
    <aside className="psl__right" aria-label="Capture details">
      <div className="psl__right-tabs">
        <button className="psl__right-tab is-active" type="button">
          Detail
        </button>
        <button className="psl__right-tab" type="button" disabled title="Coming soon">
          History
        </button>
        <button className="psl__right-tab" type="button" disabled title="Coming soon">
          OCR
        </button>
      </div>

      <div className="psl__right-body">
        <div className="psl__detail-meta">
          <div className="psl__detail-name">{sourceName} capture</div>
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
            <AppTag app={appId} name={sourceName} bundleId={record.source_app_bundle_id ?? undefined} />
            {acceptedTags.map((tag) => (
              <span key={tag} className="ps-tag is-sm">
                {tag}
              </span>
            ))}
            {visiblePendingTags.map((tag) => (
              <button
                key={tag.id}
                className="ps-tag is-suggest"
                type="button"
                onClick={() => {
                  if (tag.id !== undefined) {
                    void dispatch("codex:acceptTag", { captureId: record.id, tagId: tag.id }).then((result) => {
                      if (result.ok) {
                        setEnrichment(result.value);
                      }
                    });
                  }
                }}
              >
                + {tag.label}
              </button>
            ))}
          </div>
        </div>

        <div className="psl__ai-card">
          <div className="psl__ai-card-hdr">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="m12 2 2.5 5 5.5.5-4 4 1 5.5-5-3-5 3 1-5.5-4-4 5.5-.5z" />
            </svg>
            Codex caption
            <small>{statusLabel(codexStatus)}</small>
          </div>
          <div className="psl__ai-card-scroll">
            <div className="psl__ai-card-text">
              {acceptedOrSuggestedDescription !== null ? (
                acceptedOrSuggestedDescription
              ) : codexStatus === "queued" || codexStatus === "running" ? (
                "Codex is reading this capture."
              ) : codexStatus === "failed" ? (
                "Codex could not read this capture."
              ) : (
                <>
                  Capture from <b>{sourceName}</b>. Enable AI in Settings to generate OCR,
                  descriptions, and tag suggestions.
                </>
              )}
            </div>
            {enrichment?.ocrText ? (
              <div className="psl__ai-card-ocr">{enrichment.ocrText}</div>
            ) : null}
          </div>
          <div className="psl__ai-card-actions">
            <button
              className="psl__chip-btn"
              type="button"
              onClick={() => {
                void dispatch("codex:enrich", { captureId: record.id });
              }}
            >
              Regenerate
            </button>
            <button
              className="psl__chip-btn"
              type="button"
              disabled={!hasSuggestedDescription || suggestedDescriptionAccepted}
              onClick={() => {
                const description = enrichment?.suggestedDescription;
                if (description) {
                  void dispatch("codex:acceptDescription", { captureId: record.id, description }).then((result) => {
                    if (result.ok) {
                      setEnrichment(result.value);
                    }
                  });
                }
              }}
            >
              {suggestedDescriptionAccepted ? "Caption used" : "Use caption"}
            </button>
            <button
              className="psl__chip-btn"
              type="button"
              disabled={visiblePendingTags.length === 0}
              onClick={() => {
                void (async () => {
                  for (const tag of visiblePendingTags) {
                    if (tag.id === undefined) continue;
                    const result = await dispatch("codex:acceptTag", {
                      captureId: record.id,
                      tagId: tag.id
                    });
                    if (result.ok) {
                      setEnrichment(result.value);
                    }
                  }
                })();
              }}
            >
              Apply tags
            </button>
          </div>
        </div>

        {/* L/M/H copy row — three <CopyButton> instances. Main resolves
            the rendered cache files and returns exact byte sizes; the
            fallback estimate is visible only while that async request
            is in flight. */}
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

function statusLabel(status: CaptureEnrichment["status"]): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "reading";
    case "completed":
      return "ready";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case null:
      return "not run";
  }
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
