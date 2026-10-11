// Capture enrichment's second choice: `ai.enrichmentFallback`.
//
// A primary that is a Direct API model or an ACP agent can be switched off
// underneath us (a local model server the operator stopped, an agent CLI that
// was uninstalled). Without a fallback every new capture's caption fails until
// someone regenerates it by hand. With one, the SAME run moves to the fallback
// backend — once, and only for failures that mean "nothing answered".
//
// What does NOT fall back, on purpose: an HTTP answer other than 404/502/503/504
// (401/403 is a credential the operator must fix), invalid or empty output, a
// timeout (the server is up, just slow — paying for a second model would hide
// that), a removed or changed custom-model setting (removal fails closed), and
// a Codex primary (there is no stopped-server case to cover).

import type { AiSurfaceDefault, Settings } from "@pwrsnap/shared";
import { DirectApiError } from "./direct-api/transport";

/** Thrown when an `acp:<id>` enrichment primary has no installed binary. */
export class AcpAgentUnavailableError extends Error {
  constructor(readonly agentId: string) {
    super(`ACP agent "${agentId}" is not installed for enrichment`);
    this.name = "AcpAgentUnavailableError";
  }
}

/** HTTP answers that mean the model is not being served: no such model loaded
 *  (404), or a proxy in front of a stopped upstream (502/503/504). */
const UNAVAILABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([404, 502, 503, 504]);

/** Whether an enrichment failure means the backend could not be reached, so
 *  the run may move to `ai.enrichmentFallback`. Everything else fails the run. */
export function isEnrichmentBackendUnavailable(error: unknown): boolean {
  if (error instanceof AcpAgentUnavailableError) return true;
  if (error instanceof DirectApiError) {
    return error.unreachable || (error.status !== undefined && UNAVAILABLE_HTTP_STATUSES.has(error.status));
  }
  return false;
}

/** Normalize a provider selector: "" and "codex" both mean Codex. */
function providerKey(provider: string | undefined): string {
  return provider === undefined || provider === "" ? "codex" : provider;
}

/** The fallback to arm for a run, or null. Null when the fallback is off, when
 *  the primary is Codex (nothing to fall back from), or when the fallback
 *  names the primary itself. */
export function enrichmentFallbackFor(settings: Settings): AiSurfaceDefault | null {
  const fallback = settings.ai.enrichmentFallback ?? null;
  if (fallback === null) return null;
  const primary = providerKey(settings.ai.defaults.enrichment.provider);
  if (primary === "codex") return null;
  if (providerKey(fallback.provider) === primary) return null;
  return fallback;
}

/** `settings` with the fallback swapped into `ai.defaults.enrichment`, so the
 *  one set of provider / model / effort resolvers serves both backends. */
export function settingsWithEnrichmentDefault(
  settings: Settings,
  enrichment: AiSurfaceDefault
): Settings {
  return {
    ...settings,
    ai: { ...settings.ai, defaults: { ...settings.ai.defaults, enrichment } }
  };
}
