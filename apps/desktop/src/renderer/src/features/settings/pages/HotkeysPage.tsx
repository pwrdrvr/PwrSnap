// Hotkeys settings page. Editable rows for the globally-registered
// chords. Quick Capture / Region / Window / Full Screen / All Screens /
// Timed / Video Capture all drive real capture verbs; Re-show last
// Float-Over re-pops the most recent capture and Open Library raises
// the Library window. Region / Window / Full Screen / All Screens /
// Timed / Open Library default to UNBOUND (all also reachable from the
// tray) — bind them here if you want a dedicated chord.
//
// The EDITOR card is a read-only reference for the in-canvas tool keys
// (V / A / S / H / B / T / C). Those are hardcoded in the editor and
// aren't rebindable — the card documents them so they're discoverable.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Card,
  Hk,
  HotkeyCapture,
  HotkeyResetModal,
  Row,
  type HotkeyChange
} from "../components";
import { useSettingsContext } from "../SettingsContext";
import { SettingsPatchError } from "../useSettings";
import { HotkeyRecovery } from "../components/HotkeyRecovery";
import { TOOLS } from "../../editor/editor-tools";
import {
  DEFAULT_HOTKEYS,
  acceleratorToAccessibleText,
  acceleratorToDisplayText,
  acceleratorsAreEquivalent,
  defaultHotkeysForPlatform,
  shortcutPlatformDisplayName,
  shortcutPlatformFromString,
  suggestHotkeyAlternatives,
  type HotkeyRegistrationStatusSnapshot
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { settingsGroupOf, settingsPageName } from "../settings-categories";

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
  reshowFloatOver: "Re-show last Float-Over",
  openLibrary: "Open Library"
};

const HOTKEY_KEYS = Object.keys(DEFAULT_HOTKEYS) as HotkeyKey[];
const triggerId = (key: HotkeyKey): string => `settings-hotkey-${key}`;

function rejectedKind(error: unknown): "duplicate" | "unsupported" | "failed" | null {
  if (!(error instanceof SettingsPatchError)) return null;
  switch (error.code) {
    case "hotkey_duplicate": return "duplicate";
    case "hotkey_unsupported":
    case "invalid_hotkey_shape": return "unsupported";
    case "hotkey_unavailable": return "failed";
    default: return null;
  }
}

type FailedEdit = {
  key: HotkeyKey;
  attempted: string;
  kind: Exclude<ReturnType<typeof rejectedKind>, null>;
  detail: string;
  options: readonly string[] | undefined;
};

