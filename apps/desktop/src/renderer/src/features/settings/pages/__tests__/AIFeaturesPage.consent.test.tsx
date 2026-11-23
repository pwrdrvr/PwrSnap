// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { AIFeaturesPage } from "../AIFeaturesPage";
import { AiProvidersProvider } from "../../AiProvidersContext";
import type { UseSettingsValue } from "../../useSettings";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const patchMock = vi.fn(async (): Promise<void> => undefined);
const refreshCodexMock = vi.fn(async () => null);
const testCodexMock = vi.fn(async () => null);
const replaceSecretMock = vi.fn(async (): Promise<void> => undefined);
const clearSecretMock = vi.fn(async (): Promise<void> => undefined);

let contextValue: UseSettingsValue;

vi.mock("../../SettingsContext", () => ({
  useSettingsContext: (): UseSettingsValue => contextValue
}));

function settingsWithConsent(
  consentAcceptedAt: string | null,
  ai: Partial<Settings["ai"]> = {}
): Settings {
  const settings = {
    schemaVersion: 1,
    codex: {
      mode: "auto",
      pinnedPath: "",
      profile: "",
      captionModel: "gpt-5.4-mini"
    },
    ai: {
      enabled: false,
      consentAcceptedAt,
      budgetSafetyDisabledAt: null,
      autoAcceptSuggestions: false,
      chat: {
        userGuidance: "",
        sensitiveDataPatterns: [],
        defaultRedactionStyle: "blackout",
        firstLaunchBannerDismissed: false
      },
      defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} },
      acp: { enabledAgentIds: [] }
    }
  } as unknown as Settings;
  return { ...settings, ai: { ...settings.ai, ...ai } };
}

/** What `appleFm:status` answers; null answers like every other command
 *  here (unavailable). */
let appleFmStatus: { state: string } | null = null;

function installFakeApi(): void {
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "darwin",
      dispatch: async (channel: string) => (channel === "appleFm:status" && appleFmStatus !== null
        ? { ok: true, value: { modelLabel: null, detail: null, macosVersion: "26.6", checkedAt: 0, ...appleFmStatus } }
        : {
          ok: false,
          error: { kind: "unknown", code: "test_unavailable", message: "unavailable in test" }
        }),
      on: () => () => undefined,
      startCaptureDrag: () => undefined
    }
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderPage(
  consentAcceptedAt: string | null,
  ai: Partial<Settings["ai"]> = {},
  loaded = true
): Promise<HTMLDivElement> {
  installFakeApi();
  contextValue = {
    settings: loaded ? settingsWithConsent(consentAcceptedAt, ai) : null,
    secrets: null,
    loading: false,
    error: null,
    patch: patchMock,
    refreshCodex: refreshCodexMock,
    testCodex: testCodexMock,
    replaceSecret: replaceSecretMock,
    clearSecret: clearSecretMock
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        AiProvidersProvider,
        null,
        createElement(AIFeaturesPage, { sub: null, request: 0 })
      )
    );
  });
  await flushEffects();
  return container;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function enrichSwitch(): HTMLButtonElement {
  const found = container?.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Enrich new captures"]'
  );
  if (found === null || found === undefined) throw new Error("enrichment switch not found");
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  patchMock.mockClear();
  refreshCodexMock.mockClear();
  testCodexMock.mockClear();
  replaceSecretMock.mockClear();
  clearSecretMock.mockClear();
});

