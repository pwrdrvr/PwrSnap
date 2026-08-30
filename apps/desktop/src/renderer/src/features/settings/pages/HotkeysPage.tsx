// Hotkeys settings page. Editable rows for the globally-registered
// chords. Quick Capture / Region / Window / Full Screen / All Screens /
// Timed / Video Capture all drive real capture verbs; Re-show last
// Float-Over re-pops the most recent capture. Region / Window / Full
// Screen / All Screens / Timed default to UNBOUND (also reachable from
// the tray) — bind them here if you want a dedicated chord.
//
// The EDITOR card is a read-only reference for the in-canvas tool keys
// (V / A / S / H / B / T / C). Those are hardcoded in the editor and
// aren't rebindable — the card documents them so they're discoverable.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  Card,
  Hk,
  HotkeyCapture,
  HotkeyResetModal,
  Row,
  type HotkeyChange
} from "../components";
import { useSettingsContext } from "../SettingsContext";
import { TOOLS } from "../../editor/editor-tools";
import {
  DEFAULT_HOTKEYS,
  acceleratorToDisplayText,
  acceleratorsAreEquivalent,
  defaultHotkeysForPlatform,
  shortcutPlatformFromString,
  type HotkeyRegistrationStatusSnapshot
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";

/** The hotkey kinds this page edits — derived from the schema so a new
 *  `Settings["hotkeys"]` field is a compile error here until it gets a
 *  label below. */
type HotkeyKey = keyof typeof DEFAULT_HOTKEYS;

/** Human labels for the editable bindings — used both in the in-page
 *  rows and in the reset-confirmation modal's diff list. */
const HOTKEY_LABELS: Record<HotkeyKey, string> = {
  quickCapture: "Quick Capture",
  region: "Region",
  window: "Window",
  fullScreen: "Full Screen",
  allScreens: "All Screens",
  timed: "Timed (5 s)",
  videoCapture: "Video Capture",
  reshowFloatOver: "Re-show last Float-Over"
};

export function HotkeysPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const hk = settings?.hotkeys ?? null;
  const platform = shortcutPlatformFromString(window.pwrsnapApi?.platform);
  const hotkeyDefaults = useMemo(() => defaultHotkeysForPlatform(platform), [platform]);
  const [recordingKey, setRecordingKey] = useState<HotkeyKey | null>(null);
  const [preparingKeys, setPreparingKeys] = useState<ReadonlySet<HotkeyKey>>(
    () => new Set()
  );
  const [confirmingReset, setConfirmingReset] = useState<boolean>(false);
  const [registrationStatus, setRegistrationStatus] =
    useState<HotkeyRegistrationStatusSnapshot | null>(null);
  const [retryingKey, setRetryingKey] = useState<HotkeyKey | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [hotkeyMutationCount, setHotkeyMutationCount] = useState<number>(0);
  const hotkeyMutationBusy = hotkeyMutationCount > 0;

  const refreshRegistrationStatus = useCallback(async (): Promise<void> => {
    const result = await dispatch("settings:hotkeyStatus", {});
    if (!result.ok) {
      setStatusError(result.error.message);
      return;
    }
    setRegistrationStatus(result.value);
    setStatusError(null);
  }, []);

  useEffect(() => {
    void refreshRegistrationStatus();
  }, [refreshRegistrationStatus]);

  const runHotkeyMutation = async <T,>(operation: () => Promise<T>): Promise<T> => {
    setHotkeyMutationCount((count) => count + 1);
    try {
      return await operation();
    } finally {
      setHotkeyMutationCount((count) => Math.max(0, count - 1));
    }
  };

  const writeOne = async (key: HotkeyKey, next: string): Promise<void> => {
    await runHotkeyMutation(async () => {
      const hotkeysPatch: Partial<Record<HotkeyKey, string>> = {};
      hotkeysPatch[key] = next;
      await patch({ hotkeys: hotkeysPatch });
      await refreshRegistrationStatus();
    });
  };

  const onCommit = (key: HotkeyKey) => async (next: string): Promise<void> => {
    await writeOne(key, next);
    setRecordingKey((current) => (current === key ? null : current));
  };
  const onUnbind = (key: HotkeyKey) => (): Promise<void> => writeOne(key, "");
  const onPreparingChange =
    (key: HotkeyKey) =>
    (preparing: boolean): void => {
      setPreparingKeys((current) => {
        const next = new Set(current);
        if (preparing) next.add(key);
        else next.delete(key);
        return next;
      });
    };
  const recorderProps = (key: HotkeyKey) => ({
    label: HOTKEY_LABELS[key],
    platform,
    recording: recordingKey === key,
    onStart: (): void => setRecordingKey(key),
    onCancel: (): void => setRecordingKey((current) => (current === key ? null : current)),
    onPreparingChange: onPreparingChange(key),
    onCommit: onCommit(key),
    onUnbind: onUnbind(key)
  });

  const retryHotkey = async (key: HotkeyKey): Promise<void> => {
    if (hotkeyMutationBusy) return;
    setRetryingKey(key);
    try {
      await runHotkeyMutation(async () => {
        const result = await dispatch("settings:retryHotkey", { key });
        if (!result.ok) {
          setStatusError(result.error.message);
          return;
        }
        setRegistrationStatus(result.value);
        setStatusError(null);
      });
    } finally {
      setRetryingKey((current) => (current === key ? null : current));
    }
  };

  const hotkeyControl = (key: HotkeyKey, value: string): ReactElement => {
    const status = registrationStatus?.[key];
    // A status request can resolve just after a settings-change broadcast.
    // Never attach an old binding's failure to the newly persisted chord.
    const inactive = status?.state === "inactive" && status.accelerator === value;
    return (
      <div className="pss__hotkey-control">
        <HotkeyCapture {...recorderProps(key)} value={value} />
        {inactive ? (
          <div className="pss__hotkey-registration-error" role="alert">
            <span>
              {status.failure?.message ??
                `${HOTKEY_LABELS[key]} is not active. Choose another combination.`}
            </span>
            <button
              type="button"
              className="pss__hotkey-retry"
              disabled={hotkeyMutationBusy}
              aria-label={`Retry ${HOTKEY_LABELS[key]} hotkey`}
              onClick={() => void retryHotkey(key)}
            >
              {retryingKey === key ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  /** Diff every editable binding against its default. Drives both the
   *  customization-count badge in the header and the modal's diff list. */
  const pendingChanges = useMemo<HotkeyChange[]>(() => {
    if (hk === null) return [];
    const out: HotkeyChange[] = [];
    for (const key of Object.keys(hotkeyDefaults) as HotkeyKey[]) {
      const current = hk[key];
      const next = hotkeyDefaults[key];
      if (acceleratorsAreEquivalent(current, next, platform)) continue;
      out.push({ key, label: HOTKEY_LABELS[key], current, next });
    }
    return out;
  }, [hk, hotkeyDefaults, platform]);

  const onConfirmReset = async (): Promise<void> => {
    await runHotkeyMutation(async () => {
      await patch({ hotkeys: { ...hotkeyDefaults } });
      await refreshRegistrationStatus();
    });
    setConfirmingReset(false);
  };

  const count = pendingChanges.length;
  const customizedNoun = count === 1 ? "customization" : "customizations";
  const recorderPreparing = preparingKeys.size > 0;

  const defaultDescription = (accelerator: string): string =>
    accelerator === ""
      ? "Unbound by default on this platform"
      : `Defaults to ${acceleratorToDisplayText(accelerator, platform)}`;

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">Hotkeys</h1>
          <p className="pss__main-sub">
            PwrSnap is keyboard-first. Quick Capture is the &ldquo;smart&rdquo;
            trigger — picks region, window, or full-screen based on the cursor.
            Click any chord below to rebind. Press Escape mid-record to cancel.
          </p>
        </div>
        <div className="pss__main-actions">
          {count > 0 ? (
            <span className="pss__main-count" aria-live="polite">
              {count} {customizedNoun}
            </span>
          ) : null}
          <button
            type="button"
            className="pss__top-btn"
            disabled={count === 0 || hotkeyMutationBusy || recorderPreparing}
            onClick={() => {
              if (recorderPreparing) return;
              setRecordingKey(null);
              setConfirmingReset(true);
            }}
          >
            Reset to defaults
          </button>
        </div>
      </div>

      {statusError !== null ? (
        <div className="pss__hotkey-status-error" role="alert">
          Could not update global hotkey status: {statusError}
        </div>
      ) : null}

      <Card eyebrow="CAPTURE" title="Global capture shortcuts">
        <Row
          label="Quick Capture"
          sub="The smart trigger. Picks region, window, or full-screen based on the cursor."
          tag="global"
        >
          {hotkeyControl("quickCapture", hk?.quickCapture ?? "")}
        </Row>
        <Row
          label="Region"
          sub="Drag a marquee on any display. Unbound by default — Quick Capture covers it."
          tag="global"
        >
          {hotkeyControl("region", hk?.region ?? "")}
        </Row>
        <Row
          label="Window"
          sub="Click a window. Unbound by default — Quick Capture covers it."
          tag="global"
        >
          {hotkeyControl("window", hk?.window ?? "")}
        </Row>
        <Row
          label="Full Screen"
          sub="Capture the display under the cursor — no selector. Unbound by default; also available from the tray."
          tag="global"
        >
          {hotkeyControl("fullScreen", hk?.fullScreen ?? "")}
        </Row>
        <Row
          label="All Screens"
          sub="Stitch every connected display into a single image. Unbound by default; also available from the tray."
          tag="global"
        >
          {hotkeyControl("allScreens", hk?.allScreens ?? "")}
        </Row>
        <Row
          label="Timed (5 s)"
          sub="5-second countdown, then the auto picker — useful for menus that close on focus loss. Unbound by default; also available from the tray."
          tag="global"
        >
          {hotkeyControl("timed", hk?.timed ?? "")}
        </Row>
        <Row
          label="Video Capture"
          sub={`Pick a region/window, then record. ${defaultDescription(
            hotkeyDefaults.videoCapture
          )}${
            hotkeyDefaults.videoCapture === ""
              ? ". Choose a combination to enable it."
              : ` (not ${acceleratorToDisplayText(
                  "CommandOrControl+Shift+V",
                  platform
                )} — that's Paste & Match Style system-wide).`
          }`}
          tag="global"
        >
          {hotkeyControl("videoCapture", hk?.videoCapture ?? "")}
        </Row>
      </Card>

      <Card eyebrow="APP" title="Library & surfaces">
        <Row
          label="Re-show last Float-Over"
          sub={`Pops the most recent capture back over the screen. ${defaultDescription(
            hotkeyDefaults.reshowFloatOver
          )} — ${
            hotkeyDefaults.reshowFloatOver === ""
              ? "choose a combination to enable it."
              : "rebind or unbind any time."
          }`}
          tag="global"
        >
          {hotkeyControl("reshowFloatOver", hk?.reshowFloatOver ?? "")}
        </Row>
      </Card>

      <Card
        eyebrow="EDITOR"
        title="In-canvas tools (Focus + Float-Over)"
        defaultCollapsed
      >
        {TOOLS.map((t, i) => (
          <Row
            key={t.id}
            label={t.label}
            sub={
              i === 0
                ? "Single-letter shortcuts, active when the editor canvas has focus. Fixed — not rebindable."
                : ""
            }
          >
            <Hk keys={[t.key]} />
          </Row>
        ))}
      </Card>

      {confirmingReset ? (
        <HotkeyResetModal
          changes={pendingChanges}
          platform={platform}
          onCancel={() => setConfirmingReset(false)}
          onConfirm={onConfirmReset}
        />
      ) : null}
    </>
  );
}
