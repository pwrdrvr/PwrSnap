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

function installFakeApi(): void {
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "darwin",
      dispatch: async () => ({
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
