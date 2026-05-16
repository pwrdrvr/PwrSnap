import { useCallback, useEffect, useState } from "react";
import type { StorageSnapshot } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

type UseStorageSnapshotResult = {
  snapshot: StorageSnapshot | null;
  loading: boolean;
  clearing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  clearChromiumCache: () => Promise<void>;
};

export function useStorageSnapshot(): UseStorageSnapshotResult {
  const [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await dispatch("storage:snapshot", {});
    if (!result.ok) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    setSnapshot(result.value);
    setError(null);
    setLoading(false);
  }, []);

  const clearChromiumCache = useCallback(async (): Promise<void> => {
    setClearing(true);
    const result = await dispatch("storage:clearChromiumCache", {});
    if (!result.ok) {
      setError(result.error.message);
      setClearing(false);
      return;
    }
    setSnapshot(result.value.snapshot);
    setError(null);
    setClearing(false);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribe(EVENT_CHANNELS.capturesChanged, () => {
      void refresh();
    });
    return unsubscribe;
  }, [refresh]);

  return { snapshot, loading, clearing, error, refresh, clearChromiumCache };
}
