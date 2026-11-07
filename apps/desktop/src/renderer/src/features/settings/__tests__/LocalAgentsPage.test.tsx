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
  localAgents: { enabled: false, grants: [grant], roles, audit: [], retainedOAuthClients: [] }
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
      return { ok: true, value: { grants: [currentGrant], roles, listenerStatus, httpUrl: "unix:///tmp/fixture.sock#/mcp" } };
    }
    if (name === "localAgents:audit") return { ok: true, value: { entries: audit } };
    if (name === "localAgents:usage") return { ok: true, value: { entries: [] } };
    if (name === "localAgents:httpBootstrap") return { ok: true, value: { token: "fixture-secret-never-in-config", expiresAt: new Date(Date.now() + 120_000).toISOString(), httpUrl: "unix:///tmp/fixture.sock#/mcp" } };
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
  // A test that renders twice must not leave the first page mounted in
  // document.body for every test after it — afterEach only sees the last.
  if (root !== null) {
    const previous = root;
    act(() => previous.unmount());
    container?.remove();
  }
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

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function buttonNamed(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(el.querySelectorAll("button")).find((b) => b.textContent === text);
}

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

  test("shows local IPC connection status only while MCP access is enabled", async () => {
    const enabledSettings = {
      ...baseSettings,
      localAgents: { ...baseSettings.localAgents, enabled: true }
    };
    installFakeApi(grant, [], { state: "listening" });
    const el = await renderPage(enabledSettings);

    expect(el.textContent).toContain("Local IPC MCP");
    expect(el.textContent).not.toContain("MCP off");
  });

  test("hands out the Claude Code and Codex connect commands only while listening", async () => {
    const enabledSettings = {
      ...baseSettings,
      localAgents: { ...baseSettings.localAgents, enabled: true }
    };
    installFakeApi(grant, [], { state: "listening" });
    const el = await renderPage(enabledSettings);

    // The exact lines the operator pastes; both verified against the real
    // server. `--scope user`: without it Claude Code registers the server for
    // the terminal's current directory only.
    expect(el.textContent).toContain(
      "claude mcp add --scope user --transport stdio pwrsnap -- pwrsnap-mcp"
    );
    expect(el.textContent).not.toContain("claude mcp login pwrsnap");
    expect(el.textContent).toContain(
      "codex mcp add pwrsnap -- pwrsnap-mcp"
    );

    installFakeApi(grant, [], { state: "off" });
    const offEl = await renderPage(baseSettings);
    expect(offEl.textContent).not.toContain("claude mcp add");
    expect(offEl.textContent).toContain("Turn on local-agent access");
    // The first render was unmounted, not left behind in document.body.
    expect(document.body.children).toHaveLength(1);
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
        "claude mcp add --scope user --transport stdio pwrsnap -- pwrsnap-mcp"
    });
    // The visible label and the accessible name change together.
    expect(button?.textContent).toBe("Copied");
    expect(button?.getAttribute("aria-label")).toBe("Copied Claude Code command");
  });

  test("direct HTTP bootstrap uses native approval and copies the secret separately from configuration", async () => {
    const { dispatch } = installFakeApi(grant, [], { state: "listening" });
    const el = await renderPage({ ...baseSettings, localAgents: { ...baseSettings.localAgents, enabled: true } });
    expect(el.textContent).toContain("unix:///tmp/fixture.sock#/mcp");
    expect(el.textContent).toContain("Bearer ${input:pwrsnap-http-token}");
    expect(el.textContent).not.toContain("fixture-secret");
    await act(async () => { Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Create HTTP Session")!.click(); });
    expect(dispatch).toHaveBeenCalledWith("localAgents:httpBootstrap", {});
    expect(el.textContent).not.toContain("fixture-secret");
    await act(async () => { Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Copy HTTP credential")!.click(); });
    expect(dispatch).toHaveBeenCalledWith("clipboard:copyText", { text: "fixture-secret-never-in-config" });
    await act(async () => { Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Hide credential")!.click(); });
    expect(el.textContent).not.toContain("Copy HTTP credential");
    expect(el.querySelector("pre")?.textContent).not.toContain("fixture-secret");
  });

  test("a failed copy stays on the button and never reaches the page error banner", async () => {
    const enabledSettings = {
      ...baseSettings,
      localAgents: { ...baseSettings.localAgents, enabled: true }
    };
    const { dispatch } = installFakeApi(grant, [], { state: "listening" });
    dispatch.mockImplementation(async (name: string): Promise<AnyResult> => {
      if (name === "clipboard:copyText") {
        return { ok: false, error: { message: "clipboard unavailable" } };
      }
      if (name === "localAgents:list") {
        return { ok: true, value: { grants: [grant], roles, listenerStatus: { state: "listening" } } };
      }
      return { ok: true, value: { entries: [] } };
    });
    const el = await renderPage(enabledSettings);

    const button = el.querySelector<HTMLButtonElement>('button[aria-label="Copy Codex CLI command"]');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(button?.textContent).toBe("Copy failed");
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).not.toContain("Local agent update failed");
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
    expect(el.textContent).not.toContain("Local IPC MCP");
    expect(el.querySelector("button[role='switch']")?.getAttribute("aria-checked")).toBe("true");
    // The switch is already on, so the connect card must not say to turn it on.
    expect(el.textContent).not.toContain("Turn on local-agent access");
    expect(el.textContent).toContain("failed to start, so there is nothing to connect to yet");
  });

  test("revoking an active Session takes a second press in the card", async () => {
    const { dispatch } = installFakeApi();
    const el = await renderPage();
    const arm = buttonNamed(el, "Revoke…");
    await act(async () => {
      arm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatch).not.toHaveBeenCalledWith("localAgents:revoke", expect.anything());
    expect(el.textContent).toContain("loses access now");
    // The confirm takes focus so a keyboard user lands on the safe choice.
    expect(document.activeElement?.textContent).toBe("Cancel");

    await act(async () => {
      buttonNamed(el, "Cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("loses access now");
    expect(document.activeElement?.textContent).toBe("Revoke…");

    await act(async () => {
      buttonNamed(el, "Revoke…")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      buttonNamed(el, "Revoke access")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("localAgents:revoke", { id: "lag_test" });
    expect(document.activeElement?.textContent).toBe("Remove");
    // Now in the revoked group: no role picker, and Remove is offered.
    expect(el.textContent).toContain("Revoked · 1");
    expect(el.querySelector("select[aria-label='Role for PwrAgent']")).toBeNull();
    expect(buttonNamed(el, "Remove")).toBeDefined();
  });

  test("revoked Sessions sit below active ones, named apart, and can be removed", async () => {
    const sessions: LocalAgentClientGrant[] = [
      { ...grant, id: "lag_old_a93f", revokedAt: "2026-06-07T13:00:00.000Z" },
      { ...grant, id: "lag_new_7c1e", createdAt: "2026-06-07T14:00:00.000Z" },
      { ...grant, id: "lag_old_52d0", name: "PwrAgent 2", revokedAt: "2026-06-07T13:05:00.000Z" }
    ];
    const dispatch = vi.fn(async (name: string, req: unknown): Promise<AnyResult> => {
      if (name === "localAgents:list") {
        return { ok: true, value: { grants: sessions, roles, listenerStatus: { state: "off" } } };
      }
      if (name === "localAgents:audit") return { ok: true, value: { entries: [] } };
      if (name === "localAgents:usage") return { ok: true, value: { entries: [] } };
      if (name === "localAgents:remove") {
        return { ok: true, value: { removedIds: [(req as { id: string }).id] } };
      }
      if (name === "localAgents:removeRevoked") {
        return { ok: true, value: { removedIds: ["lag_old_52d0"] } };
      }
      return { ok: true, value: undefined };
    });
    (window as Window).pwrsnapApi = {
      dispatch,
      on: () => () => undefined,
      startCaptureDrag: () => undefined
    } as unknown as NonNullable<Window["pwrsnapApi"]>;
    const el = await renderPage();

    const cards = Array.from(el.querySelectorAll(".pss__auth-node.is-session"));
    expect(cards.map((card) => card.querySelector("h3")?.textContent)).toEqual([
      "PwrAgent", "PwrAgent 2", "PwrAgent"
    ]);
    expect(cards[0]?.textContent).toContain("ID 7c1e");
    expect(cards[0]?.textContent).toContain("active");
    // Newest revoke first; each revoked card carries its own id tail.
    expect(cards[1]?.textContent).toContain("ID 52d0");
    expect(cards[2]?.textContent).toContain("ID a93f");
    expect(el.querySelectorAll("select[aria-label='Role for PwrAgent']")).toHaveLength(1);
    expect(el.textContent).toContain("Revoked · 2");
    // An active Session never offers Remove.
    expect(cards[0]?.querySelector("button[aria-label^='Remove']")).toBeNull();

    const removeOne = el.querySelector<HTMLButtonElement>(
      "button[aria-label='Remove revoked Session PwrAgent (ID a93f)']"
    );
    await act(async () => {
      removeOne?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("localAgents:remove", { id: "lag_old_a93f" });
    expect(el.textContent).toContain("Revoked · 1");
    expect(el.textContent).not.toContain("ID a93f");
    // Focus moves to the next revoked card's Remove, not to the document body.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Remove revoked Session PwrAgent 2 (ID 52d0)"
    );

    await act(async () => {
      buttonNamed(el, "Remove all")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatch).not.toHaveBeenCalledWith("localAgents:removeRevoked", expect.anything());
    await act(async () => {
      buttonNamed(el, "Remove 1")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("localAgents:removeRevoked", {});
    expect(el.textContent).not.toContain("Revoked ·");
    expect(el.querySelectorAll(".pss__auth-node.is-session")).toHaveLength(1);
    expect(el.textContent).toContain("ID 7c1e");
  });

  test("a failed revoke keeps the confirm open", async () => {
    const { dispatch } = installFakeApi();
    dispatch.mockImplementation(async (name: string): Promise<AnyResult> => {
      if (name === "localAgents:list") {
        return { ok: true, value: { grants: [grant], roles, listenerStatus: { state: "off" } } };
      }
      if (name === "localAgents:revoke") return { ok: false, error: { message: "disk full" } };
      return { ok: true, value: { entries: [] } };
    });
    const el = await renderPage();
    await act(async () => {
      buttonNamed(el, "Revoke…")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      buttonNamed(el, "Revoke access")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("disk full");
    expect(buttonNamed(el, "Revoke access")).toBeDefined();
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

test("the graph and live scope retain the native consent ceiling after a role is widened",async()=>{
  const approved=roles[0];
  installFakeApi({...grant,roleId:"builtin.full-access",nativeConsent:{capabilities:[...approved.permissions],maxCaptureAgeDays:7,budgets:approved.budgets}});
  const el=await renderPage();
  const scope=Array.from(el.querySelectorAll(".pss__card")).find((card)=>card.textContent?.includes("LIVE SCOPE"));
  expect(scope?.textContent).toContain("Last 7 days");
  expect(scope?.textContent).toContain("0 / 50");
  expect(scope?.textContent).toContain("Reconnect and approve a new Session");
  const allowed=el.querySelectorAll(".is-permission.is-allowed");
  expect(allowed).toHaveLength(1);expect(allowed[0].textContent).toContain("Search library");
});
