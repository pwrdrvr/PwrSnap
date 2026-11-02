import { describe, expect, it } from "vitest";
import { enrichmentBackendLabel } from "../CodexStatusPill";
import type { CustomModel, CustomConnection } from "@pwrsnap/shared";

describe("enrichmentBackendLabel", () => {
  const model: CustomModel = { id: "one", connectionId: "connection", displayName: "Bench model",
    modelId: "/fixture/models/weights.gguf", capabilities: { vision: true, streaming: true }, maxOutputTokens: 4096 };
  const connection: CustomConnection = { id: "connection", name: "Local server", baseUrl: "http://127.0.0.1:8080/v1",
    protocol: "openai-chat", auth: { type: "none" } };
  it("uses the saved model and connection labels, even when the selected model field is empty", () => {
    expect(enrichmentBackendLabel({ provider: "custom:one" }, { customModels: [model], customConnections: [connection] }))
      .toEqual({ providerLabel: "Bench model", modelLabel: "Local server" });
    expect(enrichmentBackendLabel({ provider: "custom:one", model: model.modelId }, {
      customModels: [{ ...model, displayName: "Renamed" }], customConnections: [{ ...connection, name: "Renamed" }]
    })).toEqual({ providerLabel: "Renamed", modelLabel: undefined });
  });
  it("does not infer a name from a removed model's path or another model with the same API ID", () => {
    expect(enrichmentBackendLabel({ provider: "custom:removed", model: model.modelId }, { customModels: [model] }))
      .toEqual({ providerLabel: "Removed model", modelLabel: undefined });
  });
  it("defaults to Codex with no model when unset", () => {
    expect(enrichmentBackendLabel(undefined)).toEqual({
      providerLabel: "Codex",
      modelLabel: undefined
    });
    expect(enrichmentBackendLabel({})).toEqual({
      providerLabel: "Codex",
      modelLabel: undefined
    });
  });

  it("shows the model for Codex", () => {
    expect(enrichmentBackendLabel({ provider: "codex", model: "gpt-5.4-mini" })).toEqual({
      providerLabel: "Codex",
      modelLabel: "gpt-5.4-mini"
    });
    // Empty provider is also Codex.
    expect(enrichmentBackendLabel({ provider: "", model: "gpt-5.4" })).toEqual({
      providerLabel: "Codex",
      modelLabel: "gpt-5.4"
    });
  });

  it("maps known ACP provider ids to friendly labels", () => {
    expect(enrichmentBackendLabel({ provider: "acp:kimi" }).providerLabel).toBe("Kimi");
    expect(enrichmentBackendLabel({ provider: "acp:grok" }).providerLabel).toBe("Grok");
    expect(enrichmentBackendLabel({ provider: "acp:gemini" }).providerLabel).toBe("Gemini");
    expect(enrichmentBackendLabel({ provider: "acp:qwen" }).providerLabel).toBe("Qwen");
  });

  it("falls back to the raw id for an unknown ACP provider", () => {
    expect(enrichmentBackendLabel({ provider: "acp:mystery" }).providerLabel).toBe("mystery");
  });

  it("never shows a model for an ACP provider, even a stale cross-provider one", () => {
    // The regression: provider switched to Kimi but a Codex model id lingered in
    // settings. ACP runs on the agent's own default (handler passes null), so the
    // pill must NOT read "Kimi … (gpt-5.4-mini)".
    expect(enrichmentBackendLabel({ provider: "acp:kimi", model: "gpt-5.4-mini" })).toEqual({
      providerLabel: "Kimi",
      modelLabel: undefined
    });
  });
});
