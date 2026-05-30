// The "Using" pill follows `snapshot.resolvedPath`, NOT
// `settings.codex.mode` — same logic stdio-transport uses to spawn
// Codex, so the renderer doesn't lie about which binary actually runs.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  AiEnrichmentBudgetStatus,
  AiUsageRunsPage,
  AiUsageSummary,
  CodexModelList,
  CodexModelOption,
  CodexTestResult,
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot
} from "@pwrsnap/shared";
import {
  CODEX_CAPTION_MODELS,
  DEFAULT_CODEX_CAPTION_MODEL,
  EVENT_CHANNELS,
  isCodexCaptionModel
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
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

function modelOptionsForSelect(
  models: readonly CodexModelOption[],
  selectedModel: string
): CodexModelOption[] {
  const imageModels = models.filter(
    (model) =>
      !model.hidden &&
      model.inputModalities.includes("text") &&
      model.inputModalities.includes("image")
  );
  const options = imageModels.length > 0
    ? imageModels
    : CODEX_CAPTION_MODELS.map((id) => ({
        id,
        model: id,
        displayName: id,
        description: "",
        hidden: false,
        inputModalities: ["text", "image"] as Array<"text" | "image">,
        defaultServiceTier: null,
        isDefault: id === DEFAULT_CODEX_CAPTION_MODEL
      }));
  if (options.some((model) => model.id === selectedModel)) return options;
  return [
    {
      id: selectedModel,
      model: selectedModel,
      displayName: selectedModel,
      description: "",
      hidden: false,
      inputModalities: ["text", "image"],
      defaultServiceTier: null,
      isDefault: false
    },
    ...options
  ];
}

function modelLabel(model: CodexModelOption): string {
  return model.displayName === model.id || model.displayName.length === 0
    ? model.id
    : `${model.displayName} (${model.id})`;
}

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
  const [budgetStatus, setBudgetStatus] = useState<AiEnrichmentBudgetStatus | null>(null);
  const [usageSummary, setUsageSummary] = useState<AiUsageSummary | null>(null);
  const [usageRuns, setUsageRuns] = useState<AiUsageRunsPage | null>(null);
  const [usageLoading, setUsageLoading] = useState<boolean>(true);
  const [codexModels, setCodexModels] = useState<CodexModelList | null>(null);
  const [codexModelsLoading, setCodexModelsLoading] = useState<boolean>(true);

  const refreshBudgetStatus = useCallback(async (): Promise<void> => {
    const result = await dispatch("codex:budgetStatus", {});
    if (result.ok) setBudgetStatus(result.value);
  }, []);

  const refreshUsage = useCallback(async (): Promise<void> => {
    const [summaryResult, runsResult] = await Promise.all([
      dispatch("codex:usageSummary", { window: "30d" }),
      dispatch("codex:usageRuns", { limit: 5, offset: 0 })
    ]);
    if (summaryResult.ok) setUsageSummary(summaryResult.value);
    if (runsResult.ok) setUsageRuns(runsResult.value);
    setUsageLoading(false);
  }, []);

  const refreshCodexModels = useCallback(async (): Promise<void> => {
    setCodexModelsLoading(true);
    const result = await dispatch("codex:models", {});
    if (result.ok) {
      setCodexModels(result.value);
    }
    setCodexModelsLoading(false);
  }, []);

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
      void refreshCodexModels();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshCodex, refreshCodexModels]);

  useEffect(() => {
    void refreshBudgetStatus();
    const unsubscribe = subscribe(EVENT_CHANNELS.aiBudgetUpdated, (payload) => {
      setBudgetStatus(payload as AiEnrichmentBudgetStatus);
    });
    return () => {
      unsubscribe();
    };
  }, [refreshBudgetStatus]);

  useEffect(() => {
    void refreshUsage();
    const unsubscribeRun = subscribe(EVENT_CHANNELS.aiRunUpdated, () => {
      void refreshUsage();
    });
    const unsubscribeUsage = subscribe(EVENT_CHANNELS.aiUsageUpdated, () => {
      void refreshUsage();
    });
    return () => {
      unsubscribeRun();
      unsubscribeUsage();
    };
  }, [refreshUsage]);

  const onRefresh = async (): Promise<void> => {
    setSnapshotLoading(true);
    setCodexModelsLoading(true);
    const [snap] = await Promise.all([refreshCodex(true), refreshCodexModels()]);
    setSnapshot(snap);
    setSnapshotLoading(false);
  };

  const captionModel = isCodexCaptionModel(settings?.codex.captionModel)
    ? settings.codex.captionModel
    : DEFAULT_CODEX_CAPTION_MODEL;
  const captionModelOptions = modelOptionsForSelect(codexModels?.models ?? [], captionModel);

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
          <div className="pss__model-picker">
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
              {captionModelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {modelLabel(model)}
                </option>
              ))}
            </select>
            {codexModelsLoading ? <span className="pss__model-loading">loading models</span> : null}
          </div>
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

      <Card eyebrow="SAFETY" title="Capture enrichment">
        <Row
          label="AI enrichment"
          sub="Controls Codex caption, OCR, filename, and tag generation for captures."
          tag={settings?.ai.enabled ? "enabled" : "off"}
        >
          <div className="pss__test">
            <span className="pss__test-icon">AI</span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">
                {settings?.ai.budgetSafetyDisabledAt !== null &&
                settings?.ai.budgetSafetyDisabledAt !== undefined
                  ? "Disabled for cost safety"
                  : settings?.ai.enabled
                    ? "Enrichment enabled"
                    : "Enrichment disabled"}
              </span>
              <span className="pss__test-sub">
                {budgetStatusSubLine(budgetStatus, settings?.ai.budgetSafetyDisabledAt ?? null)}
              </span>
            </div>
            <div className="pss__test-r">
              <span className={"pss__badge " + budgetBadgeClass(budgetStatus)}>
                {budgetBadgeLabel(budgetStatus)}
              </span>
              <button
                className="pss__test-btn"
                type="button"
                onClick={() => {
                  const enabled = !(settings?.ai.enabled ?? false);
                  void (async () => {
                    await patch({
                      ai: {
                        enabled,
                        budgetSafetyDisabledAt: null,
                        ...(enabled && settings?.ai.consentAcceptedAt === null
                          ? { consentAcceptedAt: new Date().toISOString() }
                          : {})
                      }
                    });
                    await refreshBudgetStatus();
                  })();
                }}
              >
                {settings?.ai.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          </div>
        </Row>
      </Card>

      <Card
        eyebrow="USAGE"
        title="AI usage"
        headerAction={
          <button
            className="pss__top-btn"
            type="button"
            disabled={usageLoading}
            onClick={() => {
              setUsageLoading(true);
              void refreshUsage();
            }}
          >
            {usageLoading ? "Refreshing…" : "Refresh"}
          </button>
        }
      >
        <Row
          label="PwrSnap usage"
          sub="Observed Codex runs from this app. Cost is an OpenAI public list-price equivalent, not an account invoice."
          tag="30 days"
        >
          <AiUsagePanel
            summary={usageSummary}
            runs={usageRuns}
            loading={usageLoading}
          />
        </Row>
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
            sub={codexAuthSubLine(snapshot, snapshotLoading)}
            using={true}
            badges={
              <>
                <span className="pss__badge">default</span>
                <span className="pss__badge">auth</span>
                <span className="pss__badge">config</span>
                <span className={"pss__badge " + codexAuthBadgeClass(snapshot)}>
                  {codexAuthBadgeLabel(snapshot, snapshotLoading)}
                </span>
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

type AiUsagePanelProps = {
  summary: AiUsageSummary | null;
  runs: AiUsageRunsPage | null;
  loading: boolean;
};

function AiUsagePanel({ summary, runs, loading }: AiUsagePanelProps): ReactElement {
  if (summary === null || runs === null) {
    return (
      <div className="pss__usage">
        <div className="pss__usage-empty">
          {loading ? "Loading usage accounting." : "No usage accounting recorded yet."}
        </div>
      </div>
    );
  }

  return (
    <div className="pss__usage">
      <div className="pss__usage-metrics">
        <UsageMetric
          label="List-price"
          value={formatCostMicros(summary.estimatedTotalCostMicros)}
          sub={`${summary.runCount} runs`}
        />
        <UsageMetric
          label="Input"
          value={formatTokenCount(summary.inputTokens)}
          sub={`${formatTokenCount(uncachedInputTokens(summary.inputTokens, summary.cachedInputTokens))} uncached · ${formatTokenCount(summary.cachedInputTokens)} cached`}
        />
        <UsageMetric
          label="Output"
          value={formatTokenCount(summary.outputTokens)}
          sub={`${formatTokenCount(summary.reasoningOutputTokens)} reasoning`}
        />
      </div>
      {summary.usageUnavailableCount > 0 || summary.priceUnavailableCount > 0 ? (
        <div className="pss__usage-note">
          {summary.usageUnavailableCount > 0
            ? `${summary.usageUnavailableCount} run${summary.usageUnavailableCount === 1 ? "" : "s"} missing Codex usage. `
            : ""}
          {summary.priceUnavailableCount > 0
            ? `${summary.priceUnavailableCount} run${summary.priceUnavailableCount === 1 ? "" : "s"} missing price data.`
            : ""}
        </div>
      ) : null}
      <div className="pss__usage-runs">
        {runs.items.length === 0 ? (
          <div className="pss__usage-empty">No recent AI runs.</div>
        ) : (
          runs.items.map((item) => (
            <div className="pss__usage-run" key={item.run.id}>
              <div className="pss__usage-run-main">
                <span className="pss__usage-run-title">
                  {usageActivityTitle(item)}
                </span>
                <span className="pss__usage-run-sub">
                  {usageActivitySub(item)}
                </span>
              </div>
              <div className="pss__usage-run-right">
                <span className="pss__usage-run-cost">
                  {item.priceStatus === "available" && item.estimatedTotalCostMicros !== null
                    ? formatCostMicros(item.estimatedTotalCostMicros)
                    : "Price unavailable"}
                </span>
                <span className="pss__usage-run-tokens">
                  {item.usageStatus === "available" && item.totalTokens !== null
                    ? formatUsageTokenBreakdown({
                        inputTokens: item.inputTokens,
                        cachedInputTokens: item.cachedInputTokens,
                        outputTokens: item.outputTokens,
                        reasoningOutputTokens: item.reasoningOutputTokens
                      })
                    : "Usage unavailable"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function UsageMetric({
  label,
  value,
  sub
}: {
  label: string;
  value: string;
  sub: string;
}): ReactElement {
  return (
    <div className="pss__usage-metric">
      <span className="pss__usage-metric-label">{label}</span>
      <span className="pss__usage-metric-value">{value}</span>
      <span className="pss__usage-metric-sub">{sub}</span>
    </div>
  );
}

function usageActivityTitle(item: AiUsageRunsPage["items"][number]): string {
  if (item.subjectKind === "thread") {
    return item.threadSurface === "sizzle-chat" ? "Sizzle chat" : "Library chat";
  }
  return usageTaskLabel(item.run.task, item.run.triggerSource);
}

function usageActivitySub(item: AiUsageRunsPage["items"][number]): string {
  const model = item.model ?? "model unavailable";
  const when = formatLastSetAt(item.run.completedAt ?? item.run.createdAt);
  if (item.subjectKind === "thread") {
    const name = item.threadName ?? "Untitled thread";
    const turns = item.turnCount === null
      ? "turns unavailable"
      : `${formatTokenCount(item.turnCount)} turn${item.turnCount === 1 ? "" : "s"}`;
    return `${name} · ${turns} · ${model} · ${when}`;
  }
  return `${model} · ${when}`;
}

function usageTaskLabel(task: string, triggerSource: string): string {
  if (triggerSource === "auto-enrichment") return "Auto enrichment";
  if (triggerSource === "library-regenerate") return "Library regenerate";
  if (triggerSource === "popover-regenerate") return "Float-over regenerate";
  if (triggerSource === "library-chat") return "Library chat";
  if (triggerSource === "sizzle-chat") return "Sizzle chat";
  if (triggerSource === "annotate") return "Annotate";
  if (triggerSource === "describe") return "Describe";
  if (triggerSource === "tag") return "Tag";
  if (triggerSource === "filename") return "Filename";
  if (triggerSource === "sensitive-scan") return "Sensitive scan";
  return task === "enrich" ? "Capture enrichment" : task;
}

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

function budgetBadgeLabel(status: AiEnrichmentBudgetStatus | null): string {
  switch (status?.mode) {
    case "safety_disabled":
      return "Safety off";
    case "slow":
      return "Slow mode";
    case "available":
      return "Ready";
    case undefined:
      return "Checking";
  }
}

function budgetBadgeClass(status: AiEnrichmentBudgetStatus | null): string {
  switch (status?.mode) {
    case "safety_disabled":
      return "is-danger";
    case "slow":
      return "is-accent";
    case "available":
      return "is-using";
    case undefined:
      return "";
  }
}

function budgetStatusSubLine(
  status: AiEnrichmentBudgetStatus | null,
  disabledAt: string | null
): string {
  if (disabledAt !== null) {
    return `Repeated budget exhaustion disabled enrichment at ${formatLastSetAt(disabledAt)}.`;
  }
  if (status === null) return "Loading budget status.";
  const tokenLabel = `${status.tokensAvailable}/${status.capacity} budget tokens`;
  if (status.mode === "slow") {
    return `Slow mode: ${tokenLabel}; next token ${formatNextTokenAt(status.nextTokenAt)}.`;
  }
  return `${tokenLabel}; refill cadence is one token every ${Math.round(status.refillIntervalMs / 1000)}s.`;
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
  const then = parseTimestampMs(iso);
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

export function formatCostMicros(micros: number | null): string {
  if (micros === null) return "—";
  const dollars = micros / 1_000_000;
  if (dollars > 0 && dollars < 0.001) return "<$0.001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dollars > 0 && dollars < 0.1 ? 3 : dollars < 10 ? 2 : 0,
    maximumFractionDigits: dollars > 0 && dollars < 0.1 ? 3 : dollars < 10 ? 2 : 0
  }).format(dollars);
}

export function formatTokenCount(tokens: number | null): string {
  if (tokens === null) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}

export function formatUsageTokenBreakdown(tokens: {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}): string {
  const inputTokens = tokens.inputTokens ?? 0;
  const cachedInputTokens = tokens.cachedInputTokens ?? 0;
  const outputTokens = tokens.outputTokens ?? 0;
  const reasoningOutputTokens = tokens.reasoningOutputTokens ?? 0;
  const output = reasoningOutputTokens > 0
    ? `${formatTokenCount(outputTokens)} out (${formatTokenCount(reasoningOutputTokens)} reasoning)`
    : `${formatTokenCount(outputTokens)} out`;
  return `${formatTokenCount(uncachedInputTokens(inputTokens, cachedInputTokens))} uncached in · ${formatTokenCount(cachedInputTokens)} cached · ${output}`;
}

function uncachedInputTokens(inputTokens: number | null, cachedInputTokens: number | null): number {
  return Math.max(0, (inputTokens ?? 0) - (cachedInputTokens ?? 0));
}

function codexAuthBadgeLabel(
  snapshot: DesktopCodexDiscoverySnapshot | null,
  loading: boolean
): string {
  if (loading && snapshot === null) return "Checking";
  if (snapshot?.resolvedPath === null) return "No Codex";
  switch (snapshot?.auth?.status) {
    case "authenticated": return "Signed in";
    case "unauthenticated": return "Sign in";
    case "failed": return "Check failed";
    case undefined: return "Unknown";
  }
}

function codexAuthBadgeClass(snapshot: DesktopCodexDiscoverySnapshot | null): string {
  switch (snapshot?.auth?.status) {
    case "authenticated": return "is-using";
    case "unauthenticated":
    case "failed": return "is-accent";
    case undefined: return "";
  }
}

function codexAuthSubLine(
  snapshot: DesktopCodexDiscoverySnapshot | null,
  loading: boolean
): string {
  if (loading && snapshot === null) return "Checking Codex auth…";
  if (snapshot?.resolvedPath === null) return "No Codex binary resolved.";
  if (snapshot?.auth?.status === "authenticated") {
    return snapshot.auth.detail ?? "~/.codex";
  }
  if (snapshot?.auth?.status === "unauthenticated") {
    return "Codex is installed but not signed in. Run codex login or sign in through Codex Desktop.";
  }
  if (snapshot?.auth?.status === "failed") {
    return snapshot.auth.errorMessage ?? "Codex auth check failed.";
  }
  return "~/.codex";
}

export function formatNextTokenAt(iso: string | null): string {
  if (iso === null || iso.length === 0) return "soon";
  const then = parseTimestampMs(iso);
  if (Number.isNaN(then)) return iso;
  const deltaMs = then - Date.now();
  if (deltaMs <= 0) return "now";
  const sec = Math.ceil(deltaMs / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `in ${min} min${min === 1 ? "" : "s"}`;
  const hr = Math.ceil(min / 60);
  return `in ${hr} hour${hr === 1 ? "" : "s"}`;
}

function parseTimestampMs(value: string): number {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(" ", "T")}Z`);
  }
  return Date.parse(value);
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
