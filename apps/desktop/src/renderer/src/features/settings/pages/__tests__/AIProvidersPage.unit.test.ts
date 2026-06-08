// Pure-function unit tests for the AI Providers page helpers.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AcpAgentDiscovery } from "@pwrsnap/shared";
import {
  AiSurfaceDefaultControl,
  type AiSurfaceDefaultControlProps,
  buildAcpProviderOptions,
  formatCostMicros,
  formatLastSetAt,
  formatNextTokenAt,
  formatTokenCount,
  formatUsageTokenBreakdown,
  SecretKeyControl
} from "../AIProvidersPage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

async function renderSecretKeyControl(configured: boolean): Promise<{
  input: HTMLInputElement;
  primaryButton: HTMLButtonElement;
}> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(SecretKeyControl, {
        status: {
          configured,
          lastSetAt: configured ? "2026-05-12T12:00:00.000Z" : null
        },
        placeholder: "sk-...",
        onReplace: async () => undefined,
        onClear: async () => undefined
      })
    );
  });
  const input = container.querySelector("input");
  const primaryButton = container.querySelector("button");
  if (input === null || primaryButton === null) {
    throw new Error("SecretKeyControl did not render its input and primary button");
  }
  return { input, primaryButton };
}

function focusInput(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: true }));
  });
}

function typeIntoInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  });
}

async function renderSurfaceControl(
  props: AiSurfaceDefaultControlProps
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AiSurfaceDefaultControl, props));
  });
  return container;
}

