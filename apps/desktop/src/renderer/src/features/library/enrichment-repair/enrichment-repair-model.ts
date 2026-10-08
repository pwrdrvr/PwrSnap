// Pure parts of the enrichment repair dialog: the app picker's click rules,
// the time window, and the progress copy. No React, no DOM.

import type {
  EnrichmentRepairAppFacet,
  EnrichmentRepairCriteria,
  EnrichmentRepairJob,
  EnrichmentRepairStatus
} from "@pwrsnap/shared";

export const ALL_APPS: EnrichmentRepairAppFacet = { mode: "include", appIds: [] };

export type RepairAppRowState = "included" | "excluded" | "neutral";

export function repairAppRowState(facet: EnrichmentRepairAppFacet, appKey: string): RepairAppRowState {
  if (!facet.appIds.includes(appKey)) return "neutral";
  return facet.mode === "include" ? "included" : "excluded";
}

function facet(mode: EnrichmentRepairAppFacet["mode"], appIds: readonly string[]): EnrichmentRepairAppFacet {
  const ids = [...new Set(appIds)].sort();
  return ids.length === 0 ? ALL_APPS : { mode, appIds: ids };
}

/**
 * One click on an app row. Every app runs until the user picks some.
 *
 *   plain  — select the app, or unselect it if it is already selected, so
 *            a few clicks build "just these". Plain-clicking an excluded
 *            app takes it back.
 *   ⌥      — exclude the app ("everything but these"), or stop excluding it.
 *
 * Unlike the Library sidebar, a plain click ADDS to the selection rather
 * than replacing it: this is a picker for a batch, not a view filter.
 * Emptying either set is "all apps" again.
 */
export function toggleRepairApp(
  current: EnrichmentRepairAppFacet,
  appKey: string,
  exclude: boolean
): EnrichmentRepairAppFacet {
  const inSet = current.appIds.includes(appKey);
  const without = current.appIds.filter((id) => id !== appKey);
  if (exclude) {
    if (current.mode === "exclude") return facet("exclude", inSet ? without : [...current.appIds, appKey]);
    return facet("exclude", [appKey]);
  }
  if (current.mode === "exclude") {
    return inSet ? facet("exclude", without) : facet("include", [appKey]);
  }
  return facet("include", inSet ? without : [...current.appIds, appKey]);
}

export type RepairWindowPreset = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

export const WINDOW_PRESETS: ReadonlyArray<{ id: RepairWindowPreset; label: string }> = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" }
];

const DAY_MS = 24 * 60 * 60 * 1000;
const PRESET_MS: Partial<Record<RepairWindowPreset, number>> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS
};

/** `yyyy-mm-dd` from an `<input type="date">`, as LOCAL midnight. */
function localDayStart(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `[since, until)` as ISO strings. A custom `to` day is included whole. */
export function repairWindowBounds(
  preset: RepairWindowPreset,
  custom: { from: string; to: string },
  now: number
): { since: string | null; until: string | null } {
  const span = PRESET_MS[preset];
  if (span !== undefined) return { since: new Date(now - span).toISOString(), until: null };
  if (preset !== "custom") return { since: null, until: null };
  const from = localDayStart(custom.from);
  const to = localDayStart(custom.to);
  const untilDate = to === null ? null : new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return {
    since: from === null ? null : from.toISOString(),
    until: untilDate === null ? null : untilDate.toISOString()
  };
}

export function repairCriteria(input: {
  statuses: readonly EnrichmentRepairStatus[];
  preset: RepairWindowPreset;
  custom: { from: string; to: string };
  apps: EnrichmentRepairAppFacet;
  now: number;
}): EnrichmentRepairCriteria {
  return {
    statuses: [...input.statuses],
    ...repairWindowBounds(input.preset, input.custom, input.now),
    apps: { mode: input.apps.mode, appIds: [...input.apps.appIds] }
  };
}

/** Choices for how many snaps a repair keeps in flight; main caps at 8. */
export const REPAIR_CONCURRENCY_OPTIONS = [1, 2, 4, 8] as const;
export type RepairConcurrency = (typeof REPAIR_CONCURRENCY_OPTIONS)[number];

/** How long the oldest snap in flight has been running, or null when none is. */
export function repairOldestInFlightMs(job: EnrichmentRepairJob, now: number): number | null {
  let oldest: number | null = null;
  for (const entry of job.inFlight) {
    const started = Date.parse(entry.startedAt);
    if (Number.isFinite(started) && (oldest === null || started < oldest)) oldest = started;
  }
  return oldest === null ? null : Math.max(0, now - oldest);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function repairJobFraction(job: EnrichmentRepairJob): number {
  if (job.total <= 0) return job.state === "running" ? 0 : 1;
  return Math.min(1, job.processed / job.total);
}

/** One line for the toast and the dialog's progress block. */
export function repairJobHeadline(job: EnrichmentRepairJob): string {
  switch (job.state) {
    case "running":
      return `Re-running AI · ${job.processed.toLocaleString()} of ${job.total.toLocaleString()}`;
    case "completed":
      return job.total === 0 ? "Nothing to re-run" : `AI re-run finished · ${plural(job.total, "snap")}`;
    case "cancelled":
      return `AI re-run cancelled · ${job.processed.toLocaleString()} of ${job.total.toLocaleString()}`;
    case "stopped":
      return `AI re-run stopped · ${job.processed.toLocaleString()} of ${job.total.toLocaleString()}`;
  }
}

export function repairJobTally(job: EnrichmentRepairJob): string {
  const parts = [`${job.succeeded.toLocaleString()} fixed`];
  if (job.failed > 0) parts.push(`${job.failed.toLocaleString()} failed again`);
  if (job.skipped > 0) parts.push(`${job.skipped.toLocaleString()} skipped`);
  return parts.join(" · ");
}
