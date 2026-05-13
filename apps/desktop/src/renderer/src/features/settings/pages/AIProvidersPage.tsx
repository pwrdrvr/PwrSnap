// AI Providers settings page. Ported from design/src/Settings.jsx
// `AIProvidersPage` (lines 477–710), narrowed to the surfaces with
// live backing today: Codex discovery (live), Grok keychain (live),
// Job routing (visual preview only — Phase 4 wires it for real).
//
// Codex discovery:
//   • Snapshot is fetched on mount via `settings:refreshCodexDiscovery`
//     with force=false (cache-friendly). A "Refresh" header button
//     re-fetches with force=true.
//   • Each candidate is a clickable Use button (writes
//     codex.mode=pinned + codex.pinnedPath=path). Switching the
//     segmented control back to Auto Discovery keeps the pinnedPath
//     value so the user doesn't lose it on toggle.
//   • The "Using" pill follows `snapshot.resolvedPath`, NOT
//     `settings.codex.mode` — same logic stdio-transport uses to
//     spawn Codex.
//
// Grok secret:
//   • Status comes from `useSettings().secrets`. Plaintext never
//     crosses the IPC boundary.
//   • Replace expands an inline input; Enter submits.

import { useEffect, useState, type ReactElement } from "react";
import type {
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot
} from "@pwrsnap/shared";
import {
  Card,
  OptionRow,
  Row,
  SegmentedControl,
  type SegmentOption
} from "../components";
import { useSettingsContext } from "../SettingsContext";

const CODEX_MODE_OPTIONS: readonly SegmentOption<"auto" | "pinned">[] = [
  { id: "auto", label: "Auto Discovery — Use Newest" },
  { id: "pinned", label: "Specified Path" }
];

