// Transient "Moved to Trash · Undo" toast for capture soft-deletes.
//
// Shown after a confirmed delete as the immediate recovery affordance
// (alongside ⌘Z / Edit ▸ Undo, which the Library wires to the same restore
// via the edit-menu bridge's capture fallback). Auto-dismisses on a timer;
// the Library clears its `lastDeleted` state at the same moment so the ⌘Z
// path and the toast stay in lockstep. Presentational only — all state and
// the dismiss timer live in Library.

import { type ReactElement } from "react";
import "./UndoToast.css";

export type UndoToastProps = {
  readonly message: string;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
};

export function UndoToast({ message, onUndo, onDismiss }: UndoToastProps): ReactElement {
  return (
    <div className="ps-undo-toast" role="status" aria-live="polite">
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
