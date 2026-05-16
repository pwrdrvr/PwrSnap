import { useCallback, useEffect, useState } from "react";
import type { RenderCacheMaintenanceMode, StorageSnapshot } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

type UseStorageSnapshotResult = {
  snapshot: StorageSnapshot | null;
  loading: boolean;
  workingAction: "app-cache" | "render-trim" | "render-clear" | null;
  error: string | null;
  refresh: () => Promise<void>;
  clearAppCache: () => Promise<void>;
  maintainRenderCache: (mode: RenderCacheMaintenanceMode) => Promise<void>;
};

export function useStorageSnapshot(): UseStorageSnapshotResult {
  const [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [workingAction, setWorkingAction] = useState<
    UseStorageSnapshotResult["workingAction"]
  >(null);
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

  const clearAppCache = useCallback(async (): Promise<void> => {
    setWorkingAction("app-cache");
    const result = await dispatch("storage:clearAppCache", {});
    if (!result.ok) {
      setError(result.error.message);
      setWorkingAction(null);
      return;
    }
    setSnapshot(result.value.snapshot);
    setError(null);
    setWorkingAction(null);
  }, []);

  const maintainRenderCache = useCallback(
    async (mode: RenderCacheMaintenanceMode): Promise<void> => {
      setWorkingAction(mode === "trim" ? "render-trim" : "render-clear");
      const result = await dispatch("storage:maintainRenderCache", { mode });
      if (!result.ok) {
        setError(result.error.message);
        setWorkingAction(null);
        return;
      }
      setSnapshot(result.value.snapshot);
      setError(null);
      setWorkingAction(null);
    },
    []
  );

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribe(EVENT_CHANNELS.capturesChanged, () => {
      void refresh();
    });
    return unsubscribe;
  }, [refresh]);

  return { snapshot, loading, workingAction, error, refresh, clearAppCache, maintainRenderCache };
}
