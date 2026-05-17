import { useCallback, useEffect, useState } from "react";
import type {
  RenderCacheMaintenanceMode,
  StorageSnapshot,
  StorageSnapshotUpdate,
  StorageSummary
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

type UseStorageSnapshotOptions = {
  eagerSnapshot?: boolean;
};

type UseStorageSnapshotResult = {
  summary: StorageSummary | null;
  snapshot: StorageSnapshot | null;
  loading: boolean;
  workingAction: "app-cache" | "render-trim" | "render-clear" | null;
  error: string | null;
  refreshSummary: () => Promise<void>;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  clearAppCache: () => Promise<void>;
  maintainRenderCache: (mode: RenderCacheMaintenanceMode) => Promise<void>;
};

function summaryFromSnapshot(snapshot: StorageSnapshot): StorageSummary {
  return {
    capturedAt: snapshot.capturedAt,
    sourceCaptures: {
      bytes: snapshot.sourceCaptures.bytes,
      captureCount: snapshot.sourceCaptures.captureCount
    }
  };
}

export function useStorageSnapshot(
  options: UseStorageSnapshotOptions = {}
): UseStorageSnapshotResult {
  const eagerSnapshot = options.eagerSnapshot ?? false;
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [workingAction, setWorkingAction] = useState<
    UseStorageSnapshotResult["workingAction"]
  >(null);
  const [error, setError] = useState<string | null>(null);

  const applySnapshot = useCallback((nextSnapshot: StorageSnapshot): void => {
    setSnapshot(nextSnapshot);
    setSummary(summaryFromSnapshot(nextSnapshot));
  }, []);

  const refreshSummary = useCallback(async (): Promise<void> => {
    const result = await dispatch("storage:summary", {});
    if (!result.ok) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    setSummary(result.value);
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async (refreshOptions: { force?: boolean } = {}): Promise<void> => {
    setLoading(true);
    const req = refreshOptions.force === undefined ? {} : { force: refreshOptions.force };
    const result = await dispatch("storage:snapshot", req);
    if (!result.ok) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    applySnapshot(result.value);
    setError(null);
    setLoading(false);
  }, [applySnapshot]);

  const clearAppCache = useCallback(async (): Promise<void> => {
    setWorkingAction("app-cache");
    const result = await dispatch("storage:clearAppCache", {});
    if (!result.ok) {
      setError(result.error.message);
      setWorkingAction(null);
      return;
    }
    applySnapshot(result.value.snapshot);
    setError(null);
    setWorkingAction(null);
  }, [applySnapshot]);

  const maintainRenderCache = useCallback(
    async (mode: RenderCacheMaintenanceMode): Promise<void> => {
      setWorkingAction(mode === "trim" ? "render-trim" : "render-clear");
      const result = await dispatch("storage:maintainRenderCache", { mode });
      if (!result.ok) {
        setError(result.error.message);
        setWorkingAction(null);
        return;
      }
      applySnapshot(result.value.snapshot);
      setError(null);
      setWorkingAction(null);
    },
    [applySnapshot]
  );

  useEffect(() => {
    return subscribe(EVENT_CHANNELS.storageSnapshotUpdated, (payload) => {
      const update = payload as StorageSnapshotUpdate;
      applySnapshot(update.snapshot);
      setError(null);
      setLoading(update.scanning);
    });
  }, [applySnapshot]);

  useEffect(() => {
    if (eagerSnapshot) {
      void refresh();
    } else {
      void refreshSummary();
    }
    const unsubscribe = subscribe(EVENT_CHANNELS.capturesChanged, () => {
      void refreshSummary();
    });
    return unsubscribe;
  }, [eagerSnapshot, refresh, refreshSummary]);

  return {
    summary,
    snapshot,
    loading,
    workingAction,
    error,
    refreshSummary,
    refresh,
    clearAppCache,
    maintainRenderCache
  };
}
