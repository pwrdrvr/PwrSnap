// Renderer-side hook for the Settings substrate.
//
// Subscribes to `events:settings:changed` and keeps a local snapshot
// of both the persisted `Settings` shape and the masked secret-status
// map. Every mutation (`patch`, `replaceSecret`, `clearSecret`) goes
// through the command bus; the broadcast is the single source of truth
// for follow-up state updates.
//
// This hook is hoisted to `SettingsApp` via `SettingsContext` so each
// window has exactly one subscriber + one initial-load pair of
// dispatches.
//
// Race-handling notes:
//
//   • `patch()` does NOT optimistically set local state after the
//     dispatch resolves — the main process awaits the broadcast before
//     returning, so by the time we'd setSettings(result.value) the
//     subscriber has already done it. Eliminating the optimistic write
//     kills a class of "second write resolves first, first arrives and
//     reverts to stale state" bugs.
//
//   • `refreshCodex`, `replaceSecret`, `clearSecret` each stamp their
//     local-state update with a monotonic `writeSeq`. A late resolution
//     (newer call has been issued in the meantime) is dropped — we do
//     NOT call setState. These verbs don't ride the broadcast, so per-
//     callback seq is the simplest correct guard.
//
//   • The initial load races against the broadcast subscriber. If a
//     sibling window writes during the `Promise.all` await, the
//     subscriber fires first with newer state; the post-await block
//     then notices `loaded.current === true` and bails so the older
//     disk read doesn't clobber the live broadcast.

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

  // Set to `true` the first time either the initial load OR an
  // incoming broadcast populates state. If the broadcast wins the
  // race, the post-`Promise.all` block reads this and bails out so
  // it doesn't overwrite live state with the stale disk read.
  const loaded = useRef<boolean>(false);

  // Per-callback monotonic counters. Each mutating call bumps its
  // counter; a resolution whose `seq` no longer matches `.current`
  // is dropped (newer call in flight).
  const refreshSeq = useRef<number>(0);
  const replaceSeq = useRef<number>(0);
  const clearSeq = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;

    const initialLoad = async (): Promise<void> => {
      const [readResult, statusResult] = await Promise.all([
        dispatch("settings:read", {}),
        dispatch("settings:secretStatus", {})
      ]);
      if (cancelled) return;
      // A broadcast that arrived during the await already populated
      // state — don't overwrite live state with the older disk read.
      if (loaded.current) {
        setLoading(false);
        return;
      }
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
      loaded.current = true;
      setSettings(readResult.value);
      setSecrets(statusResult.value);
      setError(null);
      setLoading(false);
    };

    void initialLoad();

    const unsubscribe = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const evt = payload as SettingsChangedEvent;
      loaded.current = true;
      setSettings(evt.settings);
      setSecrets(evt.secrets);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const patch = useCallback(async (p: SettingsPatch): Promise<void> => {
    const result = await dispatch("settings:write", p);
    if (!result.ok) {
      setError(result.error);
      throw new Error(result.error.message);
    }
    // Intentionally no `setSettings(result.value)` — the main-process
    // handler awaits the `events:settings:changed` broadcast before
    // returning, so the subscriber has already updated state by the
    // time we get here. Calling setSettings here would re-introduce
    // the "second-write-resolves-first" race (todo #004).
    setError(null);
  }, []);

  const refreshCodex = useCallback(
    async (force?: boolean): Promise<DesktopCodexDiscoverySnapshot | null> => {
      const seq = ++refreshSeq.current;
      const result = await dispatch("settings:refreshCodexDiscovery", {
        force: force === true
      });
      // Drop late resolutions — caller's still allowed to read the
      // returned value, but we won't mutate the hook's local state
      // (error) for a superseded call.
      if (seq !== refreshSeq.current) return null;
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
      const seq = ++replaceSeq.current;
      const result = await dispatch("settings:replaceSecret", { name, value });
      if (seq !== replaceSeq.current) return;
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
      const seq = ++clearSeq.current;
      const result = await dispatch("settings:clearSecret", { name });
      if (seq !== clearSeq.current) return;
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
