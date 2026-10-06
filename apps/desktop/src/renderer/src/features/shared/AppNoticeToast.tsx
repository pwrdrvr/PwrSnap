// Transient confirmation for a menu command that has no surface of its own
// (today: Help ▸ Copy Diagnostics Info). Main sends `appNotice` to the window
// the command came from; this lives in the Library's lower-left toast stack
// and clears itself. Nothing to act on, so no button and no countdown strip.

import { useEffect, useState, type ReactElement } from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { subscribe } from "../../lib/pwrsnap";

/** How long a notice stays up. Long enough to read a short sentence. */
export const APP_NOTICE_DURATION_MS = 2_500;

type Notice = { id: number; message: string };

export function AppNoticeToast(): ReactElement | null {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let nextId = 0;
    return subscribe(EVENT_CHANNELS.appNotice, (payload) => {
      const message = (payload as { message?: unknown } | null)?.message;
      if (typeof message !== "string" || message.length === 0) return;
      nextId += 1;
      setNotice({ id: nextId, message });
    });
  }, []);

  useEffect(() => {
    if (notice === null) return;
    // A repeat notice gets a fresh id, so its timer restarts.
    const timer = window.setTimeout(() => setNotice(null), APP_NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (notice === null) return null;
  return (
    <div key={notice.id} className="app-notice" role="status" aria-live="polite">
      {notice.message}
    </div>
  );
}
