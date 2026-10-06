// The float-over's screen-edge dock, as data.
//
// A slow (local) enrichment model can take 40s+ per snap. The toast's
// countdown runs anyway; when it runs out, the toast tucks to a stack
// of recent-capture tabs on the screen edge, regardless of AI status.
// Snaps stay available until explicitly dismissed or cleared. While a
// toast is open, they also appear in the recent-snaps rail beside it.
//
// The RENDERER owns this list because it is the one that knows each
// snap's enrichment status; main only knows where the dock sits. Pure
// functions, so every membership rule is testable without a window.

import type { CaptureEnrichment, CaptureRecord } from "@pwrsnap/shared";

/** Tabs shown before the rest fold into ⋮ +N. */
export const DOCK_VISIBLE_CAP = 3;

/** The countdown a toast gets when it can tuck: long enough to reach it
 *  with the pointer (hovering pauses it), short enough that a snap the
 *  model is still reading gets out of the corner. */
export const DOCK_TUCK_COUNTDOWN_MS = 5000;

export type DockItem = {
  readonly captureId: string;
  /** When the float-over first showed this snap. Orders the stack,
   *  newest first. */
  readonly addedAt: number;
  readonly record: CaptureRecord | null;
  readonly enrichment: CaptureEnrichment | null;
  /** False when a snap without a run is not expecting one (AI off,
   *  unavailable, or an older snap). Omitted by callers that await AI. */
  readonly awaitingFirstRun?: boolean | undefined;
};

/**
 * - `waiting`  — no run yet, or queued behind another (a local server
 *   answering one request at a time queues the rest).
 * - `reading`  — the model has the snap.
 * - `ready`    — it answered; the snap waits to be looked at.
 * - `failed`   — failed or cancelled; opening shows the error + Retry.
 */
export type DockStatus = "waiting" | "reading" | "ready" | "failed";

export function dockStatus(enrichment: CaptureEnrichment | null): DockStatus {
  switch (enrichment?.status ?? null) {
    case "running":
      return "reading";
    case "completed":
      return "ready";
    case "failed":
    case "cancelled":
      return "failed";
    case "queued":
    case null:
      return "waiting";
  }
}

/** An ordinary retained capture has no AI glyph, rather than waiting forever. */
export function dockItemStatus(item: DockItem): DockStatus | null {
  if (item.enrichment?.status == null && item.awaitingFirstRun === false) return null;
  return dockStatus(item.enrichment);
}

export function isDockStatusInFlight(status: DockStatus | null): boolean {
  return status === "waiting" || status === "reading";
}

/**
 * Whether a snap on the toast expects an enrichment status glyph.
 * A run that exists and is not finished always counts. A snap with no
 * run yet counts only when enrichment is actually going to run for it —
 * with AI off, "no run" means "never", not "not yet".
 */
export function isLeavingSnapInFlight(
  enrichment: CaptureEnrichment | null,
  aiWillRun: boolean
): boolean {
  if (!isDockStatusInFlight(dockStatus(enrichment))) return false;
  return (enrichment?.status ?? null) !== null || aiWillRun;
}

/** How long after a capture its first enrichment run may still be on
 *  the way. The run's row exists from the moment it is queued, so past
 *  this a snap with no run is one enrichment is not going to reach. */
export const FIRST_RUN_GRACE_MS = 60_000;

/**
 * Whether "no run yet" can still mean "not yet" for this snap. True for
 * a capture just taken; false for an older snap opened from the rail,
 * which would otherwise wait on the dock for a run that never comes.
 */
export function mayAwaitFirstRun(record: CaptureRecord | null, now: number): boolean {
  if (record === null) return true;
  const at = Date.parse(record.captured_at);
  return !Number.isFinite(at) || now - at < FIRST_RUN_GRACE_MS;
}

