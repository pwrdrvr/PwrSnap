// Settings → Capture → System Permissions.
//
// One row per recording capability (Screen Recording, Microphone,
// System Audio). Each row shows the current status and offers the
// most useful next action — `Request` for the prompt-able mic path,
// `Open System Settings` everywhere else. Refreshes the readiness
// snapshot on mount and after any action so the row updates without
// a window restart.
//
// The same readiness payload backs the recording-time permission
// dialog; both render the same human-readable status copy so a user
// who fixed mic from this page sees consistent language at recording
// time.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import type {
  RecordingPermission,
  RecordingPermissionStatus,
  RecordingReadiness
} from "@pwrsnap/shared";
import { Card, Row } from "../components";
import { dispatch } from "../../../lib/pwrsnap";

type RowSpec = {
  permission: RecordingPermission;
  title: string;
  description: string;
};

const ROWS: readonly RowSpec[] = [
  {
    permission: "screen",
    title: "Screen Recording",
    description:
      "Required to capture any pixels from your display. Grant in System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch PwrSnap."
  },
  {
    permission: "microphone",
    title: "Microphone",
    description:
      "Optional. Lets video recordings include your microphone audio."
  },
  {
    permission: "systemAudio",
    title: "System Audio",
    description:
      "Optional. Lets video recordings capture sound played by other apps on your Mac. Requires macOS 13 or newer and shares the Screen Recording grant."
  }
];

function statusLabel(status: RecordingPermissionStatus): string {
  switch (status) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "not-determined":
      return "Not yet asked";
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
  if (status === "unavailable" || status === "restricted") return "neutral";
  return "warn";
}

export function SystemPermissionsPage(): ReactElement {
  const [readiness, setReadiness] = useState<RecordingReadiness | null>(null);
  const [busyPermission, setBusyPermission] = useState<RecordingPermission | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await dispatch("permissions:readiness", {});
    if (res.ok) {
      setReadiness(res.value);
      setLastError(null);
    } else {
      setLastError(res.error.message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestAction = useCallback(
    async (permission: RecordingPermission) => {
      setBusyPermission(permission);
      try {
        if (permission === "microphone") {
          const res = await dispatch("permissions:request", { permission });
          if (!res.ok) {
            setLastError(res.error.message);
            return;
          }
        } else {
          const res = await dispatch("permissions:openSystemSettings", { permission });
          if (!res.ok) {
            setLastError(res.error.message);
            return;
          }
        }
        await refresh();
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
            audio. Each capability has its own macOS approval. We will
            never use these capabilities unless you explicitly start a
            capture.
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
          const status: RecordingPermissionStatus =
            readiness === null
              ? "unknown"
              : row.permission === "screen"
              ? readiness.screenRecording
              : row.permission === "microphone"
              ? readiness.microphone
              : readiness.systemAudio;
          const tone = statusTone(status);
          const showAction =
            status !== "granted" && status !== "unavailable" && status !== "restricted";
          return (
            <Row
              key={row.permission}
              label={row.title}
              sub={`${statusLabel(status)} — ${row.description}`}
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
                    onClick={() => void requestAction(row.permission)}
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
                      : "Open System Settings"}
                  </button>
                )}
              </div>
            </Row>
          );
        })}
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