export function AIProvidersPage(): ReactElement {
  const { settings, secrets, patch, refreshCodex, replaceSecret, clearSecret } =
    useSettingsContext();
  const [snapshot, setSnapshot] = useState<DesktopCodexDiscoverySnapshot | null>(
    null
  );
  const [snapshotLoading, setSnapshotLoading] = useState<boolean>(true);

  // Cache-friendly first fetch on mount; only force=true when the user
  // clicks Refresh.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snap = await refreshCodex(false);
      if (cancelled) return;
      setSnapshot(snap);
      setSnapshotLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshCodex]);

  const onRefresh = async (): Promise<void> => {
    setSnapshotLoading(true);
    const snap = await refreshCodex(true);
    setSnapshot(snap);
    setSnapshotLoading(false);
  };

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Providers</div>
          <h1 className="pss__main-title">Backends &amp; credentials</h1>
          <p className="pss__main-sub">
            PwrSnap delegates AI work to multiple providers. Codex generates
            capture captions and tag suggestions; other providers vectorize
            captures + OCR for semantic search. Configure each backend below.
          </p>
        </div>
      </div>

      <Card eyebrow="ROLES" title="Job routing">
        <div className="pss__row">
          <div className="pss__row-l">
            <div className="pss__row-label">Preview</div>
            <div className="pss__row-sub">
              Routing wires up when the AI pipeline ships (Phase 4). The rows
              below are visual-only today.
            </div>
            <div className="pss__row-tag">preview</div>
          </div>
          <div className="pss__row-r" />
        </div>
        <JobRoutingRow
          name="Capture captions & tag suggestions"
          sub="Codex caption shown in Library detail + Float-Over"
          provider="Codex"
          model="haiku-4.5"
        />
        <JobRoutingRow
          name="Semantic search vectorization"
          sub="Embeds capture metadata + OCR for ⌘K search"
          provider="OpenAI"
          model="3-small"
        />
        <JobRoutingRow
          name="OCR — extract text from screenshots"
          sub="Currently using macOS Vision (local) — provider option coming soon"
          provider="System"
          model="Vision.framework"
          dim
        />
      </Card>

      <Card
        eyebrow="PROVIDER"
        title="Codex"
        headerAction={
          <button
            className="pss__top-btn"
            type="button"
            onClick={() => {
              void onRefresh();
            }}
          >
            {snapshotLoading ? "Refreshing…" : "Refresh"}
          </button>
        }
      >
        <Row
          label="Codex selection"
          sub="Pick the Codex binary to invoke for captions. Auto Discovery tracks the newest version on disk; Specified Path pins a single binary."
          tag="config"
        >
          <SegmentedControl
            options={CODEX_MODE_OPTIONS}
            value={settings?.codex.mode ?? "auto"}
            onChange={(next) => {
              void patch({ codex: { mode: next } });
            }}
          />
        </Row>

        <Row
          label="Available paths"
          sub="Detected on this machine. The resolved binary is highlighted."
          tag="config"
        >
          <CodexCandidates
            snapshot={snapshot}
            loading={snapshotLoading}
            onPin={(path) => {
              void patch({ codex: { mode: "pinned", pinnedPath: path } });
            }}
          />
        </Row>

        <Row
          label="Auth profile"
          sub="Select the Codex home used for auth, config, sessions, skills, and state."
          tag="default"
        >
          <OptionRow
            icon="~"
            primary="System default"
            sub="~/.codex"
            using={true}
            badges={
              <>
                <span className="pss__badge">default</span>
                <span className="pss__badge">auth</span>
                <span className="pss__badge">config</span>
                <span className="pss__badge is-using">Using</span>
              </>
            }
          />
        </Row>

        <Row
          label="Connection test"
          sub="Spawns the selected Codex binary with --version and validates the version banner."
          tag="test"
        >
          <div className="pss__test">
            <span className="pss__test-icon">C</span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">
                {snapshot?.resolvedPath ?? "—"}
              </span>
              <span className="pss__test-sub">spawn --version</span>
            </div>
            <div className="pss__test-r">
              <span className="pss__badge">Not tested</span>
              <button
                className="pss__test-btn"
                type="button"
                onClick={() => {
                  // Phase 4 wires the real test; v1 is inert.
                  // eslint-disable-next-line no-console
                  console.warn(
                    "[Settings] AI Providers connection test is a Phase 4 placeholder"
                  );
                }}
              >
                Test
              </button>
            </div>
          </div>
        </Row>
      </Card>

      <Card eyebrow="PROVIDER" title="Grok">
        <Row
          label="API Key"
          sub="Grok API key. Stored in the system keychain via Electron safeStorage — never written to config files or shipped to the renderer."
          tag="keychain"
        >
          <GrokKeyControl
            status={secrets?.grokApiKey ?? null}
            onReplace={async (value) => {
              await replaceSecret("grokApiKey", value);
            }}
            onClear={async () => {
              await clearSecret("grokApiKey");
            }}
          />
        </Row>

        <Row
          label="Connection test"
          sub="Calls the Grok models endpoint. Wires up when the AI pipeline ships."
          tag="test"
        >
          <div className="pss__test">
            <span className="pss__test-icon">G</span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">api.x.ai/v1/models</span>
              <span className="pss__test-sub">GET /v1/models</span>
            </div>
            <div className="pss__test-r">
              <span className="pss__badge">Not tested</span>
              <button
                className="pss__test-btn"
                type="button"
                onClick={() => {
                  // eslint-disable-next-line no-console
                  console.warn(
                    "[Settings] AI Providers Grok test is a Phase 4 placeholder"
                  );
                }}
              >
                Test
              </button>
            </div>
          </div>
        </Row>
      </Card>
    </>
  );
}

// ── Helpers ────────────────────────────────────────────────────

type CodexCandidatesProps = {
  snapshot: DesktopCodexDiscoverySnapshot | null;
  loading: boolean;
  onPin: (path: string) => void;
};

function CodexCandidates({
  snapshot,
  loading,
  onPin
}: CodexCandidatesProps): ReactElement {
  if (snapshot === null) {
    return (
      <div className="pss__opt">
        <span className="pss__opt-icon">…</span>
        <div className="pss__opt-text">
          <span className="pss__opt-primary">
            {loading ? "Discovering Codex binaries…" : "No Codex binary detected"}
          </span>
          <span className="pss__opt-sub">
            Install Codex Desktop or run <code>brew install codex</code>.
          </span>
        </div>
      </div>
    );
  }
  if (snapshot.candidates.length === 0) {
    return (
      <div className="pss__opt">
        <span className="pss__opt-icon">!</span>
        <div className="pss__opt-text">
          <span className="pss__opt-primary">No Codex binary detected</span>
          <span className="pss__opt-sub">
            Discovery returned an empty set. Install Codex Desktop or run
            <code>brew install codex</code>.
          </span>
        </div>
      </div>
    );
  }
  return (
    <>
      {snapshot.candidates.map((c) => (
        <CandidateRow
          key={c.path}
          candidate={c}
          using={c.path === snapshot.resolvedPath}
          onPin={() => onPin(c.path)}
        />
      ))}
    </>
  );
}

type CandidateRowProps = {
  candidate: DesktopCodexDiscoveryCandidate;
  using: boolean;
  onPin: () => void;
};

