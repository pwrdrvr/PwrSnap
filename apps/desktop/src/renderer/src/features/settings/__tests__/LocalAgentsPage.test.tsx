// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  LocalAgentAuditEntry,
  LocalAgentClientGrant,
  LocalAgentMcpListenerStatus,
  LocalAgentRoleProfile,
  Settings
} from "@pwrsnap/shared";
import { LOCAL_AGENT_BUILT_IN_ROLES } from "@pwrsnap/shared";
import { SettingsContext } from "../SettingsContext";
import type { UseSettingsValue } from "../useSettings";
import { LocalAgentsPage } from "../pages/LocalAgentsPage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

const grant: LocalAgentClientGrant = {
  id: "lag_test",
  name: "PwrAgent",
  roleId: "builtin.full-media",
  capabilities: ["library.read", "capture.composite.read", "capture.original.read"],
  createdAt: "2026-06-07T12:00:00.000Z",
  updatedAt: "2026-06-07T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null
};

const roles: LocalAgentRoleProfile[] = LOCAL_AGENT_BUILT_IN_ROLES.map((role) => ({
  ...role,
  permissions: [...role.permissions],
  budgets: {
    search: { ...role.budgets.search },
    "preview.read": { ...role.budgets["preview.read"] },
    "original.read": { ...role.budgets["original.read"] },
    edit: { ...role.budgets.edit },
    delete: { ...role.budgets.delete }
  }
}));

