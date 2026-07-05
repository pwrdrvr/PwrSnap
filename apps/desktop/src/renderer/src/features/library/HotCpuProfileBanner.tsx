// Floating notice for developer diagnostics when the hot renderer CPU
// monitor writes a profile. The text is intentionally copyable so bug
// reports can include the exact artifact paths without hunting logs.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  buildHotCpuProfileHandoffMessage,
  EVENT_CHANNELS,
  formatHotCpuProfileTriggerSummary,
  type HotCpuProfileCapturedEvent
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export function HotCpuProfileBanner(): ReactElement | null {
  const [event, setEvent] = useState<HotCpuProfileCapturedEvent | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    return window.pwrsnapApi?.on(EVENT_CHANNELS.hotCpuProfileCaptured, (payload) => {
      setCopied(false);
      setRevealError(null);
      setEvent(payload as HotCpuProfileCapturedEvent);
    });
  }, []);

  const key =
    event === null ? null : `${event.capturedAt}:${event.profileFilename}`;
  const handoff = useMemo(
    () => (event === null ? "" : buildHotCpuProfileHandoffMessage(event)),
    [event]
  );

  if (event === null || dismissedKey === key) return null;

  const heapCount = event.heapSnapshotArtifacts?.length ?? 0;
  const message = [
    `${formatHotCpuProfileTriggerSummary(event)} saved ${event.profileFilename}.`,
    heapCount > 0 ? ` ${heapCount} heap snapshots captured.` : "",
    " Copy this notice to hand off the profile path."
  ].join("");

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(handoff);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const reveal = async (): Promise<void> => {
    setRevealError(null);
    const result = await dispatch("diagnostics:revealHotCpuSession", {
      sessionDirectoryName: event.sessionDirectoryName
    });
    if (!result.ok) {
      setRevealError(result.error.message);
    }
  };

  return (
    <aside className="app-update-banner hot-cpu-profile-banner" role="status" aria-live="polite">
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">CPU profile captured</p>
        <p className="app-update-banner__message">{message}</p>
        <p className="app-update-banner__error">
          {revealError === null
            ? `Session: ${event.sessionDirectoryName}`
            : `Failed to reveal session: ${revealError}`}
        </p>
      </div>
      <div className="app-update-banner__actions">
        <button
          className="app-update-banner__restart"
          type="button"
          onClick={() => {
            void copy();
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          className="app-update-banner__restart"
          type="button"
          onClick={() => {
            void reveal();
          }}
        >
          Reveal
        </button>
        <button
          className="app-update-banner__dismiss"
          type="button"
          aria-label="Dismiss CPU profile notification"
          onClick={() => setDismissedKey(key)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