function CandidateRow({ candidate, using, onPin }: CandidateRowProps): ReactElement {
  return (
    <OptionRow
      icon="C"
      primary={candidate.path}
      sub={candidate.available ? "available" : "unavailable"}
      using={using}
      badges={
        <>
          <span className="pss__badge">{candidate.source}</span>
          {candidate.version !== null ? (
            <span className="pss__badge">{candidate.version}</span>
          ) : null}
          {using ? <span className="pss__badge is-using">Using</span> : null}
        </>
      }
      action={
        !using ? (
          <button
            className="pss__opt-use"
            type="button"
            onClick={onPin}
            disabled={!candidate.available}
          >
            Use
          </button>
        ) : undefined
      }
    />
  );
}

type GrokKeyControlProps = {
  status: { configured: boolean; lastSetAt: string | null } | null;
  onReplace: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
};

function GrokKeyControl({
  status,
  onReplace,
  onClear
}: GrokKeyControlProps): ReactElement {
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  const [working, setWorking] = useState<boolean>(false);
  const configured = status?.configured === true;

  const submit = async (): Promise<void> => {
    if (draft.length === 0) return;
    setWorking(true);
    try {
      await onReplace(draft);
      setDraft("");
      setEditing(false);
    } catch {
      // useSettings has already surfaced the error; just bail.
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <div className="pss__keyrow">
        {editing ? (
          <>
            <input
              className="pss__input"
              type="password"
              autoFocus
              value={draft}
              placeholder="xai-…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void submit();
                } else if (e.key === "Escape") {
                  setDraft("");
                  setEditing(false);
                }
              }}
            />
            <button
              className="pss__key-btn"
              type="button"
              onClick={() => {
                void submit();
              }}
              disabled={working || draft.length === 0}
            >
              Save
            </button>
            <button
              className="pss__key-btn"
              type="button"
              onClick={() => {
                setDraft("");
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <input
              className="pss__input"
              type="password"
              readOnly
              value={configured ? "••••••••••••••••" : ""}
              placeholder={configured ? "" : "Not set"}
            />
            <button
              className="pss__key-btn"
              type="button"
              onClick={() => {
                setEditing(true);
              }}
            >
              Replace
            </button>
            <button
              className="pss__key-btn is-danger"
              type="button"
              disabled={!configured}
              onClick={() => {
                void onClear();
              }}
            >
              Clear
            </button>
          </>
        )}
      </div>
      <div className="pss__key-meta">
        {configured ? (
          <>
            <span>
              set <b style={{ color: "var(--text-primary)" }}>{formatLastSetAt(status?.lastSetAt ?? null)}</b>
            </span>
            <span>·</span>
            <span>keychain</span>
          </>
        ) : (
          <span>Not set</span>
        )}
      </div>
    </>
  );
}

type JobRoutingRowProps = {
  name: string;
  sub: string;
  provider: string;
  model: string;
  dim?: boolean;
};

function JobRoutingRow({
  name,
  sub,
  provider,
  model,
  dim
}: JobRoutingRowProps): ReactElement {
  return (
    <div className="pss__role" style={dim === true ? { opacity: 0.6 } : undefined}>
      <span className="pss__role-icon" aria-hidden="true">
        ◆
      </span>
      <div className="pss__role-l">
        <span className="pss__role-name">{name}</span>
        <span className="pss__role-sub">{sub}</span>
      </div>
      <span className="pss__role-arrow">→</span>
      <span className="pss__role-provider" aria-disabled="true">
        <b>{provider}</b>
        <span
          style={{
            color: "var(--text-muted)",
            font: "500 11px/1 var(--font-mono)",
            marginLeft: 2
          }}
        >
          {model}
        </span>
      </span>
    </div>
  );
}

/**
 * Format `lastSetAt` ISO-8601 for the Grok status row. Returns a
 * relative phrase for recent times and a date for anything older
 * than a week — matches the design's "set 3 days ago" shape.
 *
 * Pure — no React, no `Intl.RelativeTimeFormat` dependency, no
 * window globals — so it tests trivially.
 */
export function formatLastSetAt(iso: string | null): string {
  if (iso === null || iso.length === 0) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const deltaMs = Math.max(0, now - then);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  // Older than a week: drop to an absolute date (no time-of-day,
  // matches design's calm tone).
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * Whether `candidatePath` is the one `resolveCodexCommand` will pick
 * for the next spawn, given a snapshot. Tiny helper extracted so it
 * can be unit-tested without a React render.
 */
export function resolveUsing(
  snapshot: DesktopCodexDiscoverySnapshot | null,
  candidatePath: string
): boolean {
  if (snapshot === null) return false;
  return snapshot.resolvedPath === candidatePath;
}
