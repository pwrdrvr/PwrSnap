// `library:openEnrichmentRepair` carries how the Library's AI re-run dialog
// should be set up. The request comes from a renderer (Settings), so it is
// rebuilt here from checked parts before it is handed to the Library.

import type { EnrichmentRepairOpenRequest, EnrichmentRepairStatus } from "@pwrsnap/shared";

const PRESETS = new Set(["24h", "7d", "30d", "90d", "all"]);

/** A canonical ISO string, or undefined when `value` is not a date. */
function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The request with only fields that validate, or null when any field is
 *  present and malformed. `undefined` (no request) is an empty request. */
export function parseEnrichmentRepairOpenRequest(raw: unknown): EnrichmentRepairOpenRequest | null {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const request: EnrichmentRepairOpenRequest = {};

  if (value.statuses !== undefined) {
    if (!Array.isArray(value.statuses) || value.statuses.length === 0) return null;
    const statuses: EnrichmentRepairStatus[] = [];
    for (const status of value.statuses) {
      if (status !== "failed" && status !== "never") return null;
      if (!statuses.includes(status)) statuses.push(status);
    }
    request.statuses = statuses;
  }

  const window = value.window;
  if (window !== undefined) {
    if (typeof window === "string") {
      if (!PRESETS.has(window)) return null;
      request.window = window as Exclude<EnrichmentRepairOpenRequest["window"], object | undefined>;
    } else if (typeof window === "object" && window !== null) {
      const range = window as Record<string, unknown>;
      const since = isoOrUndefined(range.since);
      const until = range.until === null ? null : isoOrUndefined(range.until);
      if (since === undefined || until === undefined) return null;
      if (until !== null && Date.parse(until) <= Date.parse(since)) return null;
      request.window = { since, until };
    } else {
      return null;
    }
  }
  return request;
}
