import { describe, expect, test } from "vitest";
import { APPLE_FM_STATES, type AcpAgentDiscovery, type AppleFmState, type AppleFmStatus } from "@pwrsnap/shared";
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

  describe("Apple's on-device model", () => {
    const status = (state: AppleFmState): AppleFmStatus => ({
      state, modelLabel: null, detail: null, macosVersion: "27.2", checkedAt: 0
    });

    test("unknown until macOS has answered, so nothing flashes Configure AI", () => {
      expect(
        isEnrichmentProviderAvailable({ provider: "apple:system", codexAvailable: true, acpDiscovery: undefined })
      ).toBeUndefined();
    });

    test("property: available exactly when macOS says ready, whatever Codex is doing", () => {
      for (const state of APPLE_FM_STATES) {
        for (const codexAvailable of [true, false, undefined]) {
          expect(
            isEnrichmentProviderAvailable({
              provider: "apple:system", codexAvailable, acpDiscovery: undefined, appleFm: status(state)
            })
          ).toBe(state === "ready");
        }
      }
    });

    test("a status for the on-device model never makes another provider available", () => {
      expect(
        isEnrichmentProviderAvailable({
          provider: "", codexAvailable: false, acpDiscovery: undefined, appleFm: status("ready")
        })
      ).toBe(false);
    });
  });
});
