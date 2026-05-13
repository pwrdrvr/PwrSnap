// useLibrary — useSyncExternalStore over the captures-changed event
// channel + keyset pagination. StrictMode-safe (no double-subscribe),
// survives renderer re-mounts cleanly.
//
// Snapshot shape:
//   - rows: CaptureRecord[]      // accumulated across loaded pages
//   - appStats / totalLive       // populated from the head-page response
//   - hasMore: boolean           // there's a nextCursor — call loadMore()
//   - loading, isLoadingMore     // first-fetch vs. successive-page state
//   - loadMore(): Promise<void>  // appends the next page to `rows`
//
// The handler returns appStats + totalLive only on head-page requests,
// so we cache them on the snapshot and don't refetch on every page.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CaptureRecord, LibraryAppStat, LibraryCursor } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

type Snapshot = {
  loading: boolean;
  isLoadingMore: boolean;
  rows: CaptureRecord[];
  nextCursor: LibraryCursor | null;
  appStats: LibraryAppStat[];
  totalLive: number;
  error: string | null;
  /** Bumps on every refetch — drives useSyncExternalStore. */
  version: number;
};

const initialSnapshot: Snapshot = {
  loading: true,
  isLoadingMore: false,
  rows: [],
  nextCursor: null,
  appStats: [],
  totalLive: 0,
  error: null,
  version: 0
};

// Module-level store. The renderer mounts one Library; the singleton
// snapshot survives StrictMode double-mount.
let snapshot: Snapshot = initialSnapshot;
const listeners = new Set<() => void>();

function setSnapshot(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function getSnapshot(): Snapshot {
  return snapshot;
}

function subscribeToStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let inFlightHead: Promise<void> | null = null;
let inFlightMore: Promise<void> | null = null;
let headRefreshQueued = false;

/** Initial-load retry schedule. The first `library:list` after a fresh
 *  BrowserWindow can race the preload's `contextBridge.exposeInMainWorld`
 *  or land before the bus handler is registered. Both resolve within
 *  ~100ms, but the silent "loading: false, rows: []" state used to
 *  persist until a capture event happened to fire — leaving the user
 *  with a blank Library and no recovery path. Retry briefly on the
 *  first head fetch so a transient failure doesn't strand the UI. */
const INITIAL_RETRY_DELAYS_MS = [80, 250, 800] as const;

/**
 * Refetch the head page. On `events:captures:changed`, this drops
 * any loaded subsequent pages and reloads page 1 — Phase 4+ can
 * upgrade this to a delta-merge that preserves loaded windows; for
 * now, refetch-from-top matches the existing behavior.
 *
 * `isInitial` toggles transient-failure retry. Capture-change refetches
 * skip the retry — if they fail, the next event triggers another one.
 */
async function refetchHead(isInitial = false): Promise<void> {
  if (inFlightHead !== null) {
    headRefreshQueued = true;
    return inFlightHead;
  }
  inFlightHead = (async () => {
    try {
      const result = await fetchHeadOnce(isInitial);
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.warn("[useLibrary] library:list failed", result.error);
        setSnapshot({
          ...snapshot,
          loading: false,
          error: result.error.message,
          version: snapshot.version + 1
        });
        return;
      }
      const { rows, nextCursor, appStats, totalLive } = result.value;
      setSnapshot({
        loading: false,
        isLoadingMore: false,
        rows,
        nextCursor,
        appStats: appStats ?? [],
        totalLive: totalLive ?? rows.length,
        error: null,
        version: snapshot.version + 1
      });
    } finally {
      inFlightHead = null;
      if (headRefreshQueued) {
        headRefreshQueued = false;
        void refetchHead();
      }
    }
  })();
  return inFlightHead;
}

async function fetchHeadOnce(
  isInitial: boolean
): Promise<Awaited<ReturnType<typeof dispatch<"library:list">>>> {
  // includeDeleted: true so the renderer can partition into live + trash
  // lists off the same paginated snapshot. At keyset scale this means
  // soft-deleted rows are intermixed with live rows by captured_at;
  // client-side partitioning still works.
  const req = { limit: 100, includeDeleted: true };
  let result = await dispatch("library:list", req);
  if (result.ok || !isInitial) return result;
  // Initial-load retry — small backoff schedule. Logs each retry so a
  // recurring failure leaves a breadcrumb in DevTools.
  for (const delay of INITIAL_RETRY_DELAYS_MS) {
    // eslint-disable-next-line no-console
    console.warn(
      `[useLibrary] initial library:list failed (${result.error.code}); retrying in ${delay}ms`,
      result.error
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    result = await dispatch("library:list", req);
    if (result.ok) return result;
  }
  return result;
}

async function loadMore(): Promise<void> {
  if (inFlightMore !== null) return inFlightMore;
  if (snapshot.nextCursor === null) return;
  inFlightMore = (async () => {
    setSnapshot({ ...snapshot, isLoadingMore: true, version: snapshot.version + 1 });
    try {
      const result = await dispatch("library:list", {
        cursor: snapshot.nextCursor ?? undefined,
        limit: 100,
        includeDeleted: true
      });
      if (!result.ok) {
        setSnapshot({
          ...snapshot,
          isLoadingMore: false,
          error: result.error.message,
          version: snapshot.version + 1
        });
        return;
      }
      const { rows, nextCursor } = result.value;
      setSnapshot({
        ...snapshot,
        isLoadingMore: false,
        rows: [...snapshot.rows, ...rows],
        nextCursor,
        version: snapshot.version + 1
      });
    } finally {
      inFlightMore = null;
    }
  })();
  return inFlightMore;
}

let subscribed = false;
function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  subscribe(EVENT_CHANNELS.capturesChanged, () => {
    void refetchHead();
  });
  // First-ever read: runs the retry backoff on transient failure so
  // a preload/handler race doesn't strand the UI at "loading: false,
  // rows: []" forever.
  void refetchHead(/* isInitial */ true);
  // Cover startup-time writes that can land after the first head
  // request starts but before this renderer has installed its event
  // subscription. The extra once-only read is cheap and keeps the
  // sidebar stats from getting stuck on the empty boot snapshot.
  setTimeout(() => {
    void refetchHead();
  }, 100);
}

export type UseLibraryResult = {
  loading: boolean;
  isLoadingMore: boolean;
  rows: CaptureRecord[];
  hasMore: boolean;
  appStats: LibraryAppStat[];
  totalLive: number;
  error: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
};

export function useLibrary(): UseLibraryResult {
  const data = useSyncExternalStore(subscribeToStore, getSnapshot, getSnapshot);
  // Ensure-subscribe inside an effect so SSR / module-load doesn't
  // immediately fire a dispatch (preload may not be available yet).
  useEffect(() => {
    ensureSubscription();
  }, []);
  return {
    loading: data.loading,
    isLoadingMore: data.isLoadingMore,
    rows: data.rows,
    hasMore: data.nextCursor !== null,
    appStats: data.appStats,
    totalLive: data.totalLive,
    error: data.error,
    loadMore,
    refresh: refetchHead
  };
}

/**
 * Re-export selection state. Phase 1.8 keeps selection in component
 * state, but expose this so future Phase 2 mode-router can lift it
 * up. (Not used yet.)
 */
export function useSelectedCaptureId(): [string | null, (id: string | null) => void] {
  const [selected, setSelected] = useState<string | null>(null);
  return [selected, setSelected];
}
