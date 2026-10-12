// Pure parts of the enrichment repair dialog: the app picker's click rules,
// the time window, the labels its token line reads as, and the progress and
// outcome copy. No React, no DOM.

import type {
  EnrichmentRepairAppFacet,
  EnrichmentRepairCriteria,
  EnrichmentRepairJob,
  EnrichmentRepairOpenRequest,
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

// ---- Time window ----------------------------------------------------------

export type RepairWindowPreset = "24h" | "7d" | "30d" | "90d" | "all";

/** What "Captured …" covers: a preset, two picked days, or an exact range
 *  handed in from outside (the span a caption model was unreachable). */
export type RepairWindow =
  | { kind: "preset"; preset: RepairWindowPreset }
  | { kind: "dates"; from: string; to: string }
  | { kind: "range"; since: string; until: string | null };

export const DEFAULT_REPAIR_WINDOW: RepairWindow = { kind: "preset", preset: "30d" };

export const WINDOW_PRESETS: ReadonlyArray<{ id: RepairWindowPreset; label: string; token: string }> = [
  { id: "24h", label: "Last 24 hours", token: "in the last 24 hours" },
  { id: "7d", label: "Last 7 days", token: "in the last 7 days" },
  { id: "30d", label: "Last 30 days", token: "in the last 30 days" },
  { id: "90d", label: "Last 90 days", token: "in the last 90 days" },
  { id: "all", label: "All time", token: "at any time" }
];

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
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

/** `[since, until)` as ISO strings. A picked `to` day is included whole. */
export function repairWindowBounds(window: RepairWindow, now: number): { since: string | null; until: string | null } {
  if (window.kind === "range") return { since: window.since, until: window.until };
  if (window.kind === "preset") {
    const span = PRESET_MS[window.preset];
    return { since: span === undefined ? null : new Date(now - span).toISOString(), until: null };
  }
  const from = localDayStart(window.from);
  const to = localDayStart(window.to);
  const untilDate = to === null ? null : new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return {
    since: from === null ? null : from.toISOString(),
    until: untilDate === null ? null : untilDate.toISOString()
  };
}

export function repairCriteria(input: {
  statuses: readonly EnrichmentRepairStatus[];
  window: RepairWindow;
  apps: EnrichmentRepairAppFacet;
  now: number;
}): EnrichmentRepairCriteria {
  return {
    statuses: [...input.statuses],
    ...repairWindowBounds(input.window, input.now),
    apps: { mode: input.apps.mode, appIds: [...input.apps.appIds] }
  };
}

function shortDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function shortTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** "Sep 28 – Oct 3", or one day alone. */
function dayRangeLabel(fromMs: number, lastDayMs: number): string {
  return sameLocalDay(fromMs, lastDayMs) ? shortDay(fromMs) : `${shortDay(fromMs)} – ${shortDay(lastDayMs)}`;
}

/** An exact range, to the minute: "10:42 – 11:20 today", "Oct 3, 10:42 – 11:20". */
function exactRangeLabel(sinceMs: number, untilMs: number | null, now: number): string {
  const end = untilMs ?? now;
  const endTime = untilMs === null ? "now" : shortTime(end);
  if (sameLocalDay(sinceMs, end)) {
    const day = sameLocalDay(sinceMs, now) ? "today" : shortDay(sinceMs);
    return day === "today" ? `${shortTime(sinceMs)} – ${endTime} today` : `${day}, ${shortTime(sinceMs)} – ${endTime}`;
  }
  return `${shortDay(sinceMs)}, ${shortTime(sinceMs)} – ${shortDay(end)}, ${endTime}`;
}

/** What follows "Captured" in the token line. */
export function repairWindowToken(window: RepairWindow, now: number): string {
  if (window.kind === "preset") return WINDOW_PRESETS.find((p) => p.id === window.preset)?.token ?? "at any time";
  if (window.kind === "range") {
    return exactRangeLabel(Date.parse(window.since), window.until === null ? null : Date.parse(window.until), now);
  }
  const from = localDayStart(window.from);
  const to = localDayStart(window.to);
  if (from !== null && to !== null) return dayRangeLabel(from.getTime(), to.getTime());
  if (from !== null) return `since ${shortDay(from.getTime())}`;
  if (to !== null) return `through ${shortDay(to.getTime())}`;
  return "between dates";
}

/** The window a job ran over, read back from its criteria. A lower bound
 *  that sits a preset's span before the job started is that preset. */
export function repairCriteriaWindowLabel(criteria: EnrichmentRepairCriteria, startedAt: string, now: number): string {
  const since = criteria.since === null ? null : Date.parse(criteria.since);
  const until = criteria.until === null ? null : Date.parse(criteria.until);
  if (since === null && until === null) return "all time";
  if (since !== null && until === null) {
    const started = Date.parse(startedAt);
    for (const preset of WINDOW_PRESETS) {
      const span = PRESET_MS[preset.id];
      if (span !== undefined && Math.abs(started - since - span) < 2 * MINUTE_MS) {
        return preset.label.toLowerCase();
      }
    }
    return `since ${shortDay(since)}`;
  }
  if (since === null) return `before ${shortDay(until!)}`;
  // Whole local days read as days; anything else is an exact range.
  const midnight = (ms: number): boolean => {
    const d = new Date(ms);
    return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  };
  if (midnight(since) && midnight(until!)) return dayRangeLabel(since, until! - 1);
  return exactRangeLabel(since, until, now);
}

// ---- Token labels ---------------------------------------------------------

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** The Apps token: "all apps", "Safari", "Safari and Xcode", "3 apps",
 *  "all but Terminal", "all but 2 apps". */
export function repairAppsToken(apps: EnrichmentRepairAppFacet, nameOf: (appKey: string) => string): string {
  const ids = apps.appIds;
  if (ids.length === 0) return "all apps";
  if (apps.mode === "include") {
    if (ids.length === 1) return nameOf(ids[0]!);
    if (ids.length === 2) return `${nameOf(ids[0]!)} and ${nameOf(ids[1]!)}`;
    return plural(ids.length, "app");
  }
  return ids.length === 1 ? `all but ${nameOf(ids[0]!)}` : `all but ${plural(ids.length, "app")}`;
}

export function repairPaceToken(concurrency: number): string {
  return concurrency === 1 ? "one at a time" : `${concurrency} at a time`;
}

export function repairStatusesLabel(statuses: readonly EnrichmentRepairStatus[]): string {
  const failed = statuses.includes("failed");
  const never = statuses.includes("never");
  if (failed && never) return "Failed and never ran";
  return failed ? "Failed" : "Never ran";
}

/** One line under the progress: what this job was asked to do. */
export function repairJobRecap(job: EnrichmentRepairJob, now: number): string {
  const apps = job.criteria.apps;
  const appsLabel =
    apps.appIds.length === 0
      ? "all apps"
      : apps.mode === "include"
        ? plural(apps.appIds.length, "app")
        : `all but ${plural(apps.appIds.length, "app")}`;
  return [
    repairStatusesLabel(job.criteria.statuses),
    repairCriteriaWindowLabel(job.criteria, job.startedAt, now),
    appsLabel,
    repairPaceToken(job.concurrency)
  ].join(" · ");
}

// ---- Opening from elsewhere ----------------------------------------------

/** What an outside request (Settings, the rail, the back-online toast)
 *  sets; the rest keeps the dialog's defaults. */
export function repairSetupFromRequest(request: EnrichmentRepairOpenRequest | undefined): {
  statuses?: EnrichmentRepairStatus[];
  window?: RepairWindow;
} {
  if (request === undefined) return {};
  const out: { statuses?: EnrichmentRepairStatus[]; window?: RepairWindow } = {};
  if (request.statuses !== undefined && request.statuses.length > 0) out.statuses = [...request.statuses];
  const window = request.window;
  if (typeof window === "string") out.window = { kind: "preset", preset: window };
  else if (window !== undefined) out.window = { kind: "range", since: window.since, until: window.until };
  return out;
}

// ---- Progress -----------------------------------------------------------

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

export function repairJobFraction(job: EnrichmentRepairJob): number {
  if (job.total <= 0) return job.state === "running" ? 0 : 1;
  return Math.min(1, job.processed / job.total);
}

/** The split bar's segments, as fractions of the job: fixed, failed again,
 *  skipped, then the snaps in flight — or, while the job waits out its own
 *  pace with nothing in flight, one held slot. */
export function repairBarSegments(job: EnrichmentRepairJob): {
  ok: number;
  bad: number;
  skip: number;
  live: number;
  held: number;
} {
  const total = Math.max(job.total, 1);
  const running = job.state === "running";
  const live = running ? job.inFlight.length : 0;
  const held = running && live === 0 && job.waitingUntil !== null ? 1 : 0;
  const left = Math.max(0, job.total - job.processed);
  return {
    ok: job.succeeded / total,
    bad: job.failed / total,
    skip: job.skipped / total,
    live: Math.min(live, left) / total,
    held: Math.min(held, left) / total
  };
}

/** One line for the toast. */
export function repairJobHeadline(job: EnrichmentRepairJob): string {
  switch (job.state) {
    case "running":
      return "Re-running AI";
    case "completed":
      if (job.total === 0) return "Nothing to re-run";
      return job.failed === 0 && job.skipped === 0 ? `All ${plural(job.total, "snap")} fixed` : "AI re-run done";
    case "cancelled":
      return "AI re-run stopped";
    case "stopped":
      return "AI re-run paused";
  }
}

/** "18 / 42", beside the toast headline. Empty when the headline already
 *  carries the count. */
export function repairJobCount(job: EnrichmentRepairJob): string {
  if (job.state === "completed" && job.failed === 0 && job.skipped === 0) return "";
  return `${job.processed.toLocaleString()} / ${job.total.toLocaleString()}`;
}

export function repairJobTally(job: EnrichmentRepairJob): string {
  const parts = [`${job.succeeded.toLocaleString()} fixed`];
  if (job.failed > 0) parts.push(`${job.failed.toLocaleString()} failed again`);
  if (job.skipped > 0) parts.push(`${job.skipped.toLocaleString()} skipped`);
  return parts.join(" · ");
}

/** How a finished job ended, for the outcome view. */
export type RepairOutcome = "clean" | "mixed" | "cancelled" | "stopped" | "empty";

export function repairOutcome(job: EnrichmentRepairJob): RepairOutcome | null {
  switch (job.state) {
    case "running":
      return null;
    case "cancelled":
      return "cancelled";
    case "stopped":
      return "stopped";
    case "completed":
      if (job.total === 0) return "empty";
      return job.failed > 0 ? "mixed" : "clean";
  }
}

/** "40 s", "14 min", "1 h 5 min". */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** A stop reason as a sentence fragment: "AI enrichment was turned off". */
export function repairStopReasonText(reason: string | null): string {
  if (reason === null || reason.trim() === "") return "it could not go on";
  return reason.trim().replace(/\.$/, "");
}
