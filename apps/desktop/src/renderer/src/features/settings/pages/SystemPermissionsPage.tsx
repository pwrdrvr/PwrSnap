// Settings → Capture → System Permissions.
//
// Presentation is explicitly platform-owned. macOS retains its three TCC
// rows and first-request/recovery flow. Windows must not reuse the recording
// pipeline's permissive readiness fallback as permission evidence: Electron
// always returns `granted` for screen there, while microphone reflects one
// global control for all classic desktop apps. The main response therefore
// carries separate `permissionEvidence`, and the Windows view renders only
// the inspectable/useful controls (screen limitation + global microphone),
// with system audio omitted because the current recorder is screen-only.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import type {
  CapturesAccessHealth,
  CapturesLocationStatus,
  PermissionReadinessReport,
  RecordingPermission,
  RecordingPermissionStatus
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { Card, Row } from "../components";
import { dispatch } from "../../../lib/pwrsnap";

type RowSpec = {
  permission: RecordingPermission;
  title: string;
};

const DARWIN_ROWS: readonly RowSpec[] = [
  { permission: "screen", title: "Screen Recording" },
  { permission: "microphone", title: "Microphone" },
  { permission: "systemAudio", title: "System Audio" }
];

function darwinStatusLabel(status: RecordingPermissionStatus): string {
  switch (status) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "not-determined":
      return "Not yet requested";
    case "restricted":
      return "Restricted by policy";
    case "unavailable":
      return "Unavailable on this Mac";
    case "unknown":
      return "Unknown";
  }
}

function statusTone(status: RecordingPermissionStatus): "ok" | "warn" | "neutral" {
  if (status === "granted") return "ok";
  // "Not yet requested" is a normal first-run state, not an error — keep
  // it neutral so a fresh install doesn't look broken. `denied` stays warn.
  if (
    status === "unavailable" ||
    status === "restricted" ||
    status === "not-determined"
  ) {
    return "neutral";
  }
  return "warn";
}

/**
 * Status-specific guidance shown beneath each row. Screen / system-audio
 * `not-determined` is PwrSnap's synthesized "we've never asked" state (see
 * `screenCapturePrompted`); `denied` means macOS has already recorded a
 * decision and won't prompt again, so the only path is the Privacy pane +
 * (usually) a relaunch.
 */
function darwinStatusHint(
  permission: RecordingPermission,
  status: RecordingPermissionStatus
): string {
  if (permission === "microphone") {
    if (status === "not-determined")
      return "Click Ask now and approve the macOS prompt to let recordings include your microphone.";
    if (status === "denied")
      return "Turn Microphone back on for PwrSnap in System Settings → Privacy & Security.";
    return "Optional. Lets video recordings include your microphone audio.";
  }
  // screen + systemAudio share the Screen Recording grant.
  if (status === "not-determined") {
    return "PwrSnap will ask macOS for this the first time you capture. Click Request access to do it now — macOS shows its own approval dialog.";
  }
  if (status === "denied") {
    return "Turn on Screen Recording for PwrSnap in System Settings → Privacy & Security → Screen & System Audio Recording. If it's already on, relaunch PwrSnap so the change takes effect.";
  }
  if (status === "unavailable") {
    return "Requires macOS 13 or newer. System audio shares the Screen Recording grant.";
  }
  return permission === "systemAudio"
    ? "Optional. Lets video recordings capture sound from other apps. Requires macOS 13+ and shares the Screen Recording grant."
    : "Required to capture any pixels from your display.";
}

function windowsMicrophoneLabel(status: RecordingPermissionStatus): string {
  switch (status) {
    case "granted":
      return "Allowed by Windows";
    case "denied":
      return "Blocked by Windows";
    case "restricted":
      return "Restricted by policy";
    case "not-determined":
    case "unknown":
      return "Not reported";
    case "unavailable":
      return "Unavailable";
  }
}

function windowsMicrophoneTone(
  status: RecordingPermissionStatus
): "ok" | "warn" | "neutral" {
  if (status === "granted") return "ok";
  if (status === "denied") return "warn";
  return "neutral";
}