export function HotkeysPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const hk = settings?.hotkeys ?? null;
  const platform = shortcutPlatformFromString(window.pwrsnapApi?.platform);
  const platformName = shortcutPlatformDisplayName(platform);
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
  const [failedEdit, setFailedEdit] = useState<FailedEdit | null>(null);
  const [trying, setTrying] = useState<{ key: HotkeyKey; accelerator: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ key: HotkeyKey; accelerator: string; verb: "Saved" | "Active" } | null>(null);
  const [lastRetry, setLastRetry] = useState<{ key: HotkeyKey; accelerator: string; time: string } | null>(null);
  const applyInFlight = useRef(false);
  const focusAfterApply = useRef<HotkeyKey | null>(null);
  const flashingRow = useRef<HTMLElement | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [rejected, setRejected] = useState<ReadonlySet<string>>(() => new Set());
  const [hotkeyMutationCount, setHotkeyMutationCount] = useState<number>(0);
  const hotkeyMutationBusy = hotkeyMutationCount > 0;
  const statusRequest = useRef(0);

  const refreshRegistrationStatus = useCallback(async (): Promise<void> => {
    const request = ++statusRequest.current;
    try {
      const result = await dispatch("settings:hotkeyStatus", {});
      if (request !== statusRequest.current) return;
      if (!result.ok) {
        setStatusError(result.error.message);
        return;
      }
      setRegistrationStatus(result.value);
      setStatusError(null);
    } catch (error) {
      if (request === statusRequest.current) setStatusError(String(error));
    }
  }, []);

  useEffect(() => {
    void refreshRegistrationStatus();
    return () => clearTimeout(flashTimer.current);
  }, [refreshRegistrationStatus]);

  useEffect(() => {
    if (confirmation === null) return;
    const timer = setTimeout(() => setConfirmation(null), 6_000);
    return () => clearTimeout(timer);
  }, [confirmation]);

  useLayoutEffect(() => {
    if (trying !== null || hotkeyMutationBusy || focusAfterApply.current === null) return;
    document.getElementById(triggerId(focusAfterApply.current))?.focus();
    focusAfterApply.current = null;
  }, [trying, hotkeyMutationBusy]);

  const runHotkeyMutation = async <T,>(operation: () => Promise<T>): Promise<T> => {
    setHotkeyMutationCount((count) => count + 1);
    try {
      return await operation();
    } finally {
      setHotkeyMutationCount((count) => Math.max(0, count - 1));
    }
  };

  const writeOne = async (key: HotkeyKey, next: string): Promise<void> => {
    const conflict = findConflict(key, next);
    if (conflict !== undefined) {
      throw new SettingsPatchError("hotkey_duplicate", `${HOTKEY_LABELS[conflict]} already uses this shortcut.`);
    }
    await runHotkeyMutation(async () => {
      const hotkeysPatch: Partial<Record<HotkeyKey, string>> = {};
      hotkeysPatch[key] = next;
      await patch({ hotkeys: hotkeysPatch });
      await refreshRegistrationStatus();
    });
  };

  const onCommit = (key: HotkeyKey) => async (next: string): Promise<void> => {
    await writeOne(key, next);
    setConfirmation({ key, accelerator: next, verb: "Saved" });
    setRecordingKey((current) => (current === key ? null : current));
  };
  const onUnbind = (key: HotkeyKey) => (): Promise<void> => writeOne(key, "");
  function findConflict(key: HotkeyKey, accelerator: string, candidates = HOTKEY_KEYS): HotkeyKey | undefined {
    if (hk === null || accelerator === "") return undefined;
    return candidates.find((other) => other !== key && acceleratorsAreEquivalent(accelerator, hk[other], platform));
  }

  const rememberFailure = (
    key: HotkeyKey,
    attempted: string,
    error: unknown,
    options?: readonly string[]
  ): boolean => {
    const kind = rejectedKind(error);
    if (kind === null && options === undefined) return false;
    const chord = acceleratorToDisplayText(attempted, platform);
    let detail = error instanceof Error ? error.message : "PwrSnap could not save this shortcut.";
    if (kind === "failed") {
      detail = error instanceof SettingsPatchError && error.threw
        ? `Registering ${chord} failed with an error, so PwrSnap didn’t save it.`
        : `${platformName} didn’t let PwrSnap register ${chord}${options === undefined ? "" : " either"}. ` +
          `Another app or a ${platformName} shortcut may be using it. PwrSnap can’t see which.`;
    }
    setFailedEdit({ key, attempted, kind: kind ?? "failed", detail, options });
    if (kind !== null) setRejected((current) => new Set([...current, attempted]));
    return true;
  };

  const focusHotkey = (key: HotkeyKey): void => document.getElementById(triggerId(key))?.focus();

  const showHotkey = (key: HotkeyKey): void => {
    const button = document.getElementById(triggerId(key));
    const row = button?.closest<HTMLElement>(".pss__row");
    if (row === null || row === undefined) return;
    row.scrollIntoView?.({ block: "nearest" });
    button?.focus({ preventScroll: true });
    clearTimeout(flashTimer.current);
    flashingRow.current?.classList.remove("is-flash");
    flashingRow.current = row;
    row.classList.add("is-flash");
    flashTimer.current = setTimeout(() => row.classList.remove("is-flash"), 1_200);
  };

  const applySuggestion = async (key: HotkeyKey, accelerator: string, options: readonly string[]): Promise<void> => {
    if (applyInFlight.current || hotkeyMutationBusy || recordingKey !== null || preparingKeys.size > 0) return;
    applyInFlight.current = true;
    setTrying({ key, accelerator });
    try {
      await writeOne(key, accelerator);
      setFailedEdit(null);
      setConfirmation({ key, accelerator, verb: "Saved" });
      focusAfterApply.current = key;
    } catch (error) {
      rememberFailure(key, accelerator, error, options);
      await refreshRegistrationStatus();
    } finally {
      setTrying(null);
      applyInFlight.current = false;
    }
  };
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
    triggerId: triggerId(key),
    disabled: hotkeyMutationBusy,
    recording: recordingKey === key,
    onStart: (): void => {
      setFailedEdit(null);
      setRecordingKey(key);
    },
    onCancel: (): void => setRecordingKey((current) => (current === key ? null : current)),
    onPreparingChange: onPreparingChange(key),
    onLeaseEnded: refreshRegistrationStatus,
    onCommitFailed: (accelerator: string, error: unknown): boolean => {
      if (!rememberFailure(key, accelerator, error)) return false;
      // The pre-recording snapshot cannot tell us which callbacks were
      // restored. The acknowledged lease end requests a fresh snapshot.
      statusRequest.current += 1;
      setRegistrationStatus(null);
      return true;
    },
    onCommit: onCommit(key),
    onUnbind: onUnbind(key)
  });

  const retryHotkey = async (key: HotkeyKey): Promise<void> => {
    if (hotkeyMutationBusy) return;
    setRetryingKey(key);
    try {
      await runHotkeyMutation(async () => {
        const request = ++statusRequest.current;
        const result = await dispatch("settings:retryHotkey", { key });
        if (request !== statusRequest.current) return;
        if (!result.ok) {
          setStatusError(result.error.message);
          return;
        }
        setRegistrationStatus(result.value);
        setStatusError(null);
        if (result.value[key].state === "active") {
          setFailedEdit((current) => current?.key === key ? null : current);
          setConfirmation({ key, accelerator: result.value[key].accelerator, verb: "Active" });
        } else {
          setLastRetry({
            key,
            accelerator: result.value[key].accelerator,
            time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date())
          });
        }
      });
    } finally {
      setRetryingKey((current) => (current === key ? null : current));
    }
  };

  const hotkeyControl = (key: HotkeyKey, value: string): ReactElement => {
    // A status request can resolve just after a settings-change broadcast.
    // Never attach an old binding's failure to the newly persisted chord.
    const snapshot = registrationStatus?.[key];
    const status = snapshot?.accelerator === value ? snapshot : undefined;
    const inactive = status?.state === "inactive";
    const failure = inactive ? status.failure : null;
    const label = HOTKEY_LABELS[key];
    const edit = failedEdit?.key === key ? failedEdit : null;
    // A duplicate failure describes the last attempt. Retry gives the first
    // configured row priority, so look for a current owner in that same order.
    const savedDuplicate = failure?.code === "duplicate" && failure.conflictsWith !== undefined;
    const savedConflict = savedDuplicate
      ? findConflict(key, value, HOTKEY_KEYS.slice(0, HOTKEY_KEYS.indexOf(key)))
      : undefined;
    const duplicateCleared = savedDuplicate && savedConflict === undefined;
    const kind = edit?.kind ?? (inactive
      ? (failure?.code === "duplicate" && !duplicateCleared ? "duplicate" : "inactive")
      : null);
    const attempted = edit?.attempted ?? value;
    const attemptedText = acceleratorToDisplayText(attempted, platform);
    const conflictKey = edit?.kind === "duplicate"
      ? findConflict(key, attempted)
      : edit === null ? savedConflict : undefined;
    const conflictLabel = conflictKey === undefined ? undefined : HOTKEY_LABELS[conflictKey];
    const title = edit?.kind === "unsupported"
      ? `${attemptedText} can’t be a global shortcut on ${platformName}`
      : conflictLabel !== undefined
        ? (edit === null ? `${label} isn’t active: ${conflictLabel} also uses ${attemptedText}` : `${conflictLabel} already uses ${attemptedText}`)
        : edit !== null ? `Couldn’t use ${attemptedText} for ${label}` : `${label} isn’t active`;
    const retried = lastRetry?.key === key && lastRetry.accelerator === value;
    let detail = edit?.detail ?? failure?.message ?? "Choose another combination.";
    if (edit === null && duplicateCleared) {
      detail = "The other shortcut has changed. Retry to activate this shortcut.";
    } else if (kind === "duplicate" && conflictLabel !== undefined) {
      detail = edit === null
        ? "Both rows are saved with the same combination. Change one of them."
        : `Pick a different combination here, or change ${conflictLabel} first.`;
    } else if (edit === null && failure?.code === "unavailable") {
      const prefix = retried ? `Tried again at ${lastRetry.time}. ` : "";
      detail = `${prefix}PwrSnap could not register ${attemptedText} for ${label}. ` +
        "This shortcut stays saved and PwrSnap tries it again at startup.";
    } else if (edit === null && failure?.threw) {
      detail = `${retried ? `Tried again at ${lastRetry.time}. ` : ""}Registering ${attemptedText} failed with an error. This shortcut stays saved.`;
    }
    const alternatives = kind === null || hk === null
      ? []
      : edit?.options ?? suggestHotkeyAlternatives(platform, key, attempted, hk, rejected);
    const canRetry = duplicateCleared || failure?.code === "unavailable" || failure?.code === "registration_error";
    const showConfirmation = confirmation?.key === key &&
      status?.state === "active" && acceleratorsAreEquivalent(value, confirmation.accelerator, platform);
    return (
      <div className="pss__hotkey-control">
        <HotkeyCapture {...recorderProps(key)} value={value} inactive={inactive} />
        {kind !== null && recordingKey !== key ? (
          <HotkeyRecovery
            kind={kind}
            title={title}
            detail={detail}
            action={label}
            platform={platform}
            saved={edit === null ? undefined : value}
            status={status}
            focusAttempt={edit?.attempted}
            focusNextAlternative={edit?.options !== undefined}
            alternatives={alternatives}
            rejected={rejected}
            trying={trying?.key === key ? trying.accelerator : undefined}
            disabled={hotkeyMutationBusy || trying !== null || recordingKey !== null || preparingKeys.size > 0}
            retrying={retryingKey === key}
            conflict={conflictKey === undefined ? undefined : { label: HOTKEY_LABELS[conflictKey], show: () => showHotkey(conflictKey) }}
            onTry={(accelerator) => void applySuggestion(key, accelerator, alternatives)}
            onRetry={canRetry ? () => void retryHotkey(key) : undefined}
            onRecord={() => document.getElementById(triggerId(key))?.click()}
            onDismiss={edit === null ? undefined : () => {
              setFailedEdit(null);
              focusHotkey(key);
            }}
          />
        ) : showConfirmation ? (
          <span className="pss__hk-confirm" role="status" aria-label={`${label} set to ${acceleratorToAccessibleText(value, platform)}`}>
            ✓ {confirmation.verb}. {platformName} registered it for PwrSnap.
          </span>
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
    setFailedEdit(null);
    setConfirmingReset(false);
  };

  const count = pendingChanges.length;
  const customizedNoun = count === 1 ? "customization" : "customizations";
  const recorderPreparing = preparingKeys.size > 0;
  const inactiveKeys = HOTKEY_KEYS.filter((key) => {
    const status = registrationStatus?.[key];
    return status?.state === "inactive" && status.accelerator === hk?.[key];
  });

  const defaultDescription = (accelerator: string): string =>
    accelerator === ""
      ? "Unbound by default on this platform"
      : `Defaults to ${acceleratorToDisplayText(accelerator, platform)}`;

  return (
    <>
      <div className="pss__main-hdr pss__hotkeys-header">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">{settingsGroupOf("hotkeys")}</div>
          <h1 className="pss__main-title">{settingsPageName("hotkeys")}</h1>
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

      {inactiveKeys.length > 0 ? (
        <div className="pss__hotkey-summary" role="status">
          <b>{inactiveKeys.length} {inactiveKeys.length === 1 ? "shortcut isn’t" : "shortcuts aren’t"} active</b>
          <div className="pss__hotkey-summary-links">
            {inactiveKeys.map((key) => (
              <a key={key} className="pss__hotkey-summary-link" href={`#${triggerId(key)}`}
                onClick={(event) => { event.preventDefault(); showHotkey(key); }}>
                {HOTKEY_LABELS[key]}
              </a>
            ))}
          </div>
        </div>
      ) : null}

      <Card eyebrow="CAPTURE" title="Global capture shortcuts">
        <Row
          label="Quick Capture"
          sub="The smart trigger. Picks region, window, or full-screen based on the cursor."
        >
          {hotkeyControl("quickCapture", hk?.quickCapture ?? "")}
        </Row>
        <Row
          label="Region"
          sub="Drag a marquee on any display. Unbound by default — Quick Capture covers it."
        >
          {hotkeyControl("region", hk?.region ?? "")}
        </Row>
        <Row
          label="Window"
          sub="Click a window. Unbound by default — Quick Capture covers it."
        >
          {hotkeyControl("window", hk?.window ?? "")}
        </Row>
        <Row
          label="Full Screen"
          sub="Capture the display under the cursor — no selector. Unbound by default; also available from the tray."
        >
          {hotkeyControl("fullScreen", hk?.fullScreen ?? "")}
        </Row>
        <Row
          label="All Screens"
          sub="Stitch every connected display into a single image. Unbound by default; also available from the tray."
        >
          {hotkeyControl("allScreens", hk?.allScreens ?? "")}
        </Row>
        <Row
          label="Timed (5 s)"
          sub="5-second countdown, then the auto picker — useful for menus that close on focus loss. Unbound by default; also available from the tray."
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
        >
          {hotkeyControl("reshowFloatOver", hk?.reshowFloatOver ?? "")}
        </Row>
        <Row
          label="Open Library"
          sub={`Brings the Library window forward, reopening it if you closed it. Unbound by default — ${acceleratorToDisplayText(
            "CommandOrControl+Shift+L",
            platform
          )} is taken by editors and by PwrSnap's own Sizzle window, and a global chord would shadow both.`}
        >
          {hotkeyControl("openLibrary", hk?.openLibrary ?? "")}
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
