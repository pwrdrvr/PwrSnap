import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from "react";
import type {
  RecordingPermission,
  RecordingPermissionAction,
  RecordingPermissionGap,
  RecordingPermissionPreflight
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

type Platform = "darwin" | "win32" | "linux";
type ElectronCSSProperties = CSSProperties & { WebkitAppRegion?: string };

const LABELS: Record<RecordingPermission, string> = {
  screen: "Screen Recording",
  microphone: "Microphone",
  systemAudio: "System Audio"
};

// Renderer-side sanity ceilings only. Main owns the authoritative window /
// display clamps; these bounds just keep a corrupt layout measurement from
// shipping an absurd value over the command bus.
const MAX_MEASURED_WIDTH = 1_200;
const MAX_MEASURED_HEIGHT = 1_600;

export function RecordingPermissionDialog({
  preflight
}: {
  preflight: RecordingPermissionPreflight;
}): ReactElement {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const platform = (window.pwrsnapApi?.platform ?? "linux") as Platform;

  const act = useCallback(
    async (action: RecordingPermissionAction): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusyAction(
        `${action.action}:${"permission" in action ? action.permission : "all"}`
      );
      setError(null);
      try {
        const result = await dispatch("recording:permissionAction", action);
        if (!result.ok) setError(result.error.message);
      } finally {
        busyRef.current = false;
        setBusyAction(null);
      }
    },
    []
  );

  // Match the tray + float-over natural-content sizing contract: measure an
  // OUTER inline-block wrapper, not the rounded / overflow-hidden card. The
  // wrapper has no fixed height, so longer managed-policy copy and inline
  // Result errors can grow the BrowserWindow instead of being clipped.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (element === null) return;

    let posted = "";
    const post = (): void => {
      const rect = element.getBoundingClientRect();
      const measuredWidth = Math.ceil(rect.width);
      const measuredHeight = Math.ceil(rect.height);
      if (
        !Number.isFinite(measuredWidth) ||
        !Number.isFinite(measuredHeight) ||
        measuredWidth <= 0 ||
        measuredHeight <= 0
      ) {
        return;
      }
      const width = Math.min(measuredWidth, MAX_MEASURED_WIDTH);
      const height = Math.min(measuredHeight, MAX_MEASURED_HEIGHT);
      const key = `${width}x${height}`;
      if (key === posted) return;
      posted = key;
      void dispatch("recording:resizePermissionController", {
        requestId: preflight.requestId,
        width,
        height
      });
    };

    post();
    const observer = new ResizeObserver(post);
    observer.observe(element);
    return () => observer.disconnect();
  }, [preflight.requestId]);

  // The OS Settings app temporarily takes focus. When the user returns,
  // re-read readiness automatically; Check again remains visible for cases
  // where the OS never moved focus (or a policy changed in the background).
  useEffect(() => {
    const onFocus = (): void => {
      void act({ requestId: preflight.requestId, action: "recheck" });
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void act({ requestId: preflight.requestId, action: "cancel" });
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [act, preflight.requestId]);

  const screenMissing = preflight.missing.some(
    (gap) => gap.permission === "screen"
  );
  const restrictedScreen = preflight.missing.some(
    (gap) => gap.permission === "screen" && gap.status === "restricted"
  );
  const hasRestrictedGap = preflight.missing.some(
    (gap) => gap.status === "restricted"
  );
  const hasOptionalGap = preflight.missing.some(
    (gap) => gap.permission !== "screen"
  );

  return (
    <div
      ref={contentRef}
      data-permission-dialog-measurer
      style={measurerStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="recording-permission-title"
        data-recording-phase="permission"
        data-recording-platform={platform}
        style={dialogStyle}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden="true" style={iconStyle}>!</span>
          <div>
            <div style={eyebrowStyle}>RECORDING SETUP</div>
            <h1 id="recording-permission-title" style={titleStyle}>
              {screenMissing
                ? "Screen access is required"
                : "Some requested audio is unavailable"}
            </h1>
          </div>
        </div>

        <p style={introStyle}>
          {restrictedScreen
            ? "A device or organization policy controls screen capture. PwrSnap can’t change that policy or start this recording without screen access."
            : screenMissing
            ? "PwrSnap can’t start a video until it can read the selected screen."
            : hasRestrictedGap
            ? "A device or organization policy controls at least one requested audio source. Continue without it or contact your administrator."
            : platform === "win32"
            ? "PwrSnap’s current Windows recorder produces video-only clips."
            : "You can fix access now or record this take without the missing audio."}
        </p>

        <div style={{ display: "grid", gap: 8 }}>
          {preflight.missing.map((gap) => (
            <PermissionRow
              key={gap.permission}
              gap={gap}
              platform={platform}
              busyAction={busyAction}
              onAction={act}
              requestId={preflight.requestId}
            />
          ))}
        </div>

        {hasOptionalGap && (
          <p data-permission-persistence-note style={noteStyle}>
            Continuing without audio changes only this recording. Your saved
            recording options stay unchanged.
          </p>
        )}

        {error !== null && (
          <div role="alert" data-permission-error style={errorStyle}>
            {error}
          </div>
        )}

        <div data-permission-dialog-actions style={footerStyle}>
          <button
            type="button"
            data-permission-action="recheck"
            disabled={busyAction !== null}
            onClick={() =>
              void act({ requestId: preflight.requestId, action: "recheck" })
            }
            style={secondaryButtonStyle}
          >
            {busyAction === "recheck:all" ? "Checking…" : "Check again"}
          </button>
          <button
            type="button"
            data-permission-action="cancel"
            disabled={busyAction !== null}
            onClick={() =>
              void act({ requestId: preflight.requestId, action: "cancel" })
            }
            style={cancelButtonStyle}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function PermissionRow({
  gap,
  platform,
  busyAction,
  onAction,
  requestId
}: {
  gap: RecordingPermissionGap;
  platform: Platform;
  busyAction: string | null;
  onAction: (action: RecordingPermissionAction) => Promise<void>;
  requestId: string;
}): ReactElement {
  const optional = gap.permission !== "screen";
  const canOpenSettings =
    platform === "darwin" &&
    gap.status !== "unavailable" &&
    gap.status !== "restricted";
  const actionKey = `openSettings:${gap.permission}`;

  return (
    <section
      data-permission-gap={gap.permission}
      data-permission-status={gap.status}
      style={rowStyle}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ font: "600 13px/1.2 'Geist', system-ui, sans-serif" }}>
            {LABELS[gap.permission]}
          </strong>
          <span style={badgeStyle}>{optional ? "OPTIONAL" : "REQUIRED"}</span>
        </div>
        <p style={detailStyle}>{permissionDetail(gap, platform)}</p>
      </div>
      <div style={{ display: "flex", gap: 7, flexShrink: 0 }}>
        {canOpenSettings && (
          <button
            type="button"
            data-permission-action="open-settings"
            data-permission={gap.permission}
            disabled={busyAction !== null}
            onClick={() =>
              void onAction({
                requestId,
                action: "openSettings",
                permission: gap.permission
              })
            }
            style={secondaryButtonStyle}
          >
            {busyAction === actionKey
              ? "Working…"
              : gap.permission === "microphone" &&
                gap.status === "not-determined"
              ? "Ask for access"
              : "Open System Settings"}
          </button>
        )}
        {optional && (
          <button
            type="button"
            data-permission-action="continue-without"
            data-permission={gap.permission}
            disabled={busyAction !== null}
            onClick={() =>
              void onAction({
                requestId,
                action: "continueWithout",
                permission: gap.permission
              })
            }
            style={primaryButtonStyle}
          >
            Continue without {gap.permission === "microphone" ? "mic" : "system audio"}
          </button>
        )}
      </div>
    </section>
  );
}

function permissionDetail(
  gap: RecordingPermissionGap,
  platform: Platform
): string {
  if (gap.status === "restricted") {
    if (gap.permission === "screen") {
      return "Screen Recording is managed by a device or organization policy. PwrSnap can’t change it; contact your administrator, then check again.";
    }
    if (gap.permission === "microphone") {
      return "Microphone access is managed by a device or organization policy. PwrSnap can’t change it; continue without your microphone or contact your administrator.";
    }
    return "System audio is managed by a device or organization policy. PwrSnap can’t change it; continue without app sound or contact your administrator.";
  }

  if (platform === "win32") {
    if (gap.permission === "screen") {
      return "PwrSnap could not access the screen. Check Windows privacy or organization policy, then return and check again.";
    }
    return gap.permission === "microphone"
      ? "The current Windows recorder is video-only, so microphone audio can’t be included in this take."
      : "The current Windows recorder is video-only, so sound from other apps can’t be included in this take.";
  }

  if (gap.permission === "screen") {
    return platform === "darwin"
      ? "Turn on Screen Recording for PwrSnap. If it is already on, quit and reopen PwrSnap, then check again."
      : "Screen capture is not available. Review your desktop privacy policy, then check again.";
  }
  if (gap.permission === "microphone") {
    if (gap.status === "not-determined") {
      return "Approve the macOS microphone prompt, or continue this take without your microphone.";
    }
    return "Turn on Microphone access for PwrSnap, or continue this take without your microphone.";
  }
  if (gap.status === "unavailable") {
    return "System audio requires macOS 13 or newer. You can still record a video-only take.";
  }
  return "System audio shares the Screen Recording grant. Fix access, or continue this take without app sound.";
}

const dialogStyle: ElectronCSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  maxHeight: "100vh",
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
  borderRadius: 14,
  border: "1px solid rgba(255, 138, 31, 0.42)",
  background: "rgba(0, 0, 0, 0.96)",
  boxShadow: "0 18px 64px rgba(0, 0, 0, 0.58)",
  color: "#f7f7f7",
  padding: "18px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  font: "500 13px/1.4 'Geist', system-ui, sans-serif",
  WebkitAppRegion: "drag",
  userSelect: "none"
};

const measurerStyle: CSSProperties = {
  display: "inline-block",
  width: "100%",
  verticalAlign: "top"
};

const iconStyle: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 28,
  height: 28,
  flex: "0 0 auto",
  borderRadius: 999,
  background: "#ff8a1f",
  color: "#000",
  font: "800 16px/1 'Geist Mono', monospace"
};

