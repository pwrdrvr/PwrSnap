import { describe, expect, test } from "vitest";
import {
  applyCodexModelVisibility, codexEffortForModel, codexModelDefaultsPatch, hasObsoleteCodexDefaults,
  resolveManagedCodexEnrichmentModel, upgradedCodexModelId
} from "../codex-model-policy";
import { DEFAULT_AI_SURFACE_DEFAULTS, type CodexModelOption, type Settings } from "../protocol";

function model(id: string, overrides: Partial<CodexModelOption> = {}): CodexModelOption {
  return { id, model: id, displayName: id, description: "", hidden: false,
    inputModalities: ["text", "image"], defaultServiceTier: null, isDefault: false, ...overrides };
}

const oldModels = ["gpt-5.5", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-astra"];
const newModels = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"];

describe("Codex live catalog policy", () => {
  test("hides both superseded families when both replacements are listed", () => {
    const models = [...oldModels, "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map((id) => model(id));
    expect(applyCodexModelVisibility(models).map((value) => value.id)).toEqual([
      "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"
    ]);
    expect(applyCodexModelVisibility(models, true).filter((value) => value.hidden)
      .map((value) => value.id)).toEqual(oldModels);
    expect(models.every((value) => !value.hidden)).toBe(true);
  });

  test("hides a superseded model only when its own replacement is listed", () => {
    // GPT-6-Sol alone replaces nothing: GPT-5.5 / GPT-5.6 move to GPT-6.1-Sol.
    const solOnly = [...oldModels, "gpt-6-sol", "gpt-6-luna"].map((id) => model(id));
    expect(applyCodexModelVisibility(solOnly).map((value) => value.id)).toEqual([
      "gpt-5.5", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-astra", "gpt-6-sol", "gpt-6-luna"
    ]);
    // GPT-6.1-Sol without GPT-6-Luna leaves GPT-5.6-Luna visible.
    const noLuna = [...oldModels, "gpt-6.1-sol"].map((id) => model(id));
    expect(applyCodexModelVisibility(noLuna).map((value) => value.id)).toEqual([
      "gpt-5.6-luna", "gpt-6.1-sol"
    ]);
  });

  test("a superseded CLI default without a listed replacement keeps its default flag", () => {
    const models = [model("gpt-5.6-luna", { isDefault: true }), model("gpt-6-sol")];
    expect(applyCodexModelVisibility(models)).toEqual([
      expect.objectContaining({ id: "gpt-5.6-luna", isDefault: true }),
      expect.objectContaining({ id: "gpt-6-sol", isDefault: false })
    ]);
  });

  test("unavailable or hidden Sol does not hide older models", () => {
    const legacy = oldModels.map((id) => model(id));
    expect(applyCodexModelVisibility(legacy)).toEqual(legacy);
    expect(applyCodexModelVisibility([...legacy, model("gpt-6.1-sol", { hidden: true })])).toEqual(legacy);
    expect(applyCodexModelVisibility([...legacy, model("gpt-6-sol", { inputModalities: ["text"] })])
      .filter((value) => oldModels.includes(value.id))).toEqual(legacy);
  });

  test.each([...oldModels, "gpt-6-sol"])("migrates %s only with its advertised replacement", (id) => {
    const expected = id === "gpt-5.6-luna" ? "gpt-6-luna" : "gpt-6.1-sol";
    expect(upgradedCodexModelId(id, newModels)).toBe(expected);
    expect(upgradedCodexModelId(id, ["gpt-6-sol"])).toBe(id);
  });

  test("GPT-6-Astra and unrelated models retain their identity", () => {
    for (const id of ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol", "other"]) {
      expect(upgradedCodexModelId(id, newModels)).toBe(id);
    }
  });

  test("replaces a superseded CLI default with its advertised successor", () => {
    const models = [model("gpt-5.6-terra", { isDefault: true }), model("gpt-6.1-sol")];
    expect(applyCodexModelVisibility(models)).toEqual([
      expect.objectContaining({ id: "gpt-6.1-sol", isDefault: true })
    ]);
  });

  test("defaults migration respects provider, availability and advertised reasoning", () => {
    const settings = { ai: { defaults: {
      libraryChat: { model: "gpt-5.6-terra", reasoning: "ultra" },
      sizzleChat: { provider: "acp:kimi", model: "gpt-5.6-terra" },
      enrichment: { model: "gpt-5.6-luna", reasoning: "high" }
    } } } as Settings;
    const models = [model("gpt-6.1-sol", { supportedReasoningEfforts: ["medium", "high"],
      defaultReasoningEffort: "high" }), model("gpt-6-luna", { supportedReasoningEfforts: ["low", "high"] })];
    expect(codexModelDefaultsPatch(settings, models)).toEqual({ ai: { defaults: {
      libraryChat: { model: "gpt-6.1-sol", reasoning: "high" },
      enrichment: { model: "gpt-6-luna", reasoning: "high" }
    } } });
    expect(codexModelDefaultsPatch(settings, [])).toBeUndefined();
    settings.ai.defaults.libraryChat = { model: "gpt-6-astra" };
    settings.ai.defaults.enrichment = { provider: "custom:00000000-0000-0000-0000-000000000000" };
    expect(codexModelDefaultsPatch(settings, models)).toBeUndefined();
  });

  test("the managed enrichment default is never written to settings", () => {
    const settings = { ai: { defaults: DEFAULT_AI_SURFACE_DEFAULTS } } as Settings;
    expect(hasObsoleteCodexDefaults(settings)).toBe(false);
    expect(codexModelDefaultsPatch(settings, [model("gpt-6-luna")])).toBeUndefined();
  });

  test("the managed enrichment default resolves to an image-capable visible successor", () => {
    expect(resolveManagedCodexEnrichmentModel([model("gpt-5.6-luna"), model("gpt-6-luna")])?.id)
      .toBe("gpt-6-luna");
    for (const successor of [model("gpt-6-luna", { hidden: true }),
      model("gpt-6-luna", { inputModalities: ["text"] })]) {
      expect(resolveManagedCodexEnrichmentModel([model("gpt-5.6-luna"), successor])?.id)
        .toBe("gpt-5.6-luna");
    }
    expect(resolveManagedCodexEnrichmentModel([model("gpt-6-sol")])).toBeUndefined();
  });

  test("an effort the target does not advertise falls back to its default, then its first", () => {
    expect(codexEffortForModel("low", model("m"))).toBe("low");
    expect(codexEffortForModel("low", model("m", { supportedReasoningEfforts: ["low", "high"] }))).toBe("low");
    expect(codexEffortForModel("low", model("m", {
      supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high"
    }))).toBe("high");
    expect(codexEffortForModel("low", model("m", { supportedReasoningEfforts: ["medium", "high"] })))
      .toBe("medium");
  });
});