const baseSettings = {
  localAgents: { enabled: false, grants: [grant], roles, audit: [] }
} as unknown as Settings;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function installFakeApi(
  currentGrant: LocalAgentClientGrant = grant,
  audit: LocalAgentAuditEntry[] = [],
  listenerStatus: LocalAgentMcpListenerStatus = { state: "off" }
): {
  dispatch: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn(async (name: string, req: unknown): Promise<AnyResult> => {
    if (name === "localAgents:list") {
      return { ok: true, value: { grants: [currentGrant], roles, listenerStatus } };
    }
    if (name === "localAgents:audit") return { ok: true, value: { entries: audit } };
    if (name === "localAgents:usage") return { ok: true, value: { entries: [] } };
    if (name === "localAgents:assignRole") {
      const roleId = (req as { roleId: string }).roleId;
      return { ok: true, value: { ...currentGrant, roleId } };
    }
    if (name === "localAgents:roleCreate") {
      return {
        ok: true,
        value: { id: "role_custom", builtIn: false, ...(req as object) }
      };
    }
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

async function renderPage(
  settings: Settings = baseSettings,
  patch: UseSettingsValue["patch"] = vi.fn(async () => undefined)
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const value: UseSettingsValue = {
    settings,
    secrets: {
      openaiApiKey: { configured: false, lastSetAt: null }
    },
    loading: false,
    error: null,
    patch,
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
    await Promise.resolve();
    await Promise.resolve();
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

  test("renders the authorization graph, selected scope, and concrete boundaries", async () => {
    const el = await renderPage();
    expect(el.textContent).toContain("MCP off");
    expect(el.textContent).toContain("PwrAgent");
    expect(el.textContent).toContain("Authorization graph");
    expect(el.textContent).toContain("Full Media");
    expect(el.textContent).toContain("Read original images");
    expect(el.textContent).toContain("Last 30 days");
    expect(el.textContent).toContain("Full-res images");
    expect(el.textContent).toContain("1 approved");
  });

  test("enables MCP access through the settings substrate", async () => {
    const patch = vi.fn(async () => undefined);
    const el = await renderPage(baseSettings, patch);
    const row = Array.from(el.querySelectorAll(".pss__row")).find((candidate) =>
      candidate.textContent?.includes("Enable local-agent access")
    );
    const toggle = row?.querySelector<HTMLButtonElement>("button[role='switch']");

    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle?.click();
    });

    expect(patch).toHaveBeenCalledWith({ localAgents: { enabled: true } });
  });

  test("shows the loopback endpoint only while MCP access is enabled", async () => {
    const enabledSettings = {
      ...baseSettings,
      localAgents: { ...baseSettings.localAgents, enabled: true }
    };
    installFakeApi(grant, [], { state: "listening" });
    const el = await renderPage(enabledSettings);

    expect(el.textContent).toContain("http://127.0.0.1:51729/mcp");
    expect(el.textContent).not.toContain("MCP off");
  });

  test("hands out the Claude Code and Codex connect commands only while listening", async () => {
    const enabledSettings = {
      ...baseSettings,
      localAgents: { ...baseSettings.localAgents, enabled: true }
    };
    installFakeApi(grant, [], { state: "listening" });
    const el = await renderPage(enabledSettings);

    // The exact lines the operator pastes; both verified against the real server.
    expect(el.textContent).toContain(
      "claude mcp add --transport http pwrsnap http://127.0.0.1:51729/mcp"
    );
    expect(el.textContent).toContain("claude mcp login pwrsnap");
    expect(el.textContent).toContain(
      "codex mcp add pwrsnap --url http://127.0.0.1:51729/mcp --oauth-client-registration dcr"
    );

    installFakeApi(grant, [], { state: "off" });
    const offEl = await renderPage(baseSettings);
    expect(offEl.textContent).not.toContain("claude mcp add");
    expect(offEl.textContent).toContain("Turn on local-agent access");
  });

  test("copy button puts the whole command on the clipboard", async () => {
    const enabledSettings = {
      ...baseSettings,
      localAgents: { ...baseSettings.localAgents, enabled: true }
    };
    const { dispatch } = installFakeApi(grant, [], { state: "listening" });
    const el = await renderPage(enabledSettings);

    const button = el.querySelector<HTMLButtonElement>('button[aria-label="Copy Claude Code command"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledWith("clipboard:copyText", {
      text:
        "claude mcp add --transport http pwrsnap http://127.0.0.1:51729/mcp\n" +
        "claude mcp login pwrsnap"
    });
  });

  test("shows enabled intent as unavailable after listener startup fails", async () => {
    const enabledSettings = {
      ...baseSettings,
      localAgents: { ...baseSettings.localAgents, enabled: true }
    };
    installFakeApi(grant, [], { state: "failed" });
    const el = await renderPage(enabledSettings);

    expect(el.textContent).toContain("MCP unavailable");
    expect(el.textContent).toContain("failed to start");
    expect(el.textContent).not.toContain("http://127.0.0.1:51729/mcp");
    expect(el.querySelector("button[role='switch']")?.getAttribute("aria-checked")).toBe("true");
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

  test("role assignment dispatches the selected Session and role", async () => {
    const { dispatch } = installFakeApi();
    const el = await renderPage();
    const select = el.querySelector<HTMLSelectElement>("select[aria-label='Role for PwrAgent']");
    expect(select).not.toBeNull();
    await act(async () => {
      if (select !== null) {
        select.value = "builtin.search";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(dispatch).toHaveBeenCalledWith("localAgents:assignRole", {
      sessionId: "lag_test",
      roleId: "builtin.search"
    });
  });

  test("creates a custom role from the graph", async () => {
    const { dispatch } = installFakeApi();
    const el = await renderPage();
    const createButton = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New custom role")
    );
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Create role");
    const name = el.querySelector<HTMLInputElement>(".pss__role-editor-fields input");
    await act(async () => {
      if (name !== null) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(name, "Codex guarded");
        name.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const save = Array.from(el.querySelectorAll("button")).find((button) => button.textContent === "Save role");
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("localAgents:roleCreate", expect.objectContaining({
      name: "Codex guarded",
      maxCaptureAgeDays: 30
    }));
  });

  test("renders metadata-only agent activity", async () => {
    installFakeApi(grant, [{
      id: "lae_1",
      clientId: grant.id,
      action: "capture.original.read",
      capability: "capture.original.read",
      subjectKind: "capture",
      subjectId: "cap_1",
      outcome: "success",
      occurredAt: "2026-06-07T13:00:00.000Z"
    }]);

    const el = await renderPage();

    expect(el.textContent).toContain("Original image read");
    expect(el.textContent).toContain("cap_1");
    expect(el.textContent).toContain("success");
  });
});
