// @vitest-environment jsdom
//
// The AI Providers sidebar children and the per-provider screens they open.
// Both render through the real `AiProvidersProvider`, so these tests pin the
// thing that matters most: the sidebar and the page read ONE status.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AcpAgentDiscovery, DesktopCodexDiscoverySnapshot, Settings } from "@pwrsnap/shared";
import { AiProvidersProvider } from "../AiProvidersContext";
import { AIProvidersPage } from "../pages/AIProvidersPage";
import { Sidebar } from "../Sidebar";
import type { SecretMap, UseSettingsValue } from "../useSettings";
import { baseSettings } from "./settings-fixture";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let contextValue: UseSettingsValue;
vi.mock("../SettingsContext", () => ({
  useSettingsContext: (): UseSettingsValue => contextValue
}));

const CODEX: DesktopCodexDiscoverySnapshot = {
  candidates: [
    { path: "/opt/homebrew/bin/codex", source: "path", version: "0.148.0", available: true }
  ],
  resolvedPath: "/opt/homebrew/bin/codex",
  auth: { status: "authenticated", testedAt: "2026-09-17T00:00:00.000Z", durationMs: 9 },
  refreshedAt: "2026-09-17T00:00:00.000Z"
};

// Kimi: enabled + installed. Qwen: enabled, NOT installed. Grok: installed,
// not enabled. Gemini: neither. OpenAI: no key.
const DISCOVERY: AcpAgentDiscovery = {
  agents: [
    { id: "gemini", displayName: "Gemini CLI", installed: false, instances: [] },
    {
      id: "grok",
      displayName: "Grok",
      installed: true,
      version: "0.9.1",
      instances: [{ command: "/usr/local/bin/grok", source: "path", version: "0.9.1" }],
      activeCommand: "/usr/local/bin/grok"
    },
    {
      id: "kimi",
      displayName: "Kimi Code CLI",
      installed: true,
      version: "1.4.0",
      instances: [{ command: "/usr/local/bin/kimi", source: "path", version: "1.4.0" }],
      activeCommand: "/usr/local/bin/kimi"
    },
    { id: "qwen", displayName: "Qwen Code", installed: false, instances: [] }
  ]
};

const SECRETS = {
  openaiApiKey: { configured: false, lastSetAt: null }
} as unknown as SecretMap;

const refreshCodexMock = vi.fn(async (): Promise<DesktopCodexDiscoverySnapshot | null> => CODEX);
const dispatchCalls: Array<{ name: string; req: unknown }> = [];
let modelsProbeFails = false;

function installFakeApi(): void {
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "darwin",
      dispatch: async (name: string, req: unknown) => {
        dispatchCalls.push({ name, req });
        if (name === "acp:discover") return { ok: true, value: DISCOVERY };
        if (name === "acp:models") {
          return modelsProbeFails
            ? { ok: false, error: { kind: "acp", code: "auth", message: "Kimi is not logged in" } }
            : { ok: true, value: { agentId: "kimi", models: [] } };
        }
        return {
          ok: false,
          error: { kind: "unknown", code: "test_unavailable", message: "unavailable in test" }
        };
      },
      on: () => () => undefined,
      startCaptureDrag: () => undefined
    }
  });
}

function settings(overrides: Partial<Settings["ai"]> = {}): Settings {
  return {
    ...baseSettings,
    ai: {
      ...baseSettings.ai,
      acp: { enabledAgentIds: ["kimi", "qwen"] },
      ...overrides
    }
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(element: ReactElement, s: Settings = settings()): Promise<HTMLDivElement> {
  installFakeApi();
  contextValue = {
    settings: s,
    secrets: SECRETS,
    loading: false,
    error: null,
    patch: vi.fn(async () => undefined),
    refreshCodex: refreshCodexMock,
    testCodex: vi.fn(async () => null),
    replaceSecret: vi.fn(async () => undefined),
    clearSecret: vi.fn(async () => undefined)
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AiProvidersProvider, null, element));
  });
  await flush();
  return container;
}

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => {
    root?.render(createElement(AiProvidersProvider, null, element));
  });
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error("element not found");
  await act(async () => {
    el.click();
  });
  await flush();
}

