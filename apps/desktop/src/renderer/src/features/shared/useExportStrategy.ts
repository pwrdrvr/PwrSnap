// The active export-preset strategy (legacy / DPI-aware, Retina on or
// off), kept current from settings. Same shape as `useHotkeys`: one
// initial `settings:read`, one `events:settings:changed` subscriber, and
// a broadcast that lands first wins over the slower read.

import { useEffect, useState } from "react";
import {
  exportStrategyFromSettings,
  type ExportStrategy,
  type SettingsChangedEvent
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared/ipc";
import { dispatch, subscribe } from "../../lib/pwrsnap";

export function useExportStrategy(): ExportStrategy {
  const [strategy, setStrategy] = useState<ExportStrategy>("legacy");

  useEffect(() => {
    let cancelled = false;
    let loadedFromBroadcast = false;

    void (async () => {
      const result = await dispatch("settings:read", {});
      if (cancelled || loadedFromBroadcast) return;
      if (result.ok) setStrategy(exportStrategyFromSettings(result.value));
    })();

    const unsubscribe = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const evt = payload as SettingsChangedEvent;
      loadedFromBroadcast = true;
      setStrategy(exportStrategyFromSettings(evt.settings));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return strategy;
}
