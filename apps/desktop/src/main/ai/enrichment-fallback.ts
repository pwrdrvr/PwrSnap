import { planErrorMessage } from "./chatgpt-plan/errors";
// Capture enrichment's second choice: `ai.enrichmentFallback`.
//
// A primary can stop answering underneath us: a local model server the
// operator stopped, an agent CLI that was uninstalled, or — for Codex — a Mac
// that has no network. Without a fallback every new capture's caption fails
// until someone regenerates it by hand. With one, the SAME run moves to the
// fallback backend once. Apple also has a capture-local refusal route, which
// is independent of the reachability and outage handling below.
//
// What counts as "nothing answered" depends on the primary:
// - Direct API / ACP: a refused or unreachable connection, HTTP 404/502/503,
//   or an agent that is no longer installed.
// - Codex: the App Server's own transport classification of a connection
//   that got no HTTP answer at all (`isCodexNetworkUnavailable`).
//
// What does NOT fall back, on purpose: any other HTTP answer (401/403 is a
// credential the operator must fix; a 504 is an upstream that took the request
// and was slow), a Codex stream that disconnected mid-answer, sign-in, plan,
// policy or overload errors, invalid or empty output, a timeout (the server is
// up, just slow — paying for a second model would hide that), a Codex that
// cannot start (a local setup error), and a removed or changed custom-model
// setting (removal fails closed).

import {
  appleRefusalFallbackRoute,
  enrichmentProviderBackend,
  isAppleFmProvider,
  type AiSurfaceDefault,
  type Settings
} from "@pwrsnap/shared";
import { CodexTurnFailedError, isCodexNetworkUnavailable } from "./codex-turn-error";
import { DirectApiError } from "./direct-api/transport";

/** Thrown when an `acp:<id>` enrichment primary has no installed binary. */
export class AcpAgentUnavailableError extends Error {
  constructor(readonly agentId: string) {
    super(`ACP agent "${agentId}" is not installed for enrichment`);
    this.name = "AcpAgentUnavailableError";
  }
}

/** HTTP answers that mean the model is not being served: no such model loaded
 *  (404), or a proxy in front of a stopped upstream (502/503). Not 504: the
 *  upstream accepted the request and was slow, and may already have spent. */
const UNAVAILABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([404, 502, 503]);

/** Whether an enrichment failure means the backend could not be reached, so
 *  the run may move to `ai.enrichmentFallback`. Everything else fails the run. */
export function isEnrichmentBackendUnavailable(error: unknown): boolean {
  if (error instanceof AcpAgentUnavailableError) return true;
  if (error instanceof DirectApiError) {
    if (planErrorMessage(error.code) !== undefined) return false;
    return error.unreachable || (error.status !== undefined && UNAVAILABLE_HTTP_STATUSES.has(error.status));
  }
  if (error instanceof CodexTurnFailedError) return isCodexNetworkUnavailable(error.codexErrorInfo);
  return false;
}

/** The backend a provider selector runs on (shared with Settings). */
function providerKey(settings: Settings, provider: string | undefined): string {
  return enrichmentProviderBackend(provider, settings.ai.acp.enabledAgentIds);
}

/** The fallback to arm for a run, or null. Null when the fallback is off or
 *  when it runs on the primary's own backend (a Codex primary with a Codex
 *  fallback, say): a second try at what just failed is not a fallback. */
export function enrichmentFallbackFor(settings: Settings): AiSurfaceDefault | null {
  const fallback = settings.ai.enrichmentFallback ?? null;
  if (fallback === null || settings.ai.enrichmentFallbackPaused === true) return null;
  const primaryProvider = settings.ai.defaults.enrichment.provider;
  if (isAppleFmProvider(primaryProvider)) {
    const route = appleRefusalFallbackRoute(settings.ai);
    if (route === null || (route.consentKey !== null && route.consentKey !== settings.ai.appleRefusalFallbackConsent)) {
      return null;
    }
  }
  const primary = providerKey(settings, primaryProvider);
  if (providerKey(settings, fallback.provider) === primary) return null;
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

/** How long a primary that nothing answered at stays marked down. Runs in
 *  that window go straight to the fallback; the first run after it tries the
 *  primary again, so a restarted local server is back within a minute. */
export const ENRICHMENT_PRIMARY_DOWN_MS = 60_000;

/** Which enrichment primaries are down, in memory only (a restart forgets).
 *  Keyed by provider selector. `markDown` / `markUp` return true only on a
 *  transition, which is what the logs report: one line when a primary goes
 *  down and one when it answers again, not one per capture. */
export class EnrichmentPrimaryHealth {
  /** Provider → when its down mark expires. An expired entry is kept: the
   *  next probe either confirms it (quietly) or clears it (a transition). */
  private readonly downUntil = new Map<string, number>();

  constructor(
    private readonly nowMs: () => number = () => Date.now(),
    private readonly downMs: number = ENRICHMENT_PRIMARY_DOWN_MS
  ) {}

  /** True while the provider's down mark has not expired. */
  isDown(provider: string): boolean {
    const until = this.downUntil.get(provider);
    return until !== undefined && this.nowMs() < until;
  }

  /** Nothing answered: (re)start the window. True if it was not down before. */
  markDown(provider: string): boolean {
    const wasKnown = this.downUntil.has(provider);
    this.downUntil.set(provider, this.nowMs() + this.downMs);
    return !wasKnown;
  }

  /** The provider answered (with anything). True if it had been marked down. */
  markUp(provider: string): boolean {
    return this.downUntil.delete(provider);
  }

  /** When each provider's current outage began, fallback or not. Separate
   *  from `downUntil`, which exists only to route runs to a fallback; this
   *  is what the Library's "back online" nudge reports, and captions fail
   *  during an outage precisely when there is no fallback. */
  private readonly unreachableSince = new Map<string, number>();

  /** A run could not reach the provider. Starts the outage clock once. */
  noteUnreachable(provider: string): void {
    if (!this.unreachableSince.has(provider)) this.unreachableSince.set(provider, this.nowMs());
  }

  /** The provider answered: the outage that ends, or null if there was none.
   *  Outages of any other provider end with it: only one primary is in use,
   *  so one left behind by a provider the user moved off would otherwise
   *  surface weeks later as a "down since" covering everything between. */
  endOutage(provider: string): { downSince: number; upAt: number } | null {
    const downSince = this.unreachableSince.get(provider);
    this.unreachableSince.clear();
    return downSince === undefined ? null : { downSince, upAt: this.nowMs() };
  }
}
