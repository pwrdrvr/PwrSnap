// Which provider runs each job, as the AI Providers hub tells it (the Jobs
// card, the chips on each provider row, a provider screen's "Jobs" strip).
//
// Oracle: the backend the runtime itself resolves, `enrichmentProviderBackend`
// (shared with main): "" / "codex" / a disabled `acp:<id>` run on Codex, an
// enabled agent on itself, Apple's model on this Mac, and a Direct API model
// on its connection. The hub must say what will run, not what the stored
// string looks like. Before this, a job routed to a Direct API model was
// counted on the Codex screen — Codex claimed captions it never ran.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { AiSurfaceId, CustomModel, Settings } from "@pwrsnap/shared";
import {
  APPLE_FM_PROVIDER,
  APPLE_FM_SETTINGS_SUB,
  appleRefusalFallbackRoute,
  connectionSettingsSub,
  enrichmentProviderBackend,
  isAppleFmProvider
} from "@pwrsnap/shared";
import { captionFallbackOn, jobRunners, routedSurfaces } from "../ai-provider-status";
import { baseSettings } from "./settings-fixture";

const AGENTS = ["gemini", "grok", "kimi", "qwen"] as const;
const CONN_LOCAL = "11111111-1111-4111-8111-111111111111";
const CONN_CLOUD = "22222222-2222-4222-8222-222222222222";
const MODEL_LOCAL = "33333333-3333-4333-8333-333333333333";
const MODEL_CLOUD = "44444444-4444-4444-8444-444444444444";
const MODEL_GONE = "55555555-5555-4555-8555-555555555555";

const MODELS: CustomModel[] = [
  { id: MODEL_LOCAL, connectionId: CONN_LOCAL, displayName: "Local", modelId: "local-1",
    capabilities: { vision: true, streaming: true }, maxOutputTokens: 4096 },
  { id: MODEL_CLOUD, connectionId: CONN_CLOUD, displayName: "Cloud", modelId: "cloud-1",
    capabilities: { vision: true, streaming: true }, maxOutputTokens: 4096 }
];

const PROVIDERS = [
  "", "codex", ...AGENTS.map((id) => `acp:${id}`), APPLE_FM_PROVIDER,
  `custom:${MODEL_LOCAL}`, `custom:${MODEL_CLOUD}`, `custom:${MODEL_GONE}`
];
const SURFACES: readonly AiSurfaceId[] = ["enrichment", "libraryChat", "sizzleChat"];

const providerArb = fc.option(fc.constantFrom(...PROVIDERS), { nil: undefined });

const settingsArb: fc.Arbitrary<Settings> = fc
  .record({
    enabled: fc.subarray([...AGENTS]),
    enrichment: providerArb,
    libraryChat: providerArb,
    sizzleChat: providerArb,
    fallback: fc.option(fc.record({ provider: providerArb }), { nil: null }),
    paused: fc.boolean(),
    approveRefusalRoute: fc.boolean()
  })
  .map((r) => {
    const def = (provider: string | undefined) => (provider === undefined ? {} : { provider });
    const ai: Settings["ai"] = {
      ...baseSettings.ai,
      acp: { enabledAgentIds: r.enabled },
      defaults: { enrichment: def(r.enrichment), libraryChat: def(r.libraryChat), sizzleChat: def(r.sizzleChat) },
      enrichmentFallback: r.fallback === null ? null : def(r.fallback.provider),
      enrichmentFallbackPaused: r.paused,
      customConnections: [
        { id: CONN_LOCAL, name: "Bench", baseUrl: "http://127.0.0.1:8080/v1", protocol: "openai-chat", auth: { type: "none" } },
        { id: CONN_CLOUD, name: "Cloud", baseUrl: "https://api.example.test/v1", protocol: "openai-chat", auth: { type: "api-key" } }
      ],
      customModels: MODELS
    };
    // Sometimes the operator approved exactly the destination the refusal
    // route names, sometimes not.
    const consentKey = appleRefusalFallbackRoute(ai)?.consentKey ?? null;
    return {
      ...baseSettings,
      ai: { ...ai, appleRefusalFallbackConsent: r.approveRefusalRoute ? consentKey : null }
    };
  });

/** The screen the runtime's own backend resolution lands on, or null when
 *  the saved Direct API model is gone. */
