// The "Using" pill follows `snapshot.resolvedPath`, NOT
// `settings.codex.mode` — same logic stdio-transport uses to spawn
// Codex, so the renderer doesn't lie about which binary actually runs.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  AcpAgentDiscovery,
  AcpAgentDiscoveryEntry,
  AcpAgentModelOption,
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
  builtInAcpAgentDisplayName,
  CODEX_CAPTION_MODELS,
  DEFAULT_CODEX_CAPTION_MODEL,
  EVENT_CHANNELS,
  isAiReasoningEffort
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

/** Friendly model name for a picker option. Prefer the display name; only fall
 *  back to the raw id when there's no friendlier name. (We used to append the id
 *  in parens — "GPT-5.4-Mini (gpt-5.4-mini)" — which is just noise.) */
function modelLabel(model: CodexModelOption): string {
  return model.displayName.length > 0 ? model.displayName : model.id;
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


  // The chat-surface provider dropdown offers Codex + each ENABLED ACP agent
  // (value `acp:<id>`, labeled by its discovery display name). Built from the
  // enabled set intersected with discovery so an enabled-but-now-uninstalled
  // agent still shows by id (the factory falls back to Codex at runtime). An
  // agent enabled before discovery resolves is shown by its id until names
  // arrive.
  const enabledAgentIds = settings?.ai.acp.enabledAgentIds ?? [];
  const acpChatProviderOptions = buildAcpProviderOptions(enabledAgentIds, acpDiscovery);

  // ACP model lists, fetched lazily per agent (listing spawns the agent in ACP
  // mode — seconds — so the main process memoizes; here we cache per agent and
  // fetch only the agents a surface actually selects).
  const [acpModels, setAcpModels] = useState<Record<string, readonly AcpAgentModelOption[]>>({});
  const [acpModelsLoadingIds, setAcpModelsLoadingIds] = useState<readonly string[]>([]);
  const fetchAcpModels = useCallback(async (agentId: string, refresh = false): Promise<void> => {
    setAcpModelsLoadingIds((ids) => (ids.includes(agentId) ? ids : [...ids, agentId]));
    const result = await dispatch("acp:models", { agentId, refresh });
    setAcpModels((prev) => {
      if (result.ok) return { ...prev, [agentId]: result.value.models };
      // A FAILED probe must not blank a list we already have (e.g. a Refresh
      // that errored shouldn't wipe the cached models). Only fall back to `[]`
      // on the INITIAL load — so the picker resolves to "Default" instead of
      // sticking on "Loading…" — never on a refresh of an existing list.
      return agentId in prev ? prev : { ...prev, [agentId]: [] };
    });
    setAcpModelsLoadingIds((ids) => ids.filter((id) => id !== agentId));
  }, []);
  const agentIdFromProvider = (provider: string | undefined): string | null =>
    provider !== undefined && provider.startsWith("acp:")
      ? provider.slice("acp:".length)
      : null;
  const acpAgentIdsInUse = [
    settings?.ai.defaults.enrichment.provider,
    settings?.ai.defaults.libraryChat.provider,
    settings?.ai.defaults.sizzleChat.provider
  ]
    .map(agentIdFromProvider)
    .filter((id): id is string => id !== null);
  const acpAgentIdsKey = [...new Set(acpAgentIdsInUse)].sort().join(",");
  useEffect(() => {
    for (const id of acpAgentIdsKey.length > 0 ? acpAgentIdsKey.split(",") : []) {
      if (acpModels[id] === undefined && !acpModelsLoadingIds.includes(id)) {
        void fetchAcpModels(id);
      }
    }
  }, [acpAgentIdsKey, acpModels, acpModelsLoadingIds, fetchAcpModels]);

  const onRefresh = async (): Promise<void> => {
    setSnapshotLoading(true);
    setCodexModelsLoading(true);
    // Force-refresh the in-use ACP agents' model lists too (re-spawns them),
    // alongside the Codex snapshot + models. Normal opens read the persisted
    // ACP model cache (instant); Refresh is the explicit re-discover.
    const acpInUse = acpAgentIdsKey.length > 0 ? acpAgentIdsKey.split(",") : [];
    const [snap] = await Promise.all([
      refreshCodex(true),
      refreshCodexModels(),
      ...acpInUse.map((id) => fetchAcpModels(id, true))
    ]);
    setSnapshot(snap);
    setSnapshotLoading(false);
  };
  const acpModelsForProvider = (
    provider: string | undefined
  ): readonly AcpAgentModelOption[] | undefined => {
    const id = agentIdFromProvider(provider);
    return id === null ? undefined : acpModels[id];
  };
  const acpModelsLoadingForProvider = (provider: string | undefined): boolean => {
    const id = agentIdFromProvider(provider);
    return id !== null && acpModelsLoadingIds.includes(id);
  };

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Providers</div>
          <h1 className="pss__main-title">Backends &amp; credentials</h1>
          <p className="pss__main-sub">
            PwrSnap delegates AI work to your local Codex install or an enabled
            ACP agent. Captions, tag suggestions, and OCR all ride on a single
            enrichment turn per capture. Semantic search vectorization is
            planned.
          </p>
        </div>
      </div>

      <Card eyebrow="ROLES" title="Job routing">
        <p className="pss__role-intro">
          Route each AI job to a backend — Codex or an enabled ACP agent — and
          pick its model + reasoning effort. Leave a field on Default to let the
          backend choose. Applies to new runs / threads; existing conversations
          aren&apos;t rewritten.
        </p>
        <AiSurfaceDefaultControl
          surface="enrichment"
          name="Capture captions, tags & OCR"
          sub="Caption, tags + extracted text — one turn per capture, shown in Library detail + Float-Over"
          value={settings?.ai.defaults.enrichment ?? {}}
          models={codexModels?.models ?? []}
          modelsLoading={codexModelsLoading}
          acpProviderOptions={acpChatProviderOptions}
          acpModelOptions={acpModelsForProvider(settings?.ai.defaults.enrichment.provider)}
          acpModelsLoading={acpModelsLoadingForProvider(settings?.ai.defaults.enrichment.provider)}
          onChange={(p) => {
            void patch({ ai: { defaults: { enrichment: p } } });
          }}
        />
        <JobRoutingRow
          name="Semantic search vectorization"
          sub="Will embed capture metadata + OCR text for ⌘K search"
          provider="—"
          model="Coming soon"
          dim
        />
        <AiSurfaceDefaultControl
          surface="libraryChat"
          name="Library chat"
          sub="Ask the agent about a snap"
          value={settings?.ai.defaults.libraryChat ?? {}}
          models={codexModels?.models ?? []}
          modelsLoading={codexModelsLoading}
          acpProviderOptions={acpChatProviderOptions}
          acpModelOptions={acpModelsForProvider(settings?.ai.defaults.libraryChat.provider)}
          acpModelsLoading={acpModelsLoadingForProvider(settings?.ai.defaults.libraryChat.provider)}
          onChange={(p) => {
            void patch({ ai: { defaults: { libraryChat: p } } });
          }}
        />
        <AiSurfaceDefaultControl
          surface="sizzleChat"
          name="Sizzle Reel chat"
          sub="Composer agent for the reel"
          value={settings?.ai.defaults.sizzleChat ?? {}}
          models={codexModels?.models ?? []}
          modelsLoading={codexModelsLoading}
          acpProviderOptions={acpChatProviderOptions}
          acpModelOptions={acpModelsForProvider(settings?.ai.defaults.sizzleChat.provider)}
          acpModelsLoading={acpModelsLoadingForProvider(settings?.ai.defaults.sizzleChat.provider)}
          onChange={(p) => {
            void patch({ ai: { defaults: { sizzleChat: p } } });
          }}
        />
      </Card>

      <Card eyebrow="SAFETY" title="Capture enrichment">
        <Row
          label="AI enrichment"
          sub="Controls caption, OCR, filename, and tag generation for captures."
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
          sub="Observed AI runs from this app (Codex and local ACP agents). Cost is a public list-price equivalent, not an account invoice."
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
          sub="Detected on this machine. The resolved binary is highlighted; the test below spawns it with --version to confirm it runs."
          tag="config"
        >
          <CodexCandidates
            snapshot={snapshot}
            loading={snapshotLoading}
            onPin={(path) => {
              void patch({ codex: { mode: "pinned", pinnedPath: path } });
            }}
          />
          {snapshot !== null && snapshot.resolvedPath !== null ? (
            <div className="pss__test pss__test--attached">
              <span className="pss__test-icon" aria-hidden="true">
                ›_
              </span>
              <div className="pss__test-l">
                <span className="pss__test-cmd">
                  {codexTest?.account ?? "Connection test"}
                </span>
                <span className="pss__test-sub">
                  {codexTestSubLine(codexTest, codexTesting)}
                </span>
              </div>
              <div className="pss__test-r">
                <span
                  className={
                    "pss__badge" +
                    (codexTest ? ` ${codexTestBadgeClass(codexTest)}` : "")
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
          ) : null}
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
      </Card>

      <AcpAgentsCard
        discovery={acpDiscovery}
        loading={acpDiscoveryLoading}
        error={acpDiscoveryError}
        onRefresh={() => {
          // Re-discover installs AND re-probe the in-use agents' model lists, so
          // a stale cache (e.g. one captured before the agent reported its
          // default model) is refreshed and the "Default (…)" annotation +
          // model options update. Previously this only ran acp:discover, so
          // clicking Refresh here never updated models.
          void refreshAcpDiscovery();
          for (const id of acpAgentIdsKey.length > 0 ? acpAgentIdsKey.split(",") : []) {
            void fetchAcpModels(id, true);
          }
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
            ? `${summary.usageUnavailableCount} run${summary.usageUnavailableCount === 1 ? "" : "s"} missing token usage. `
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
  // The path gets its own full-width line (never squeezed by the badges, which
  // is what chopped `/Applications/Code…` before). Source/version/status drop
  // to a muted meta line below — the same shape as the ACP installed-agent card.
  return (
    <div className={"pss__cand" + (using ? " is-using" : "")}>
      <span className="pss__cand-icon" aria-hidden="true">
        C
      </span>
      <div className="pss__cand-body">
        <span className="pss__cand-path" title={candidate.path}>
          {candidate.path}
        </span>
        <span className="pss__cand-meta">
          <span>{candidate.source}</span>
          {candidate.version !== null ? (
            <>
              <span className="pss__cand-sep" aria-hidden="true">
                ·
              </span>
              <span>v{candidate.version}</span>
            </>
          ) : null}
          <span className="pss__cand-sep" aria-hidden="true">
            ·
          </span>
          <span className={candidate.available ? undefined : "pss__cand-unavail"}>
            {candidate.available ? "available" : "unavailable"}
          </span>
        </span>
      </div>
      <div className="pss__cand-action">
        {using ? (
          <span className="pss__badge is-using">Using</span>
        ) : (
          <button
            className="pss__opt-use"
            type="button"
            onClick={onPin}
            disabled={!candidate.available}
          >
            Use
          </button>
        )}
      </div>
    </div>
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
export type AcpChatProviderOption = { value: string; label: string };

/** Build the chat-surface provider dropdown options from the enabled agent ids.
 *  The label comes from discovery's display name once it resolves, else the
 *  built-in friendly name — NEVER the raw id, so the dropdown never flashes
 *  "gemini" before becoming "Gemini CLI" while discovery loads. */
export function buildAcpProviderOptions(
  enabledAgentIds: readonly string[],
  discovery: AcpAgentDiscovery | null
): AcpChatProviderOption[] {
  return enabledAgentIds.map((id) => {
    const entry = discovery?.agents.find((a) => a.id === id);
    return { value: `acp:${id}`, label: entry?.displayName ?? builtInAcpAgentDisplayName(id) };
  });
}

export type AiSurfaceDefaultControlProps = {
  surface: AiSurfaceId;
  /** Job name shown as the row heading (e.g. "Library chat"). */
  name: string;
  /** One-line description under the name. */
  sub: string;
  value: AiSurfaceDefault;
  models: readonly CodexModelOption[];
  modelsLoading: boolean;
  /** Backend choices offered in the provider dropdown (enabled ACP agents).
   *  Always provided now — pass `[]` for a Codex-only surface. */
  acpProviderOptions: readonly AcpChatProviderOption[];
  /** When this surface's provider is an ACP agent, its advertised models —
   *  so the Model picker shows e.g. Gemini's models, not Codex's. Undefined
   *  while loading / when the provider is Codex. */
  acpModelOptions?: readonly AcpAgentModelOption[] | undefined;
  /** True while the ACP model list for this surface's provider is loading. */
  acpModelsLoading?: boolean | undefined;
  onChange: (patch: AiSurfaceDefaultPatch) => void;
};

/** Build the `<select>` model option list for the Codex backend. Filters to
 *  non-hidden, image-capable models, falling back to the static
 *  `CODEX_CAPTION_MODELS` when the live list is empty.
 *
 *  EVERY PwrSnap AI surface feeds the model a capture image — enrichment/OCR
 *  directly, and even "ask about this snap" / the Sizzle composer carry the
 *  visual. A text-only model (e.g. Codex Spark) can't do any of it, so it's
 *  hidden everywhere, not just on enrichment.
 *
 *  Deliberately does NOT inject the user's stored model when it's absent from
 *  the list: a stale id that isn't a real Codex model (e.g. a Gemini id left
 *  behind after switching providers) must NOT stay selectable — the picker
 *  shows Default instead, forcing a model that's actually valid for Codex. */
function surfaceModelOptions(models: readonly CodexModelOption[]): CodexModelOption[] {
  const filtered = models.filter((m) => {
    if (m.hidden) return false;
    return m.inputModalities.includes("text") && m.inputModalities.includes("image");
  });
  if (filtered.length > 0) return filtered;
  return CODEX_CAPTION_MODELS.map((id) => ({
    id,
    model: id,
    displayName: id,
    description: "",
    hidden: false,
    inputModalities: ["text", "image"] as Array<"text" | "image">,
    defaultServiceTier: null,
    isDefault: id === DEFAULT_CODEX_CAPTION_MODEL
  }));
}

export function AiSurfaceDefaultControl({
  surface,
  name,
  sub,
  value,
  models,
  modelsLoading,
  acpProviderOptions,
  acpModelOptions,
  acpModelsLoading,
  onChange
}: AiSurfaceDefaultControlProps): ReactElement {
  const providerValue = value.provider ?? "";
  const modelValue = value.model ?? "";
  const reasoningValue: AiReasoningEffort | "" = isAiReasoningEffort(value.reasoning)
    ? value.reasoning
    : "";
  // `provider` is a BACKEND selector for every surface: Codex + each enabled
  // ACP agent. "" and "codex" both mean Codex; collapse onto "" so the
  // dropdown's Codex option matches whichever the user stored.
  const chatProviderValue = providerValue === "codex" ? "" : providerValue;
  // Model choices follow the selected BACKEND: Codex models for Codex, the ACP
  // agent's advertised models for an acp:<id> provider.
  const isAcpProvider = chatProviderValue.startsWith("acp:");
  // The ACP model list spawns the agent to fetch — disable the picker (showing
  // "Loading…") until it arrives, instead of a stale Codex value next to
  // "loading". Codex models load fast and the stored value is valid, so the
  // Codex picker is never disabled (it just shows the stored model meanwhile).
  void modelsLoading;
  const modelLoading =
    isAcpProvider && (acpModelsLoading === true || acpModelOptions === undefined);
  // Mark the backend's PROTOCOL-CONFIRMED default model (isDefault) with a
  // "(default)" suffix so the user can see which one "Default" resolves to —
  // for BOTH Codex and ACP. Do NOT guess: if no model carries isDefault (e.g. a
  // cached ACP list captured before the agent reported a currentModelId), leave
  // it undefined and show a plain "Default". Guessing the first-listed model
  // actively misleads — Grok lists "Composer 2.5" first but its real default is
  // "Grok Build", so a guess would claim Default → Composer while a run uses
  // Grok Build.
  const defaultModelName: string | undefined = isAcpProvider
    ? (acpModelOptions ?? []).find((m) => m.isDefault)?.label
    : (() => {
        const def = surfaceModelOptions(models).find((m) => m.isDefault);
        return def !== undefined ? modelLabel(def) : undefined;
      })();
  const modelChoices: Array<{ id: string; label: string }> = isAcpProvider
    ? (acpModelOptions ?? []).map((m) => ({
        id: m.id,
        label: m.isDefault === true ? `${m.label} (default)` : m.label
      }))
    : surfaceModelOptions(models).map((m) => ({
        id: m.id,
        label: m.isDefault === true ? `${modelLabel(m)} (default)` : modelLabel(m)
      }));
  // A stored model that isn't in the selected backend's list (e.g. a Gemini id
  // left on a now-Codex surface) is NOT kept as a phantom option — the select
  // falls back to "Default", forcing a model that's actually valid for the
  // provider. Same rule for Codex and ACP.
  const modelInChoices = modelChoices.some((m) => m.id === modelValue);
  const selectModelValue = modelInChoices ? modelValue : "";
  // Normalize a stale/invalid ACP model to Default ("") once the agent's list
  // has loaded. Without this, a Codex id left under an ACP provider (e.g.
  // "gpt-5.4-mini" after switching to Grok) lingers in settings: it DISPLAYS as
  // Default but is still sent to the agent every run (the kit logs "model
  // selection not applied" and falls back), and the run record's model is
  // wrong. Reset to "" so stored == displayed == what runs. Only when the list
  // is non-empty (so we can actually judge validity) and the value is a real
  // non-empty id that isn't in it. Codex isn't normalized — its picker already
  // shows Default for an unknown id and the App Server resolves server-side.
  const staleAcpModel =
    isAcpProvider && !modelLoading && modelChoices.length > 0 && modelValue !== "" && !modelInChoices;
  const normalizedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!staleAcpModel) return;
    const key = `${chatProviderValue}|${modelValue}`;
    if (normalizedKeyRef.current === key) return;
    normalizedKeyRef.current = key;
    onChange({ model: "" });
  }, [staleAcpModel, chatProviderValue, modelValue, onChange]);
  // "Default" means "let the backend pick its own default model" (runtime sends
  // null). When we know the backend's default model, annotate the entry —
  // "Default (GPT-5.4-Mini)" / "Default (Grok Build)" — instead of leaving it a
  // mystery. Falls back to a plain "Default" when the default is unknown.
  const defaultOptionLabel =
    defaultModelName !== undefined ? `Default (${defaultModelName})` : "Default";
  // A persisted acp:<id> whose agent isn't currently in the enabled set
  // (toggled off, or discovery still loading) — keep it as a visible option
  // so the select never silently drops the saved value.
  const showsStaleAcp =
    chatProviderValue.startsWith("acp:") &&
    !acpProviderOptions.some((o) => o.value === chatProviderValue);

  return (
    <div className="pss__role pss__role--routable" data-surface={surface}>
      <div className="pss__role-head">
        <span className="pss__role-icon" aria-hidden="true">
          ◆
        </span>
        <div className="pss__role-l">
          <span className="pss__role-name">{name}</span>
          <span className="pss__role-sub">{sub}</span>
        </div>
      </div>
      <div className="pss__role-controls">
        <label className="pss__ai-surface-field">
          <span className="pss__ai-surface-field-label">Provider</span>
          <select
            className="pss__select pss__ai-surface-select"
            value={chatProviderValue}
            aria-label={`${name} provider`}
            onChange={(e) => {
              // "" is the Codex default (the merge drops the key on "").
              // RESET the model on a backend switch — a model id is meaningful
              // only for the backend that advertised it (a Gemini model can't
              // run on Codex), so fall back to Default rather than carrying a
              // stale value across providers.
              onChange({ provider: e.target.value, model: "" });
            }}
          >
            <option value="">Codex</option>
            {acpProviderOptions.map((o) => (
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
        </label>
        <label className="pss__ai-surface-field">
          <span className="pss__ai-surface-field-label">Model</span>
          <select
            className="pss__select pss__ai-surface-select"
            value={modelLoading ? "__loading__" : selectModelValue}
            aria-label={`${name} model`}
            disabled={modelLoading}
            onChange={(e) => {
              onChange({ model: e.target.value });
            }}
          >
            {modelLoading ? (
              <option value="__loading__">Loading…</option>
            ) : (
              <>
                {/* "Default" = let the backend choose its own default model. For
                    ACP it's annotated with the agent's actual default (e.g.
                    "Default (kimi-k2)") so it's not a mystery; for Codex it's
                    resolved server-side. */}
                <option value="">{defaultOptionLabel}</option>
                {modelChoices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
        {/* Reasoning effort (low/medium/high) is a Codex concept; ACP agents
            don't expose it (they have execution "modes", a separate idea), so
            the field is hidden for an ACP provider. The stored value is left
            untouched so it returns if the user switches back to Codex. */}
        {isAcpProvider ? null : (
          <label className="pss__ai-surface-field">
            <span className="pss__ai-surface-field-label">Reasoning</span>
            <select
              className="pss__select pss__ai-surface-select"
              value={reasoningValue}
              aria-label={`${name} reasoning effort`}
              onChange={(e) => {
                const next = e.target.value;
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
        )}
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
