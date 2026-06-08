import type { AcpAgentDiscovery } from "@pwrsnap/shared";

/**
 * Whether the enrichment backend the user selected in Settings → AI can
 * actually run right now. This is the signal that drives the Library footer
 * AI toggle and the float-over "Configure AI" affordance — both used to gate
 * purely on Codex availability, which wrongly blocked users whose enrichment
 * provider is a local ACP agent (Kimi / Gemini / Grok / Qwen) and who have no
 * Codex installed.
 *
 * The selector lives at `settings.ai.defaults.enrichment.provider`:
 *   - "" / "codex" → Codex. Availability IS the Codex discovery probe
 *     (`codexAvailable`: resolved path + authenticated).
 *   - "acp:<id>"   → a local ACP agent. Availability is whether `acp:discover`
 *     reports that agent INSTALLED.
 *
 * We key the ACP case off INSTALL state, not the enabled set, because the
 * enrichment runtime routes on the provider string alone (`enrichmentAcpAgentId`
 * in codex-handlers) and THROWS for an uninstalled agent — it does NOT fall back
 * to Codex the way the chat factory does. So "installed" is exactly the
 * can-it-run signal for this toggle.
 *
 * Returns `undefined` while the relevant discovery is still loading so callers
 * hold their pre-hydration state instead of flashing "Configure AI". Callers
 * treat `=== false` (not falsy) as the configure trigger, mirroring the old
 * `codexAvailable === false` checks.
 */
export function isEnrichmentProviderAvailable(params: {
  provider: string | undefined;
  codexAvailable: boolean | undefined;
  acpDiscovery: AcpAgentDiscovery | undefined;
}): boolean | undefined {
  const provider = params.provider ?? "";
  if (!provider.startsWith("acp:")) {
    return params.codexAvailable;
  }
  if (params.acpDiscovery === undefined) {
    return undefined;
  }
  const id = provider.slice("acp:".length);
  const entry = params.acpDiscovery.agents.find((agent) => agent.id === id);
  return entry?.installed === true;
}
