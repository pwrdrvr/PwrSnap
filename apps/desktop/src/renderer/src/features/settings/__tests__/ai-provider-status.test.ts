// The sidebar dot and the hub badge for a provider are two renderings of
// one `describe*` answer, so these tables are the whole contract for both.

import { describe, expect, test } from "vitest";
import type {
  AcpAgentDiscoveryEntry,
  DesktopCodexDiscoverySnapshot,
  Settings
} from "@pwrsnap/shared";
import { isSettingsSub } from "@pwrsnap/shared";
import {
  AI_PROVIDER_SUBS,
  describeAcpAgentStatus,
  describeAiProviders,
  describeCodexStatus,
  describeOpenAiStatus,
  routedSurfaces
} from "../ai-provider-status";

function codexSnapshot(
  overrides: Partial<DesktopCodexDiscoverySnapshot> = {}
): DesktopCodexDiscoverySnapshot {
  return {
    candidates: [
      { path: "/opt/homebrew/bin/codex", source: "path", version: "0.148.0", available: true }
    ],
    resolvedPath: "/opt/homebrew/bin/codex",
    auth: { status: "authenticated", testedAt: "2026-09-17T00:00:00.000Z", durationMs: 12 },
    refreshedAt: "2026-09-17T00:00:00.000Z",
    ...overrides
  };
}

function acpEntry(): AcpAgentDiscoveryEntry {
  return {
    id: "kimi",
    displayName: "Kimi Code CLI",
    installed: true,
    version: "1.4.0",
    instances: [{ command: "/usr/local/bin/kimi", source: "path", version: "1.4.0" }],
    activeCommand: "/usr/local/bin/kimi"
  };
}

const KIMI_NOT_INSTALLED: AcpAgentDiscoveryEntry = {
  id: "kimi",
  displayName: "Kimi Code CLI",
  installed: false,
  detail: "Not found on PATH",
  instances: []
};

describe("AI provider sub ids", () => {
  test("Codex leads, OpenAI trails, Gemini sorts last among the ACP agents", () => {
    expect(AI_PROVIDER_SUBS).toEqual(["codex", "grok", "kimi", "qwen", "gemini", "openai"]);
  });

  test("only known provider ids are AI Providers subs", () => {
    for (const sub of AI_PROVIDER_SUBS) expect(isSettingsSub("ai", sub)).toBe(true);
    expect(isSettingsSub("ai", "claude")).toBe(false);
    expect(isSettingsSub("ai", "__proto__")).toBe(false);
    expect(isSettingsSub("ai", undefined)).toBe(false);
    // A provider id is not a sub of any other page.
    expect(isSettingsSub("hotkeys", "codex")).toBe(false);
  });

  test("Direct API screens are subs by shape: the add page and one per connection id", () => {
    expect(isSettingsSub("ai", "new-connection")).toBe(true);
    expect(isSettingsSub("ai", "connection:12345678-1234-4234-8234-123456789003")).toBe(true);
    expect(isSettingsSub("ai", "connection:not-a-uuid")).toBe(false);
    expect(isSettingsSub("ai", "connection:12345678-1234-4234-8234-123456789003/x")).toBe(false);
    expect(isSettingsSub("ai-features", "new-connection")).toBe(false);
    expect(isSettingsSub("hotkeys", "connection:12345678-1234-4234-8234-123456789003")).toBe(false);
  });
});

describe("describeCodexStatus", () => {
  test("no snapshot yet has no dot — unknown is not green", () => {
    const loading = describeCodexStatus(null, true);
    expect(loading.tone).toBeUndefined();
    expect(loading.badge).toBe("Checking…");
    expect(describeCodexStatus(null, false).badge).toBe("Unknown");
  });

  test("a resolved, signed-in binary is ok and names its version + path", () => {
    const status = describeCodexStatus(codexSnapshot(), false);
    expect(status.tone).toBe("ok");
    expect(status.chip).toBeUndefined();
    expect(status.meta).toBe("v0.148.0 · /opt/homebrew/bin/codex");
  });

  test("no resolvable binary is bad and says so in words", () => {
    const status = describeCodexStatus(codexSnapshot({ resolvedPath: null, auth: null }), false);
    expect(status).toMatchObject({ tone: "bad", chip: "missing", badge: "Not found" });
  });

  test("a found binary that is not signed in needs attention, not red", () => {
    const status = describeCodexStatus(
      codexSnapshot({
        auth: { status: "unauthenticated", testedAt: "2026-09-17T00:00:00.000Z", durationMs: 5 }
      }),
      false
    );
    expect(status).toMatchObject({ tone: "warn", chip: "sign in" });
  });

  test("a failed auth probe is flagged too", () => {
    const status = describeCodexStatus(
      codexSnapshot({
        auth: { status: "failed", testedAt: "2026-09-17T00:00:00.000Z", durationMs: 5 }
      }),
      false
    );
    expect(status).toMatchObject({ tone: "warn", chip: "check" });
  });
});

