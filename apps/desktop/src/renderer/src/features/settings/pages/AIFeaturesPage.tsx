// Settings → AI Features: what PwrSnap does with AI, and which provider
// does each job. Everything here only takes effect once a provider on AI
// Providers is installed and signed in — which is why it is its own page
// instead of more cards under the provider list.
//
// Its sidebar children are jump-to links, not screens (see
// `settings-nav.ts`): a section sub keeps this page rendered and scrolls to
// that card, the way PwrAgnt's Messaging → Routes does.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  AcpAgentDiscovery,
  AcpAgentModelOption,
  AiEnrichmentBudgetStatus,
  AiFeaturesSettingsSub,
  AiReasoningEffort,
  AiSurfaceDefault,
  AiSurfaceDefaultPatch,
  AiSurfaceId,
  AiUsageRunsPage,
  AiUsageSummary,
  CodexModelList,
  CodexModelOption
} from "@pwrsnap/shared";
import {
  AI_REASONING_EFFORTS,
  builtInAcpAgentDisplayName,
  CODEX_CAPTION_MODELS,
  DEFAULT_CODEX_CAPTION_MODEL,
  DEFAULT_ENRICHMENT_REASONING_EFFORT,
  EVENT_CHANNELS,
  isAiReasoningEffort
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import { Card, Row, Switch } from "../components";
import { AiConsentDialog } from "../../shared/AiConsentDialog";
import { useAiProvidersContext, useInUseAcpModelProbes } from "../AiProvidersContext";
import { acpAgentIdOfProvider, AI_SURFACE_LABELS } from "../ai-provider-status";
import { AI_FEATURE_SECTION_LABELS, settingsSectionId } from "../settings-nav";
import { useSettingsContext } from "../SettingsContext";
import { setActivePage } from "../useActivePage";
import {
  formatCostMicros,
  formatLastSetAt,
  formatNextTokenAt,
  formatTokenCount,
  formatUsageTokenBreakdown,
  uncachedInputTokens
} from "./ai-format";
import { ChatSettingsCard } from "./ChatSettingsCard";

type AIFeaturesPageProps = {
  /** Section to bring into view, or `null` for the top of the page.
   *  Validated by the router before it gets here. */
  sub: string | null;
  /** The route's request counter — bumps on every navigation, including a
   *  re-click of the section already shown, so that re-click scrolls back. */
  request: number;
};

export function AIFeaturesPage({ sub, request }: AIFeaturesPageProps): ReactElement {
  const { settings, patch } = useSettingsContext();
  // Discovery supplies the agents' display names for the provider pickers;
  // the model probes supply their model lists (and catch a signed-out CLI).
  const {
    request: requestDiscovery,
    codexSnapshotLoading,
    acpDiscovery,
    acpModels,
    acpModelErrors,
    acpModelsLoadingIds,
    fetchAcpModels
  } = useAiProvidersContext();
  const acpAgentIdsInUse = useInUseAcpModelProbes();
  const [budgetStatus, setBudgetStatus] = useState<AiEnrichmentBudgetStatus | null>(null);
  const [usageSummary, setUsageSummary] = useState<AiUsageSummary | null>(null);
  const [usageRuns, setUsageRuns] = useState<AiUsageRunsPage | null>(null);
  const [usageLoading, setUsageLoading] = useState<boolean>(true);
  const [codexModels, setCodexModels] = useState<CodexModelList | null>(null);
  const [codexModelsLoading, setCodexModelsLoading] = useState<boolean>(true);
  const [aiConsentDialogOpen, setAiConsentDialogOpen] = useState<boolean>(false);

  useEffect(() => {
    requestDiscovery();
  }, [requestDiscovery]);

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
    if (codexSnapshotLoading || codexModelsRequested.current) return;
    codexModelsRequested.current = true;
    void refreshCodexModels();
  }, [codexSnapshotLoading, refreshCodexModels]);

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

  // The provider dropdown offers Codex + each ENABLED ACP agent (value
  // `acp:<id>`, labeled by its discovery display name). Built from the
  // enabled set intersected with discovery so an enabled-but-now-uninstalled
  // agent still shows by name. An agent enabled before discovery resolves is
  // shown by its built-in name until discovery arrives.
  const enabledAgentIds = settings?.ai.acp.enabledAgentIds ?? [];
  const enabledAgentIdSet = new Set(enabledAgentIds);
  const acpChatProviderOptions = [...buildAcpProviderOptions(enabledAgentIds, acpDiscovery), ...(settings?.ai.customModels ?? []).map((m) => ({ value: `custom:${m.id}`, label: m.displayName }))];
  const acpModelsForProvider = (
    provider: string | undefined
  ): readonly AcpAgentModelOption[] | undefined => {
    if (provider?.startsWith("custom:")) {
      const m = settings?.ai.customModels?.find((entry) => `custom:${entry.id}` === provider);
      return m ? [{ id: m.modelId, label: m.modelId, isDefault: true }] : [];
    }
    const id = acpAgentIdOfProvider(provider);
    if (id === null) return undefined;
    return enabledAgentIdSet.has(id) ? acpModels[id] : [];
  };
  const acpModelsLoadingForProvider = (provider: string | undefined): boolean => {
    const id = acpAgentIdOfProvider(provider);
    return id !== null && enabledAgentIdSet.has(id) && acpModelsLoadingIds.includes(id);
  };
  const acpModelErrorForProvider = (provider: string | undefined): string | undefined => {
    const id = acpAgentIdOfProvider(provider);
    return id === null || !enabledAgentIdSet.has(id) ? undefined : acpModelErrors[id];
  };

  // Re-list Codex's models and re-probe every in-use agent's (re-spawns
  // them). Normal opens read the persisted ACP model cache.
  const onRefreshModels = (): void => {
    void refreshCodexModels();
    for (const id of acpAgentIdsInUse) void fetchAcpModels(id, true);
  };

  const section = (id: AiFeaturesSettingsSub): { id: string; focusRequest: number | undefined } => ({
    id: settingsSectionId("ai-features", id),
    focusRequest: sub === id ? request : undefined
  });

  const surfaceControl = (surface: AiSurfaceId, description: string): ReactElement => {
    const value = settings?.ai.defaults[surface] ?? {};
    return (
      <AiSurfaceDefaultControl
        surface={surface}
        name={AI_SURFACE_LABELS[surface]}
        sub={description}
        value={value}
        models={codexModels?.models ?? []}
        modelsLoading={codexModelsLoading}
        acpProviderOptions={acpChatProviderOptions}
        acpModelOptions={acpModelsForProvider(value.provider)}
        acpModelsLoading={acpModelsLoadingForProvider(value.provider)}
        acpModelError={acpModelErrorForProvider(value.provider)}
        onChange={(p) => {
          void patch({ ai: { defaults: { [surface]: p } } });
        }}
      />
    );
  };

  const safetyDisabled =
    settings?.ai.budgetSafetyDisabledAt !== null &&
    settings?.ai.budgetSafetyDisabledAt !== undefined;

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">AI Features</h1>
          <p className="pss__main-sub">
            What PwrSnap uses AI for — captions and tags for new captures, and
            chatting about a snap or a Sizzle Reel — and which provider does
            each job. None of it runs until a provider is set up in{" "}
            <button
              type="button"
              className="pss__text-link"
              onClick={() => {
                setActivePage("ai");
              }}
            >
              AI Providers
            </button>
            .
          </p>
        </div>
      </div>

      <Card
        {...section("default-agents")}
        eyebrow="JOBS"
        title={AI_FEATURE_SECTION_LABELS["default-agents"]}
        headerAction={
          <button
            className="pss__top-btn"
            type="button"
            disabled={codexModelsLoading}
            onClick={onRefreshModels}
          >
            {codexModelsLoading ? "Refreshing…" : "Refresh models"}
          </button>
        }
      >
        <div className="pss__roles">
          <p className="pss__role-intro">
            Pick the agent, model, and reasoning effort for each job. Leave a
            field on Default to let PwrSnap choose. Changes apply to new
            captures and new chats; conversations already under way keep what
            they started with.
          </p>
          {surfaceControl(
            "enrichment",
            "Caption, tags + extracted text — one turn per capture, shown in Library detail + Float-Over"
          )}
          {surfaceControl("libraryChat", "Ask the agent about a snap")}
          {surfaceControl("sizzleChat", "Composer agent for the reel")}
        </div>
      </Card>

      <Card {...section("enrichment")} eyebrow="CAPTURES" title={AI_FEATURE_SECTION_LABELS.enrichment}>
        <Row
          label="Enrich new captures"
          sub="Writes a caption, tags, a filename, and the text it can read in each new capture, using the agent chosen for captions above."
          tag={settings?.ai.enabled ? "on" : "off"}
        >
          <Switch
            on={settings?.ai.enabled ?? false}
            label="Enrich new captures"
            onChange={(enabled) => {
              // First time on: show the disclosure; the switch stays off
              // unless it is accepted. Turning on also clears a cost-safety
              // cutoff — the breaker turns enrichment off, so this is how
              // the operator lifts it. Settings not loaded yet counts as no
              // consent: enabling blind would switch on a job main refuses
              // to run, and never show the disclosure.
              if (enabled && (settings?.ai.consentAcceptedAt ?? null) === null) {
                setAiConsentDialogOpen(true);
                return;
              }
              void setAiEnrichmentEnabled(enabled);
            }}
          />
        </Row>
        <Row
          label="Budget"
          sub="Enrichment runs draw from a small budget that refills over time, so a burst of captures can't run up a bill. If it keeps running dry, PwrSnap turns enrichment off; switch it back on above."
        >
          <div className="pss__test">
            <span className="pss__test-icon">AI</span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">
                {safetyDisabled ? "Turned off for cost safety" : "Enrichment budget"}
              </span>
              <span className="pss__test-sub">
                {budgetStatusSubLine(budgetStatus, settings?.ai.budgetSafetyDisabledAt ?? null)}
              </span>
            </div>
            <div className="pss__test-r">
              <span className={"pss__badge " + budgetBadgeClass(budgetStatus)}>
                {budgetBadgeLabel(budgetStatus)}
              </span>
            </div>
          </div>
        </Row>
      </Card>

      <Card
        {...section("usage")}
        eyebrow="LAST 30 DAYS"
        title={AI_FEATURE_SECTION_LABELS.usage}
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
          sub="AI runs from this app, on Codex and on ACP agents. Cost is what the tokens would cost at public list prices, not what your account is billed."
          tag="30 days"
        >
          <AiUsagePanel summary={usageSummary} runs={usageRuns} loading={usageLoading} />
        </Row>
      </Card>

      <ChatSettingsCard {...section("guidance")} />

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