function subRow(label: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll<HTMLButtonElement>(".pss__sb-sub") ?? []).find(
    (b) => b.querySelector(".pss__sb-sublabel")?.textContent === label
  );
  if (found === undefined) throw new Error(`sidebar child not found: ${label}`);
  return found;
}

function dotTone(row: Element): string | null {
  const dot = row.querySelector(".pss__status-dot");
  const tone = Array.from(dot?.classList ?? []).find((c) => c.startsWith("pss__status-dot--"));
  return tone === undefined ? null : tone.slice("pss__status-dot--".length);
}

function chip(row: Element): string | null {
  return row.querySelector(".pss__sb-subchip")?.textContent ?? null;
}

function aiParent(): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll<HTMLButtonElement>(".pss__sb-nav") ?? []).find(
    (b) => b.textContent === "AI Providers"
  );
  if (found === undefined) throw new Error("AI Providers nav row not found");
  return found;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  dispatchCalls.length = 0;
  modelsProbeFails = false;
  refreshCodexMock.mockClear();
  window.location.hash = "";
  Reflect.deleteProperty(window, "pwrsnapApi");
});

describe("Settings sidebar — AI Providers children", () => {
  test("reads no provider status until the group is opened", async () => {
    const page = await render(createElement(Sidebar, { active: "general", sub: null }));

    // Opening Settings on General must not start discovery — that is the
    // footprint the page had before this state was lifted out of it.
    expect(refreshCodexMock).not.toHaveBeenCalled();
    expect(dispatchCalls.filter((c) => c.name === "acp:discover")).toEqual([]);
    const sublist = page.querySelector("#pss-sb-sublist-ai");
    expect(sublist?.getAttribute("aria-hidden")).toBe("true");

    await click(page.querySelector('button[aria-label="Expand AI Providers"]'));

    expect(sublist?.getAttribute("aria-hidden")).toBe("false");
    // Cache-served reads only: the sidebar never forces a scan.
    expect(refreshCodexMock).toHaveBeenCalledWith(false);
    expect(dispatchCalls.filter((c) => c.name === "acp:discover")).toEqual([
      { name: "acp:discover", req: { force: false } }
    ]);
    // And it never spawns an agent to probe models.
    expect(dispatchCalls.some((c) => c.name === "acp:models")).toBe(false);
  });

  test("each child shows its status as a dot AND a word", async () => {
    await render(createElement(Sidebar, { active: "ai", sub: null }));

    const labels = Array.from(container?.querySelectorAll(".pss__sb-sublabel") ?? []).map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["Codex", "Grok", "Kimi Code CLI", "Qwen Code", "Gemini CLI", "OpenAI"]);

    expect([dotTone(subRow("Codex")), chip(subRow("Codex"))]).toEqual(["ok", null]);
    expect([dotTone(subRow("Kimi Code CLI")), chip(subRow("Kimi Code CLI"))]).toEqual(["ok", null]);
    // Enabled but not installed: on and broken.
    expect([dotTone(subRow("Qwen Code")), chip(subRow("Qwen Code"))]).toEqual(["bad", "missing"]);
    // Installed but not enabled: available, just off.
    expect([dotTone(subRow("Grok")), chip(subRow("Grok"))]).toEqual(["off", "off"]);
    expect([dotTone(subRow("Gemini CLI")), chip(subRow("Gemini CLI"))]).toEqual(["off", "missing"]);
    expect([dotTone(subRow("OpenAI")), chip(subRow("OpenAI"))]).toEqual(["off", "no key"]);
  });

  test("the active child is marked; collapsing hands the marker to the parent", async () => {
    await render(createElement(Sidebar, { active: "ai", sub: "codex" }));

    expect(subRow("Codex").getAttribute("aria-current")).toBe("page");
    expect(aiParent().getAttribute("aria-current")).toBeNull();

    await click(container?.querySelector('button[aria-label="Collapse AI Providers"]'));

    // The child is now inside an inert, aria-hidden list — the nav must
    // still say where the operator is.
    expect(aiParent().getAttribute("aria-current")).toBe("page");
  });

  test("a child routes to its provider screen", async () => {
    await render(createElement(Sidebar, { active: "ai", sub: null }));
    await click(subRow("Kimi Code CLI"));
    expect(window.location.hash).toBe("#stage=settings&page=ai&sub=kimi");
  });

  test("a change to a setting discovery depends on re-reads it", async () => {
    await render(createElement(Sidebar, { active: "ai", sub: null }));
    expect(refreshCodexMock).toHaveBeenCalledTimes(1);
    const acpReads = (): number => dispatchCalls.filter((c) => c.name === "acp:discover").length;
    expect(acpReads()).toBe(1);

    // Pinning a Codex path moves the Codex publication's fingerprint.
    contextValue = {
      ...contextValue,
      settings: { ...contextValue.settings!, codex: { ...contextValue.settings!.codex, mode: "pinned", pinnedPath: "/tmp/nope/codex" } }
    };
    await rerender(createElement(Sidebar, { active: "ai", sub: null }));
    expect(refreshCodexMock).toHaveBeenCalledTimes(2);
    expect(refreshCodexMock).toHaveBeenLastCalledWith(false);
    expect(acpReads()).toBe(1);

    // Enabling an agent is NOT a discovery input — the status derivation
    // applies enablement — so it must not cost a re-read.
    const s = contextValue.settings!;
    contextValue = {
      ...contextValue,
      settings: { ...s, ai: { ...s.ai, acp: { ...s.ai.acp, enabledAgentIds: ["kimi"] } } }
    };
    await rerender(createElement(Sidebar, { active: "ai", sub: null }));
    expect(acpReads()).toBe(1);
    expect([dotTone(subRow("Qwen Code")), chip(subRow("Qwen Code"))]).toEqual(["off", "missing"]);

    // Picking an agent install is.
    const s2 = contextValue.settings!;
    contextValue = {
      ...contextValue,
      settings: {
        ...s2,
        ai: {
          ...s2.ai,
          acp: { ...s2.ai.acp, agents: { kimi: { selectedPath: "/usr/local/bin/kimi" } } }
        }
      }
    };
    await rerender(createElement(Sidebar, { active: "ai", sub: null }));
    expect(dispatchCalls.filter((c) => c.name === "acp:discover").at(-1)).toEqual({
      name: "acp:discover",
      req: { force: false }
    });
    expect(acpReads()).toBe(2);
  });

  test("an older Codex read that resolves last cannot overwrite a newer one", async () => {
    // First read (the sidebar's) is slow and would report "missing"; a newer
    // forced read reports the binary. The old answer must not win.
    let releaseFirst: (value: DesktopCodexDiscoverySnapshot | null) => void = () => undefined;
    refreshCodexMock
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          releaseFirst = resolve;
        })
      )
      .mockImplementationOnce(async () => CODEX);
    await render(
      createElement(
        "div",
        null,
        createElement(Sidebar, { active: "ai", sub: "codex" }),
        createElement(AIProvidersPage, { sub: "codex" })
      )
    );
    // The Codex card's Refresh (labelled "Refreshing…" while the first read
    // is still in flight) issues the newer, forced read.
    expect(refreshCodexMock).toHaveBeenCalledTimes(1);
    await click(container?.querySelector(".pss__card-hdr-action button"));
    expect(refreshCodexMock).toHaveBeenLastCalledWith(true);
    expect(dotTone(subRow("Codex"))).toBe("ok");

    await act(async () => {
      releaseFirst({ ...CODEX, resolvedPath: null, auth: null });
    });
    await flush();
    expect(dotTone(subRow("Codex"))).toBe("ok");
  });

  test("arriving at the AI page from elsewhere expands the group", async () => {
    await render(createElement(Sidebar, { active: "general", sub: null }));
    expect(container?.querySelector("#pss-sb-sublist-ai")?.getAttribute("aria-hidden")).toBe("true");
    await rerender(createElement(Sidebar, { active: "ai", sub: "openai" }));
    expect(container?.querySelector("#pss-sb-sublist-ai")?.getAttribute("aria-hidden")).toBe("false");
  });
});

