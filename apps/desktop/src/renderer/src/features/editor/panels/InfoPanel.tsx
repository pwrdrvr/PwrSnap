// InfoPanel — read-only capture metadata panel for the editor's
// right sidebar. Mounted inside EditorChrome's `panels.info` slot
// (task #9 wires the prop; this file just owns the panel body).
//
// Data sources (NO new IPC verbs):
//   • `library:byId` — the canonical CaptureRecord (dimensions, app
//     name + bundle id, byte_size, captured_at, kind, edits_version,
//     bundle_modified_at). Mirrors Editor.tsx's existing fetch pattern
//     so the substrate behaviour matches what the canvas already does.
//   • `codex:enrichment` — accepted description + accepted tags
//     (when the user has run Codex on this capture). Returns null
//     when no enrichment row exists; tag + description rows are
//     hidden in that case.
//
// Refetch lives on `events:captures:changed`: any edit (overlay
// change, tag accept, description accept, doctor reconcile) bumps
// the library row's `edits_version` and emits the event; this panel
// re-fetches both the record and the enrichment so the displayed
// metadata stays fresh while the user works.
//
// Cancel-safety: every in-flight dispatch carries a captured
// `cancelled` flag so an unmount during fetch never setState's into
// a torn-down tree.

import { useEffect, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  type CaptureEnrichment,
  type CaptureRecord
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import { formatBytes } from "../../../lib/format-bytes";

export interface InfoPanelProps {
  captureId: string;
}

type LoadState =
  | { kind: "loading" }
  | {
      kind: "loaded";
      record: CaptureRecord;
      enrichment: CaptureEnrichment | null;
    }
  | { kind: "error"; message: string };

export function InfoPanel({ captureId }: InfoPanelProps): ReactElement {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    const refetch = async (): Promise<void> => {
      const recordResult = await dispatch("library:byId", { id: captureId });
      if (cancelled) return;
      if (!recordResult.ok) {
        setState({ kind: "error", message: recordResult.error.message });
        return;
      }
      if (recordResult.value === null) {
        setState({ kind: "error", message: `capture not found: ${captureId}` });
        return;
      }
      const record = recordResult.value;
      const enrichmentResult = await dispatch("codex:enrichment", {
        captureId
      });
      if (cancelled) return;
      // Enrichment failure is non-fatal — the rest of the panel still
      // renders. The description/tag rows simply hide themselves when
      // enrichment === null.
      const enrichment = enrichmentResult.ok ? enrichmentResult.value : null;
      setState({ kind: "loaded", record, enrichment });
    };

    void refetch();

    const unsubscribe = subscribe(EVENT_CHANNELS.capturesChanged, () => {
      void refetch();
    });

    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId]);

  if (state.kind === "loading") {
    return (
      <div className="pse-info-panel">
        <h3 className="pse-info-title">Info</h3>
        <div className="pse-info-loading" role="status">
          Loading…
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="pse-info-panel">
        <h3 className="pse-info-title">Info</h3>
        <div className="pse-info-error" role="status">
          Couldn&apos;t load capture info.
        </div>
      </div>
    );
  }

  const { record, enrichment } = state;
  const sourceName = record.source_app_name ?? "Unknown app";
  const bundleId = record.source_app_bundle_id;
  const acceptedTags = enrichment?.acceptedTags ?? [];
  const description =
    enrichment?.acceptedDescription !== null &&
    enrichment?.acceptedDescription !== undefined &&
    enrichment.acceptedDescription.trim().length > 0
      ? enrichment.acceptedDescription
      : null;

  return (
    <div className="pse-info-panel">
      <h3 className="pse-info-title">Info</h3>

      <InfoRow label="Source app">
        <span className="pse-info-app" data-testid="info-source-app">
          {bundleId !== null ? (
            <img
              className="pse-info-app-icon"
              src={`pwrsnap-app-icon://r/${bundleId}`}
              width={32}
              height={32}
              alt=""
              draggable={false}
              decoding="async"
              loading="lazy"
              data-testid="info-source-app-icon"
            />
          ) : (
            <span
              className="pse-info-app-icon pse-info-app-icon--fallback"
              data-testid="info-source-app-icon-fallback"
              aria-hidden="true"
            />
          )}
          <span className="pse-info-app-name">{sourceName}</span>
        </span>
      </InfoRow>

      <InfoRow label="Captured">
        <span data-testid="info-captured-at">
          {formatTimestamp(record.captured_at)}
        </span>
      </InfoRow>

      <InfoRow label="Dimensions">
        <span data-testid="info-dimensions">
          {record.width_px} × {record.height_px}
        </span>
      </InfoRow>

      <InfoRow label="File size">
        <span data-testid="info-file-size">{formatBytes(record.byte_size)}</span>
      </InfoRow>

      <InfoRow label="Kind">
        <span
          className={
            "pse-info-kind" +
            (record.kind === "video" ? " is-video" : " is-image")
          }
          data-testid="info-kind"
        >
          {record.kind === "video" ? "Video" : "Image"}
        </span>
      </InfoRow>

      {record.bundle_modified_at !== null && (
        <InfoRow label="Last edited">
          <span data-testid="info-last-edited">
            {formatTimestamp(record.bundle_modified_at)}
          </span>
        </InfoRow>
      )}

      {acceptedTags.length > 0 && (
        <InfoRow label="Tags">
          <span className="pse-info-tags" data-testid="info-tags">
            {acceptedTags.map((tag) => (
              <span key={tag} className="pse-tag" data-testid="info-tag-chip">
                {tag}
              </span>
            ))}
          </span>
        </InfoRow>
      )}

      {description !== null && (
        <InfoRow label="Description">
          <span
            className="pse-info-description"
            data-testid="info-description"
          >
            {description}
          </span>
        </InfoRow>
      )}
    </div>
  );
}

interface InfoRowProps {
  label: string;
  children: React.ReactNode;
}

function InfoRow({ label, children }: InfoRowProps): ReactElement {
  return (
    <div className="pse-info-row">
      <div className="pse-info-label">{label}</div>
      <div className="pse-info-value">{children}</div>
    </div>
  );
}

/**
 * Relative-ish timestamp formatter. Same shape as TrayMenu's
 * `relativeTime`: short forms (`12s ago`, `5m ago`, `3h ago`) within
 * 24 hours; locale-formatted absolute date past that. Kept here as a
 * local helper rather than lifted into a shared module — the only two
 * surfaces today (tray + this panel) have slightly different fallback
 * tastes (the panel wants "yesterday at 2:30 PM"-style; the tray
 * wants raw locale date). Promoting becomes worth it on the third
 * caller.
 */
function formatTimestamp(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  // Past 24h: show the date — locale-friendly, includes year when it
  // doesn't match the current year.
  const date = new Date(then);
  const now = new Date();
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}
