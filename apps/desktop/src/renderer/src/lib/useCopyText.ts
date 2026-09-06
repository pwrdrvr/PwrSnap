// One "copy text → show Copied → reset after a moment" for every renderer
// surface that can reach the command bus. The copy goes through
// `clipboard:copyText` — the main-process chokepoint for plain-text
// clipboard writes (see `library-handlers.ts`) — not `navigator.clipboard`,
// which would also work from a sandboxed renderer: the bus is the one place
// a redaction policy or audit hook plugs in, so every copy should land
// there. In experimental process-split mode the verb is library-owned (see
// `command-routing.ts`), so a float-over or tray adopter would forward the
// copy to the library process and could spawn it; keep the hook on
// library-owned surfaces until that verb is registered in both.
//
// The hook owns exactly one feedback timer. A repeat click re-arms it, so
// an older click cannot cut a newer "Copied" short, and unmount clears it,
// so nothing fires into a component that is gone. Feedback is keyed by the
// caller's `id` so a surface with several copy buttons (Settings > Local
// Agents prints one per connect command) flips only the one that was
// clicked. The bus Result comes back to the caller untouched: the hook
// decides what the button says, the caller decides whether a failure also
// belongs somewhere else (the Logs window routes it into its error line).

import { useCallback, useEffect, useRef, useState } from "react";
import type { PwrSnapError, Result } from "@pwrsnap/shared";
import { dispatch } from "./pwrsnap";

/** How long "Copied" / "Copy failed" stays on the button. */
export const COPY_TEXT_FEEDBACK_MS = 1_500;

export type CopyTextFeedback = { id: string; status: "copied" | "failed" };

export type UseCopyTextValue = {
  /** Which button to flip and what it should say, or null once reset. */
  feedback: CopyTextFeedback | null;
  /**
   * Put `text` on the clipboard and show feedback on the button keyed `id`.
   * Resolves to the bus Result so the caller can keep its own error handling.
   */
  copy: (id: string, text: string) => Promise<Result<void, PwrSnapError>>;
};

export function useCopyText(): UseCopyTextValue {
  const [feedback, setFeedback] = useState<CopyTextFeedback | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Monotonic per click, bumped again on cleanup. A copy that resolves after
  // a newer click started, or after the component went away, is dropped: it
  // must not overwrite the newer feedback or re-arm its timer. What shows is
  // the newest click's own outcome — not necessarily what the clipboard
  // holds, since an older copy can succeed where the newer one failed.
  const seq = useRef(0);

  useEffect(
    () => () => {
      seq.current += 1;
      clearTimeout(timer.current);
      // Fast Refresh re-runs effects with state intact, so the label would
      // otherwise outlive its timer. A silent no-op on a real unmount.
      setFeedback(null);
    },
    []
  );

  const copy = useCallback(
    async (id: string, text: string): Promise<Result<void, PwrSnapError>> => {
      const mine = ++seq.current;
      const result = await dispatch("clipboard:copyText", { text });
      if (mine !== seq.current) return result;
      const status = result.ok ? "copied" : "failed";
      // Keep the identity when nothing changed, so a repeat click on the same
      // button bails out of a re-render (the Logs window reconciles thousands
      // of lines on each one). The timer still re-arms below.
      setFeedback((current) =>
        current !== null && current.id === id && current.status === status
          ? current
          : { id, status }
      );
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setFeedback(null), COPY_TEXT_FEEDBACK_MS);
      return result;
    },
    []
  );

  return { feedback, copy };
}
