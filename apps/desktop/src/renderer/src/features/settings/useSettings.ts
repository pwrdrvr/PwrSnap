// Renderer-side hook for the Settings substrate.
//
// Subscribes to `events:settings:changed` and keeps a local snapshot
// of both the persisted `Settings` shape and the masked secret-status
// map. Every mutation (`patch`, `replaceSecret`, `clearSecret`) goes
// through the command bus; the broadcast updates state.
//
// Mirrors PwrAgnt's `useDesktopSettings.ts` shape but trimmed to fit
// the slice — no `useSyncExternalStore` (unneeded for this surface),
// no optimistic concurrency (writes are infrequent + idempotent), no
// global cache (mount cost is one parallel pair of dispatches).

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopCodexDiscoverySnapshot,
  DesktopSettingsSecretName,
  PwrSnapError,
  SecretStatus,
  Settings,
  SettingsChangedEvent,
  SettingsPatch
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared/ipc";
import { dispatch, subscribe } from "../../lib/pwrsnap";

export type SecretMap = Record<DesktopSettingsSecretName, SecretStatus>;

export type UseSettingsValue = {
  settings: Settings | null;
  secrets: SecretMap | null;
  loading: boolean;
  error: PwrSnapError | null;
  patch: (p: SettingsPatch) => Promise<void>;
  refreshCodex: (force?: boolean) => Promise<DesktopCodexDiscoverySnapshot | null>;
  replaceSecret: (name: DesktopSettingsSecretName, value: string) => Promise<void>;
  clearSecret: (name: DesktopSettingsSecretName) => Promise<void>;
};

export function useSettings(): UseSettingsValue {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [secrets, setSecrets] = useState<SecretMap | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<PwrSnapError | null>(null);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const initialLoad = async (): Promise<void> => {
      const [readResult, statusResult] = await Promise.all([
        dispatch("settings:read", {}),
        dispatch("settings:secretStatus", {})
      ]);
      if (cancelled) return;
      if (!readResult.ok) {
        setError(readResult.error);
        setLoading(false);
        return;
      }
      if (!statusResult.ok) {
        setError(statusResult.error);
        setLoading(false);
        return;
      }
      setSettings(readResult.value);
      setSecrets(statusResult.value);
      setError(null);
      setLoading(false);
    };

    void initialLoad();

    const unsubscribe = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      if (!mountedRef.current) return;
      const evt = payload as SettingsChangedEvent;
      setSettings(evt.settings);
      setSecrets(evt.secrets);
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);

  const patch = useCallback(async (p: SettingsPatch): Promise<void> => {
    const result = await dispatch("settings:write", p);
    if (!result.ok) {
      setError(result.error);
      throw new Error(result.error.message);
    }
    // Broadcast will update state; also set optimistically so the UI
    // updates even in race conditions where the broadcast lands after
    // the next render.
    setSettings(result.value);
    setError(null);
  }, []);

  const refreshCodex = useCallback(
    async (force?: boolean): Promise<DesktopCodexDiscoverySnapshot | null> => {
      const result = await dispatch("settings:refreshCodexDiscovery", {
        force: force === true
      });
      if (!result.ok) {
        setError(result.error);
        return null;
      }
      return result.value;
    },
    []
  );

  const replaceSecret = useCallback(
    async (name: DesktopSettingsSecretName, value: string): Promise<void> => {
      const result = await dispatch("settings:replaceSecret", { name, value });
      if (!result.ok) {
        setError(result.error);
        throw new Error(result.error.message);
      }
      setSecrets((prev) =>
        prev === null ? prev : ({ ...prev, [name]: result.value } as SecretMap)
      );
      setError(null);
    },
    []
  );

  const clearSecret = useCallback(
    async (name: DesktopSettingsSecretName): Promise<void> => {
      const result = await dispatch("settings:clearSecret", { name });
      if (!result.ok) {
        setError(result.error);
        throw new Error(result.error.message);
      }
      setSecrets((prev) =>
        prev === null ? prev : ({ ...prev, [name]: result.value } as SecretMap)
      );
      setError(null);
    },
    []
  );

  return {
    settings,
    secrets,
    loading,
    error,
    patch,
    refreshCodex,
    replaceSecret,
    clearSecret
  };
}