describe("AI Providers page — hub and provider screens", () => {
  test("the hub lists every provider instead of every provider's settings", async () => {
    const page = await render(createElement(AIProvidersPage, { sub: null }));

    expect(page.textContent).toContain("Backends & credentials");
    expect(page.textContent).toContain("Capture enrichment");
    const names = Array.from(page.querySelectorAll(".pss__prov-name")).map((el) => el.textContent);
    expect(names).toEqual(["Codex", "Grok", "Kimi Code CLI", "Qwen Code", "Gemini CLI", "OpenAI"]);
    // The per-provider controls moved to their own screens.
    expect(page.textContent).not.toContain("Codex selection");
    expect(page.textContent).not.toContain("Save & enable");
  });

  test("a hub row opens that provider's screen", async () => {
    const page = await render(createElement(AIProvidersPage, { sub: null }));
    const row = Array.from(page.querySelectorAll(".pss__prov-row")).find(
      (el) => el.querySelector(".pss__prov-name")?.textContent === "Qwen Code"
    );
    expect(row?.querySelector(".pss__badge")?.textContent).toBe("Not installed");
    await click(row);
    expect(window.location.hash).toBe("#stage=settings&page=ai&sub=qwen");
  });

  test("the Codex screen shows Codex controls and the jobs that run on it", async () => {
    const page = await render(createElement(AIProvidersPage, { sub: "codex" }));

    expect(page.querySelector("h1")?.textContent).toBe("Codex");
    expect(page.textContent).toContain("Codex selection");
    expect(page.textContent).toContain("Auth profile");
    expect(page.textContent).not.toContain("Capture enrichment");
    // Nothing is routed to an ACP agent, so every job runs on Codex.
    expect(page.querySelector(".pss__prov-strip-items")?.textContent).toBe(
      "Capture captions, tags & OCR · Library chat · Sizzle Reel chat"
    );
  });

  test("an agent screen shows that agent alone", async () => {
    const s = settings({
      defaults: { libraryChat: { provider: "acp:kimi" }, sizzleChat: {}, enrichment: {} }
    });
    const page = await render(createElement(AIProvidersPage, { sub: "kimi" }), s);

    expect(page.querySelector("h1")?.textContent).toBe("Kimi Code CLI");
    const agents = Array.from(page.querySelectorAll(".pss__acp-agent .pss__opt-primary")).map(
      (el) => el.textContent
    );
    expect(agents).toEqual(["Kimi Code CLI"]);
    expect(page.querySelector(".pss__prov-strip-items")?.textContent).toBe("Library chat");

    await click(
      Array.from(page.querySelectorAll("button")).find((b) => b.textContent === "Edit routing")
    );
    expect(window.location.hash).toBe("#stage=settings&page=ai");
  });

  test("the OpenAI screen carries the key and no routing strip", async () => {
    const page = await render(createElement(AIProvidersPage, { sub: "openai" }));
    expect(page.querySelector("h1")?.textContent).toBe("OpenAI");
    expect(page.textContent).toContain("API Key");
    expect(page.querySelector(".pss__prov-strip")).toBeNull();
  });

  test("a model-probe failure found by the page turns the sidebar dot too", async () => {
    // Library chat routed to Kimi makes the page probe Kimi's models on
    // mount — the probe that catches a logged-out CLI. The sidebar issues no
    // probe of its own; it must still reflect what the page found, or it
    // shows green beside a card that says "Unavailable".
    modelsProbeFails = true;
    const s = settings({
      defaults: { libraryChat: { provider: "acp:kimi" }, sizzleChat: {}, enrichment: {} }
    });
    await render(
      createElement(
        "div",
        null,
        createElement(Sidebar, { active: "ai", sub: null }),
        createElement(AIProvidersPage, { sub: null })
      ),
      s
    );

    expect(dispatchCalls.filter((c) => c.name === "acp:models")).toEqual([
      { name: "acp:models", req: { agentId: "kimi", refresh: true } }
    ]);
    expect([dotTone(subRow("Kimi Code CLI")), chip(subRow("Kimi Code CLI"))]).toEqual([
      "warn",
      "error"
    ]);
    const hubRow = Array.from(container?.querySelectorAll(".pss__prov-row") ?? []).find(
      (el) => el.querySelector(".pss__prov-name")?.textContent === "Kimi Code CLI"
    );
    expect(hubRow?.querySelector(".pss__badge")?.textContent).toBe("Unavailable");
  });
});
