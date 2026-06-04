// The "Using" pill follows `snapshot.resolvedPath`, NOT
// `settings.codex.mode` — same logic stdio-transport uses to spawn
// Codex, so the renderer doesn't lie about which binary actually runs.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  AcpAgentDiscovery,
  AcpAgentDiscoveryEntry,
  AcpAgentPreference,
  AiEnrichmentBudgetStatus,
  AiReasoningEffort,
  AiSurfaceDefault,
  AiSurfaceDefaultPatch,
  AiSurfaceId,
  AiUsageRunsPage,
  AiUsageSummary,
  CodexModelList,
  CodexModelOption,
  CodexTestResult,
  DesktopCodexAuthProfile,
  DesktopCodexAuthProfileList,
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot
} from "@pwrsnap/shared";
import {
  AI_REASONING_EFFORTS,
  CODEX_CAPTION_MODELS,
  DEFAULT_CODEX_CAPTION_MODEL,
  EVENT_CHANNELS,
  isAiReasoningEffort,
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
  const [acpDiscovery, setAcpDiscovery] = useState<AcpAgentDiscovery | null>(null);
  const [acpDiscoveryLoading, setAcpDiscoveryLoading] = useState<boolean>(true);
  const [acpDiscoveryError, setAcpDiscoveryError] = useState<string | null>(null);

  const refreshAcpDiscovery = useCallback(async (): Promise<void> => {
    setAcpDiscoveryLoading(true);
    const result = await dispatch("acp:discover", {});
    if (result.ok) {
      setAcpDiscovery(result.value);
      setAcpDiscoveryError(null);
    } else {
      setAcpDiscoveryError(result.error.message);
    }
    setAcpDiscoveryLoading(false);
  }, []);

  useEffect(() => {
    void refreshAcpDiscovery();
  }, [refreshAcpDiscovery]);

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

  // The chat-surface provider dropdown offers Codex + each ENABLED ACP agent
  // (value `acp:<id>`, labeled by its discovery display name). Built from the
  // enabled set intersected with discovery so an enabled-but-now-uninstalled
  // agent still shows by id (the factory falls back to Codex at runtime). An
  // agent enabled before discovery resolves is shown by its id until names
  // arrive.
  const enabledAgentIds = settings?.ai.acp.enabledAgentIds ?? [];
  const acpChatProviderOptions: AcpChatProviderOption[] = enabledAgentIds.map((id) => {
    const entry = acpDiscovery?.agents.find((a) => a.id === id);
    return { value: `acp:${id}`, label: entry?.displayName ?? id };
  });

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

      <Card eyebrow="ROLES" title="Per-surface defaults">
        <Row
          label="Default model & reasoning"
          sub="Pick the default provider, model, and reasoning effort for each AI surface. Leave a field on Default to let Codex choose. These apply to new threads / runs; they don't rewrite existing conversations."
          tag="config"
        >
          <div className="pss__ai-surface-defaults">
            <AiSurfaceDefaultControl
              surface="libraryChat"
              label="Library chat"
              value={settings?.ai.defaults.libraryChat ?? {}}
              models={codexModels?.models ?? []}
              modelsLoading={codexModelsLoading}
              acpProviderOptions={acpChatProviderOptions}
              onChange={(p) => {
                void patch({ ai: { defaults: { libraryChat: p } } });
              }}
            />
            <AiSurfaceDefaultControl
              surface="sizzleChat"
              label="Sizzle Reel chat"
              value={settings?.ai.defaults.sizzleChat ?? {}}
              models={codexModels?.models ?? []}
              modelsLoading={codexModelsLoading}
              acpProviderOptions={acpChatProviderOptions}
              onChange={(p) => {
                void patch({ ai: { defaults: { sizzleChat: p } } });
              }}
            />
            <AiSurfaceDefaultControl
              surface="enrichment"
              label="Enrichment (captions, OCR, tags)"
              value={settings?.ai.defaults.enrichment ?? {}}
              models={codexModels?.models ?? []}
              modelsLoading={codexModelsLoading}
              imageOnly
              onChange={(p) => {
                void patch({ ai: { defaults: { enrichment: p } } });
              }}
            />
          </div>
        </Row>
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
          sub="Each profile is a separate Codex home (auth, config, sessions, state). Switch accounts, add a profile, or re-login. The selected profile is used for AI features."
          tag="default"
        >
          <CodexProfilesControl
            selectedProfile={settings?.codex.profile ?? ""}
            onSelect={(name) => {
              void patch({ codex: { profile: name } });
            }}
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

      <AcpAgentsCard
        discovery={acpDiscovery}
        loading={acpDiscoveryLoading}
        error={acpDiscoveryError}
        onRefresh={() => {
          void refreshAcpDiscovery();
        }}
        enabledAgentIds={settings?.ai.acp.enabledAgentIds ?? []}
        agents={settings?.ai.acp.agents}
        onToggle={(id, enabled) => {
          const current = settings?.ai.acp.enabledAgentIds ?? [];
          const next = enabled
            ? current.includes(id)
              ? current
              : [...current, id]
            : current.filter((existing) => existing !== id);
          void patch({ ai: { acp: { enabledAgentIds: next } } });
        }}
        onPickInstance={(id, command) => {
          // Pin this instance; clear any override so the pick takes effect
          // (the resolver gives an override precedence over a pick).
          void patch({
            ai: { acp: { agents: { [id]: { selectedPath: command, overridePath: "" } } } }
          });
        }}
        onRevertAuto={(id) => {
          void patch({
            ai: { acp: { agents: { [id]: { selectedPath: "", overridePath: "" } } } }
          });
        }}
        onSetOverride={(id, path) => {
          void patch({ ai: { acp: { agents: { [id]: { overridePath: path } } } } });
        }}
        onClearOverride={(id) => {
          void patch({ ai: { acp: { agents: { [id]: { overridePath: "" } } } } });
        }}
      />

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

// ---- Codex auth-profile management ------------------------------------
//
// Lists the user's Codex auth profiles (each a CODEX_HOME), shows each
// profile's signed-in status + account email, and lets the user pick the
// active profile, create a new one, and re-login. All backed by the kit via
// the `codex:profiles:*` command-bus verbs. Selecting a profile is a settings
// patch to `codex.profile` (handled by the parent via `onSelect`).

type LoginState =
  | { phase: "idle" }
  | { phase: "waiting"; profile: string }
  | { phase: "done"; profile: string; message: string }
  | { phase: "error"; profile: string; message: string };

type CodexProfilesControlProps = {
  selectedProfile: string;
  onSelect: (name: string) => void;
};

function profileStatusBadge(profile: DesktopCodexAuthProfile): {
  label: string;
  className: string;
} {
  switch (profile.status) {
    case "authenticated":
      return { label: "Signed in", className: "is-using" };
    case "unauthenticated":
      return { label: "Not signed in", className: "is-accent" };
    case "failed":
      return { label: "Check failed", className: "is-accent" };
  }
}

function profileSubLine(profile: DesktopCodexAuthProfile): string {
  if (profile.status === "authenticated") {
    const account =
      profile.email !== undefined && profile.email.length > 0
        ? profile.email
        : "signed in";
    return profile.planType !== undefined && profile.planType.length > 0
      ? `${account} · ${profile.planType}`
      : account;
  }
  if (profile.status === "unauthenticated") {
    return "Not signed in — click Re-login to sign in through Codex.";
  }
  return "Could not confirm sign-in status for this profile.";
}

function CodexProfilesControl({
  selectedProfile,
  onSelect
}: CodexProfilesControlProps): ReactElement {
  const [list, setList] = useState<DesktopCodexAuthProfileList | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [creating, setCreating] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState<boolean>(false);
  const [loginState, setLoginState] = useState<LoginState>({ phase: "idle" });

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await dispatch("codex:profiles:list", {});
    if (result.ok) setList(result.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected =
    list?.profiles.find((p) => p.name === selectedProfile) ??
    list?.profiles.find((p) => p.selected) ??
    null;

  const onLogin = useCallback(
    async (name: string): Promise<void> => {
      setLoginState({ phase: "waiting", profile: name });
      const result = await dispatch("codex:profiles:login", { name });
      if (!result.ok) {
        setLoginState({
          phase: "error",
          profile: name,
          message: result.error.message
        });
        return;
      }
      const value = result.value;
      const message =
        value.authenticated === true
          ? "Signed in."
          : value.loginUrl !== undefined
            ? "Opened the sign-in page in your browser. Finish signing in there, then Refresh."
            : "Started Codex login. Finish in your browser, then Refresh.";
      setLoginState({ phase: "done", profile: name, message });
      void refresh();
    },
    [refresh]
  );

  const onCreate = useCallback(async (): Promise<void> => {
    setCreateBusy(true);
    setCreateError(null);
    const result = await dispatch("codex:profiles:create", { name: newName });
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(result.error.message);
      return;
    }
    const created = result.value;
    setCreating(false);
    setNewName("");
    onSelect(created.name);
    await refresh();
    // A brand-new profile has no auth — prompt the login immediately.
    void onLogin(created.name);
  }, [newName, onSelect, refresh, onLogin]);

  return (
    <div className="pss__codex-profiles">
      <div className="pss__model-picker">
        <select
          className="pss__select"
          value={selectedProfile}
          disabled={loading || list === null || list.profiles.length === 0}
          onChange={(e) => {
            onSelect(e.target.value);
          }}
          aria-label="Active Codex auth profile"
        >
          {(list?.profiles ?? []).map((profile) => {
            const account =
              profile.status === "authenticated" &&
              profile.email !== undefined &&
              profile.email.length > 0
                ? ` — ${profile.email}`
                : profile.status === "authenticated"
                  ? " — signed in"
                  : " — no auth";
            return (
              <option key={profile.name} value={profile.name}>
                {profile.displayName}
                {account}
              </option>
            );
          })}
        </select>
        {loading ? (
          <span className="pss__model-loading">loading profiles</span>
        ) : null}
      </div>

      {selected !== null ? (
        <OptionRow
          icon={selected.name === "" ? "~" : "P"}
          primary={selected.displayName}
          sub={profileSubLine(selected)}
          using={true}
          badges={
            <span
              className={"pss__badge " + profileStatusBadge(selected).className}
            >
              {profileStatusBadge(selected).label}
            </span>
          }
          action={
            <button
              className="pss__opt-use"
              type="button"
              disabled={
                loginState.phase === "waiting" &&
                loginState.profile === selected.name
              }
              onClick={() => {
                void onLogin(selected.name);
              }}
            >
              {loginState.phase === "waiting" &&
              loginState.profile === selected.name
                ? "Signing in…"
                : "Re-login"}
            </button>
          }
        />
      ) : null}

      {loginState.phase === "done" && selected?.name === loginState.profile ? (
        <p className="pss__opt-sub">{loginState.message}</p>
      ) : null}
      {loginState.phase === "error" && selected?.name === loginState.profile ? (
        <p className="pss__opt-sub pss__opt-sub--error">{loginState.message}</p>
      ) : null}

      {list?.error !== undefined ? (
        <p className="pss__opt-sub pss__opt-sub--error">{list.error}</p>
      ) : null}

      {creating ? (
        <div className="pss__profile-create">
          <input
            className="pss__input"
            type="text"
            value={newName}
            placeholder="Profile name (e.g. work, personal)"
            maxLength={64}
            autoFocus
            onChange={(e) => {
              setNewName(e.target.value);
              setCreateError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim().length > 0 && !createBusy) {
                void onCreate();
              }
            }}
            aria-label="New profile name"
          />
          <button
            className="pss__opt-use"
            type="button"
            disabled={createBusy || newName.trim().length === 0}
            onClick={() => {
              void onCreate();
            }}
          >
            {createBusy ? "Creating…" : "Create"}
          </button>
          <button
            className="pss__top-btn"
            type="button"
            disabled={createBusy}
            onClick={() => {
              setCreating(false);
              setNewName("");
              setCreateError(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="pss__top-btn"
          type="button"
          onClick={() => {
            setCreating(true);
          }}
        >
          Create profile…
        </button>
      )}
      {createError !== null ? (
        <p className="pss__opt-sub pss__opt-sub--error">{createError}</p>
      ) : null}
    </div>
  );
}

// ---- ACP agents (discovery + enable) ----------------------------------
//
// Discovers which built-in ACP agents (Kimi / Qwen / Gemini / Grok) are
// installed via the `acp:discover` verb and lists each one with its install
// status. Installed agents get an enable checkbox that patches
// `ai.acp.enabledAgentIds`; not-installed agents show an install hint and a
// disabled checkbox. Read-only discovery — enabling an agent here does NOT
// wire it as a live chat backend (that's a separate next phase); it only
// records the user's opt-in.

type AcpAgentsCardProps = {
  discovery: AcpAgentDiscovery | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  enabledAgentIds: readonly string[];
  agents: Record<string, AcpAgentPreference> | undefined;
  onToggle: (id: string, enabled: boolean) => void;
  onPickInstance: (id: string, command: string) => void;
  onRevertAuto: (id: string) => void;
  onSetOverride: (id: string, path: string) => void;
  onClearOverride: (id: string) => void;
};

function AcpAgentsCard({
  discovery,
  loading,
  error,
  onRefresh,
  enabledAgentIds,
  agents,
  onToggle,
  onPickInstance,
  onRevertAuto,
  onSetOverride,
  onClearOverride
}: AcpAgentsCardProps): ReactElement {
  return (
    <Card
      eyebrow="PROVIDER"
      title="ACP agents"
      headerAction={
        <button
          className="pss__top-btn"
          type="button"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      <Row
        label="Installed agents"
        sub="ACP agent CLIs (Qwen, Gemini, Grok, Kimi) PwrSnap looks for on this machine. Enable the ones you want, pick which install to use when several are found, or set a manual path. Enabled agents become selectable as the chat backend in Per-surface defaults above."
        tag="config"
      >
        <AcpAgentList
          discovery={discovery}
          loading={loading}
          error={error}
          enabledAgentIds={enabledAgentIds}
          agents={agents}
          onToggle={onToggle}
          onPickInstance={onPickInstance}
          onRevertAuto={onRevertAuto}
          onSetOverride={onSetOverride}
          onClearOverride={onClearOverride}
        />
      </Row>
    </Card>
  );
}

type AcpAgentListProps = {
  discovery: AcpAgentDiscovery | null;
  loading: boolean;
  error: string | null;
  enabledAgentIds: readonly string[];
  agents: Record<string, AcpAgentPreference> | undefined;
  onToggle: (id: string, enabled: boolean) => void;
  onPickInstance: (id: string, command: string) => void;
  onRevertAuto: (id: string) => void;
  onSetOverride: (id: string, path: string) => void;
  onClearOverride: (id: string) => void;
};

function AcpAgentList({
  discovery,
  loading,
  error,
  enabledAgentIds,
  agents,
  onToggle,
  onPickInstance,
  onRevertAuto,
  onSetOverride,
  onClearOverride
}: AcpAgentListProps): ReactElement {
  if (discovery === null) {
    return (
      <div className="pss__opt">
        <span className="pss__opt-icon">{loading ? "…" : "!"}</span>
        <div className="pss__opt-text">
          <span className="pss__opt-primary">
            {loading ? "Discovering ACP agents…" : "ACP agent discovery unavailable"}
          </span>
          {error !== null ? (
            <span className="pss__opt-sub pss__opt-sub--error">{error}</span>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <>
      {error !== null ? (
        <p className="pss__opt-sub pss__opt-sub--error">{error}</p>
      ) : null}
      {discovery.agents.map((agent) => (
        <AcpAgentRow
          key={agent.id}
          agent={agent}
          enabled={enabledAgentIds.includes(agent.id)}
          pref={agents?.[agent.id]}
          onToggle={(next) => onToggle(agent.id, next)}
          onPickInstance={(command) => onPickInstance(agent.id, command)}
          onRevertAuto={() => onRevertAuto(agent.id)}
          onSetOverride={(path) => onSetOverride(agent.id, path)}
          onClearOverride={() => onClearOverride(agent.id)}
        />
      ))}
    </>
  );
}

function AcpAgentRow({
  agent,
  enabled,
  pref,
  onToggle,
  onPickInstance,
  onRevertAuto,
  onSetOverride,
  onClearOverride
}: {
  agent: AcpAgentDiscoveryEntry;
  enabled: boolean;
  pref: AcpAgentPreference | undefined;
  onToggle: (enabled: boolean) => void;
  onPickInstance: (command: string) => void;
  onRevertAuto: () => void;
  onSetOverride: (path: string) => void;
  onClearOverride: () => void;
}): ReactElement {
  const instanceCount = agent.instances.length;
  const isAuto =
    (pref?.selectedPath ?? "") === "" && (pref?.overridePath ?? "") === "";
  const summarySub = agent.installed
    ? `${instanceCount} install${instanceCount === 1 ? "" : "s"} found${
        agent.version !== undefined ? ` · active v${agent.version}` : ""
      }${isAuto ? " · auto" : " · pinned"}`
    : (agent.detail ?? "Not installed");

  return (
    <div className="pss__acp-agent">
      <OptionRow
        icon={agent.displayName.charAt(0).toUpperCase()}
        primary={agent.displayName}
        sub={summarySub}
        using={agent.installed && enabled}
        badges={
          agent.installed ? (
            enabled ? (
              <span className="pss__badge is-using">Enabled</span>
            ) : (
              <span className="pss__badge">Installed</span>
            )
          ) : (
            <span className="pss__badge">Not installed</span>
          )
        }
        action={
          <label className="pss__acp-toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!agent.installed}
              aria-label={`Enable ${agent.displayName}`}
              onChange={(e) => {
                onToggle(e.target.checked);
              }}
            />
            <span>Enable</span>
          </label>
        }
      />
      {agent.installed ? (
        <div className="pss__acp-detail">
          <div className="pss__acp-instances" role="list">
            {agent.instances.map((inst) => {
              const active = inst.command === agent.activeCommand;
              const meta = [
                inst.version !== undefined ? `v${inst.version}` : null,
                inst.source === "override"
                  ? "override"
                  : inst.source === "fallback"
                    ? "fallback path"
                    : "found"
              ]
                .filter((part): part is string => part !== null)
                .join(" · ");
              return (
                <button
                  key={inst.command}
                  type="button"
                  role="listitem"
                  className={"pss__acp-instance" + (active ? " is-active" : "")}
                  aria-pressed={active}
                  title={
                    active
                      ? "Active — click to revert to auto (use the first found)"
                      : "Click to always use this install"
                  }
                  onClick={() => {
                    if (active) onRevertAuto();
                    else onPickInstance(inst.command);
                  }}
                >
                  <span className="pss__acp-instance-path">{inst.command}</span>
                  <span className="pss__acp-instance-meta">{meta}</span>
                  {active ? <span className="pss__badge is-using">Using</span> : null}
                </button>
              );
            })}
          </div>
          <AcpOverrideInput
            overridePath={pref?.overridePath ?? ""}
            onSave={onSetOverride}
            onClear={onClearOverride}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Manual override-path input for one ACP agent — mirrors PwrAgnt's per-agent
 *  "Custom path" control. Save persists the path (it's probed on the next
 *  Refresh and, when valid, becomes the active instance); Clear reverts to
 *  discovery + any pinned instance. */
function AcpOverrideInput({
  overridePath,
  onSave,
  onClear
}: {
  overridePath: string;
  onSave: (path: string) => void;
  onClear: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<string>(overridePath);
  // Re-sync the draft when the persisted value changes out from under us
  // (e.g. a settings broadcast from another window).
  useEffect(() => {
    setDraft(overridePath);
  }, [overridePath]);
  const trimmed = draft.trim();
  const dirty = trimmed !== overridePath;
  return (
    <div className="pss__acp-override">
      <input
        className="pss__acp-override-input"
        type="text"
        value={draft}
        spellCheck={false}
        placeholder="Manual path — e.g. /Users/you/.nvm/versions/node/vXX/bin/qwen"
        aria-label="Manual override path"
        onChange={(e) => setDraft(e.currentTarget.value)}
      />
      <button
        className="pss__top-btn"
        type="button"
        disabled={!dirty || trimmed.length === 0}
        onClick={() => onSave(trimmed)}
      >
        Save
      </button>
      <button
        className="pss__top-btn is-muted"
        type="button"
        disabled={overridePath.length === 0 && draft.length === 0}
        onClick={() => {
          setDraft("");
          onClear();
        }}
      >
        Clear
      </button>
    </div>
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

export function SecretKeyControl({
  status,
  placeholder,
  onReplace,
  onClear
}: SecretKeyControlProps): ReactElement {
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  const [working, setWorking] = useState<boolean>(false);
  const configured = status?.configured === true;
  const canSubmit = draft.length > 0;

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
    if (!canSubmit) return;
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

  const startEditing = (): void => {
    if (working) return;
    setEditing(true);
  };

  return (
    <>
      <div className="pss__keyrow">
        <input
          className="pss__input"
          type="password"
          autoFocus={editing}
          readOnly={!editing}
          value={editing ? draft : configured ? "••••••••••••••••" : ""}
          placeholder={editing ? placeholder : configured ? "" : "Enter a key"}
          onFocus={startEditing}
          onClick={startEditing}
          onChange={(e) => {
            if (editing) setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (!editing) return;
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
          disabled={working || !canSubmit}
        >
          {configured ? "Replace" : "Set"}
        </button>
        {editing ? (
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
        ) : (
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

// ---- Per-surface default provider / model / reasoning -------------------

/** One option in a chat surface's provider dropdown — an enabled ACP agent.
 *  `value` is the persisted `acp:<id>` selector; `label` is the agent's
 *  discovery display name (falls back to its id before names resolve). */
type AcpChatProviderOption = { value: string; label: string };

type AiSurfaceDefaultControlProps = {
  surface: AiSurfaceId;
  label: string;
  value: AiSurfaceDefault;
  models: readonly CodexModelOption[];
  modelsLoading: boolean;
  /** Enrichment feeds images to Codex, so its model picker is filtered to
   *  text+image models (mirrors the caption picker). Chat surfaces show
   *  every non-hidden model. */
  imageOnly?: boolean;
  /** Enabled ACP agents, offered as backend choices in the provider
   *  dropdown. Present for CHAT surfaces (Library / Sizzle) only — when
   *  omitted the surface renders the enrichment-style free-text provider
   *  input (Codex modelProvider token). */
  acpProviderOptions?: readonly AcpChatProviderOption[];
  onChange: (patch: AiSurfaceDefaultPatch) => void;
};

/** Build the `<select>` model option list for a surface. Filters to
 *  non-hidden (and, for enrichment, image-capable) models, falling back
 *  to the static `CODEX_CAPTION_MODELS` when the live list is empty.
 *  Always includes the user's currently-pinned model even if it's no
 *  longer in the live list, so the select never silently drops a saved
 *  value. */
function surfaceModelOptions(
  models: readonly CodexModelOption[],
  imageOnly: boolean,
  pinned: string | undefined
): CodexModelOption[] {
  const filtered = models.filter((m) => {
    if (m.hidden) return false;
    if (!imageOnly) return true;
    return (
      m.inputModalities.includes("text") && m.inputModalities.includes("image")
    );
  });
  const base =
    filtered.length > 0
      ? filtered
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
  if (
    pinned !== undefined &&
    pinned.length > 0 &&
    !base.some((m) => m.id === pinned)
  ) {
    return [
      {
        id: pinned,
        model: pinned,
        displayName: pinned,
        description: "",
        hidden: false,
        inputModalities: ["text", "image"],
        defaultServiceTier: null,
        isDefault: false
      },
      ...base
    ];
  }
  return base;
}

function AiSurfaceDefaultControl({
  surface,
  label,
  value,
  models,
  modelsLoading,
  imageOnly,
  acpProviderOptions,
  onChange
}: AiSurfaceDefaultControlProps): ReactElement {
  const modelOptions = surfaceModelOptions(models, imageOnly === true, value.model);
  const providerValue = value.provider ?? "";
  const modelValue = value.model ?? "";
  const reasoningValue: AiReasoningEffort | "" = isAiReasoningEffort(value.reasoning)
    ? value.reasoning
    : "";
  // Chat surfaces (Library / Sizzle) select a BACKEND via a dropdown:
  // Codex + each enabled ACP agent. Enrichment is Codex-only, so it keeps
  // the free-text Codex `modelProvider` input.
  const isChatSurface = acpProviderOptions !== undefined;
  // "" and "codex" both mean the Codex backend; collapse onto "" so the
  // dropdown's Codex option matches whichever the user stored.
  const chatProviderValue = providerValue === "codex" ? "" : providerValue;
  // A persisted acp:<id> whose agent isn't currently in the enabled set
  // (toggled off, or discovery still loading) — keep it as a visible option
  // so the select never silently drops the saved value.
  const showsStaleAcp =
    isChatSurface &&
    chatProviderValue.startsWith("acp:") &&
    !(acpProviderOptions ?? []).some((o) => o.value === chatProviderValue);

  return (
    <div className="pss__ai-surface" data-surface={surface}>
      <div className="pss__ai-surface-l">
        <span className="pss__ai-surface-name">{label}</span>
      </div>
      <div className="pss__ai-surface-controls">
        <label className="pss__ai-surface-field">
          <span className="pss__ai-surface-field-label">Provider</span>
          {isChatSurface ? (
            <select
              className="pss__select pss__ai-surface-select"
              value={chatProviderValue}
              aria-label={`${label} default provider`}
              onChange={(e) => {
                // "" is the Codex default (the merge drops the key on "").
                onChange({ provider: e.target.value });
              }}
            >
              <option value="">Codex</option>
              {(acpProviderOptions ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {showsStaleAcp ? (
                <option value={chatProviderValue}>
                  {chatProviderValue.slice("acp:".length)} (not enabled)
                </option>
              ) : null}
            </select>
          ) : (
            <input
              className="pss__input pss__ai-surface-input"
              type="text"
              value={providerValue}
              placeholder="Codex default"
              aria-label={`${label} default provider`}
              onChange={(e) => {
                // Empty string clears (→ Codex default); the merge in the
                // settings service drops the key on "".
                onChange({ provider: e.target.value });
              }}
            />
          )}
        </label>
        <label className="pss__ai-surface-field">
          <span className="pss__ai-surface-field-label">Model</span>
          <select
            className="pss__select pss__ai-surface-select"
            value={modelValue}
            aria-label={`${label} default model`}
            onChange={(e) => {
              onChange({ model: e.target.value });
            }}
          >
            <option value="">Default</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLabel(m)}
              </option>
            ))}
          </select>
          {modelsLoading ? (
            <span className="pss__model-loading">loading models</span>
          ) : null}
        </label>
        <label className="pss__ai-surface-field">
          <span className="pss__ai-surface-field-label">Reasoning</span>
          <select
            className="pss__select pss__ai-surface-select"
            value={reasoningValue}
            aria-label={`${label} default reasoning effort`}
            onChange={(e) => {
              const next = e.target.value;
              // Empty string is the explicit clear sentinel — the service
              // merge drops the stored reasoning back to "Codex default".
              if (next === "") {
                onChange({ reasoning: "" });
                return;
              }
              if (!isAiReasoningEffort(next)) return;
              onChange({ reasoning: next });
            }}
          >
            <option value="">Default</option>
            {AI_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
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
