// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { LocalAgentClientGrant, Settings } from "@pwrsnap/shared";
import { SettingsContext } from "../SettingsContext";
import type { UseSettingsValue } from "../useSettings";
import { LocalAgentsPage } from "../pages/LocalAgentsPage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

const grant: LocalAgentClientGrant = {
  id: "lag_test",
  name: "PwrAgent",
  capabilities: ["library.read", "capture.composite.read", "capture.original.read"],
  createdAt: "2026-06-07T12:00:00.000Z",
  updatedAt: "2026-06-07T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null
};

const baseSettings = {
  localAgents: { grants: [grant] }
} as Settings;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function installFakeApi(currentGrant: LocalAgentClientGrant = grant): {
  dispatch: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn(async (name: string, req: unknown): Promise<AnyResult> => {
    if (name === "localAgents:list") return { ok: true, value: { grants: [currentGrant] } };
    if (name === "localAgents:revoke") {
      return {
        ok: true,
        value: {
          ...currentGrant,
          revokedAt: "2026-06-07T13:00:00.000Z",
          updatedAt: "2026-06-07T13:00:00.000Z"
        }
      };
    }
    return { ok: true, value: undefined };
  });
  (globalThis as unknown as { window: Window }).window = (globalThis as unknown as {
    window: Window;
  }).window ?? ({} as Window);
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on: () => () => undefined,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return { dispatch };
}

async function renderPage(settings: Settings = baseSettings): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const value: UseSettingsValue = {
    settings,
    secrets: {
      grokApiKey: { configured: false, lastSetAt: null },
      openaiApiKey: { configured: false, lastSetAt: null }
    },
    loading: false,
    error: null,
    patch: vi.fn(),
    refreshCodex: vi.fn(),
    testCodex: vi.fn(),
    replaceSecret: vi.fn(),
    clearSecret: vi.fn()
  };
  await act(async () => {
    root?.render(
      createElement(
        SettingsContext.Provider,
        { value },
        createElement(LocalAgentsPage)
      )
    );
  });
  return container;
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("LocalAgentsPage", () => {
  beforeEach(() => {
    installFakeApi();
  });

  test("renders paired clients and sensitive capability labels", async () => {
    const el = await renderPage();
    expect(el.textContent).toContain("PwrAgent");
    expect(el.textContent).toContain("Original images");
    expect(el.textContent).toContain("sensitive");
    expect(el.textContent).toContain("1 active");
  });

  test("revoke button dispatches localAgents:revoke", async () => {
    const { dispatch } = installFakeApi();
    const el = await renderPage();
    const button = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Revoke")
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("localAgents:revoke", { id: "lag_test" });
    expect(el.textContent).toContain("Revoked");
  });
});
