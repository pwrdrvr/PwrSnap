// Which backend a caption provider selector runs on. Main (arming the caption
// fallback) and Settings (presenting it) must agree, so both read this.

import { isAppleFmProvider } from "./apple-fm";
import { isLoopbackApiUrl, resolveCustomModel } from "./custom-models";
import type { Settings } from "./protocol";

/** "" and "codex" are Codex, and so is an `acp:<id>` whose agent is not
 *  enabled: the run resolver sends that to Codex too. Anything else is its
 *  own backend. */
export function enrichmentProviderBackend(
  provider: string | undefined,
  enabledAgentIds: readonly string[]
): string {
  if (provider === undefined || provider === "" || provider === "codex") return "codex";
  if (provider.startsWith("acp:") && !enabledAgentIds.includes(provider.slice("acp:".length))) return "codex";
  return provider;
}

/** The saved alternate behind Apple. A null route has no eligible fallback.
 *  A route with a null consent key stays on this Mac. Off-device approval is
 *  tied to the destination so an edit cannot authorize another provider/model. */
export function appleRefusalFallbackRoute(ai: Settings["ai"]): { consentKey: string | null } | null {
  const fallback = ai.enrichmentFallback;
  if (!isAppleFmProvider(ai.defaults.enrichment.provider) || fallback == null || isAppleFmProvider(fallback.provider)) {
    return null;
  }
  const provider = fallback.provider || "codex";
  if (provider.startsWith("custom:")) {
    const model = resolveCustomModel(ai.customConnections, ai.customModels, provider.slice("custom:".length));
    if (model?.capabilities.vision !== true) return null;
    return { consentKey: isLoopbackApiUrl(model.baseUrl)
      ? null
      : JSON.stringify([provider, model.connectionId, model.baseUrl, model.protocol, model.modelId]) };
  }
  // An ACP agent that was disabled is no longer the selected destination.
  if (enrichmentProviderBackend(provider, ai.acp.enabledAgentIds) !== provider) return null;
  return { consentKey: JSON.stringify([provider, fallback.model ?? ""]) };
}
