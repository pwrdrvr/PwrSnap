// `resolveEnabledAcpAgent` — the single resolver every surface (chat backend,
// enrichment, model listing) uses to turn a configured agent id into the
// active install. All surfaces resolving through one helper is what keys them
// to the SAME pooled process. Also pinned: a disabled or unknown agent is
// never even discovered (probing can wake CLIs like Gemini), so an agent the
// user set up but never invokes is never touched, let alone spawned.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import type { DiscoveredAcpAgentGroup } from "@pwrdrvr/agent-acp";
import { acpAgentPoolKey, acpPoolScratchCwd, resolveEnabledAcpAgent } from "../acp-agent-pool";

function settingsWith(input: {
  enabledAgentIds?: string[];
  agents?: Record<string, { overridePath?: string; selectedPath?: string }>;
}): Settings {
  return {
    ai: {
      acp: {
        enabledAgentIds: input.enabledAgentIds ?? [],
        agents: input.agents ?? {}
      }
    }
  } as unknown as Settings;
}

function geminiGroup(
  instances: Array<{ command: string; source: "path" | "override"; version?: string }>
): DiscoveredAcpAgentGroup {
  return {
    strategyId: "gemini",
    backendId: "acp:gemini",
    name: "Gemini CLI",
    args: ["--acp"],
    env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
    instances,
    discoveredAt: 123
  };
}

describe("resolveEnabledAcpAgent", () => {
  test("resolves the active install of an enabled agent", async () => {
    const discover = vi.fn(async () => [
      geminiGroup([{ command: "/opt/bin/gemini", source: "path", version: "1.2.3" }])
    ]);
    const agent = await resolveEnabledAcpAgent({
      settings: settingsWith({ enabledAgentIds: ["gemini"] }),
      agentId: "gemini",
      discover
    });
    expect(agent).toEqual({
      strategyId: "gemini",
      backendId: "acp:gemini",
      name: "Gemini CLI",
      command: "/opt/bin/gemini",
      args: ["--acp"],
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
      discoveredAt: 123,
      version: "1.2.3"
    });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  test("an override instance wins over a PATH instance", async () => {
    const discover = vi.fn(async () => [
      geminiGroup([
        { command: "/usr/local/bin/gemini", source: "path" },
        { command: "/custom/gemini", source: "override" }
      ])
    ]);
    const agent = await resolveEnabledAcpAgent({
      settings: settingsWith({
        enabledAgentIds: ["gemini"],
        agents: { gemini: { overridePath: "/custom/gemini" } }
      }),
      agentId: "gemini",
      discover
    });
    expect(agent?.command).toBe("/custom/gemini");
  });

  test("a disabled agent is never discovered", async () => {
    const discover = vi.fn(async () => [
      geminiGroup([{ command: "/opt/bin/gemini", source: "path" }])
    ]);
    const agent = await resolveEnabledAcpAgent({
      settings: settingsWith({ enabledAgentIds: [] }),
      agentId: "gemini",
      discover
    });
    expect(agent).toBeNull();
    expect(discover).not.toHaveBeenCalled();
  });

  test("an unknown agent id is never discovered", async () => {
    const discover = vi.fn(async () => []);
    const agent = await resolveEnabledAcpAgent({
      settings: settingsWith({ enabledAgentIds: ["not-a-real-agent"] }),
      agentId: "not-a-real-agent",
      discover
    });
    expect(agent).toBeNull();
    expect(discover).not.toHaveBeenCalled();
  });

  test("an enabled-but-not-installed agent resolves to null", async () => {
    const discover = vi.fn(async () => []);
    const agent = await resolveEnabledAcpAgent({
      settings: settingsWith({ enabledAgentIds: ["gemini"] }),
      agentId: "gemini",
      discover
    });
    expect(agent).toBeNull();
    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe("pool key + scratch cwd", () => {
  test("pool key is (agent, resolved binary) — same binary shares one process", () => {
    const base = {
      strategyId: "gemini",
      backendId: "acp:gemini",
      name: "Gemini CLI",
      args: [],
      env: {},
      discoveredAt: 0
    };
    expect(acpAgentPoolKey({ ...base, command: "/opt/bin/gemini" })).toBe(
      "gemini@/opt/bin/gemini"
    );
    expect(acpAgentPoolKey({ ...base, command: "/custom/gemini" })).toBe(
      "gemini@/custom/gemini"
    );
  });

  // On the ACP path the scratch cwd is not just a perf guard, it is one of only
  // two configurable controls: the kit drops `sandbox` / `approvalPolicy` /
  // `workspaceRoots` as Codex-only, so cwd + per-thread mcpServers IS the
  // posture. It must never resolve into the user's data.
  test("the scratch cwd is an app-owned jail, not a user directory", () => {
    const cwd = acpPoolScratchCwd();
    expect(cwd).toBe(join(tmpdir(), "pwrsnap", ".acp-scratch"));
    // The three places it must never land: the captures/chats tree (also
    // TCC-gated on macOS), the home dir root, and userData (which holds
    // pwrsnap.db + pwrsnap-secrets.bin).
    expect(cwd).not.toContain("Documents");
    expect(cwd).not.toContain("Application Support");
    expect(cwd.startsWith(tmpdir())).toBe(true);
  });

  // The pool key is (strategyId, command) — cwd is NOT part of it, so whichever
  // surface acquires first fixes the cwd for every other surface sharing the
  // process. A parameterless jail is what makes that safe.
  test("takes no argument, so no caller can point it at a user path", () => {
    expect(acpPoolScratchCwd).toHaveLength(0);
  });
});
