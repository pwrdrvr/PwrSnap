import { describe, expect, test } from "vitest";
import type { AcpAgentDiscovery } from "@pwrsnap/shared";
import { isEnrichmentProviderAvailable } from "../enrichment-provider-availability";

function discovery(
  agents: Array<{ id: string; installed: boolean }>
): AcpAgentDiscovery {
  return {
    agents: agents.map((a) => ({
      id: a.id,
      displayName: a.id,
      installed: a.installed,
      instances: []
    }))
  };
}

describe("isEnrichmentProviderAvailable", () => {
  describe("Codex provider", () => {
    test.each(["", "codex"])(
      "mirrors codexAvailable for provider %j",
      (provider) => {
        expect(
          isEnrichmentProviderAvailable({
            provider,
            codexAvailable: true,
            acpDiscovery: undefined
          })
        ).toBe(true);
        expect(
          isEnrichmentProviderAvailable({
            provider,
            codexAvailable: false,
            acpDiscovery: undefined
          })
        ).toBe(false);
        expect(
          isEnrichmentProviderAvailable({
            provider,
            codexAvailable: undefined,
            acpDiscovery: undefined
          })
        ).toBeUndefined();
      }
    );

    test("undefined provider falls back to the Codex signal", () => {
      expect(
        isEnrichmentProviderAvailable({
          provider: undefined,
          codexAvailable: false,
          acpDiscovery: discovery([])
        })
      ).toBe(false);
    });

    test("unknown/legacy non-acp provider is treated as Codex", () => {
      expect(
        isEnrichmentProviderAvailable({
          provider: "something-legacy",
          codexAvailable: true,
          acpDiscovery: undefined
        })
      ).toBe(true);
    });
  });

  describe("ACP provider", () => {
    test("available when the selected agent is installed — even with no Codex", () => {
      expect(
        isEnrichmentProviderAvailable({
          provider: "acp:kimi",
          codexAvailable: false,
          acpDiscovery: discovery([{ id: "kimi", installed: true }])
        })
      ).toBe(true);
    });

    test("unavailable when the selected agent is not installed", () => {
      expect(
        isEnrichmentProviderAvailable({
          provider: "acp:kimi",
          codexAvailable: true,
          acpDiscovery: discovery([{ id: "kimi", installed: false }])
        })
      ).toBe(false);
    });

    test("unavailable when the selected agent is absent from discovery", () => {
      expect(
        isEnrichmentProviderAvailable({
          provider: "acp:qwen",
          codexAvailable: true,
          acpDiscovery: discovery([{ id: "kimi", installed: true }])
        })
      ).toBe(false);
    });

    test("undefined (holds, no flash) while ACP discovery is still loading", () => {
      expect(
        isEnrichmentProviderAvailable({
          provider: "acp:kimi",
          codexAvailable: false,
          acpDiscovery: undefined
        })
      ).toBeUndefined();
    });
  });
});