// ---- Default agents: one row per job -----------------------------------

/** Friendly model name for a picker option. Prefer the display name; only fall
 *  back to the raw id when there's no friendlier name. (We used to append the id
 *  in parens — "GPT-5.4-Mini (gpt-5.4-mini)" — which is just noise.) */
function modelLabel(model: CodexModelOption): string {
  return model.displayName.length > 0 ? model.displayName : model.id;
}

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
  const isCustomProvider = chatProviderValue.startsWith("custom:");
  const isAcpProvider = chatProviderValue.startsWith("acp:") || isCustomProvider;
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
    (chatProviderValue.startsWith("acp:") || isCustomProvider) &&
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
              onChange({ provider: e.target.value, model: "", ...(isCustomProvider || e.target.value.startsWith("custom:") ? { reasoning: "" } : {}) });
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
                onChange({ model: nextModelId, ...(isCustomProvider ? { provider: chatProviderValue, reasoning: "" } : {}) });
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
        {!isCustomProvider && <label className="pss__ai-surface-field">
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
        </label>}
        {isCustomProvider && <span className="pss__opt-sub">Direct API · no tools, reasoning controls or pricing estimate</span>}
      </div>
    </div>
  );
}

// ---- Enrichment budget -------------------------------------------------

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

// ---- Usage ---------------------------------------------------------------

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
