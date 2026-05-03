// useLibrary — useSyncExternalStore over the captures-changed event
// channel. StrictMode-safe (no double-subscribe), survives renderer
// re-mounts cleanly. Per the deepening review: the renderer must use
// useSyncExternalStore for live external sources, not useEffect +
// watchCaptures, otherwise React 19's intentional dev double-mount
// duplicates listeners.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

type Snapshot = {
  loading: boolean;
  records: CaptureRecord[];
  error: string | null;
  /** Bumps on every refetch — drives useSyncExternalStore. */
  version: number;
};

const initialSnapshot: Snapshot = { loading: true, records: [], error: null, version: 0 };

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

let inFlight: Promise<void> | null = null;

async function refetch(): Promise<void> {
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    try {
      const result = await dispatch("library:list", { limit: 500 });
      if (!result.ok) {
        setSnapshot({
          loading: false,
          records: snapshot.records,
          error: result.error.message,
          version: snapshot.version + 1
        });
        return;
      }
      setSnapshot({
        loading: false,
        records: result.value,
        error: null,
        version: snapshot.version + 1
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let subscribed = false;
function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  // Initial fetch.
  void refetch();
  // Server pushes events:captures:changed after every insert / soft-
  // delete; renderer just refetches. (The server sends `{ changedIds }`;
  // Phase 2+ can use it to do delta merges instead of a full refetch.)
  subscribe(EVENT_CHANNELS.capturesChanged, () => {
    void refetch();
  });
}

export type UseLibraryResult = {
  loading: boolean;
  records: CaptureRecord[];
  error: string | null;
  refresh: () => Promise<void>;
};

export function useLibrary(): UseLibraryResult {
  const data = useSyncExternalStore(subscribeToStore, getSnapshot, getSnapshot);
  // Ensure-subscribe inside an effect so SSR / module-load doesn't
  // immediately fire a dispatch (preload may not be available yet).
  useEffect(() => {
    ensureSubscription();
  }, []);
  const refresh = useCallback(() => refetch(), []);
  return {
    loading: data.loading,
    records: data.records,
    error: data.error,
    refresh
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