function statusColor(tone: "ok" | "warn" | "neutral"): string {
  return tone === "ok"
    ? "var(--success-text, #22c55e)"
    : tone === "warn"
    ? "var(--warning-text, #ff8a1f)"
    : "var(--text-secondary)";
}

export function SystemPermissionsPage(): ReactElement {
  const platform = window.pwrsnapApi?.platform;
  const isDarwin = platform === "darwin";
  const isWindows = platform === "win32";
  const [readiness, setReadiness] = useState<PermissionReadinessReport | null>(null);
  const [busyPermission, setBusyPermission] = useState<RecordingPermission | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  // Captures-folder access is a real write probe on every platform. The copy
  // explains the platform-specific failure class (Files & Folders on macOS,
  // Controlled Folder Access / antivirus / OneDrive on Windows) without
  // treating an absence of observed failures as a completed check.
  const [capturesHealth, setCapturesHealth] = useState<CapturesAccessHealth | null>(null);
  const [capturesLocation, setCapturesLocation] = useState<CapturesLocationStatus | null>(null);
  const [capturesBusy, setCapturesBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await dispatch("permissions:readiness", {});
    if (res.ok) {
      setReadiness(res.value);
      setLastError(null);
    } else {
      setLastError(res.error.message);
    }
  }, []);

  const refreshCapturesHealth = useCallback(async (): Promise<void> => {
    const res = await dispatch("storage:capturesAccessHealth", {});
    if (res.ok) setCapturesHealth(res.value);
  }, []);

  const refreshCapturesLocation = useCallback(async (): Promise<void> => {
    const res = await dispatch("storage:capturesLocationStatus", {});
    if (res.ok) setCapturesLocation(res.value);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Windows owns the microphone toggle in a separate Settings window. Re-read
  // its global desktop-app status when the user returns so this page does not
  // keep showing the value from before the settings round-trip.
  useEffect(() => {
    if (!isWindows) return;
    const refreshOnFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [isWindows, refresh]);

  // Read captures-access health once, then stay live off the same event
  // channel the Library banner uses (a capture that fails mid-session
  // flips this row to "Denied" without a re-open).
  useEffect(() => {
    void refreshCapturesHealth();
    void refreshCapturesLocation();
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.capturesAccessChanged,
      (payload) => setCapturesHealth(payload as CapturesAccessHealth)
    );
    const unsubscribeSettings = window.pwrsnapApi?.on(
      EVENT_CHANNELS.settingsChanged,
      () => void refreshCapturesLocation()
    );
    return () => {
      unsubscribe?.();
      unsubscribeSettings?.();
    };
  }, [refreshCapturesHealth, refreshCapturesLocation]);

  const checkCapturesAccess = useCallback(async (): Promise<void> => {
    setCapturesBusy(true);
    try {
      // Active probe — may show the macOS Documents prompt. Updates the
      // health snapshot main-side; we re-read it for the result.
      const res = await dispatch("storage:checkCapturesAccess", {});
      if (!res.ok) {
        setLastError(res.error.message);
        return;
      }
      await Promise.all([refreshCapturesHealth(), refreshCapturesLocation()]);
    } finally {
      setCapturesBusy(false);
    }
  }, [refreshCapturesHealth, refreshCapturesLocation]);

  const moveCapturesToDocuments = useCallback(async (): Promise<void> => {
    setCapturesBusy(true);
    try {
      const res = await dispatch("storage:moveCapturesToDocuments", {});
      if (!res.ok) {
        setLastError(res.error.message);
        return;
      }
      setCapturesLocation(res.value);
      setLastError(null);
    } finally {
      setCapturesBusy(false);
    }
  }, []);

  const openCapturesSettings = useCallback(async (): Promise<void> => {
    const res = await dispatch("storage:openCapturesAccessSettings", {});
    if (!res.ok) setLastError(res.error.message);
  }, []);

  const requestDarwinPermission = useCallback(
    async (permission: RecordingPermission, status: RecordingPermissionStatus) => {
      setBusyPermission(permission);
      try {
        if (permission === "microphone") {
          // Mic: askForMediaAccess re-prompts directly.
          const res = await dispatch("permissions:request", { permission });
          if (!res.ok) {
            setLastError(res.error.message);
            return;
          }
          await refresh();
          return;
        }
        // Screen / system audio: ALWAYS try a real screen-capture probe
        // FIRST — even on the "Open System Settings" (denied) button. The
        // probe re-registers PwrSnap + shows the OS dialog when macOS has
        // no decision on file (fresh install, or after a `tccutil reset` /
        // a new unsigned dev build that gets a different TCC identity), and
        // it picks up a grant that just landed. Never skip it — that's how
        // a denied-looking app gets back into the Privacy pane.
        const res = await dispatch("permissions:request", { permission });
        if (!res.ok) {
          setLastError(res.error.message);
          return;
        }
        await refresh();
        // If the probe didn't grant AND macOS had already recorded a
        // decision (effective status was "denied", not the synthesized
        // "not-determined" first-ask), open System Settings as the
        // fallback — macOS won't re-prompt for an already-decided app, so
        // the Privacy pane is the only recovery. On the first ask the OS
        // dialog is the UI; don't stack a Settings window on top of it.
        if (res.value.status !== "granted" && status === "denied") {
          const opened = await dispatch("permissions:openSystemSettings", { permission });
          if (!opened.ok) {
            setLastError(opened.error.message);
          }
        }
      } finally {
        setBusyPermission(null);
      }
    },
    [refresh]
  );

  const openWindowsMicrophonePrivacy = useCallback(
    async (): Promise<void> => {
      setBusyPermission("microphone");
      try {
        const result = await dispatch("permissions:openSystemSettings", {
          permission: "microphone"
        });
        if (!result.ok) setLastError(result.error.message);
      } finally {
        setBusyPermission(null);
      }
    },
    []
  );

  const windowsMicrophoneEvidence =
    readiness?.permissionEvidence.platform === "win32"
      ? readiness.permissionEvidence.microphone
      : null;
  const windowsMicrophoneStatus: RecordingPermissionStatus =
    windowsMicrophoneEvidence?.kind === "os-status"
      ? windowsMicrophoneEvidence.status
      : "unknown";
  const windowsMicrophoneToneValue = windowsMicrophoneTone(
    windowsMicrophoneStatus
  );
  const canOpenWindowsMicrophonePrivacy =
    windowsMicrophoneStatus !== "restricted" &&
    windowsMicrophoneStatus !== "unavailable";

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Capture</div>
          <h1 className="pss__main-title">System Permissions</h1>
          <p className="pss__main-sub">
            {isDarwin ? (
              <>
                PwrSnap needs access to record your screen and, optionally,
                audio. Each capability has its own macOS approval, and we never
                use any of them unless you explicitly start a capture. On a
                fresh install you'll see <strong>Not yet requested</strong> —
                click <strong>Request access</strong> (or just take your first
                snap) and macOS will show its own approval dialog.
              </>
            ) : isWindows ? (
              <>
                Windows does not expose a reliable per-app screen-capture
                status to Electron, so PwrSnap labels that limitation instead
                of treating a fallback as proof. Windows does report the global
                microphone control for desktop apps. PwrSnap 1.1 recordings on
                Windows are screen-only, so microphone status is informational.
              </>
            ) : (
              <>
                This platform does not expose a reliable permission preflight
                to PwrSnap. Access is verified only when you start a capture.
              </>
            )}
          </p>
        </div>
      </div>

      {lastError !== null && (
        <Card eyebrow="ERROR" title="Last action failed">
          <Row label="Details" sub={lastError} tag="err">
            <span />
          </Row>
        </Card>
      )}

      {isDarwin ? (
        <Card eyebrow="STATUS" title="Recording capabilities">
          {DARWIN_ROWS.map((row) => {
            const rawStatus: RecordingPermissionStatus =
              readiness === null
                ? "unknown"
                : row.permission === "screen"
                ? readiness.screenRecording
                : row.permission === "microphone"
                ? readiness.microphone
                : readiness.systemAudio;
            // macOS reports `denied` for screen / system-audio both when
            // PwrSnap has never asked AND when the user explicitly denied —
            // `getMediaAccessStatus('screen')` can't tell them apart. Use
            // PwrSnap's own `screenCapturePrompted` memory to surface the
            // honest "Not yet requested" state (synthesized as
            // `not-determined`) so the row offers a working "Request access"
            // that fires the OS prompt, instead of a dead-end "Open System
            // Settings" for an app that isn't in the Privacy pane yet.
            const isScreenFamily =
              row.permission === "screen" || row.permission === "systemAudio";
            const neverRequested =
              isScreenFamily &&
              readiness !== null &&
              !readiness.screenCapturePrompted &&
              rawStatus !== "granted" &&
              rawStatus !== "unavailable" &&
              rawStatus !== "restricted";
            const status: RecordingPermissionStatus = neverRequested
              ? "not-determined"
              : rawStatus;
            const tone = statusTone(status);
            const showAction =
              status !== "granted" &&
              status !== "unavailable" &&
              status !== "restricted";
            return (
              <Row
                key={row.permission}
                label={row.title}
                sub={`${darwinStatusLabel(status)} — ${darwinStatusHint(
                  row.permission,
                  status
                )}`}
                tag={row.permission}
              >
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <span
                    data-permission-status={status}
                    data-tone={tone}
                    style={{
                      font: "500 11px/1 var(--font-sans)",
                      color: statusColor(tone),
                      textTransform: "uppercase",
                      letterSpacing: "0.04em"
                    }}
                  >
                    {darwinStatusLabel(status)}
                  </span>
                  {showAction && (
                    <button
                      type="button"
                      onClick={() =>
                        void requestDarwinPermission(row.permission, status)
                      }
                      disabled={
                        busyPermission === row.permission || readiness === null
                      }
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--surface)",
                        color: "var(--text)",
                        cursor:
                          busyPermission === row.permission ? "wait" : "pointer",
                        font: "500 12px/1 var(--font-sans)"
                      }}
                    >
                      {busyPermission === row.permission
                        ? "Working…"
                        : row.permission === "microphone"
                        ? "Ask now"
                        : status === "not-determined"
                        ? "Request access"
                        : "Open System Settings"}
                    </button>
                  )}
                </div>
              </Row>
            );
          })}
        </Card>
      ) : isWindows ? (
        <Card eyebrow="STATUS" title="Windows privacy controls">
          <Row
            label="Screen capture"
            sub="Not reported — PwrSnap's gdigrab recorder has no inspectable per-app screen permission. Starting a capture is the only reliable test; Windows Graphics Capture privacy controls do not prove gdigrab access."
            tag="screen"
          >
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span
                data-permission-status="not-inspectable"
                data-tone="neutral"
                style={{
                  font: "500 11px/1 var(--font-sans)",
                  color: statusColor("neutral"),
                  textTransform: "uppercase",
                  letterSpacing: "0.04em"
                }}
              >
                Not reported
              </span>
            </div>
          </Row>
          <Row
            label="Microphone privacy"
            sub={`${windowsMicrophoneLabel(
              windowsMicrophoneStatus
            )} — Windows reports one global microphone control for all desktop apps, not a PwrSnap-specific grant. The current Windows recorder is screen-only and does not use the microphone.`}
            tag="microphone"
          >
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span
                data-permission-status={`windows-${windowsMicrophoneStatus}`}
                data-tone={windowsMicrophoneToneValue}
                style={{
                  font: "500 11px/1 var(--font-sans)",
                  color: statusColor(windowsMicrophoneToneValue),
                  textTransform: "uppercase",
                  letterSpacing: "0.04em"
                }}
              >
                {windowsMicrophoneLabel(windowsMicrophoneStatus)}
              </span>
              {canOpenWindowsMicrophonePrivacy && (
                <button
                  type="button"
                  onClick={() => void openWindowsMicrophonePrivacy()}
                  disabled={busyPermission === "microphone" || readiness === null}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text)",
                    cursor:
                      busyPermission === "microphone" ? "wait" : "pointer",
                    font: "500 12px/1 var(--font-sans)"
                  }}
                >
                  {busyPermission === "microphone"
                    ? "Opening…"
                    : "Open microphone privacy"}
                </button>
              )}
            </div>
          </Row>
        </Card>
      ) : (
        <Card eyebrow="STATUS" title="Permission inspection">
          <Row
            label="Screen capture"
            sub="Not reported — this platform has no permission status that PwrSnap can inspect before capture."
            tag="screen"
          >
            <span data-permission-status="not-inspectable" data-tone="neutral">
              Not reported
            </span>
          </Row>
        </Card>
      )}

      <Card eyebrow="STORAGE" title="Captures folder">
        {(() => {
          const activeLocation = capturesLocation?.location ?? "documents";
          const isHome = activeLocation === "home";
          const documentsDenied =
            capturesHealth?.denied === true ||
            capturesLocation?.documentsAccess === "denied";
          const loadingLocation = capturesLocation === null;
          const overridden = capturesLocation?.overridden === true;
          const documentsConfirmed = capturesLocation?.documentsAccess === "confirmed";
          const homeItems = Math.max(
            capturesLocation?.homeCaptureReferences ?? 0,
            capturesLocation?.homeDirectoryEntryCount ?? 0
          );
          let label: string;
          let tone: "ok" | "warn" | "neutral";
          let hint: string;
          let checkLabel: string;

          if (overridden) {
            label = documentsDenied
              ? "Blocked"
              : documentsConfirmed
              ? "Writable"
              : "Custom";
            tone = documentsDenied
              ? "warn"
              : documentsConfirmed
              ? "ok"
              : "neutral";
            hint = documentsDenied
              ? `${capturesHealth?.deniedPathCount ?? 0} capture path(s) can't be accessed under the PWRSNAP_DATA_ROOT override. Check that custom folder's permissions, then try again.`
              : documentsConfirmed
              ? "PwrSnap completed a write check for the custom PWRSNAP_DATA_ROOT captures folder."
              : "Captures use the custom PWRSNAP_DATA_ROOT override. Check custom folder access runs a write probe against its captures subfolder.";
            checkLabel = "Check custom folder access";
          } else if (isDarwin) {
            label = loadingLocation
              ? "Checking…"
              : isHome
              ? "Home fallback"
              : documentsDenied
              ? "Denied"
              : "OK";
            tone = loadingLocation
              ? "neutral"
              : isHome || documentsDenied
              ? "warn"
              : "ok";
            hint = isHome
              ? capturesLocation?.canMoveToDocuments === true
                ? "Saving to ~/PwrSnap — Documents was blocked. This folder is empty and Documents access is confirmed, so new captures can use Documents again."
                : homeItems > 0
                ? `Saving to ~/PwrSnap — Documents was blocked. This choice stays sticky while ${homeItems} capture item(s) remain tied to the home folder.`
                : "Saving to ~/PwrSnap — Documents was blocked. Check Documents access to enable a user-initiated move back; PwrSnap never probes or relocates at startup."
              : documentsDenied
              ? `${capturesHealth?.deniedPathCount ?? 0} capture path(s) can't be accessed. Grant PwrSnap access to Documents under Privacy & Security → Files & Folders, then relaunch.`
              : "Captures are saved to ~/Documents/PwrSnap so you can find them in Finder. Check access performs the only active Documents probe.";
            checkLabel = isHome ? "Check Documents access" : "Check access";
          } else if (isWindows) {
            label = loadingLocation
              ? "Checking…"
              : isHome
              ? "Home fallback"
              : documentsDenied
              ? "Blocked"
              : documentsConfirmed
              ? "Writable"
              : "Not checked";
            tone = loadingLocation || (!documentsDenied && !documentsConfirmed && !isHome)
              ? "neutral"
              : isHome || documentsDenied
              ? "warn"
              : "ok";
            hint = isHome
              ? capturesLocation?.canMoveToDocuments === true
                ? "Saving to your profile's PwrSnap folder because the Windows Documents folder was blocked. The fallback is empty and a write check now succeeds, so new captures can use Documents again."
                : homeItems > 0
                ? `Saving to your profile's PwrSnap folder because Documents was blocked. This choice stays sticky while ${homeItems} capture item(s) remain tied to the fallback folder.`
                : "Saving to your profile's PwrSnap folder because Documents was blocked. Check folder access before moving back; PwrSnap does not probe or relocate folders at startup."
              : documentsDenied
              ? `${capturesHealth?.deniedPathCount ?? 0} capture path(s) can't be accessed. Check Windows Security → Ransomware protection (Controlled Folder Access), antivirus rules, or OneDrive sync, then try again.`
              : documentsConfirmed
              ? "PwrSnap completed a write check for the Windows Documents folder. You can find captures in File Explorer; Check folder access runs the check again."
              : "PwrSnap has not run a write check for the Windows Documents folder in this session. Check folder access runs one now.";
            checkLabel = "Check folder access";
          } else {
            label = loadingLocation
              ? "Checking…"
              : isHome
              ? "Home fallback"
              : documentsDenied
              ? "Blocked"
              : documentsConfirmed
              ? "Writable"
              : "Not checked";
            tone = loadingLocation || (!documentsDenied && !documentsConfirmed && !isHome)
              ? "neutral"
              : isHome || documentsDenied
              ? "warn"
              : "ok";
            hint = isHome
              ? "PwrSnap is using the fallback captures folder. Check folder access before moving new captures back to Documents."
              : documentsDenied
              ? `${capturesHealth?.deniedPathCount ?? 0} capture path(s) can't be accessed. Check the folder permissions, then try again.`
              : documentsConfirmed
              ? "PwrSnap completed a write check for the captures folder."
              : "PwrSnap has not run a captures-folder write check in this session.";
            checkLabel = "Check folder access";
          }
          return (
            <Row
              label={`Captures Folder (${overridden ? "Custom" : isHome ? "Home" : "Documents"})`}
              sub={`${label} — ${hint}`}
              tag={overridden ? "custom" : isHome ? "home" : "documents"}
            >
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span
                  data-captures-access={
                    loadingLocation
                      ? "unknown"
                      : overridden
                      ? documentsDenied
                        ? "denied"
                        : documentsConfirmed
                        ? "ok"
                        : "unknown"
                      : isHome
                      ? "home"
                      : documentsDenied
                      ? "denied"
                      : documentsConfirmed
                      ? "ok"
                      : isDarwin
                      ? "ok"
                      : "unknown"
                  }
                  data-tone={tone}
                  style={{
                    font: "500 11px/1 var(--font-sans)",
                    color: statusColor(tone),
                    textTransform: "uppercase",
                    letterSpacing: "0.04em"
                  }}
                >
                  {label}
                </span>
                {documentsDenied && isDarwin && !overridden && (
                  <button
                    type="button"
                    onClick={() => void openCapturesSettings()}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--text)",
                      cursor: "pointer",
                      font: "500 12px/1 var(--font-sans)"
                    }}
                  >
                    Open System Settings
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void checkCapturesAccess()}
                  disabled={capturesBusy}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text)",
                    cursor: capturesBusy ? "wait" : "pointer",
                    font: "500 12px/1 var(--font-sans)"
                  }}
                >
                  {capturesBusy
                    ? "Checking…"
                    : checkLabel}
                </button>
                {!overridden && capturesLocation?.canMoveToDocuments === true && (
                  <button
                    type="button"
                    onClick={() => void moveCapturesToDocuments()}
                    disabled={capturesBusy}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--text)",
                      cursor: capturesBusy ? "wait" : "pointer",
                      font: "500 12px/1 var(--font-sans)"
                    }}
                  >
                    Use Documents for new captures
                  </button>
                )}
              </div>
            </Row>
          );
        })()}
      </Card>

      {isDarwin ? (
        <Card eyebrow="DIAGNOSTICS" title="Permission fingerprint">
          <Row
            label="Fingerprint"
            sub="Stable hash of (screen, microphone, system audio, recorder backend). PwrSnap uses this to remember which permission state it last routed you here from."
            tag="fingerprint"
          >
            <code
              style={{
                font: "500 11px/1 var(--font-mono)",
                color: "var(--text-secondary)",
                padding: "4px 8px",
                borderRadius: 4,
                background: "var(--surface)"
              }}
            >
              {readiness?.fingerprint ?? "—"}
            </code>
          </Row>
        </Card>
      ) : null}
    </>
  );
}