const eyebrowStyle: CSSProperties = {
  color: "#ff8a1f",
  font: "700 9px/1 'Geist Mono', monospace",
  letterSpacing: "0.12em"
};

const titleStyle: CSSProperties = {
  margin: "4px 0 0",
  font: "650 19px/1.15 'Geist', system-ui, sans-serif"
};

const introStyle: CSSProperties = {
  margin: 0,
  color: "rgba(255,255,255,0.68)",
  font: "450 12px/1.45 'Geist', system-ui, sans-serif"
};

const rowStyle: ElectronCSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 14,
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  background: "rgba(255,255,255,0.045)",
  padding: "11px 12px",
  WebkitAppRegion: "no-drag"
};

const badgeStyle: CSSProperties = {
  color: "#ffb16a",
  border: "1px solid rgba(255, 138, 31, 0.38)",
  borderRadius: 999,
  padding: "2px 5px",
  font: "700 8px/1 'Geist Mono', monospace",
  letterSpacing: "0.08em"
};

const detailStyle: CSSProperties = {
  maxWidth: 300,
  margin: "5px 0 0",
  color: "rgba(255,255,255,0.62)",
  font: "450 11px/1.35 'Geist', system-ui, sans-serif"
};

const buttonBase: ElectronCSSProperties = {
  borderRadius: 7,
  padding: "7px 10px",
  color: "#fff",
  cursor: "pointer",
  font: "600 11px/1 'Geist', system-ui, sans-serif",
  WebkitAppRegion: "no-drag"
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonBase,
  border: "1px solid rgba(255,255,255,0.22)",
  background: "rgba(255,255,255,0.06)"
};

const primaryButtonStyle: CSSProperties = {
  ...buttonBase,
  border: "1px solid #ff8a1f",
  background: "#ff8a1f",
  color: "#000"
};

const cancelButtonStyle: CSSProperties = {
  ...buttonBase,
  border: "1px solid rgba(255,255,255,0.22)",
  background: "transparent"
};

const noteStyle: CSSProperties = {
  margin: 0,
  color: "rgba(255,255,255,0.46)",
  font: "450 10px/1.3 'Geist', system-ui, sans-serif"
};

const errorStyle: CSSProperties = {
  border: "1px solid rgba(248, 113, 113, 0.4)",
  borderRadius: 7,
  background: "rgba(127, 29, 29, 0.32)",
  color: "#fecaca",
  padding: "7px 9px",
  font: "500 11px/1.3 'Geist', system-ui, sans-serif"
};

const footerStyle: ElectronCSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: "auto",
  position: "sticky",
  bottom: 0,
  paddingTop: 6,
  background: "rgba(0, 0, 0, 0.96)",
  WebkitAppRegion: "no-drag"
};
