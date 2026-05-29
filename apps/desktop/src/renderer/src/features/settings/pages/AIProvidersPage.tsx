// The "Using" pill follows `snapshot.resolvedPath`, NOT
// `settings.codex.mode` — same logic stdio-transport uses to spawn
// Codex, so the renderer doesn't lie about which binary actually runs.

import { useEffect, useRef, useState, type ReactElement } from "react";
import type {
  CodexCaptionModel,
  CodexTestResult,
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot
} from "@pwrsnap/shared";
import {
  CODEX_CAPTION_MODELS,
  DEFAULT_CODEX_CAPTION_MODEL,
  isCodexCaptionModel
} from "@pwrsnap/shared";
import {
  Card,
  OptionRow,
  Row,
  SegmentedControl,
  type SegmentOption
} from "../components";
import { useSettingsContext } from "../SettingsContext";
import { ChatSettingsCard } from "./ChatSettingsCard";

const CODEX_MODE_OPTIONS: readonly SegmentOption<"auto" | "pinned">[] = [
  { id: "auto", label: "Auto Discovery — Use Newest" },
  { id: "pinned", label: "Specified Path" }
];

export function AIProvidersPage(): ReactElement {
  const {
    settings,
    secrets,
    patch,
    refreshCodex,
    testCodex,
    replaceSecret,
    clearSecret
  } = useSettingsContext();
  const [snapshot, setSnapshot] = useState<DesktopCodexDiscoverySnapshot | null>(
    null
  );
  const [snapshotLoading, setSnapshotLoading] = useState<boolean>(true);
  const [codexTest, setCodexTest] = useState<CodexTestResult | null>(null);
  const [codexTesting, setCodexTesting] = useState<boolean>(false);

  // Cache-friendly first fetch on mount; only force=true when the user
  // clicks Refresh. `refreshCodex` is a stable `useCallback` from
  // `useSettings` with an empty dep list, so this effect runs exactly
  // once per mount even though we list it as a dep.
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

  const captionModel: CodexCaptionModel = isCodexCaptionModel(
    settings?.codex.captionModel
  )
    ? settings.codex.captionModel
    : DEFAULT_CODEX_CAPTION_MODEL;

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Providers</div>
          <h1 className="pss__main-title">Backends &amp; credentials</h1>
          <p className="pss__main-sub">
            PwrSnap delegates AI work to your local Codex install. Captions,
            tag suggestions, and OCR all ride on a single Codex enrichment
            turn per capture. Semantic search vectorization is planned.
          </p>
        </div>
      </div>

      <Card eyebrow="ROLES" title="Job routing">
        <JobRoutingRow
          name="Capture captions & tag suggestions"
          sub="Codex caption shown in Library detail + Float-Over"
          provider="Codex"
        >
          <select
            className="pss__select"
            value={captionModel}
            onChange={(e) => {
              const next = e.target.value;
              if (!isCodexCaptionModel(next)) return;
              void patch({ codex: { captionModel: next } });
            }}
            aria-label="Capture caption model"
          >
            {CODEX_CAPTION_MODELS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </JobRoutingRow>
        <JobRoutingRow
          name="OCR — extract text from screenshots"
          sub="Rides with the captions request — same Codex turn, same model"
          provider="Codex"
          model={captionModel}
        />
        <JobRoutingRow
          name="Semantic search vectorization"
          sub="Will embed capture metadata + OCR text for ⌘K search"
          provider="—"
          model="Coming soon"
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
                {codexTest?.account ?? snapshot?.resolvedPath ?? "—"}
              </span>
              <span className="pss__test-sub">
                {codexTestSubLine(codexTest, codexTesting)}
              </span>
            </div>
            <div className="pss__test-r">
              <span
                className={
                  "pss__badge" + (codexTest ? ` ${codexTestBadgeClass(codexTest)}` : "")
                }
              >
                {codexTestBadgeLabel(codexTest, codexTesting)}
              </span>
              <button
                className="pss__test-btn"
                type="button"
                disabled={codexTesting}
                onClick={() => {
                  void (async () => {
                    setCodexTesting(true);
                    try {
                      const result = await testCodex();
                      if (result !== null) setCodexTest(result);
                    } finally {
                      setCodexTesting(false);
                    }
                  })();
                }}
              >
                {codexTesting ? "Testing…" : "Test"}
              </button>
            </div>
          </div>
        </Row>
      </Card>

      <ChatSettingsCard />

      <Card eyebrow="PROVIDER" title="Grok">
        <Row
          label="API Key"
          sub="Grok API key. Stored in the system keychain via Electron safeStorage — never written to config files or shipped to the renderer."
          tag="keychain"
        >
          <SecretKeyControl
            status={secrets?.grokApiKey ?? null}
            placeholder="xai-…"
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

      <Card eyebrow="PROVIDER" title="OpenAI (Sizzle Reels voiceover)">
        <Row
          label="API Key"
          sub="OpenAI API key. Used by the Sizzle Reels composer for text-to-speech voiceover. Stored in the system keychain via Electron safeStorage."
          tag="keychain"
        >
          <SecretKeyControl
            status={secrets?.openaiApiKey ?? null}
            placeholder="sk-…"
            onReplace={async (value) => {
              await replaceSecret("openaiApiKey", value);
            }}
            onClear={async () => {
              await clearSecret("openaiApiKey");
            }}
          />
        </Row>
      </Card>
    </>
  );
}

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
  if (snapshot === null || snapshot.candidates.length === 0) {
    const stillSearching = snapshot === null && loading;
    return (
      <div className="pss__opt">
        <span className="pss__opt-icon">{stillSearching ? "…" : "!"}</span>
        <div className="pss__opt-text">
          <span className="pss__opt-primary">
            {stillSearching
              ? "Discovering Codex binaries…"
              : "No Codex binary detected"}
          </span>
          <span className="pss__opt-sub">
            Install Codex Desktop or run <code>brew install codex</code>.
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

type SecretKeyControlProps = {
  status: { configured: boolean; lastSetAt: string | null } | null;
  placeholder: string;
  onReplace: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
};

function SecretKeyControl({
  status,
  placeholder,
  onReplace,
  onClear
}: SecretKeyControlProps): ReactElement {
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  const [working, setWorking] = useState<boolean>(false);
  const configured = status?.configured === true;

  // Cancel disables itself while a write is in flight (see the
  // disabled={working} below), but the user can still trigger
  // unmount via window close or page navigation mid-await. Guard
  // the `finally` setState so we don't fire on an unmounted control.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (): Promise<void> => {
    if (draft.length === 0) return;
    setWorking(true);
    try {
      await onReplace(draft);
      if (!mountedRef.current) return;
      setDraft("");
      setEditing(false);
    } catch {
      // useSettings has already surfaced the error; just bail.
    } finally {
      if (mountedRef.current) setWorking(false);
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
              placeholder={placeholder}
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
              disabled={working}
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
              placeholder={configured ? "" : "Click Set to enter a key"}
              onFocus={() => {
                if (!configured) setEditing(true);
              }}
            />
            <button
              className="pss__key-btn"
              type="button"
              onClick={() => {
                setEditing(true);
              }}
            >
              {configured ? "Replace" : "Set"}
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
  /** Static model label rendered to the right of the provider name.
   *  Mutually exclusive with `children` — pass `model` for read-only
   *  rows (OCR, Coming-soon), pass `children` to drop in a real
   *  control (dropdown, button, etc.). */
  model?: string;
  /** Custom right-edge slot. When set, replaces the provider chip's
   *  "model" sub-label so the row can host a real `<select>` or any
   *  other input. */
  children?: ReactElement;
  dim?: boolean;
};

function JobRoutingRow({
  name,
  sub,
  provider,
  model,
  children,
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
      {children !== undefined ? (
        <div className="pss__role-control">
          <b>{provider}</b>
          {children}
        </div>
      ) : (
        <span className="pss__role-provider" aria-disabled="true">
          <b>{provider}</b>
          <span className="pss__role-model">{model ?? ""}</span>
        </span>
      )}
    </div>
  );
}

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
  return new Date(then).toISOString().slice(0, 10);
}

export function codexTestBadgeLabel(
  result: CodexTestResult | null,
  testing: boolean
): string {
  if (testing) return "Testing…";
  if (result === null) return "Not tested";
  switch (result.status) {
    case "ok": return result.detail ?? "OK";
    case "unset": return "No Codex";
    case "failed": return "Failed";
  }
}

export function codexTestBadgeClass(result: CodexTestResult): string {
  switch (result.status) {
    case "ok": return "is-using";
    case "unset": return "";
    case "failed": return "is-accent";
  }
}

export function codexTestSubLine(
  result: CodexTestResult | null,
  testing: boolean
): string {
  if (testing) return "spawn --version";
  if (result === null) return "spawn --version";
  if (result.status === "ok") {
    return `${result.durationMs}ms · ${formatLastSetAt(result.testedAt)}`;
  }
  if (result.status === "unset") {
    return "no Codex binary resolved";
  }
  return result.errorMessage ?? "spawn failed";
}
