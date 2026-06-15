// Transient "Moved to Trash · Undo" toast for capture soft-deletes.
//
// Shown after a confirmed delete as the immediate recovery affordance
// (alongside ⌘Z / Edit ▸ Undo, which the Library wires to the same restore
// via the edit-menu bridge's capture fallback). The toast OWNS its
// auto-dismiss countdown — a depleting top strip, same pattern as the
// post-capture float-over (`.fo__progress`) — and calls `onDismiss` when it
// runs out. The Library clears `lastDeleted` at that point, so the ⌘Z undo
// window is exactly "as long as this toast is on screen." Hovering pauses
// the countdown so reaching for the Undo button never races the timer.
//
// Remount per delete (Library keys it by the deleted id) gives each delete a
// fresh countdown without any reset plumbing here.

import { useEffect, useRef, useState, type ReactElement } from "react";
import "./UndoToast.css";

export type UndoToastProps = {
  readonly message: string;
  /** Auto-dismiss window in ms; also the countdown-strip duration. */
  readonly durationMs: number;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
};

export function UndoToast({
  message,
  durationMs,
  onUndo,
  onDismiss
}: UndoToastProps): ReactElement {
  const [progress, setProgress] = useState(1);
  const [hovering, setHovering] = useState(false);
  const startedAt = useRef<number>(Date.now());
  const elapsedAtPause = useRef(0);
  const rafRef = useRef<number | null>(null);
  // Stable ref so the countdown effect calls the latest onDismiss without
  // re-subscribing (a parent re-render makes a fresh callback identity).
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    // Pause while hovered: bank the elapsed time and stop the loop so the
    // user can reach the Undo button without the toast vanishing.
    if (hovering) {
      elapsedAtPause.current += Date.now() - startedAt.current;
      startedAt.current = Date.now();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = (): void => {
      const elapsed = elapsedAtPause.current + (Date.now() - startedAt.current);
      const p = Math.max(0, 1 - elapsed / durationMs);
      setProgress(p);
      if (p <= 0) {
        onDismissRef.current();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    startedAt.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [hovering, durationMs]);

  return (
    <div
      className={"ps-undo-toast" + (hovering ? " is-paused" : "")}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="ps-undo-toast__progress" aria-hidden="true">
        <div
          className="ps-undo-toast__progress-fill"
          style={{ transform: `scaleX(${progress})` }}
        />
      </div>
      <svg
        className="ps-undo-toast__icon"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
      </svg>
      <span className="ps-undo-toast__msg">{message}</span>
      <button type="button" className="ps-undo-toast__undo" onClick={onUndo}>
        Undo
      </button>
      <button
        type="button"
        className="ps-undo-toast__close"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