describe("AIFeaturesPage — enrichment consent", () => {
  test("renders existing partial settings without a storage section", async () => {
    const page = await renderPage(null);

    expect(page.textContent).toContain("Guidance");
    expect(page.textContent).toContain("Where your chats live.");
  });

  test("does not advertise unavailable semantic search routing", async () => {
    const page = await renderPage(null);

    expect(page.textContent).toContain("Capture captions, tags & OCR");
    expect(page.textContent).not.toContain("Semantic search vectorization");
    expect(page.textContent).not.toContain("Coming soon");
  });

  test("shows the disclosure before first-time enable and Cancel writes nothing", async () => {
    const page = await renderPage(null);

    await act(async () => {
      enrichSwitch().click();
    });

    expect(page.querySelector('[role="dialog"]')).not.toBeNull();
    expect(page.textContent).toContain("downsampled copy of each new screenshot");
    expect(patchMock).not.toHaveBeenCalled();

    await act(async () => {
      button("Cancel").click();
    });
    expect(page.querySelector('[role="dialog"]')).toBeNull();
    expect(patchMock).not.toHaveBeenCalled();
  });

  test("records consent only after the disclosure is accepted", async () => {
    await renderPage(null);

    await act(async () => {
      enrichSwitch().click();
    });
    await act(async () => {
      button("Enable AI enrichment").click();
      await Promise.resolve();
    });

    expect(patchMock).toHaveBeenCalledOnce();
    expect(patchMock).toHaveBeenCalledWith({
      ai: {
        enabled: true,
        budgetSafetyDisabledAt: null,
        consentAcceptedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      }
    });
  });

  test("re-enables directly when consent was already recorded", async () => {
    const page = await renderPage("2026-08-01T12:00:00.000Z");

    await act(async () => {
      enrichSwitch().click();
      await Promise.resolve();
    });

    expect(page.querySelector('[role="dialog"]')).toBeNull();
    expect(patchMock).toHaveBeenCalledWith({
      ai: {
        enabled: true,
        budgetSafetyDisabledAt: null
      }
    });
  });

  test("before settings load, switching on asks for consent instead of enabling blind", async () => {
    const page = await renderPage(null, {}, false);

    await act(async () => {
      enrichSwitch().click();
      await Promise.resolve();
    });

    expect(page.querySelector('[role="dialog"]')).not.toBeNull();
    expect(patchMock).not.toHaveBeenCalled();
  });

  test("enrichment is an on/off switch that reflects the setting", async () => {
    await renderPage("2026-08-01T12:00:00.000Z", { enabled: true });
    expect(enrichSwitch().getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      enrichSwitch().click();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({
      ai: { enabled: false, budgetSafetyDisabledAt: null }
    });
  });

  test("a cost-safety cutoff reads as off, and switching on lifts it", async () => {
    // The budget breaker writes `enabled: false` + a timestamp.
    const page = await renderPage("2026-08-01T12:00:00.000Z", {
      enabled: false,
      budgetSafetyDisabledAt: "2026-09-18T10:00:00.000Z"
    });
    expect(enrichSwitch().getAttribute("aria-checked")).toBe("false");
    expect(page.textContent).toContain("Turned off for cost safety");

    await act(async () => {
      enrichSwitch().click();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({
      ai: { enabled: true, budgetSafetyDisabledAt: null }
    });
  });
});

describe("AIFeaturesPage — enrichment rate limit", () => {
  function field(label: string): HTMLInputElement {
    const found = Array.from(container?.querySelectorAll("label") ?? []).find(
      (candidate) => candidate.textContent?.trim().startsWith(label)
    );
    const input = found?.querySelector("input");
    if (input === null || input === undefined) throw new Error(`field not found: ${label}`);
    return input;
  }

  async function type(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  test("shows the default and applies an override as a pair", async () => {
    await renderPage("2026-10-01T00:00:00.000Z", { enrichmentRateLimit: null });
    expect(field("At once").value).toBe("20");
    expect(field("Per minute").value).toBe("10");
    expect(button("Apply").disabled).toBe(true);

    await type(field("At once"), "60");
    await type(field("Per minute"), "120");
    await act(async () => {
      button("Apply").click();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({ ai: { enrichmentRateLimit: { burst: 60, perMinute: 120 } } });
  });

  test("an out-of-range value cannot be applied", async () => {
    await renderPage("2026-10-01T00:00:00.000Z", { enrichmentRateLimit: null });
    await type(field("Per minute"), "0");
    expect(button("Apply").disabled).toBe(true);
    expect(container?.textContent).toContain("Whole numbers");
  });

  test("Use default clears an override to null", async () => {
    await renderPage("2026-10-01T00:00:00.000Z", { enrichmentRateLimit: { burst: 60, perMinute: 120 } });
    expect(field("At once").value).toBe("60");
    await act(async () => {
      button("Use default").click();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({ ai: { enrichmentRateLimit: null } });
  });
});

describe("AIFeaturesPage — caption fallback", () => {
  const MODEL_ID = "12345678-1234-4234-8234-123456789001";
  const CONNECTION_ID = "12345678-1234-4234-8234-123456789003";
  const localPrimary: Partial<Settings["ai"]> = {
    defaults: { libraryChat: {}, sizzleChat: {}, enrichment: { provider: `custom:${MODEL_ID}` } },
    customConnections: [{ id: CONNECTION_ID, name: "Local llama.cpp", baseUrl: "http://127.0.0.1:8080/v1",
      protocol: "openai-chat", auth: { type: "none" } }],
    customModels: [{ id: MODEL_ID, connectionId: CONNECTION_ID, displayName: "qwen3-vl-8b",
      modelId: "qwen3-vl-8b-instruct", capabilities: { vision: true, streaming: true }, maxOutputTokens: 1024 }]
  } as unknown as Partial<Settings["ai"]>;

  function fallbackSwitch(): HTMLButtonElement | null {
    return container?.querySelector<HTMLButtonElement>('[role="switch"][aria-label^="Fall back when"]') ?? null;
  }

  afterEach(() => {
    appleFmStatus = null;
  });

  function fallbackProvider(): HTMLSelectElement | null {
    return container?.querySelector<HTMLSelectElement>('[aria-label="Caption fallback provider"]') ?? null;
  }

  const lunaPrimary: Partial<Settings["ai"]> = {
    defaults: { libraryChat: {}, sizzleChat: {}, enrichment: { provider: "codex", model: "gpt-6-luna" } }
  } as unknown as Partial<Settings["ai"]>;

  const applePrimary: Partial<Settings["ai"]> = {
    defaults: { libraryChat: {}, sizzleChat: {}, enrichment: { provider: "apple:system" } }
  };

  test("a saved Codex choice requires explicit off-device approval for Apple refusals", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", { ...applePrimary, enrichmentFallback: {} });
    expect(fallbackSwitch()?.getAttribute("aria-label")).toBe("Fall back when Apple Intelligence refuses a caption");
    expect(fallbackSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(fallbackProvider()?.value).toBe("");
    const descriptionId = fallbackSwitch()?.getAttribute("aria-describedby");
    expect(document.getElementById(descriptionId ?? "")?.textContent)
      .toContain("send the capture to Codex for processing off this Mac");
    expect(patchMock).not.toHaveBeenCalled();
    await act(async () => { fallbackSwitch()?.click(); });
    expect(patchMock).toHaveBeenCalledWith({ ai: { appleRefusalFallbackConsent: '["codex",""]' } });
  });

  test("with no saved Apple fallback, offers a choice without selecting Codex", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", { ...localPrimary, ...applePrimary });
    expect(fallbackSwitch()?.disabled).toBe(true);
    expect(fallbackProvider()?.selectedOptions[0]?.textContent).toBe("Choose a model");
    await act(async () => {
      const select = fallbackProvider()!;
      select.value = `custom:${MODEL_ID}`;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(patchMock).toHaveBeenCalledWith({ ai: {
      enrichmentFallback: { provider: `custom:${MODEL_ID}`, model: "", reasoning: "" }
    } });
  });

  test("turning off an approved Apple fallback preserves its configuration", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", {
      ...applePrimary, enrichmentFallback: {}, appleRefusalFallbackConsent: '["codex",""]'
    });
    expect(fallbackSwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(container?.textContent).toContain("This model runs on this Mac");
    expect(container?.textContent).toContain("PwrSnap goes straight to the fallback after a refusal");
    expect(container?.textContent).toContain("send the capture to Codex for processing off this Mac");
    await act(async () => { fallbackSwitch()?.click(); });
    expect(patchMock).toHaveBeenCalledWith({ ai: { enrichmentFallbackPaused: true } });
  });

  test.each([
    { primary: applePrimary, provider: "", model: "gpt-5.4-mini", approval: '["codex","gpt-5.4-mini"]' },
    { primary: localPrimary, provider: "", model: "gpt-5.4-mini", approval: null },
    { primary: lunaPrimary, provider: "apple:system", model: "", approval: null }
  ])("a paused fallback keeps $provider and $model selected and can resume", async ({ primary, provider, model, approval }) => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", {
      ...primary, enrichmentFallback: { provider, model }, appleRefusalFallbackConsent: approval,
      enrichmentFallbackPaused: true
    });
    expect(fallbackSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(fallbackProvider()?.value).toBe(provider);
    const modelPicker = container?.querySelector<HTMLSelectElement>('[aria-label="Caption fallback model"]');
    expect(modelPicker?.value).toBe(model);
    await act(async () => { fallbackSwitch()?.click(); });
    expect(patchMock).toHaveBeenCalledWith({ ai: { enrichmentFallbackPaused: false } });
  });

  test("a saved loopback fallback is active for refusals without an off-device prompt", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", {
      ...localPrimary, ...applePrimary, enrichmentFallback: { provider: `custom:${MODEL_ID}` }
    });
    expect(fallbackSwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(container?.querySelector('[aria-label="Caption order"]')?.textContent).toContain("when Apple refuses");
    expect(container?.textContent).not.toContain("processing off this Mac");
  });

  test("an inherited Apple fallback cannot stand in for Apple", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", {
      ...applePrimary, enrichmentFallback: { provider: "apple:system" }
    });
    expect(fallbackSwitch()?.disabled).toBe(true);
    expect(fallbackSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(fallbackProvider()?.selectedOptions[0]?.textContent).toBe("Choose a model");
  });

  test("behind Codex it is the offline fallback, and turning it on picks Apple Intelligence", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", lunaPrimary);
    expect(container?.textContent).toContain("If Codex is offline");
    expect(fallbackSwitch()?.getAttribute("aria-label")).toBe("Fall back when Codex is offline");
    expect(fallbackSwitch()?.disabled).toBe(false);
    await act(async () => {
      fallbackSwitch()?.click();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({ ai: { enrichmentFallback: { provider: "apple:system" } } });
  });

  test("Luna → Apple: no Codex in the picker, the order, and the offline-only rule", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", { ...lunaPrimary, enrichmentFallback: { provider: "apple:system" } });
    const provider = fallbackProvider();
    expect(provider?.value).toBe("apple:system");
    expect(Array.from(provider?.options ?? []).map((o) => o.value)).not.toContain("");
    const order = container?.querySelector('[aria-label="Caption order"]');
    expect(order?.textContent).toContain("1 Codex · gpt-6-luna");
    expect(order?.textContent).toContain("2 Apple Intelligence when offline");
    expect(container?.textContent).toContain("Sign-in, plan limits, timeouts, bad output and Codex setup problems still fail");
    expect(container?.textContent).toContain("This model runs on this Mac");
    expect(container?.querySelector(".pss__role-fallback-note--warn")).toBeNull();
  });

  test("a saved Apple fallback that isn't ready stays selected and says why", async () => {
    appleFmStatus = { state: "license-required" };
    await renderPage("2026-10-01T00:00:00.000Z", { ...lunaPrimary, enrichmentFallback: { provider: "apple:system" } });
    expect(fallbackProvider()?.value).toBe("apple:system");
    expect(container?.querySelector(".pss__role-fallback-note--warn")?.textContent)
      .toContain("isn't ready on this Mac (terms not agreed)");
  });

  test("with no model on this Mac to pick, the switch is disabled and says why", async () => {
    appleFmStatus = { state: "license-required" };
    await renderPage("2026-10-01T00:00:00.000Z", lunaPrimary);
    expect(fallbackSwitch()?.disabled).toBe(true);
    expect(container?.textContent).toContain(
      "Nothing here captions without a network. Apple Intelligence isn't ready on this Mac (terms not agreed)");
    await act(async () => {
      fallbackSwitch()?.click();
      await Promise.resolve();
    });
    expect(patchMock).not.toHaveBeenCalled();
  });

  test("a disabled ACP agent's primary is named as Codex, which is what runs", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", {
      defaults: { libraryChat: {}, sizzleChat: {}, enrichment: { provider: "acp:qwen" } },
      enrichmentFallback: { provider: "apple:system" }
    } as unknown as Partial<Settings["ai"]>);
    expect(container?.textContent).toContain("If Codex is offline, use");
    expect(container?.querySelector('[aria-label="Caption order"]')?.textContent).toContain("1 Codex");
  });

  test("a stale Codex fallback behind Codex is flagged, not shown as Codex", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", { ...lunaPrimary, enrichmentFallback: {} });
    expect(fallbackProvider()?.selectedOptions[0]?.textContent).toBe("Choose a model");
    expect(container?.querySelector('[aria-label="Caption fallback model"]')).toBeNull();
    expect(container?.querySelector(".pss__role-fallback-note--warn")?.textContent)
      .toContain("Codex can't stand in for itself");
  });

  test("a remote fallback behind Codex warns it won't caption offline", async () => {
    appleFmStatus = { state: "ready" };
    await renderPage("2026-10-01T00:00:00.000Z", {
      ...lunaPrimary,
      customConnections: [{ id: CONNECTION_ID, name: "Team gateway", baseUrl: "https://models.example.test/v1",
        protocol: "openai-chat", auth: { type: "none" } }],
      customModels: [{ id: MODEL_ID, connectionId: CONNECTION_ID, displayName: "vision-large",
        modelId: "vision-large", capabilities: { vision: true, streaming: true }, maxOutputTokens: 1024 }],
      enrichmentFallback: { provider: `custom:${MODEL_ID}` }
    } as unknown as Partial<Settings["ai"]>);
    expect(container?.querySelector(".pss__role-fallback-note--warn")?.textContent)
      .toContain("vision-large needs a network too, so it can't caption while this Mac is offline");
  });

  test("is off by default under a Direct API primary, and turns on from {}", async () => {
    await renderPage("2026-10-01T00:00:00.000Z", localPrimary);
    expect(container?.textContent).toContain("If qwen3-vl-8b can't be reached");
    expect(fallbackSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(container?.querySelector('[aria-label="Caption fallback provider"]')).toBeNull();
    await act(async () => {
      fallbackSwitch()?.click();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({ ai: { enrichmentFallback: {} } });
  });

  test("when on, offers every backend but the primary and says the image leaves this Mac", async () => {
    await renderPage("2026-10-01T00:00:00.000Z", { ...localPrimary, enrichmentFallback: {} });
    expect(fallbackSwitch()?.getAttribute("aria-checked")).toBe("true");
    const provider = container?.querySelector<HTMLSelectElement>('[aria-label="Caption fallback provider"]');
    expect(provider?.value).toBe("");
    expect(Array.from(provider?.options ?? []).map((o) => o.value)).not.toContain(`custom:${MODEL_ID}`);
    expect(container?.textContent).toContain("goes to Codex instead of staying on this Mac");
    await act(async () => {
      fallbackSwitch()?.click();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({ ai: { enrichmentFallbackPaused: true } });
  });

  test("a field change patches the fallback, not the primary", async () => {
    await renderPage("2026-10-01T00:00:00.000Z", { ...localPrimary, enrichmentFallback: {} });
    const reasoning = container?.querySelector<HTMLSelectElement>('[aria-label="Caption fallback reasoning effort"]');
    expect(reasoning).not.toBeNull();
    await act(async () => {
      reasoning!.value = "medium";
      reasoning!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith({ ai: { enrichmentFallback: { reasoning: "medium" } } });
  });
});
