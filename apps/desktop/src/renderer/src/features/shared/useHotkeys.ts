// Minimal renderer-side hotkey snapshot. The Settings window owns the
// full `useSettings`/`SettingsProvider` machinery; everything else
// (tray, float-over, library chrome) just wants the four
// `settings.hotkeys.*` strings without paying for the secret-status
// fetch, the codex helpers, or the rest of the Settings surface.
//
// One initial `settings:read`, one `events:settings:changed`
// subscriber, unsubscribe on unmount. Use this from any renderer
// surface that isn't itself the Settings shell.

import { useEffect, useState } from "react";
import type { Settings, SettingsChangedEvent } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared/ipc";
import { dispatch, subscribe } from "../../lib/pwrsnap";

export type HotkeysSnapshot = Settings["hotkeys"];

const EMPTY: HotkeysSnapshot = {
  quickCapture: "",
  region: "",
  window: "",
  fullScreen: "",
  allScreens: "",
  timed: "",
  videoCapture: "",
  reshowFloatOver: ""
};

export function useHotkeys(): HotkeysSnapshot {
  const [hotkeys, setHotkeys] = useState<HotkeysSnapshot>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let loadedFromBroadcast = false;

    void (async () => {
      const result = await dispatch("settings:read", {});
      if (cancelled || loadedFromBroadcast) return;
      if (result.ok) setHotkeys(result.value.hotkeys);
    })();

    const unsubscribe = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const evt = payload as SettingsChangedEvent;
      loadedFromBroadcast = true;
      setHotkeys(evt.settings.hotkeys);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return hotkeys;
}