function newestFirst(items: readonly DockItem[]): DockItem[] {
  return [...items].sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * Add a snap, or refresh one already there. An existing entry keeps its
 * `addedAt` (its place in the stack) and only takes the newer record /
 * enrichment when one is supplied. A snap that joins goes ahead of one
 * with the same `addedAt`: it is the newer of the two.
 */
export function upsertDockItem(queue: readonly DockItem[], item: DockItem): DockItem[] {
  const existing = queue.find((entry) => entry.captureId === item.captureId);
  if (existing === undefined) return newestFirst([item, ...queue]);
  const merged: DockItem = {
    captureId: existing.captureId,
    addedAt: existing.addedAt,
    record: item.record ?? existing.record,
    enrichment: item.enrichment ?? existing.enrichment,
    awaitingFirstRun: item.awaitingFirstRun ?? existing.awaitingFirstRun
  };
  return queue.map((entry) => (entry.captureId === item.captureId ? merged : entry));
}

export function removeDockItem(queue: readonly DockItem[], captureId: string): DockItem[] {
  return queue.filter((entry) => entry.captureId !== captureId);
}

/** Apply an enrichment broadcast to whichever waiting snap it is for. */
export function updateDockEnrichment(
  queue: readonly DockItem[],
  enrichment: CaptureEnrichment
): DockItem[] {
  if (!queue.some((entry) => entry.captureId === enrichment.captureId)) return [...queue];
  return queue.map((entry) =>
    entry.captureId === enrichment.captureId ? { ...entry, enrichment } : entry
  );
}

export function hasFinishedDockItems(
  queue: readonly DockItem[],
  exceptCaptureId?: string | null
): boolean {
  return queue.some(
    (entry) =>
      entry.captureId !== exceptCaptureId && !isDockStatusInFlight(dockItemStatus(entry))
  );
}

/** "Clear finished": drop every snap the model is done with, except the
 *  one the toast is showing right now. */
export function clearFinishedDockItems(
  queue: readonly DockItem[],
  exceptCaptureId?: string | null
): DockItem[] {
  return queue.filter(
    (entry) =>
      entry.captureId === exceptCaptureId || isDockStatusInFlight(dockItemStatus(entry))
  );
}

/**
 * The rail beside an open toast is the recent-snaps catalog: every snap,
 * newest first, not only the ones waiting on the model. It never drops a
 * snap because it was opened, and it never reorders under the pointer —
 * the order is capture time, the same keyset `library:list` pages in.
 */
export function compareCatalog(a: CaptureRecord, b: CaptureRecord): number {
  if (a.captured_at !== b.captured_at) return a.captured_at < b.captured_at ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** Add or refresh records in the catalog. A deleted record leaves it. */
export function mergeCatalogRecords(
  catalog: readonly CaptureRecord[],
  incoming: readonly CaptureRecord[]
): CaptureRecord[] {
  const byId = new Map(catalog.map((record) => [record.id, record]));
  for (const record of incoming) {
    if (record.deleted_at !== null) byId.delete(record.id);
    else byId.set(record.id, record);
  }
  return [...byId.values()].sort(compareCatalog);
}

export function removeCatalogRecords(
  catalog: readonly CaptureRecord[],
  ids: readonly string[]
): CaptureRecord[] {
  if (ids.length === 0) return [...catalog];
  const gone = new Set(ids);
  return catalog.filter((record) => !gone.has(record.id));
}

export type RailItem = {
  readonly captureId: string;
  readonly record: CaptureRecord;
  /** What the model has said, when the host knows (the snap is on the
   *  dock, or on the toast). Names the snap; the status comes from it. */
  readonly enrichment: CaptureEnrichment | null;
  /** A glyph only where it means something: the model is still on it,
   *  or it finished (or failed) while the snap waited unseen on the
   *  dock. An ordinary snap, or the one on the toast now, has none. */
  readonly status: DockStatus | null;
};

/**
 * What the rail shows: the catalog, with the toast's own snap in it even
 * before the catalog has heard of it, and the dock's glyphs laid over the
 * snaps that are waiting. `aiWillRun` is whether a run is coming for the
 * toast's snap if it has none yet (see `mayAwaitFirstRun`).
 */
export function catalogRailItems(
  catalog: readonly CaptureRecord[],
  queue: readonly DockItem[],
  current: DockItem | null,
  aiWillRun: boolean,
  /** What the model said about snaps the host has seen, for names. */
  enrichments: ReadonlyMap<string, CaptureEnrichment> = new Map()
): RailItem[] {
  const records =
    current?.record != null ? mergeCatalogRecords(catalog, [current.record]) : [...catalog];
  const waiting = new Map(queue.map((item) => [item.captureId, item]));
  return records.map((record) => {
    if (record.id === current?.captureId) {
      return {
        captureId: record.id,
        record,
        enrichment: current.enrichment,
        status: isLeavingSnapInFlight(current.enrichment, aiWillRun)
          ? dockStatus(current.enrichment)
          : null
      };
    }
    const entry = waiting.get(record.id);
    return {
      captureId: record.id,
      record,
      enrichment: entry?.enrichment ?? enrichments.get(record.id) ?? null,
      status: entry === undefined ? null : dockItemStatus(entry)
    };
  });
}

export function railInFlightCount(items: readonly RailItem[]): number {
  return items.filter((item) => item.status !== null && isDockStatusInFlight(item.status)).length;
}

/** The first `cap` items, newest first, with the rest folded into the
 *  overflow menu. */
export function splitDockItems(
  items: readonly DockItem[],
  cap: number = DOCK_VISIBLE_CAP
): { visible: DockItem[]; overflow: DockItem[] } {
  const ordered = newestFirst(items);
  return { visible: ordered.slice(0, cap), overflow: ordered.slice(cap) };
}

const STATUS_WORDS: Record<DockStatus, string> = {
  waiting: "waiting",
  reading: "reading",
  ready: "ready",
  failed: "failed"
};

/** The snap's name as the user would know it: the title the model gave
 *  it once there is one, otherwise where it came from and its size. */
export function dockItemTitle(item: DockItem): string {
  const title = item.enrichment?.acceptedTitle ?? item.enrichment?.suggestedTitle ?? null;
  if (title !== null && title.trim().length > 0) return title.trim();
  if (item.record === null) return "Snap";
  const kind = item.record.kind === "video" ? "Recording" : "Snap";
  const source = item.record.source_app_name?.trim();
  const dims = `${item.record.width_px.toLocaleString()} × ${item.record.height_px.toLocaleString()}`;
  return source !== undefined && source.length > 0
    ? `${source} ${kind.toLowerCase()} · ${dims}`
    : `${kind} · ${dims}`;
}

/** One overflow-menu row: `Title — reading`. */
export function dockItemLabel(item: DockItem): string {
  const status = dockItemStatus(item);
  return status === null ? dockItemTitle(item) : `${dockItemTitle(item)} — ${STATUS_WORDS[status]}`;
}