describe("AiSurfaceDefaultControl — job routing", () => {
  test("resets the model to Default when the provider changes (no stale cross-provider model)", async () => {
    const onChange = vi.fn();
    const el = await renderSurfaceControl({
      surface: "libraryChat",
      name: "Library chat",
      sub: "",
      value: { provider: "acp:gemini", model: "gemini-3-pro-preview" },
      models: [],
      modelsLoading: false,
      acpProviderOptions: [{ value: "acp:gemini", label: "Gemini CLI" }],
      acpModelOptions: [{ id: "gemini-3-pro-preview", label: "gemini-3-pro-preview" }],
      acpModelsLoading: false,
      onChange
    });
    const providerSelect = el.querySelector<HTMLSelectElement>(
      '[aria-label="Library chat provider"]'
    );
    expect(providerSelect).not.toBeNull();
    await act(async () => {
      providerSelect!.value = ""; // switch to Codex
      providerSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // The model must be cleared alongside the provider — a Gemini model can't
    // carry over to Codex.
    expect(onChange).toHaveBeenCalledWith({ provider: "", model: "" });
  });

  test("annotates the ACP Default with the agent's true default; marks the (default) model", async () => {
    const onChange = vi.fn();
    const el = await renderSurfaceControl({
      surface: "enrichment",
      name: "Enrichment",
      sub: "",
      value: { provider: "acp:kimi" }, // on Default already
      models: [],
      modelsLoading: false,
      acpProviderOptions: [{ value: "acp:kimi", label: "Kimi Code CLI" }],
      acpModelOptions: [
        { id: "kimi-k1.5", label: "kimi-k1.5" },
        { id: "kimi-k2", label: "kimi-k2", isDefault: true }
      ],
      acpModelsLoading: false,
      onChange
    });
    expect(onChange).not.toHaveBeenCalled(); // nothing to normalize
    const modelSelect = el.querySelector<HTMLSelectElement>('[aria-label="Enrichment model"]');
    expect(modelSelect!.value).toBe("");
    const options = Array.from(modelSelect!.options).map((o) => ({
      value: o.value,
      text: o.textContent
    }));
    // Default entry names what it resolves to; the default model is tagged.
    expect(options).toEqual([
      { value: "", text: "Default (kimi-k2)" },
      { value: "kimi-k1.5", text: "kimi-k1.5" },
      { value: "kimi-k2", text: "kimi-k2 (default)" }
    ]);
  });

  test("shows Fast/Thinking reasoning for an ACP provider and maps them to low/high", async () => {
    const onChange = vi.fn();
    const el = await renderSurfaceControl({
      surface: "enrichment",
      name: "Enrichment",
      sub: "",
      value: { provider: "acp:kimi" },
      models: [],
      modelsLoading: false,
      acpProviderOptions: [{ value: "acp:kimi", label: "Kimi Code CLI" }],
      acpModelOptions: [{ id: "kimi-code/kimi-for-coding", label: "Kimi-k2.6", isDefault: true }],
      acpModelsLoading: false,
      onChange
    });
    const reasoning = el.querySelector<HTMLSelectElement>('[aria-label="Enrichment reasoning effort"]');
    expect(reasoning).not.toBeNull();
    const options = Array.from(reasoning!.options).map((o) => ({ value: o.value, text: o.textContent }));
    expect(options).toEqual([
      { value: "", text: "Default" },
      { value: "low", text: "Fast" },
      { value: "high", text: "Thinking" }
    ]);
    // Picking "Thinking" stores reasoning "high" (the kit maps it to thinking ON).
    await act(async () => {
      reasoning!.value = "high";
      reasoning!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ reasoning: "high" });
  });

  test("keeps graded low/medium/high reasoning for a Codex provider", async () => {
    const onChange = vi.fn();
    const el = await renderSurfaceControl({
      surface: "libraryChat",
      name: "Library chat",
      sub: "",
      value: { provider: "" },
      models: [],
      modelsLoading: false,
      acpProviderOptions: [],
      acpModelOptions: undefined,
      acpModelsLoading: false,
      onChange
    });
    const reasoning = el.querySelector<HTMLSelectElement>('[aria-label="Library chat reasoning effort"]');
    const values = Array.from(reasoning!.options).map((o) => o.value);
    expect(values).toEqual(["", "low", "medium", "high"]);
  });

  test("normalizes a stale cross-provider model to Default once the ACP list loads", async () => {
    // The live Grok bug: provider switched to an ACP agent but a Codex model id
    // ("gpt-5.4-mini") lingered → it was sent to the agent every run. Once the
    // agent's real model list is known, the invalid id resets to Default ("").
    const onChange = vi.fn();
    await renderSurfaceControl({
      surface: "enrichment",
      name: "Enrichment",
      sub: "",
      value: { provider: "acp:grok", model: "gpt-5.4-mini" },
      models: [],
      modelsLoading: false,
      acpProviderOptions: [{ value: "acp:grok", label: "Grok" }],
      acpModelOptions: [{ id: "grok-4", label: "grok-4", isDefault: true }],
      acpModelsLoading: false,
      onChange
    });
    expect(onChange).toHaveBeenCalledWith({ model: "" });
  });

  test("does NOT normalize while the ACP model list is still loading", async () => {
    const onChange = vi.fn();
    await renderSurfaceControl({
      surface: "enrichment",
      name: "Enrichment",
      sub: "",
      value: { provider: "acp:grok", model: "gpt-5.4-mini" },
      models: [],
      modelsLoading: false,
      acpProviderOptions: [{ value: "acp:grok", label: "Grok" }],
      acpModelsLoading: true, // list not yet known — can't judge validity
      onChange
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("does NOT guess a default when the agent reports no currentModelId (stale cache)", async () => {
    // Grok lists Composer 2.5 first but its real default is Grok Build. When the
    // cached list has no isDefault, the picker must show a PLAIN "Default" — not
    // "Default (Composer 2.5)", which would mislabel the first-listed model.
    const onChange = vi.fn();
    const el = await renderSurfaceControl({
      surface: "enrichment",
      name: "Enrichment",
      sub: "",
      value: { provider: "acp:grok" },
      models: [],
      modelsLoading: false,
      acpProviderOptions: [{ value: "acp:grok", label: "Grok" }],
      acpModelOptions: [
        { id: "grok-composer-2.5-fast", label: "Composer 2.5" },
        { id: "grok-build", label: "Grok Build" }
      ], // no isDefault on either (cache predates the capture)
      acpModelsLoading: false,
      onChange
    });
    const modelSelect = el.querySelector<HTMLSelectElement>('[aria-label="Enrichment model"]');
    const options = Array.from(modelSelect!.options).map((o) => o.textContent);
    expect(options).toEqual(["Default", "Composer 2.5", "Grok Build"]); // no "(default)" guess
  });

  test("keeps a plain Default for an ACP agent that advertises no models", async () => {
    const onChange = vi.fn();
    const el = await renderSurfaceControl({
      surface: "libraryChat",
      name: "Library chat",
      sub: "",
      value: { provider: "acp:grok" },
      models: [],
      modelsLoading: false,
      acpProviderOptions: [{ value: "acp:grok", label: "Grok" }],
      acpModelOptions: [], // agent advertises none
      acpModelsLoading: false,
      onChange
    });
    const modelSelect = el.querySelector<HTMLSelectElement>('[aria-label="Library chat model"]');
    const defaultOption = Array.from(modelSelect!.options).find((o) => o.value === "");
    expect(defaultOption?.textContent).toBe("Default"); // no annotation when no default known
    expect(onChange).not.toHaveBeenCalled();
  });

  test("hides a text-only Codex model from the picker (Spark is image-incapable)", async () => {
    const codexModels = [
      {
        id: "gpt-5.4-spark",
        model: "gpt-5.4-spark",
        displayName: "Codex Spark",
        description: "",
        hidden: false,
        inputModalities: ["text"] as Array<"text" | "image">, // text-only
        defaultServiceTier: null,
        isDefault: false
      },
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "",
        hidden: false,
        inputModalities: ["text", "image"] as Array<"text" | "image">,
        defaultServiceTier: null,
        isDefault: true
      }
    ];
    const el = await renderSurfaceControl({
      surface: "libraryChat",
      name: "Library chat",
      sub: "",
      value: {},
      models: codexModels,
      modelsLoading: false,
      acpProviderOptions: [],
      acpModelsLoading: false,
      onChange: vi.fn()
    });
    const modelSelect = el.querySelector<HTMLSelectElement>('[aria-label="Library chat model"]');
    const optionValues = Array.from(modelSelect!.options).map((o) => o.value);
    expect(optionValues).not.toContain("gpt-5.4-spark"); // text-only → hidden everywhere
    expect(optionValues).toContain("gpt-5.5");
  });

  test("Codex: annotates Default with the default model + shows friendly names (no id in parens)", async () => {
    const codexModels = [
      {
        id: "gpt-5.4-mini",
        model: "gpt-5.4-mini",
        displayName: "GPT-5.4-Mini",
        description: "",
        hidden: false,
        inputModalities: ["text", "image"] as Array<"text" | "image">,
        defaultServiceTier: null,
        isDefault: true
      },
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "",
        hidden: false,
        inputModalities: ["text", "image"] as Array<"text" | "image">,
        defaultServiceTier: null,
        isDefault: false
      }
    ];
    const el = await renderSurfaceControl({
      surface: "enrichment",
      name: "Enrichment",
      sub: "",
      value: {}, // Codex, on Default
      models: codexModels,
      modelsLoading: false,
      acpProviderOptions: [],
      acpModelsLoading: false,
      onChange: vi.fn()
    });
    const modelSelect = el.querySelector<HTMLSelectElement>('[aria-label="Enrichment model"]');
    const options = Array.from(modelSelect!.options).map((o) => o.textContent);
    expect(options).toEqual([
      "Default (GPT-5.4-Mini)", // annotated with the default model's friendly name
      "GPT-5.4-Mini (default)", // friendly name + (default), NOT "GPT-5.4-Mini (gpt-5.4-mini)"
      "GPT-5.5"
    ]);
  });

  test("does NOT keep a stored model that isn't valid for the provider (Sizzle bug)", async () => {
    // Repro of the real saved state: sizzleChat = { model: "gemini-3-flash-preview" }
    // with no provider → defaults to Codex. The Codex model picker must NOT
    // keep the stale Gemini id selectable/selected — it shows Default until a
    // real Codex model is chosen.
    const codexModels = [
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "",
        hidden: false,
        inputModalities: ["text", "image"] as Array<"text" | "image">,
        defaultServiceTier: null,
        isDefault: true
      }
    ];
    const el = await renderSurfaceControl({
      surface: "sizzleChat",
      name: "Sizzle Reel chat",
      sub: "",
      value: { model: "gemini-3-flash-preview" }, // no provider → Codex
      models: codexModels,
      modelsLoading: false,
      acpProviderOptions: [],
      acpModelsLoading: false,
      onChange: vi.fn()
    });
    const modelSelect = el.querySelector<HTMLSelectElement>(
      '[aria-label="Sizzle Reel chat model"]'
    );
    expect(modelSelect).not.toBeNull();
    const optionValues = Array.from(modelSelect!.options).map((o) => o.value);
    expect(optionValues).not.toContain("gemini-3-flash-preview");
    expect(modelSelect!.value).toBe(""); // Default, not the stale Gemini id
  });
});

describe("buildAcpProviderOptions", () => {
  test("labels an enabled agent by its friendly name BEFORE discovery resolves (no raw-id flash)", () => {
    // discovery=null → the label must come from the built-in name, not "gemini".
    const opts = buildAcpProviderOptions(["gemini"], null);
    expect(opts).toEqual([{ value: "acp:gemini", label: "Gemini CLI" }]);
  });

  test("prefers discovery's display name once it resolves", () => {
    const discovery = {
      agents: [{ id: "gemini", displayName: "Gemini CLI (v0.4)" }]
    } as unknown as AcpAgentDiscovery;
    const opts = buildAcpProviderOptions(["gemini"], discovery);
    expect(opts[0]?.label).toBe("Gemini CLI (v0.4)");
  });
});

describe("formatLastSetAt", () => {
  test("returns em-dash for null / empty input", () => {
    expect(formatLastSetAt(null)).toBe("—");
    expect(formatLastSetAt("")).toBe("—");
  });

  test("returns 'just now' under a minute", () => {
    vi.useFakeTimers();
    const now = new Date("2026-05-12T12:00:00.000Z");
    vi.setSystemTime(now);
    expect(formatLastSetAt("2026-05-12T11:59:30.000Z")).toBe("just now");
    vi.useRealTimers();
  });

  test("formats minutes / hours / days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    expect(formatLastSetAt("2026-05-12T11:55:00.000Z")).toBe("5 mins ago");
    expect(formatLastSetAt("2026-05-12T11:00:00.000Z")).toBe("1 hour ago");
    expect(formatLastSetAt("2026-05-12T09:00:00.000Z")).toBe("3 hours ago");
    expect(formatLastSetAt("2026-05-10T12:00:00.000Z")).toBe("2 days ago");
    vi.useRealTimers();
  });

  test("treats SQLite UTC timestamps as UTC instead of local time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T17:30:00.000Z"));
    expect(formatLastSetAt("2026-05-30 17:23:08")).toBe("6 mins ago");
    vi.useRealTimers();
  });

  test("falls back to an absolute YYYY-MM-DD past one week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    expect(formatLastSetAt("2026-05-01T12:00:00.000Z")).toBe("2026-05-01");
    vi.useRealTimers();
  });

  test("returns the raw input on parse failure rather than crashing", () => {
    expect(formatLastSetAt("not-an-iso-date")).toBe("not-an-iso-date");
  });
});

