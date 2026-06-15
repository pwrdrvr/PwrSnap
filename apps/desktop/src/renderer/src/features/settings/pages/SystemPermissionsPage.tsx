// Settings → Capture → System Permissions.
//
// One row per recording capability (Screen Recording, Microphone,
// System Audio). Each row shows the current status and offers the
// most useful next action:
//
//   • `not-determined` — the OS has never asked the user about this
//     capability for PwrSnap, so our bundle is not yet listed in
//     System Settings → Privacy. Send the user to a prompt path that
//     triggers the real TCC dialog and registers PwrSnap in the
//     pane: `permissions:request` for every capability.
//
//   • `denied` (or other recoverable state) — PwrSnap is already in
//     the list and the user needs to flip a checkbox. macOS will
//     not re-prompt, so route to System Settings via
//     `permissions:openSystemSettings`. Microphone is the one
//     exception that `askForMediaAccess` keeps prompting on without
//     a Settings round-trip.
//
// Refreshes the readiness snapshot on mount and after any action so
// the row updates without a window restart. The same readiness
// payload backs the recording-time permission dialog; both render
// the same human-readable status copy so a user who fixed mic from
// this page sees consistent language at recording time.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import type {
  CapturesAccessHealth,
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

const ROWS: readonly RowSpec[] = [
  { permission: "screen", title: "Screen Recording" },
  { permission: "microphone", title: "Microphone" },
  { permission: "systemAudio", title: "System Audio" }
];

function statusLabel(status: RecordingPermissionStatus): string {
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
function statusHint(
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

export function SystemPermissionsPage(): ReactElement {
  const [readiness, setReadiness] = useState<PermissionReadinessReport | null>(null);
  const [busyPermission, setBusyPermission] = useState<RecordingPermission | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  // Captures folder (Documents) TCC. macOS exposes NO non-prompting status
  // read for Files & Folders, so we reflect the observed-access health
  // signal (the same one the Library banner uses) and offer an active
  // "Check access" that probes (and can trigger the OS prompt).
  const [capturesHealth, setCapturesHealth] = useState<CapturesAccessHealth | null>(null);
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Read captures-access health once, then stay live off the same event
  // channel the Library banner uses (a capture that fails mid-session
  // flips this row to "Denied" without a re-open).
  useEffect(() => {
    void refreshCapturesHealth();
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.capturesAccessChanged,
      (payload) => setCapturesHealth(payload as CapturesAccessHealth)
    );
    return () => unsubscribe?.();
  }, [refreshCapturesHealth]);

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
      await refreshCapturesHealth();
    } finally {
      setCapturesBusy(false);
    }
  }, [refreshCapturesHealth]);

  const openCapturesSettings = useCallback(async (): Promise<void> => {
    const res = await dispatch("storage:openCapturesAccessSettings", {});
    if (!res.ok) setLastError(res.error.message);
  }, []);

  const requestAction = useCallback(
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

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Capture</div>
          <h1 className="pss__main-title">System Permissions</h1>
          <p className="pss__main-sub">
            PwrSnap needs access to record your screen and, optionally,
            audio. Each capability has its own macOS approval, and we never
            use any of them unless you explicitly start a capture. On a
            fresh install you'll see <strong>Not yet requested</strong> —
            click <strong>Request access</strong> (or just take your first
            snap) and macOS will show its own approval dialog.
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

      <Card eyebrow="STATUS" title="Recording capabilities">
        {ROWS.map((row) => {
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
            status !== "granted" && status !== "unavailable" && status !== "restricted";
          return (
            <Row
              key={row.permission}
              label={row.title}
              sub={`${statusLabel(status)} — ${statusHint(row.permission, status)}`}
              tag={row.permission}
            >
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span
                  data-permission-status={status}
                  data-tone={tone}
                  style={{
                    font: "500 11px/1 var(--font-sans)",
                    color:
                      tone === "ok"
                        ? "var(--success-text, #22c55e)"
                        : tone === "warn"
                        ? "var(--warning-text, #ff8a1f)"
                        : "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em"
                  }}
                >
                  {statusLabel(status)}
                </span>
                {showAction && (
                  <button
                    type="button"
                    onClick={() => void requestAction(row.permission, status)}
                    disabled={busyPermission === row.permission || readiness === null}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--text)",
                      cursor: busyPermission === row.permission ? "wait" : "pointer",
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

      <Card eyebrow="STORAGE" title="Captures folder">
        {(() => {
          // macOS has no non-prompting status read for the Documents
          // folder, so this reflects observed access: "Denied" once a real
          // read/write was blocked, "OK" otherwise, "Checking…" before the
          // first snapshot. "Check access" actively probes (and can trigger
          // the OS prompt). `denied` is the only authoritative state.
          const denied = capturesHealth?.denied === true;
          const isDarwin = window.pwrsnapApi?.platform === "darwin";
          const label =
            capturesHealth === null ? "Checking…" : denied ? "Denied" : "OK";
          const tone: "ok" | "warn" | "neutral" =
            capturesHealth === null ? "neutral" : denied ? "warn" : "ok";
          const hint = denied
            ? `${capturesHealth?.deniedPathCount ?? 0} capture file(s) can't be read. Grant PwrSnap access to your Documents folder under Privacy & Security → Files & Folders, then relaunch.`
            : "Captures are saved to ~/Documents/PwrSnap so you can find them in Finder. macOS gates the Documents folder — use Check access to verify (or grant) it.";
          return (
            <Row
              label="Captures Folder (Documents)"
              sub={`${label} — ${hint}`}
              tag="documents"
            >
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span
                  data-captures-access={denied ? "denied" : capturesHealth === null ? "unknown" : "ok"}
                  data-tone={tone}
                  style={{
                    font: "500 11px/1 var(--font-sans)",
                    color:
                      tone === "ok"
                        ? "var(--success-text, #22c55e)"
                        : tone === "warn"
                        ? "var(--warning-text, #ff8a1f)"
                        : "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em"
                  }}
                >
                  {label}
                </span>
                {denied && isDarwin && (
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
                  {capturesBusy ? "Checking…" : "Check access"}
                </button>
              </div>
            </Row>
          );
        })()}
      </Card>

      <Card eyebrow="DIAGNOSTICS" title="Permission fingerprint">
        <Row
          label="Fingerprint"
          sub="Stable hash of (screen, microphone, system audio, recorder backend, app version). PwrSnap uses this to remember which permission state it last routed you here from."
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
    </>
  );
}
