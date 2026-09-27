// The float-over's screen-edge dock, as data.
//
// A slow (local) enrichment model can take 40s+ per snap. The toast's
// countdown runs anyway; if the model is still reading when it runs out,
// the toast tucks to a stack of tabs on the screen edge, and the snap
// waits there until the user opens it. Several snaps can be waiting at
// once. While a toast is open, the same list shows as a rail beside it.
//
// The RENDERER owns this list because it is the one that knows each
// snap's enrichment status; main only knows where the dock sits. Pure
// functions, so every membership rule is testable without a window.

import type { CaptureEnrichment, CaptureRecord } from "@pwrsnap/shared";

/** Tabs (and rail thumbnails) shown before the rest fold into ⋮ +N. */
export const DOCK_VISIBLE_CAP = 3;

/** The countdown a toast gets when it can tuck: long enough to reach it
 *  with the pointer (hovering pauses it), short enough that a snap the
 *  model is still reading gets out of the corner. */
export const DOCK_TUCK_COUNTDOWN_MS = 5000;

export type DockItem = {
  readonly captureId: string;
  /** When the float-over first showed this snap. Orders the stack,
   *  newest first, and is what the age on a tab counts from. */
  readonly addedAt: number;
  readonly record: CaptureRecord | null;
  readonly enrichment: CaptureEnrichment | null;
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

export function isDockStatusInFlight(status: DockStatus): boolean {
  return status === "waiting" || status === "reading";
}

/**
 * Whether a snap that is leaving the toast should wait on the dock.
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
    enrichment: item.enrichment ?? existing.enrichment
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
      entry.captureId !== exceptCaptureId && !isDockStatusInFlight(dockStatus(entry.enrichment))
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
      entry.captureId === exceptCaptureId || isDockStatusInFlight(dockStatus(entry.enrichment))
  );
}

/**
 * Everything the rail beside an open toast lists: the waiting snaps plus
 * the one on screen, newest first. The toast's own snap is not
 * necessarily waiting — a fresh capture joins the dock only if it
 * leaves the toast unfinished.
 */
export function railDockItems(
  queue: readonly DockItem[],
  current: DockItem | null
): DockItem[] {
  if (current === null) return newestFirst(queue);
  return newestFirst(upsertDockItem(queue, current));
}

/**
 * The first `cap` items, newest first, with the rest folded into the
 * overflow menu. A pinned item (the toast's own snap) is never folded
 * away: it takes the last visible slot if it would otherwise overflow.
 */
export function splitDockItems(
  items: readonly DockItem[],
  cap: number = DOCK_VISIBLE_CAP,
  pinnedCaptureId: string | null = null
): { visible: DockItem[]; overflow: DockItem[] } {
  const ordered = newestFirst(items);
  if (ordered.length <= cap) return { visible: ordered, overflow: [] };
  const visible = ordered.slice(0, cap);
  const pinned =
    pinnedCaptureId === null
      ? undefined
      : ordered.find((entry) => entry.captureId === pinnedCaptureId);
  if (pinned !== undefined && !visible.includes(pinned)) {
    visible[visible.length - 1] = pinned;
  }
  return {
    visible,
    overflow: ordered.filter((entry) => !visible.includes(entry))
  };
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatDockAge(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${minutes}:${seconds}`;
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

/** One overflow-menu row: `Title — reading · 0:31`. */
export function dockItemLabel(item: DockItem, now: number): string {
  return `${dockItemTitle(item)} — ${STATUS_WORDS[dockStatus(item.enrichment)]} · ${formatDockAge(now - item.addedAt)}`;
}
