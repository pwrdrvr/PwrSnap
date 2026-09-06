// One "copy text → show Copied → reset after a moment" for every renderer
// surface that can reach the command bus. The copy goes through
// `clipboard:copyText` — the main-process chokepoint for plain-text
// clipboard writes (see `library-handlers.ts`) — never through
// `navigator.clipboard`: renderers are sandboxed, and the bus is the one
// place a redaction policy or audit hook plugs in.
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

export type CopyTextStatus = "copied" | "failed";

export type CopyTextFeedback = { id: string; status: CopyTextStatus };

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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic per click. A copy that resolves after a newer one started must
  // not overwrite the newer feedback or re-arm its timer — the clipboard holds
  // the newer text, so the newer button is the one telling the truth.
  const seq = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const copy = useCallback(
    async (id: string, text: string): Promise<Result<void, PwrSnapError>> => {
      const mine = ++seq.current;
      const result = await dispatch("clipboard:copyText", { text });
      if (!mounted.current || mine !== seq.current) return result;
      setFeedback({ id, status: result.ok ? "copied" : "failed" });
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setFeedback(null);
      }, COPY_TEXT_FEEDBACK_MS);
      return result;
    },
    []
  );

  return { feedback, copy };
}