describe("formatNextTokenAt", () => {
  test("formats future token refill times without clamping to just now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    expect(formatNextTokenAt("2026-05-12T12:00:30.000Z")).toBe("in 30s");
    expect(formatNextTokenAt("2026-05-12T12:05:00.000Z")).toBe("in 5 mins");
    expect(formatNextTokenAt("2026-05-12T14:00:00.000Z")).toBe("in 2 hours");
    vi.useRealTimers();
  });

  test("handles empty, past, and invalid token refill times", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    expect(formatNextTokenAt(null)).toBe("soon");
    expect(formatNextTokenAt("")).toBe("soon");
    expect(formatNextTokenAt("2026-05-12T11:59:00.000Z")).toBe("now");
    expect(formatNextTokenAt("not-an-iso-date")).toBe("not-an-iso-date");
    vi.useRealTimers();
  });
});

describe("usage formatting helpers", () => {
  test("formats micro-dollar estimates without hiding sub-cent usage", () => {
    expect(formatCostMicros(null)).toBe("—");
    expect(formatCostMicros(0)).toBe("$0.00");
    expect(formatCostMicros(500)).toBe("<$0.001");
    expect(formatCostMicros(1_958)).toBe("$0.002");
    expect(formatCostMicros(99_400)).toBe("$0.099");
    expect(formatCostMicros(100_000)).toBe("$0.10");
    expect(formatCostMicros(1_250_000)).toBe("$1.25");
  });

  test("formats token counts with grouping", () => {
    expect(formatTokenCount(null)).toBe("—");
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(1234567)).toBe("1,234,567");
  });

  test("formats usage tokens by uncached input, cached input, and output", () => {
    expect(
      formatUsageTokenBreakdown({
        inputTokens: 21_981,
        cachedInputTokens: 2_432,
        outputTokens: 174,
        reasoningOutputTokens: 0
      })
    ).toBe("19,549 uncached in · 2,432 cached · 174 out");
    expect(
      formatUsageTokenBreakdown({
        inputTokens: 1_000,
        cachedInputTokens: 100,
        outputTokens: 300,
        reasoningOutputTokens: 25
      })
    ).toBe("900 uncached in · 100 cached · 300 out (25 reasoning)");
  });
});

describe("SecretKeyControl", () => {
  test("keeps Replace disabled until the user types a replacement key", async () => {
    const { input, primaryButton } = await renderSecretKeyControl(true);

    expect(primaryButton.textContent).toBe("Replace");
    expect(primaryButton.disabled).toBe(true);

    focusInput(input);
    expect(primaryButton.disabled).toBe(true);

    typeIntoInput(input, "sk-new");
    expect(primaryButton.disabled).toBe(false);
  });

  test("keeps Set disabled until the user types a new key", async () => {
    const { input, primaryButton } = await renderSecretKeyControl(false);

    expect(primaryButton.textContent).toBe("Set");
    expect(primaryButton.disabled).toBe(true);

    focusInput(input);
    typeIntoInput(input, "xai-new");
    expect(primaryButton.disabled).toBe(false);
  });
});