describe("describeAcpAgentStatus", () => {
  // ACP agents are opt-in in PwrSnap, so a fresh install has every agent
  // disabled. The chip is what still tells installed apart from absent.
  test("disabled + installed reads 'off' (ready to enable)", () => {
    const status = describeAcpAgentStatus("kimi", acpEntry(), false, false, undefined);
    expect(status).toMatchObject({ tone: "off", chip: "off", badge: "Off" });
    expect(status.meta).toBe("v1.4.0 · /usr/local/bin/kimi");
  });

  test("disabled + not installed reads 'missing' with a grey dot, not red", () => {
    const status = describeAcpAgentStatus(
      "kimi",
      KIMI_NOT_INSTALLED,
      false,
      false,
      undefined
    );
    expect(status).toMatchObject({ tone: "off", chip: "missing", badge: "Not installed" });
  });

  test("enabled + installed is ok", () => {
    const status = describeAcpAgentStatus("kimi", acpEntry(), false, true, undefined);
    expect(status).toMatchObject({ tone: "ok", badge: "Enabled" });
    expect(status.chip).toBeUndefined();
  });

  test("enabled but not installed is bad — it is on and cannot run", () => {
    const status = describeAcpAgentStatus(
      "kimi",
      KIMI_NOT_INSTALLED,
      false,
      true,
      undefined
    );
    expect(status).toMatchObject({ tone: "bad", chip: "missing" });
  });

  test("a runtime model-probe failure outranks an install that looks fine", () => {
    const status = describeAcpAgentStatus("kimi", acpEntry(), false, true, "not logged in");
    expect(status).toMatchObject({ tone: "warn", chip: "error", badge: "Unavailable" });
    expect(status.meta).toBe("not logged in");
  });

  test("before discovery reports: disabled is still known, enabled is not", () => {
    expect(describeAcpAgentStatus("kimi", undefined, true, false, undefined)).toMatchObject({
      tone: "off",
      label: "Kimi Code CLI"
    });
    const enabled = describeAcpAgentStatus("kimi", undefined, true, true, undefined);
    expect(enabled.tone).toBeUndefined();
    expect(enabled.badge).toBe("Checking…");
    // A failed discovery must not read "Checking…" forever.
    expect(describeAcpAgentStatus("kimi", undefined, false, true, undefined).badge).toBe(
      "Unknown"
    );
  });
});

describe("describeOpenAiStatus", () => {
  test("key presence is the whole status", () => {
    expect(describeOpenAiStatus(null).tone).toBeUndefined();
    expect(describeOpenAiStatus({ configured: true, lastSetAt: null })).toMatchObject({
      tone: "ok",
      badge: "Key set"
    });
    expect(describeOpenAiStatus({ configured: false, lastSetAt: null })).toMatchObject({
      tone: "off",
      chip: "no key"
    });
  });
});

describe("describeAiProviders", () => {
  test("covers every provider sub, in sidebar order", () => {
    const statuses = describeAiProviders({
      codex: codexSnapshot(),
      codexLoading: false,
      acpDiscovery: { agents: [acpEntry()] },
      acpDiscoveryLoading: false,
      enabledAgentIds: ["kimi"],
      acpModelErrors: {},
      openaiKey: { configured: false, lastSetAt: null }
    });
    expect(statuses.map((s) => s.sub)).toEqual([...AI_PROVIDER_SUBS]);
    expect(statuses.find((s) => s.sub === "kimi")?.tone).toBe("ok");
    // An agent discovery did not report, and that is disabled, is still off.
    expect(statuses.find((s) => s.sub === "grok")).toMatchObject({ tone: "off", label: "Grok" });
  });
});

describe("routedSurfaces", () => {
  function settingsWith(
    defaults: Partial<Record<"enrichment" | "libraryChat" | "sizzleChat", string>>,
    enabledAgentIds: string[]
  ): Settings {
    const surface = (provider: string | undefined) =>
      provider === undefined ? {} : { provider };
    return {
      ai: {
        acp: { enabledAgentIds },
        defaults: {
          enrichment: surface(defaults.enrichment),
          libraryChat: surface(defaults.libraryChat),
          sizzleChat: surface(defaults.sizzleChat)
        }
      }
    } as unknown as Settings;
  }

  test("unset, empty and 'codex' all run on Codex", () => {
    const settings = settingsWith({ libraryChat: "", sizzleChat: "codex" }, []);
    expect(routedSurfaces(settings, "codex")).toEqual(["enrichment", "libraryChat", "sizzleChat"]);
  });

  test("an enabled agent takes the jobs routed to it", () => {
    const settings = settingsWith({ libraryChat: "acp:kimi" }, ["kimi"]);
    expect(routedSurfaces(settings, "kimi")).toEqual(["libraryChat"]);
    expect(routedSurfaces(settings, "codex")).toEqual(["enrichment", "sizzleChat"]);
  });

  test("a job routed to a DISABLED agent falls back to Codex, as the runtime does", () => {
    const settings = settingsWith({ libraryChat: "acp:kimi" }, []);
    expect(routedSurfaces(settings, "kimi")).toEqual([]);
    expect(routedSurfaces(settings, "codex")).toEqual(["enrichment", "libraryChat", "sizzleChat"]);
  });

  test("OpenAI is never a job backend", () => {
    expect(routedSurfaces(settingsWith({}, []), "openai")).toEqual([]);
    expect(routedSurfaces(null, "codex")).toEqual([]);
  });
});