function oracleSub(settings: Settings, surface: AiSurfaceId, provider: string | undefined): string | null {
  if (isAppleFmProvider(provider)) return surface === "enrichment" ? APPLE_FM_SETTINGS_SUB : "codex";
  const backend = enrichmentProviderBackend(provider, settings.ai.acp.enabledAgentIds);
  if (backend === "codex") return "codex";
  if (backend.startsWith("acp:")) return backend.slice("acp:".length);
  const model = MODELS.find((m) => `custom:${m.id}` === backend);
  return model === undefined ? null : connectionSettingsSub(model.connectionId);
}

describe("jobRunners (property)", () => {
  test("each job's primary is the provider the runtime will run it on", () => {
    fc.assert(fc.property(settingsArb, (settings) => {
      const runners = jobRunners(settings);
      for (const surface of SURFACES) {
        const primaries = runners.filter((r) => r.surface === surface && r.role === "primary");
        const expected = oracleSub(settings, surface, settings.ai.defaults[surface].provider);
        expect(primaries.map((r) => r.sub)).toEqual(expected === null ? [] : [expected]);
      }
    }), { numRuns: 500 });
  });

  test("the caption fallback is listed exactly when main would arm it, on its own provider", () => {
    fc.assert(fc.property(settingsArb, (settings) => {
      const fallbacks = jobRunners(settings).filter((r) => r.role === "fallback");
      // Main's `enrichmentFallbackFor`: on (and, behind Apple, approved),
      // and not on the primary's own backend.
      const enabled = settings.ai.acp.enabledAgentIds;
      const sameBackend =
        enrichmentProviderBackend(settings.ai.enrichmentFallback?.provider, enabled) ===
        enrichmentProviderBackend(settings.ai.defaults.enrichment.provider, enabled);
      const expected = captionFallbackOn(settings.ai) && !sameBackend
        ? oracleSub(settings, "enrichment", settings.ai.enrichmentFallback?.provider)
        : null;
      expect(fallbacks).toEqual(
        expected === null ? [] : [{ surface: "enrichment", role: "fallback", sub: expected }]
      );
    }), { numRuns: 500 });
  });

  test("a provider screen's Jobs strip names the same jobs its hub row does", () => {
    const subs = ["codex", ...AGENTS, APPLE_FM_SETTINGS_SUB] as const;
    fc.assert(fc.property(settingsArb, (settings) => {
      const primaries = jobRunners(settings).filter((r) => r.role === "primary");
      for (const sub of subs) {
        expect(routedSurfaces(settings, sub)).toEqual(
          primaries.filter((r) => r.sub === sub).map((r) => r.surface)
        );
      }
    }), { numRuns: 300 });
  });
});

describe("jobRunners (examples)", () => {
  test("a fallback on the primary's own backend is not listed: main never arms it", () => {
    const settings: Settings = {
      ...baseSettings,
      ai: {
        ...baseSettings.ai,
        acp: { enabledAgentIds: [] },
        defaults: { ...baseSettings.ai.defaults, enrichment: {} },
        // A disabled agent runs on Codex, the primary's own backend.
        enrichmentFallback: { provider: "acp:kimi" }
      }
    };
    expect(jobRunners(settings)).toEqual([
      { surface: "enrichment", role: "primary", sub: "codex" },
      { surface: "libraryChat", role: "primary", sub: "codex" },
      { surface: "sizzleChat", role: "primary", sub: "codex" }
    ]);
  });
});

describe("captionFallbackOn", () => {
  test("paused is off, whatever else is saved", () => {
    fc.assert(fc.property(settingsArb, (settings) => {
      const paused = { ...settings.ai, enrichmentFallbackPaused: true };
      expect(captionFallbackOn(paused)).toBe(false);
    }), { numRuns: 100 });
  });

  test("behind Apple, an off-device fallback needs approval of that exact destination", () => {
    const ai: Settings["ai"] = {
      ...baseSettings.ai,
      defaults: { ...baseSettings.ai.defaults, enrichment: { provider: APPLE_FM_PROVIDER } },
      enrichmentFallback: { provider: `custom:${MODEL_CLOUD}` },
      customConnections: [
        { id: CONN_CLOUD, name: "Cloud", baseUrl: "https://api.example.test/v1", protocol: "openai-chat", auth: { type: "api-key" } }
      ],
      customModels: MODELS
    };
    expect(captionFallbackOn(ai)).toBe(false);
    const key = appleRefusalFallbackRoute(ai)?.consentKey ?? null;
    expect(key).not.toBeNull();
    expect(captionFallbackOn({ ...ai, appleRefusalFallbackConsent: key })).toBe(true);
  });
});
