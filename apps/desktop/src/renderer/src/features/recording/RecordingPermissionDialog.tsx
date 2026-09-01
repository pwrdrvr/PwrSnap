import { useEffect, useState, type ReactElement } from "react";
import type {
  RecordingPermission,
  RecordingPermissionGap,
  RecordingPermissionPrompt
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export function RecordingPermissionDialog({
  prompt
}: {
  prompt: RecordingPermissionPrompt;
}): ReactElement {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (
    action: "recheck" | "cancel" | "openSettings" | "continueWithout",
    permission?: RecordingPermission
  ): Promise<void> => {
    const key = `${action}:${permission ?? "all"}`;
    setPending(key);
    setError(null);
    const req =
      permission === undefined
        ? { requestId: prompt.requestId, action: action as "recheck" | "cancel" }
        : { requestId: prompt.requestId, action: action as "openSettings" | "continueWithout", permission };
    const result = await dispatch("recording:permissionAction", req);
    if (!result.ok) setError(result.error.message);
    setPending(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void act("cancel");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <section className="recording-permission" data-recording-phase="permission">
      <header className="recording-permission__header">
        <span className="recording-permission__eyebrow">Recording permission</span>
        <h1>Before this recording can start</h1>
        <p>Review only the capabilities requested for this take.</p>
      </header>

      <div className="recording-permission__list">
        {prompt.missing.map((gap) => (
          <PermissionRow
            key={gap.permission}
            gap={gap}
            prompt={prompt}
            pending={pending}
            onAction={act}
          />
        ))}
      </div>

      {error !== null && <p className="recording-permission__error">{error}</p>}

      <footer className="recording-permission__footer">
        <button
          type="button"
          className="recording-permission__button recording-permission__button--secondary"
          disabled={pending !== null}
          onClick={() => void act("cancel")}
        >
          Cancel
        </button>
        <button
          type="button"
          className="recording-permission__button recording-permission__button--primary"
          disabled={pending !== null}
          onClick={() => void act("recheck")}
        >
          Check again
        </button>
      </footer>
    </section>
  );
}

function PermissionRow({
  gap,
  prompt,
  pending,
  onAction
}: {
  gap: RecordingPermissionGap;
  prompt: RecordingPermissionPrompt;
  pending: string | null;
  onAction: (
    action: "recheck" | "cancel" | "openSettings" | "continueWithout",
    permission?: RecordingPermission
  ) => Promise<void>;
}): ReactElement {
  const optional = gap.permission !== "screen";
  const settingsAvailable =
    prompt.platform === "darwin" &&
    gap.status !== "restricted" &&
    gap.status !== "unavailable";
  const label = permissionLabel(gap.permission);

  return (
    <article className="recording-permission__row" data-permission={gap.permission}>
      <div>
        <h2>{label}</h2>
        <p>{permissionDetail(gap, prompt.platform)}</p>
      </div>
      <div className="recording-permission__actions">
        {settingsAvailable && (
          <button
            type="button"
            className="recording-permission__button recording-permission__button--primary"
            disabled={pending !== null}
            onClick={() => void onAction("openSettings", gap.permission)}
          >
            {gap.permission === "microphone" && gap.status === "not-determined"
              ? "Request microphone access"
              : "Open System Settings"}
          </button>
        )}
        {optional && (
          <button
            type="button"
            className="recording-permission__button recording-permission__button--secondary"
            disabled={pending !== null}
            onClick={() => void onAction("continueWithout", gap.permission)}
          >
            Continue without {label.toLowerCase()}
          </button>
        )}
      </div>
    </article>
  );
}

function permissionLabel(permission: RecordingPermission): string {
  if (permission === "screen") return "Screen Recording";
  if (permission === "systemAudio") return "System audio";
  return "Microphone";
}

function permissionDetail(
  gap: RecordingPermissionGap,
  platform: RecordingPermissionPrompt["platform"]
): string {
  if (gap.status === "restricted") {
    return "Access is managed by your device or organization. PwrSnap cannot change this policy.";
  }
  if (gap.status === "unavailable") {
    if (platform === "win32" && gap.permission !== "screen") {
      return "The current Windows recorder is video-only. You can continue this take without this audio source.";
    }
    return "This capability is not available on this system.";
  }
  if (gap.permission === "screen") {
    return "Screen access is required for every recording and cannot be skipped.";
  }
  return "This audio source is optional. Grant access or continue without it for this take.";
}
