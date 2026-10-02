import {
  AI_SURFACE_IDS,
  DEFAULT_CODEX_CAPTION_MODEL,
  DEFAULT_ENRICHMENT_REASONING_EFFORT,
  type CodexModelOption,
  type Settings,
  type SettingsPatch
} from "./protocol";

/** Only advertised, visible image-capable models can replace a PwrSnap default. */
function usableModels(models: readonly CodexModelOption[]): CodexModelOption[] {
  return models.filter((model) =>
    !model.hidden && model.inputModalities.includes("text") && model.inputModalities.includes("image")
  );
}

function isSupersededModel(model: string): boolean {
  return model === "gpt-5.5" || /^gpt-5\.6(?:-|$)/.test(model);
}

function replacementId(model: string): string | undefined {
  if (model === "gpt-5.6-luna") return "gpt-6-luna";
  if (isSupersededModel(model) || model === "gpt-6-sol") {
    return "gpt-6.1-sol";
  }
  return undefined;
}

export function upgradedCodexModelId(model: string, availableIds: readonly string[]): string {
  const target = replacementId(model);
  return target !== undefined && availableIds.includes(target) ? target : model;
}

export function hasObsoleteCodexDefaults(settings: Settings): boolean {
  return AI_SURFACE_IDS.some((surface) => {
    const value = settings.ai.defaults[surface];
    return (!value.provider || value.provider === "codex") && replacementId(
      value.model || (surface === "enrichment" ? DEFAULT_CODEX_CAPTION_MODEL : "")
    ) !== undefined;
  });
}

/** Respect includeHidden while hiding superseded families from normal pickers. */
export function applyCodexModelVisibility(
  models: readonly CodexModelOption[],
  includeHidden = false
): CodexModelOption[] {
  const available = usableModels(models);
  const ids = available.map((model) => model.id);
  const hasSol = ids.includes("gpt-6-sol") || ids.includes("gpt-6.1-sol");
  const oldDefault = models.find((model) => model.isDefault);
  const replacementDefault = oldDefault === undefined
    ? undefined : upgradedCodexModelId(oldDefault.id, ids);
  return models.map((model) => {
    const hidden = model.hidden || (hasSol && isSupersededModel(model.id));
    return { ...model, hidden, isDefault: replacementDefault === model.id && !hidden };
  }).filter((model) => includeHidden || !model.hidden);
}

/** Called inside the serialized settings write, using its latest snapshot. */
export function codexModelDefaultsPatch(
  settings: Settings,
  models: readonly CodexModelOption[]
): SettingsPatch | undefined {
  const available = usableModels(models);
  const ids = available.map((model) => model.id);
  const defaults: NonNullable<NonNullable<SettingsPatch["ai"]>["defaults"]> = {};
  for (const surface of AI_SURFACE_IDS) {
    const value = settings.ai.defaults[surface];
    if (value.provider && value.provider !== "codex") continue;
    const model = value.model || (surface === "enrichment" ? DEFAULT_CODEX_CAPTION_MODEL : "");
    const targetId = upgradedCodexModelId(model, ids);
    if (targetId === model) continue;
    const target = available.find((candidate) => candidate.id === targetId);
    if (target === undefined) continue;
    const effort = value.reasoning ??
      (surface === "enrichment" ? DEFAULT_ENRICHMENT_REASONING_EFFORT : undefined);
    const supported = target.supportedReasoningEfforts;
    let reasoning = effort;
    if (effort !== undefined && supported !== undefined &&
        supported.length > 0 && !supported.includes(effort)) {
      reasoning = target.defaultReasoningEffort && supported.includes(target.defaultReasoningEffort)
        ? target.defaultReasoningEffort : supported[0];
    }
    defaults[surface] = { model: targetId, ...(reasoning !== undefined ? { reasoning } : {}) };
  }
  return Object.keys(defaults).length > 0 ? { ai: { defaults } } : undefined;
}
