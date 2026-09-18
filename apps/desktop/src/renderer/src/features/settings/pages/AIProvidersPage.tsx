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
  DesktopCodexDiscoverySnapshot,
  Settings,
  SettingsPatch
} from "@pwrsnap/shared";
import {
  AI_REASONING_EFFORTS,
  builtInAcpAgentDisplayName,
  CODEX_CAPTION_MODELS,
  DEFAULT_CODEX_CAPTION_MODEL,
  DEFAULT_ENRICHMENT_REASONING_EFFORT,
  EVENT_CHANNELS,
  executablePathExample,
  isAiReasoningEffort,
  normalizeManualExecutablePath
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import {
  Card,
  OptionRow,
  Row,
  SegmentedControl,
  type SegmentOption
} from "../components";
import { AiConsentDialog } from "../../shared/AiConsentDialog";
import { useAiProvidersContext } from "../AiProvidersContext";
import {
  AI_SURFACE_LABELS,
  routedSurfaces,
  type AiProviderStatus,
  type AiProviderSub,
  type AiProviderTone
} from "../ai-provider-status";
import { useSettingsContext } from "../SettingsContext";
import { setActivePage } from "../useActivePage";
import { ChatSettingsCard } from "./ChatSettingsCard";

const CODEX_MODE_OPTIONS: readonly SegmentOption<"auto" | "pinned">[] = [
  { id: "auto", label: "Auto Discovery — Use Newest" },
  { id: "pinned", label: "Specified Path" }
];

export function buildAcpOverridePatch(
  currentEnabledAgentIds: readonly string[],
  id: string,
  path: string,
  enable: boolean
): SettingsPatch {
  const enabledAgentIds =
    enable && !currentEnabledAgentIds.includes(id)
      ? [...currentEnabledAgentIds, id]
      : [...currentEnabledAgentIds];
  return {
    ai: {
      acp: {
        ...(enable ? { enabledAgentIds } : {}),
        agents: { [id]: { overridePath: path } }
      }
    }
  };
}

/** Friendly model name for a picker option. Prefer the display name; only fall
 *  back to the raw id when there's no friendlier name. (We used to append the id
 *  in parens — "GPT-5.4-Mini (gpt-5.4-mini)" — which is just noise.) */
function modelLabel(model: CodexModelOption): string {
  return model.displayName.length > 0 ? model.displayName : model.id;
}

type AIProvidersPageProps = {
  /** Provider screen to show — `codex`, an ACP agent id, or `openai` —
   *  or `null` for the hub. Validated by the router before it gets here. */
  sub: string | null;
};

export function AIProvidersPage({ sub }: AIProvidersPageProps): ReactElement {
  const {
    settings,
    secrets,
    patch,
    testCodex,
    replaceSecret,
    clearSecret
  } = useSettingsContext();
  // Discovery + ACP model results live in the provider so the sidebar's
  // status dots read the same answer this page renders.
  const {
    request,
    codexSnapshot: snapshot,
    codexSnapshotLoading: snapshotLoading,
    refreshCodexSnapshot,
    acpDiscovery,
    acpDiscoveryLoading,
    acpDiscoveryError,
    refreshAcpDiscovery,
    acpModels,
    acpModelErrors,
    acpModelsLoadingIds,
    fetchAcpModels,
    statuses
  } = useAiProvidersContext();
  const [codexTest, setCodexTest] = useState<CodexTestResult | null>(null);
  const [codexTesting, setCodexTesting] = useState<boolean>(false);
  const [budgetStatus, setBudgetStatus] = useState<AiEnrichmentBudgetStatus | null>(null);
  const [usageSummary, setUsageSummary] = useState<AiUsageSummary | null>(null);
  const [usageRuns, setUsageRuns] = useState<AiUsageRunsPage | null>(null);
  const [usageLoading, setUsageLoading] = useState<boolean>(true);
  const [codexModels, setCodexModels] = useState<CodexModelList | null>(null);
  const [codexModelsLoading, setCodexModelsLoading] = useState<boolean>(true);
  const [aiConsentDialogOpen, setAiConsentDialogOpen] = useState<boolean>(false);

  useEffect(() => {
    request();
  }, [request]);

  const refreshBudgetStatus = useCallback(async (): Promise<void> => {
    const result = await dispatch("codex:budgetStatus", {});
    if (result.ok) setBudgetStatus(result.value);
  }, []);

  const setAiEnrichmentEnabled = useCallback(
    async (enabled: boolean, consentAcceptedAt?: string): Promise<void> => {
      await patch({
        ai: {
          enabled,
          budgetSafetyDisabledAt: null,
          ...(consentAcceptedAt !== undefined ? { consentAcceptedAt } : {})
        }
      });
      await refreshBudgetStatus();
    },
    [patch, refreshBudgetStatus]
  );

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

  // The model list waits for the first Codex discovery read to settle, as it
  // always has — listing models resolves the same binary, so it follows
  // discovery rather than racing it. Once per mount; Refresh re-lists.
  const codexModelsRequested = useRef<boolean>(false);
  useEffect(() => {
    if (snapshotLoading || codexModelsRequested.current) return;
    codexModelsRequested.current = true;
    void refreshCodexModels();
  }, [snapshotLoading, refreshCodexModels]);

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
  const enabledAgentIdSet = new Set(enabledAgentIds);
  const acpChatProviderOptions = buildAcpProviderOptions(enabledAgentIds, acpDiscovery);

  // ACP model lists, fetched lazily per in-use agent. The first Settings pass
  // bypasses the persisted cache so this doubles as a runtime availability/auth
  // probe; otherwise a stale model cache can make a logged-out or retired CLI
  // look selectable until the next capture fails. The results are held by the
  // provider, so a failure found here also turns the agent's sidebar dot.
  const agentIdFromProvider = (provider: string | undefined): string | null =>
    provider !== undefined && provider.startsWith("acp:")
      ? provider.slice("acp:".length)
      : null;
  const acpAgentIdsInUse = enabledAcpAgentIdsForModelProbes(settings);
  const acpAgentIdsKey = [...new Set(acpAgentIdsInUse)].sort().join(",");
  useEffect(() => {
    for (const id of acpAgentIdsKey.length > 0 ? acpAgentIdsKey.split(",") : []) {
      if (acpModels[id] === undefined && !acpModelsLoadingIds.includes(id)) {
        void fetchAcpModels(id, true);
      }
    }
  }, [acpAgentIdsKey, acpModels, acpModelsLoadingIds, fetchAcpModels]);

  const onRefresh = async (): Promise<void> => {
    setCodexModelsLoading(true);
    // Force-refresh the in-use ACP agents' model lists too (re-spawns them),
    // alongside the Codex snapshot + models. Normal opens read the persisted
    // ACP model cache (instant); Refresh is the explicit re-discover.
    const acpInUse = acpAgentIdsKey.length > 0 ? acpAgentIdsKey.split(",") : [];
    await Promise.all([
      refreshCodexSnapshot(true),
      refreshCodexModels(),
      ...acpInUse.map((id) => fetchAcpModels(id, true))
    ]);
  };
  const onRefreshAcp = (): void => {
    // Re-discover installs AND re-probe the in-use agents' model lists, so
    // a stale cache (e.g. one captured before the agent reported its
    // default model) is refreshed and the "Default (…)" annotation +
    // model options update. Previously this only ran acp:discover, so
    // clicking Refresh here never updated models.
    void refreshAcpDiscovery(true);
    for (const id of acpAgentIdsKey.length > 0 ? acpAgentIdsKey.split(",") : []) {
      void fetchAcpModels(id, true);
    }
  };
  const acpModelsForProvider = (
    provider: string | undefined
  ): readonly AcpAgentModelOption[] | undefined => {
    const id = agentIdFromProvider(provider);
    if (id === null) return undefined;
    return enabledAgentIdSet.has(id) ? acpModels[id] : [];
  };
  const acpModelsLoadingForProvider = (provider: string | undefined): boolean => {
    const id = agentIdFromProvider(provider);
    return id !== null && enabledAgentIdSet.has(id) && acpModelsLoadingIds.includes(id);
  };
  const acpModelErrorForProvider = (provider: string | undefined): string | undefined => {
    const id = agentIdFromProvider(provider);
    return id === null || !enabledAgentIdSet.has(id) ? undefined : acpModelErrors[id];
  };

  // ---- Per-provider screens ---------------------------------------------
  // Each sidebar child opens one of these. They share the page's state, so
  // moving between them (or back to the hub) re-fetches nothing.

  const focused = sub !== null ? statuses.find((status) => status.sub === sub) : undefined;
  if (focused !== undefined) {
    const routed = routedSurfaces(settings, focused.sub);
    let body: ReactElement;
    let help: string;
    if (focused.sub === "codex") {
      help =
        "The Codex CLI that PwrSnap drives over App Server: which binary runs, which account it signs in with, and a connection test.";
      body = (
        <CodexCard
          settings={settings}
          snapshot={snapshot}
          snapshotLoading={snapshotLoading}
          codexTest={codexTest}
          codexTesting={codexTesting}
          onRefresh={() => {
            void onRefresh();
          }}
          onModeChange={(next) => {
            void patch({ codex: { mode: next } });
          }}
          onPin={async (path) => {
            await patch({ codex: { mode: "pinned", pinnedPath: path } });
            await onRefresh();
          }}
          onTest={() => {
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
          onSelectProfile={(name) => {
            void patch({ codex: { profile: name } });
          }}
        />
      );
    } else if (focused.sub === "openai") {
      help =
        "Used only for Sizzle Reels text-to-speech voiceover. Every other AI job runs through Codex or an ACP agent.";
      body = (
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
      );
    } else {
      const agentId = focused.sub;
      help =
        "An ACP agent CLI. Once enabled, it becomes a backend you can pick in Job routing.";
      body = (
        <AcpAgentCard
          agentId={agentId}
          title={focused.label}
          discovery={acpDiscovery}
          loading={acpDiscoveryLoading}
          error={acpDiscoveryError}
          onRefresh={onRefreshAcp}
          enabledAgentIds={enabledAgentIds}
          agents={settings?.ai.acp.agents}
          modelErrors={acpModelErrors}
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
          onSetOverride={async (id, path, enable) => {
            const current = settings?.ai.acp.enabledAgentIds ?? [];
            await patch(buildAcpOverridePatch(current, id, path, enable));
            if (enable) await refreshAcpDiscovery();
          }}
          onClearOverride={(id) => {
            void patch({ ai: { acp: { agents: { [id]: { overridePath: "" } } } } });
          }}
        />
      );
    }
    return (
      <>
        <div className="pss__main-hdr">
          <div className="pss__main-hdr-l">
            <div className="pss__main-eyebrow">AI Providers</div>
            <h1 className="pss__main-title">{focused.label}</h1>
            <p className="pss__main-sub">{help}</p>
          </div>
        </div>
        {focused.sub !== "openai" ? (
          <ProviderRoutingStrip
            routed={routed}
            onEdit={() => {
              setActivePage("ai");
            }}
          />
        ) : null}
        {body}
      </>
    );
  }

  // ---- Hub ----------------------------------------------------------------

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Providers</div>
          <h1 className="pss__main-title">Backends &amp; credentials</h1>
          <p className="pss__main-sub">
            PwrSnap delegates AI work to your local Codex install or an enabled
            ACP agent. Captions, tag suggestions, and OCR all ride on a single
            enrichment turn per capture.
          </p>
        </div>
      </div>

      <Card eyebrow="ROLES" title="Job routing">
        <p className="pss__role-intro">
          Route each AI job to a backend — Codex or an enabled ACP agent — and
          pick its model + reasoning effort. Leave a field on Default to use its
          managed choice. Applies to new runs / threads; existing conversations
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
          acpModelError={acpModelErrorForProvider(settings?.ai.defaults.enrichment.provider)}
          onChange={(p) => {
            void patch({ ai: { defaults: { enrichment: p } } });
          }}
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
          acpModelError={acpModelErrorForProvider(settings?.ai.defaults.libraryChat.provider)}
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
          acpModelError={acpModelErrorForProvider(settings?.ai.defaults.sizzleChat.provider)}
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
                  if (enabled && settings?.ai.consentAcceptedAt === null) {
                    setAiConsentDialogOpen(true);
                    return;
                  }
                  void setAiEnrichmentEnabled(enabled);
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

      <Card eyebrow="STATUS" title="Providers">
        <Row
          label="Backends"
          sub="Every backend PwrSnap can use, and whether it is ready. Each opens its own screen for paths, sign-in, and connection checks — the same list sits under AI Providers in the sidebar."
        >
          <ProviderIndex
            statuses={statuses}
            onOpen={(next) => {
              setActivePage("ai", next);
            }}
          />
        </Row>
      </Card>

      <ChatSettingsCard />
      {aiConsentDialogOpen ? (
        <AiConsentDialog
          onCancel={() => setAiConsentDialogOpen(false)}
          onAccept={() => {
            setAiConsentDialogOpen(false);
            void setAiEnrichmentEnabled(true, new Date().toISOString());
          }}
        />
      ) : null}
    </>
  );
}

type CodexCardProps = {
  settings: Settings | null;
  snapshot: DesktopCodexDiscoverySnapshot | null;
  snapshotLoading: boolean;
  codexTest: CodexTestResult | null;
  codexTesting: boolean;
  onRefresh: () => void;
  onModeChange: (mode: "auto" | "pinned") => void;
  onPin: (path: string) => Promise<void>;
  onTest: () => void;
  onSelectProfile: (name: string) => void;
};

function CodexCard({
  settings,
  snapshot,
  snapshotLoading,
  codexTest,
  codexTesting,
  onRefresh,
  onModeChange,
  onPin,
  onTest,
  onSelectProfile
}: CodexCardProps): ReactElement {
  return (
    <Card
      eyebrow="PROVIDER"
      title="Codex"
      headerAction={
        <button className="pss__top-btn" type="button" onClick={onRefresh}>
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
          onChange={onModeChange}
        />
      </Row>

      <Row
        label="Available paths"
        sub="Detected on this machine. The resolved binary is highlighted; the test below spawns it with --version to confirm it runs."
        tag="config"
      >
        <CodexCandidates snapshot={snapshot} loading={snapshotLoading} onPin={onPin} />
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
                onClick={onTest}
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
          onSelect={onSelectProfile}
        />
      </Row>
    </Card>
  );
}

// ---- Provider hub index + per-provider routing strip --------------------

function statusBadgeClass(tone: AiProviderTone | undefined): string {
  switch (tone) {
    case "ok":
      return " is-using";
    case "warn":
      return " is-warn";
    case "bad":
      return " is-danger";
    default:
      return "";
  }
}

/** One row per provider, same order and same status as the sidebar
 *  children — both render `statuses` from `AiProvidersContext`. */
export function ProviderIndex({
  statuses,
  onOpen
}: {
  statuses: readonly AiProviderStatus[];
  onOpen: (sub: AiProviderSub) => void;
}): ReactElement {
  return (
    <div className="pss__prov-index">
      {statuses.map((status) => (
        <button
          key={status.sub}
          type="button"
          className={"pss__prov-row" + (status.tone === "off" ? " is-off" : "")}
          onClick={() => onOpen(status.sub)}
        >
          <span
            aria-hidden="true"
            className={
              "pss__status-dot" +
              (status.tone !== undefined ? ` pss__status-dot--${status.tone}` : "")
            }
          />
          <span className="pss__prov-text">
            <span className="pss__prov-name">{status.label}</span>
            <span className="pss__prov-meta" title={status.meta}>
              {status.meta}
            </span>
          </span>
          <span className={"pss__badge" + statusBadgeClass(status.tone)}>{status.badge}</span>
          <span className="pss__prov-chev" aria-hidden="true">
            ›
          </span>
        </button>
      ))}
    </div>
  );
}

/** Ported from PwrAgnt's `ProviderDefaultsStrip`: a provider screen must not
 *  strand the operator away from the routing that decides whether it is used
 *  at all, so it leads with that answer and one action back to the editor. */
function ProviderRoutingStrip({
  routed,
  onEdit
}: {
  routed: readonly AiSurfaceId[];
  onEdit: () => void;
}): ReactElement {
  return (
    <div className="pss__prov-strip">
      <span className="pss__prov-strip-eyebrow">Job routing</span>
      <span className="pss__prov-strip-items">
        {routed.length > 0
          ? routed.map((surface) => AI_SURFACE_LABELS[surface]).join(" · ")
          : "No jobs routed here"}
      </span>
      <button className="pss__top-btn" type="button" onClick={onEdit}>
        Edit routing
      </button>
    </div>
  );
}

type CodexCandidatesProps = {
  snapshot: DesktopCodexDiscoverySnapshot | null;
  loading: boolean;
  onPin: (path: string) => Promise<void>;
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

export function CodexCandidates({
  snapshot,
  loading,
  onPin
}: CodexCandidatesProps): ReactElement {
  const [manualPath, setManualPath] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const platform = window.pwrsnapApi?.platform;
  const stillSearching = snapshot === null && loading;
  const trimmed = manualPath.trim();
  const persistPath = async (path: string, updateDraft: boolean): Promise<void> => {
    setSubmitting(true);
    setManualError(null);
    try {
      await onPin(path);
      if (updateDraft) setManualPath(path);
    } catch (cause) {
      setManualError(
        cause instanceof Error ? cause.message : "Could not save this Codex path."
      );
    } finally {
      setSubmitting(false);
    }
  };
  const submitManualPath = async (): Promise<void> => {
    const normalized = normalizeManualExecutablePath(platform, manualPath);
    if (!normalized.ok) {
      setManualError(normalized.error);
      return;
    }
    await persistPath(normalized.path, true);
  };
  const manualControl = stillSearching ? null : (
    <div className="pss__acp-override">
      <input
        className="pss__acp-override-input"
        type="text"
        value={manualPath}
        spellCheck={false}
        placeholder={`Manual path — e.g. ${executablePathExample(platform, "codex")}`}
        aria-label="Manual Codex path"
        aria-invalid={manualError !== null}
        onChange={(e) => {
          setManualPath(e.currentTarget.value);
          setManualError(null);
        }}
      />
      <button
        className="pss__top-btn"
        type="button"
        disabled={trimmed.length === 0 || submitting}
        onClick={() => {
          void submitManualPath();
        }}
      >
        {submitting ? "Saving…" : "Use path"}
      </button>
      {manualError !== null ? (
        <p className="pss__opt-sub pss__opt-sub--error" role="alert">
          {manualError}
        </p>
      ) : null}
    </div>
  );
  if (snapshot === null || snapshot.candidates.length === 0) {
    return (
      <>
        <div className="pss__opt">
          <span className="pss__opt-icon">{stillSearching ? "…" : "!"}</span>
          <div className="pss__opt-text">
            <span className="pss__opt-primary">
              {stillSearching
                ? "Discovering Codex binaries…"
                : "Codex not found on this machine"}
            </span>
            <span className="pss__opt-sub">
              {platform === "darwin" ? (
                <>
                  Install Codex Desktop or run <code>brew install codex</code>, then
                  Refresh — or pin the binary&apos;s full path below.
                </>
              ) : (
                <>
                  Install Codex Desktop or the Codex CLI, then Refresh — or pin
                  the binary&apos;s full path below.
                </>
              )}
            </span>
          </div>
        </div>
        {manualControl}
      </>
    );
  }
  return (
    <>
      {snapshot.candidates.map((c) => (
        <CandidateRow
          key={c.path}
          candidate={c}
          using={c.path === snapshot.resolvedPath}
          onPin={() => {
            void persistPath(c.path, false);
          }}
        />
      ))}
      {manualControl}
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
// installed via the `acp:discover` verb. Each agent has its own provider
// screen (a sidebar child under AI Providers) showing its install status.
// Installed agents get an enable checkbox that patches
// `ai.acp.enabledAgentIds`; not-installed agents show an install hint and a
// disabled checkbox. Enabling an agent makes it selectable in Job routing.

type AcpAgentCardProps = {
  agentId: string;
  title: string;
  discovery: AcpAgentDiscovery | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  enabledAgentIds: readonly string[];
  agents: Record<string, AcpAgentPreference> | undefined;
  modelErrors: Record<string, string | undefined>;
  onToggle: (id: string, enabled: boolean) => void;
  onPickInstance: (id: string, command: string) => void;
  onRevertAuto: (id: string) => void;
  onSetOverride: (id: string, path: string, enable: boolean) => Promise<void>;
  onClearOverride: (id: string) => void;
};

function AcpAgentCard({
  agentId,
  title,
  discovery,
  loading,
  error,
  onRefresh,
  enabledAgentIds,
  agents,
  modelErrors,
  onToggle,
  onPickInstance,
  onRevertAuto,
  onSetOverride,
  onClearOverride
}: AcpAgentCardProps): ReactElement {
  return (
    <Card
      eyebrow="PROVIDER"
      title={title}
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
        label="Install"
        sub="Where PwrSnap found this agent's CLI. Pick which install to use when several are found, or set a manual path."
        tag="config"
      >
        <AcpAgentList
          only={agentId}
          discovery={discovery}
          loading={loading}
          error={error}
          enabledAgentIds={enabledAgentIds}
          agents={agents}
          modelErrors={modelErrors}
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
  /** Render just this agent (a provider screen) instead of every agent. */
  only?: string;
  discovery: AcpAgentDiscovery | null;
  loading: boolean;
  error: string | null;
  enabledAgentIds: readonly string[];
  agents: Record<string, AcpAgentPreference> | undefined;
  modelErrors: Record<string, string | undefined>;
  onToggle: (id: string, enabled: boolean) => void;
  onPickInstance: (id: string, command: string) => void;
  onRevertAuto: (id: string) => void;
  onSetOverride: (id: string, path: string, enable: boolean) => Promise<void>;
  onClearOverride: (id: string) => void;
};

export function AcpAgentList({
  only,
  discovery,
  loading,
  error,
  enabledAgentIds,
  agents,
  modelErrors,
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
      {only !== undefined && !discovery.agents.some((agent) => agent.id === only) ? (
        <p className="pss__opt-sub">Discovery did not report this agent.</p>
      ) : null}
      {discovery.agents
        .filter((agent) => only === undefined || agent.id === only)
        .map((agent) => (
        <AcpAgentRow
          key={agent.id}
          agent={agent}
          enabled={enabledAgentIds.includes(agent.id)}
          pref={agents?.[agent.id]}
          modelError={modelErrors[agent.id]}
          onToggle={(next) => onToggle(agent.id, next)}
          onPickInstance={(command) => onPickInstance(agent.id, command)}
          onRevertAuto={() => onRevertAuto(agent.id)}
          onSetOverride={(path, enable) => onSetOverride(agent.id, path, enable)}
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
  modelError,
  onToggle,
  onPickInstance,
  onRevertAuto,
  onSetOverride,
  onClearOverride
}: {
  agent: AcpAgentDiscoveryEntry;
  enabled: boolean;
  pref: AcpAgentPreference | undefined;
  modelError: string | undefined;
  onToggle: (enabled: boolean) => void;
  onPickInstance: (command: string) => void;
  onRevertAuto: () => void;
  onSetOverride: (path: string, enable: boolean) => Promise<void>;
  onClearOverride: () => void;
}): ReactElement {
  const instanceCount = agent.instances.length;
  const isAuto =
    (pref?.selectedPath ?? "") === "" && (pref?.overridePath ?? "") === "";
  const summarySub = agent.installed
    ? modelError !== undefined
      ? `Not available: ${modelError}`
      : `${instanceCount} install${instanceCount === 1 ? "" : "s"} found${
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
          modelError !== undefined ? (
            <span className="pss__badge is-danger">Unavailable</span>
          ) : agent.installed ? (
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
              disabled={!agent.installed && !enabled}
              aria-label={`Enable ${agent.displayName}`}
              onChange={(e) => {
                onToggle(e.target.checked);
              }}
            />
            <span>Enable</span>
          </label>
        }
      />
      <div className="pss__acp-detail">
        {agent.installed ? (
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
        ) : null}
        <AcpOverrideInput
          executableName={agent.id}
          overridePath={pref?.overridePath ?? ""}
          saveLabel={agent.installed ? "Save" : "Save & enable"}
          onSave={(path) => onSetOverride(path, !agent.installed)}
          onClear={onClearOverride}
        />
      </div>
    </div>
  );
}

/** Manual override-path input for one ACP agent — mirrors PwrAgnt's per-agent
 *  "Custom path" control. Save persists the path (it's probed on the next
 *  Refresh and, when valid, becomes the active instance); Clear reverts to
 *  discovery + any pinned instance. */
function AcpOverrideInput({
  executableName,
  overridePath,
  saveLabel,
  onSave,
  onClear
}: {
  executableName: string;
  overridePath: string;
  saveLabel: string;
  onSave: (path: string) => Promise<void>;
  onClear: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<string>(overridePath);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Re-sync the draft when the persisted value changes out from under us
  // (e.g. a settings broadcast from another window).
  useEffect(() => {
    setDraft(overridePath);
  }, [overridePath]);
  const trimmed = draft.trim();
  const dirty = trimmed !== overridePath;
  const submit = async (): Promise<void> => {
    const normalized = normalizeManualExecutablePath(
      window.pwrsnapApi?.platform,
      draft
    );
    if (!normalized.ok) {
      setSubmissionError(normalized.error);
      return;
    }
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await onSave(normalized.path);
      setDraft(normalized.path);
    } catch (cause) {
      setSubmissionError(
        cause instanceof Error ? cause.message : "Could not save this agent path."
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="pss__acp-override">
      <input
        className="pss__acp-override-input"
        type="text"
        value={draft}
        spellCheck={false}
        placeholder={`Manual path — e.g. ${executablePathExample(window.pwrsnapApi?.platform, executableName)}`}
        aria-label="Manual override path"
        aria-invalid={submissionError !== null}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setSubmissionError(null);
        }}
      />
      <button
        className="pss__top-btn"
        type="button"
        disabled={!dirty || trimmed.length === 0 || submitting}
        onClick={() => {
          void submit();
        }}
      >
        {submitting ? "Saving…" : saveLabel}
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
      {submissionError !== null ? (
        <p className="pss__opt-sub pss__opt-sub--error" role="alert">
          {submissionError}
        </p>
      ) : null}
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

export function enabledAcpAgentIdsForModelProbes(
  settings: Settings | null | undefined
): string[] {
  if (settings === null || settings === undefined) return [];
  const enabled = new Set(settings.ai.acp.enabledAgentIds);
  const providers = [
    settings.ai.defaults.enrichment.provider,
    settings.ai.defaults.libraryChat.provider,
    settings.ai.defaults.sizzleChat.provider
  ];
  return [
    ...new Set(
      providers
        .map((provider) =>
          provider !== undefined && provider.startsWith("acp:")
            ? provider.slice("acp:".length)
            : null
        )
        .filter((id): id is string => id !== null && enabled.has(id))
    )
  ];
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
  /** Error from probing the selected ACP agent's runtime model/session state. */
  acpModelError?: string | undefined;
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

function codexReasoningEfforts(model: CodexModelOption | undefined): AiReasoningEffort[] {
  const advertised = model?.supportedReasoningEfforts?.filter(isAiReasoningEffort) ?? [];
  return advertised.length > 0 ? advertised : [...AI_REASONING_EFFORTS];
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
  acpModelError,
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
  const codexModels = surfaceModelOptions(models);
  const managedCodexDefaultModelId =
    surface === "enrichment" ? DEFAULT_CODEX_CAPTION_MODEL : undefined;
  const isCodexDefaultForSurface = (model: CodexModelOption): boolean =>
    managedCodexDefaultModelId !== undefined
      ? model.id === managedCodexDefaultModelId
      : model.isDefault;
  const liveSelectedCodexModel =
    models.find((model) => model.id === modelValue) ??
    models.find(isCodexDefaultForSurface);
  const selectedCodexModel =
    liveSelectedCodexModel ??
    codexModels.find((model) => model.id === modelValue) ??
    codexModels.find(isCodexDefaultForSurface);
  // The ACP model list spawns the agent to fetch — disable the picker (showing
  // "Loading…") until it arrives, instead of a stale Codex value next to
  // "loading". Codex models load fast and the stored value is valid, so the
  // Codex picker is never disabled (it just shows the stored model meanwhile).
  const modelLoading =
    isAcpProvider && (acpModelsLoading === true || acpModelOptions === undefined);
  // Mark the model that "Default" resolves to with a "(default)" suffix. Chat
  // uses the backend's protocol-confirmed default; enrichment uses PwrSnap's
  // managed default. Do NOT guess for backend-managed surfaces when no model
  // carries isDefault (e.g. a
  // cached ACP list captured before the agent reported a currentModelId), leave
  // it undefined and show a plain "Default". Guessing the first-listed model
  // actively misleads — Grok lists "Composer 2.5" first but its real default is
  // "Grok Build", so a guess would claim Default → Composer while a run uses
  // Grok Build.
  const defaultModelName: string | undefined = isAcpProvider
    ? (acpModelOptions ?? []).find((m) => m.isDefault)?.label
    : (() => {
        const def = codexModels.find(isCodexDefaultForSurface);
        if (def !== undefined) return modelLabel(def);
        return managedCodexDefaultModelId;
      })();
  const modelChoices: Array<{ id: string; label: string }> = isAcpProvider
    ? (acpModelOptions ?? []).map((m) => ({
        id: m.id,
        label: m.isDefault === true ? `${m.label} (default)` : m.label
      }))
    : codexModels.map((m) => ({
        id: m.id,
        label: isCodexDefaultForSurface(m) ? `${modelLabel(m)} (default)` : modelLabel(m)
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
  // "Default" means "use the managed default". When we know that model,
  // annotate the entry —
  // "Default (GPT-5.6-Luna)" / "Default (Grok Build)" — instead of leaving it a
  // mystery. Falls back to a plain "Default" when the default is unknown.
  const defaultOptionLabel =
    defaultModelName !== undefined ? `Default (${defaultModelName})` : "Default";
  // A persisted acp:<id> whose agent isn't currently in the enabled set
  // (toggled off, or discovery still loading) — keep it as a visible option
  // so the select never silently drops the saved value.
  const showsStaleAcp =
    chatProviderValue.startsWith("acp:") &&
    !acpProviderOptions.some((o) => o.value === chatProviderValue);
  // Reasoning options follow the backend and selected model. Codex advertises
  // model-specific effort values from `model/list` (for example, GPT-5.6 model
  // variants do not all expose the same ceiling). ACP "thinking" agents (Kimi)
  // expose an on/off thinking pass — surface it as the same two choices
  // everywhere: "Fast" (no thinking) and "Thinking".
  const selectedCodexReasoningEfforts = codexReasoningEfforts(selectedCodexModel);
  const liveCodexReasoningEfforts =
    liveSelectedCodexModel?.supportedReasoningEfforts?.filter(isAiReasoningEffort) ?? [];
  // When the live catalog is temporarily unavailable, retain an extended
  // persisted value in the picker instead of making the controlled <select>
  // look blank against the low/medium/high fallback.
  const displayedCodexReasoningEfforts =
    liveCodexReasoningEfforts.length === 0 &&
    reasoningValue !== "" &&
    !selectedCodexReasoningEfforts.includes(reasoningValue)
      ? [...selectedCodexReasoningEfforts, reasoningValue]
      : selectedCodexReasoningEfforts;
  const reasoningChoices: Array<{ value: AiReasoningEffort; label: string }> = isAcpProvider
    ? [
        { value: "low", label: "Fast" },
        { value: "high", label: "Thinking" }
      ]
    : displayedCodexReasoningEfforts.map((effort) => ({ value: effort, label: effort }));
  // What "Default" (empty reasoning) actually resolves to differs by surface and
  // backend, so spell it out rather than leave it ambiguous. For ACP the kit
  // collapses to Fast/Thinking: enrichment defaults Fast (its effort default is
  // "low"); the chat surfaces default Thinking ("medium" → thinking on). Codex
  // names the selected model's advertised default when one is available.
  const codexDefaultReasoning =
    selectedCodexModel !== undefined &&
    isAiReasoningEffort(selectedCodexModel.defaultReasoningEffort) &&
    selectedCodexReasoningEfforts.includes(selectedCodexModel.defaultReasoningEffort)
      ? selectedCodexModel.defaultReasoningEffort
      : undefined;
  const defaultReasoningLabel = isAcpProvider
    ? surface === "enrichment"
      ? "Default (Fast)"
      : "Default (Thinking)"
    : surface === "enrichment"
      ? `Default (${DEFAULT_ENRICHMENT_REASONING_EFFORT})`
      : codexDefaultReasoning !== undefined
      ? `Default (${codexDefaultReasoning})`
      : "Default";
  // A surface can carry a stale Codex "medium" from before its provider was
  // switched to an ACP agent. "medium" isn't an ACP choice, so a controlled
  // <select> would render a BLANK selection. Show what the ACP backend will
  // actually do with it — collapse anything non-"low" to Thinking — so the
  // control never looks empty and matches the value that gets sent.
  const reasoningInChoices = reasoningChoices.some((choice) => choice.value === reasoningValue);
  const reasoningSelectValue: AiReasoningEffort | "" = isAcpProvider
    ? reasoningValue !== "" && !reasoningInChoices
      ? "high"
      : reasoningValue
    : reasoningValue !== "" && !reasoningInChoices
      ? ""
      : reasoningValue;
  // A saved Codex effort can become invalid when the selected model changes.
  // Clear it only when a successful live catalog identified the selected or
  // default model and proved the effort unsupported. An empty list may mean a
  // transient `codex:models` failure and must never mutate persisted settings.
  const staleCodexReasoning =
    !isAcpProvider &&
    !modelsLoading &&
    liveCodexReasoningEfforts.length > 0 &&
    reasoningValue !== "" &&
    !liveCodexReasoningEfforts.includes(reasoningValue);
  const normalizedReasoningKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!staleCodexReasoning) return;
    const key = `${modelValue}|${reasoningValue}`;
    if (normalizedReasoningKeyRef.current === key) return;
    normalizedReasoningKeyRef.current = key;
    onChange({ reasoning: "" });
  }, [modelValue, onChange, reasoningValue, staleCodexReasoning]);

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
        {isAcpProvider && acpModelError !== undefined ? (
          <div className="pss__ai-surface-error" role="alert">
            {acpProviderOptions.find((o) => o.value === chatProviderValue)?.label ??
              chatProviderValue.slice("acp:".length)}{" "}
            is not available: {acpModelError}
          </div>
        ) : null}
        <label className="pss__ai-surface-field">
          <span className="pss__ai-surface-field-label">Model</span>
          <select
            className="pss__select pss__ai-surface-select"
            value={modelLoading ? "__loading__" : selectModelValue}
            aria-label={`${name} model`}
            disabled={modelLoading}
            onChange={(e) => {
              const nextModelId = e.target.value;
              if (isAcpProvider) {
                onChange({ model: nextModelId });
                return;
              }
              const nextModel =
                codexModels.find((model) => model.id === nextModelId) ??
                (nextModelId === ""
                  ? codexModels.find(isCodexDefaultForSurface)
                  : undefined);
              const nextEfforts = codexReasoningEfforts(nextModel);
              onChange({
                model: nextModelId,
                ...(reasoningValue !== "" && !nextEfforts.includes(reasoningValue)
                  ? { reasoning: "" }
                  : {})
              });
            }}
          >
            {modelLoading ? (
              <option value="__loading__">Loading…</option>
            ) : (
              <>
                {/* "Default" uses the surface's managed choice. ACP is annotated
                    with the agent's actual default; Codex enrichment is annotated
                    with PwrSnap's managed model; Codex chat resolves server-side. */}
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
        {/* Reasoning: protocol-advertised, per-model effort for Codex;
            Fast/Thinking for ACP "thinking" agents. Shown for every backend
            now — for ACP it drives the agent's thinking pass (the kit ignores
            it for agents that have none, so the worst case is a no-op control). */}
        <label className="pss__ai-surface-field">
          <span className="pss__ai-surface-field-label">Reasoning</span>
          <select
            className="pss__select pss__ai-surface-select"
            value={reasoningSelectValue}
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
            <option value="">{defaultReasoningLabel}</option>
            {reasoningChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
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
