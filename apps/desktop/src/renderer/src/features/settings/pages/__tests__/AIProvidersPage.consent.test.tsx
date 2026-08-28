// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { AIProvidersPage } from "../AIProvidersPage";
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

function settingsWithConsent(consentAcceptedAt: string | null): Settings {
  return {
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

async function renderPage(consentAcceptedAt: string | null): Promise<HTMLDivElement> {
  installFakeApi();
  contextValue = {
    settings: settingsWithConsent(consentAcceptedAt),
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
    root?.render(createElement(AIProvidersPage));
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

describe("AIProvidersPage — enrichment consent", () => {
  test("renders existing partial settings without a storage section", async () => {
    const page = await renderPage(null);

    expect(page.textContent).toContain("Library Chat");
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
      button("Enable").click();
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
      button("Enable").click();
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
      button("Enable").click();
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
});
