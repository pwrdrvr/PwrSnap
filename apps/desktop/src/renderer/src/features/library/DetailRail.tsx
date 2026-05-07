// DetailRail — right-side panel showing capture metadata, Codex
// caption stub, and the L/M/H copy row. Visible in Focus + Reel
// modes; returns null in Grid (mode-conditional lives INSIDE the
// component per architecture-strategist's recommendation D6).
//
// Plan reference:
//   docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md
//   Phase B.2 (shell) + Phase C.5 (body).

import type { ReactElement } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { CopyButton, presetMetrics } from "../shared/CopyButton";
import { AppTag } from "../shared/AppIcons";
import { dispatch } from "../../lib/pwrsnap";
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
};

export function DetailRail({ view, record }: DetailRailProps): ReactElement | null {
  // Grid mode: rail not rendered. Future surfaces that want a rail
  // in Grid (bulk-select, etc.) only change one component.
  if (view.kind === "grid") return null;
  if (record === null) return null;

  const capturedAt = formatTimestamp(record.captured_at);
  const sourceName = record.source_app_name ?? "Unknown app";
  const appId = mapBundleIdToAppId(record.source_app_bundle_id);

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
            <AppTag app={appId} name={sourceName} />
            <span className="ps-tag is-suggest">+ codex</span>
          </div>
        </div>

        {/* Codex caption stub — Phase 4 wires the real Codex pipeline.
            For now it's static placeholder text so the layout looks
            right at scale. */}
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
            <small>haiku-4.5 · 1.4s</small>
          </div>
          <div className="psl__ai-card-text">
            Capture from <b>{sourceName}</b>. Codex auto-tagging hasn't run yet — connect a Codex
            instance in Settings &rarr; AI to enable.
          </div>
          <div className="psl__ai-card-actions">
            <button className="psl__chip-btn" type="button" disabled>
              Regenerate
            </button>
            <button className="psl__chip-btn" type="button" disabled>
              Apply tags
            </button>
            <button className="psl__chip-btn" type="button" disabled>
              Copy as alt-text
            </button>
          </div>
        </div>

        {/* L/M/H copy row — three <CopyButton> instances. presetMetrics()
            shows the user the scaled dimensions + estimated bytes
            before they click. The user feedback loop (orange "Copied"
            overlay for 1.2s on click) is owned by CopyButton. */}
        <div>
          <div className="psl__copy-eyebrow">
            <span>Copy to clipboard</span>
            <span className="psl__copy-eyebrow-line" />
            <span className="psl__copy-eyebrow-meta">scaled, not blind</span>
          </div>
          <div className="psl__copy-row">
            {COPY_PRESETS.map((p) => {
              const m = presetMetrics(
                p,
                record.width_px,
                record.height_px,
                record.byte_size
              );
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
              <button type="button" disabled title="Coming soon">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 4v12M6 10l6-6 6 6M4 20h16" />
                </svg>
                Share
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
