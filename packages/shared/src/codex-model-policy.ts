import {
  AI_SURFACE_IDS,
  DEFAULT_CODEX_CAPTION_MODEL,
  type AiSurfaceId,
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

/** True when a surface's EXPLICIT Codex model has a successor. An unset
 *  enrichment model is PwrSnap's managed default, which is resolved per run
 *  (see resolveManagedCodexEnrichmentModel) and never needs migrating. */
export function hasObsoleteCodexDefaults(
  settings: Settings,
  surfaces: readonly AiSurfaceId[] = AI_SURFACE_IDS
): boolean {
  return surfaces.some((surface) => {
    const value = settings.ai.defaults[surface];
    return (!value.provider || value.provider === "codex") && !!value.model &&
      replacementId(value.model) !== undefined;
  });
}

/** The managed enrichment default for this catalog: DEFAULT_CODEX_CAPTION_MODEL,
 *  or its advertised successor. Resolved at run time and never written to
 *  settings, so a later default change still reaches every user who did not
 *  pick a model. Undefined when the catalog lists neither. */
export function resolveManagedCodexEnrichmentModel(
  models: readonly CodexModelOption[]
): CodexModelOption | undefined {
  const available = usableModels(models);
  const id = upgradedCodexModelId(DEFAULT_CODEX_CAPTION_MODEL, available.map((model) => model.id));
  return available.find((model) => model.id === id);
}

/** Keep a reasoning effort the target advertises; otherwise use its own
 *  default, or the first effort it lists. Unknown support keeps the effort. */
export function codexEffortForModel(effort: string, target: CodexModelOption): string {
  const supported = target.supportedReasoningEfforts;
  if (supported === undefined || supported.length === 0 || supported.includes(effort)) return effort;
  return target.defaultReasoningEffort && supported.includes(target.defaultReasoningEffort)
    ? target.defaultReasoningEffort : supported[0]!;
}

/** Respect includeHidden while hiding superseded models from normal pickers.
 *  A superseded model is hidden only when its own replacement is listed, so a
 *  saved default never disappears without the migration that replaces it. */
export function applyCodexModelVisibility(
  models: readonly CodexModelOption[],
  includeHidden = false
): CodexModelOption[] {
  const available = usableModels(models);
  const ids = available.map((model) => model.id);
  const oldDefault = models.find((model) => model.isDefault);
  const replacementDefault = oldDefault === undefined
    ? undefined : upgradedCodexModelId(oldDefault.id, ids);
  return models.map((model) => {
    const hidden = model.hidden ||
      (isSupersededModel(model.id) && upgradedCodexModelId(model.id, ids) !== model.id);
    return { ...model, hidden, isDefault: replacementDefault === model.id && !hidden };
  }).filter((model) => includeHidden || !model.hidden);
}

/** Called inside the serialized settings write, using its latest snapshot.
 *  Migrates only explicit model choices; the managed default stays unset. */
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
    if (!value.model) continue;
    const targetId = upgradedCodexModelId(value.model, ids);
    if (targetId === value.model) continue;
    const target = available.find((candidate) => candidate.id === targetId);
    if (target === undefined) continue;
    const reasoning = value.reasoning === undefined ? undefined : codexEffortForModel(value.reasoning, target);
    defaults[surface] = { model: targetId, ...(reasoning !== undefined ? { reasoning } : {}) };
  }
  return Object.keys(defaults).length > 0 ? { ai: { defaults } } : undefined;
}
