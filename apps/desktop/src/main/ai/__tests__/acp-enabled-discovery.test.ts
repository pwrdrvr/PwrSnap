import { describe, expect, test } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import {
  acpDiscoveryOptionsForEnabledAgent,
  acpDiscoveryOptionsForEnabledAgents,
  enabledChatAcpAgentIdsInUse
} from "../acp-enabled-discovery";

function settings(input: {
  enabledAgentIds: string[];
  agents?: Settings["ai"]["acp"]["agents"];
  libraryProvider?: string;
  sizzleProvider?: string;
}): Settings {
  return {
    ai: {
      acp: {
        enabledAgentIds: input.enabledAgentIds,
        agents: input.agents ?? {}
      },
      defaults: {
        libraryChat: {
          ...(input.libraryProvider !== undefined ? { provider: input.libraryProvider } : {})
        },
        sizzleChat: {
          ...(input.sizzleProvider !== undefined ? { provider: input.sizzleProvider } : {})
        },
        enrichment: {}
      }
    }
  } as unknown as Settings;
}

describe("enabled ACP discovery options", () => {
  test("filters disabled strategies and override paths before discovery", () => {
    const options = acpDiscoveryOptionsForEnabledAgents(
      settings({
        enabledAgentIds: ["qwen"],
        agents: {
          gemini: { overridePath: "/custom/gemini" },
          qwen: { overridePath: "/custom/qwen" }
        }
      })
    );

    expect(options.strategies?.map((strategy) => strategy.id)).toEqual(["qwen"]);
    expect(options.overrides).toEqual({ qwen: "/custom/qwen" });
  });

  test("returns null for a disabled single-agent probe", () => {
    expect(
      acpDiscoveryOptionsForEnabledAgent(
        settings({
          enabledAgentIds: [],
          agents: { gemini: { overridePath: "/custom/gemini" } }
        }),
        "gemini"
      )
    ).toBeNull();
  });

  test("builds a one-strategy probe for an enabled single agent", () => {
    const options = acpDiscoveryOptionsForEnabledAgent(
      settings({
        enabledAgentIds: ["gemini"],
        agents: { gemini: { overridePath: "/custom/gemini" } }
      }),
      "gemini"
    );

    expect(options?.strategies?.map((strategy) => strategy.id)).toEqual(["gemini"]);
    expect(options?.overrides).toEqual({ gemini: "/custom/gemini" });
  });
});

describe("enabled ACP agents in use", () => {
  test("returns only enabled chat providers", () => {
    expect(
      enabledChatAcpAgentIdsInUse(
        settings({
          enabledAgentIds: ["qwen"],
          libraryProvider: "acp:gemini",
          sizzleProvider: "acp:qwen"
        })
      )
    ).toEqual(["qwen"]);
  });
});
