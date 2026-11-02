import { useLayoutEffect, useRef, type ReactElement } from "react";
import { useModal } from "../../lib/useModal";
import "./AiConsentDialog.css";

export type AiConsentDialogProps = {
  readonly onAccept: () => void;
  readonly onCancel: () => void;
};

export function AiConsentDialog({
  onAccept,
  onCancel
}: AiConsentDialogProps): ReactElement {
  // Escape is Cancel, and focus starts there too: the first control, and the
  // answer that sends nothing. In the float-over the dialog sits inline in the
  // toast rather than over a scrim, and still traps — it says aria-modal, so a
  // screen reader already treats the toast's other controls as unreachable.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModal<HTMLElement>({ onClose: onCancel, initialFocusRef: cancelRef });

  // What the trap does not do: focus moved outside by something other than
  // Tab (a click on another control in the float-over toast, a programmatic
  // focus behind the scrim) is pulled straight back, so Enter or Space never
  // lands on a control the dialog covers. A modal opened on top keeps its
  // focus: pulling it back here would fight that modal's own containment.
  useLayoutEffect(() => {
    const containFocus = (event: FocusEvent): void => {
      const dialog = dialogRef.current;
      const target = event.target;
      if (dialog === null || !(target instanceof Element) || dialog.contains(target)) return;
      if (target.closest('[aria-modal="true"]') !== null) return;
      cancelRef.current?.focus();
    };
    document.addEventListener("focusin", containFocus, true);
    return () => document.removeEventListener("focusin", containFocus, true);
  }, [dialogRef]);

  return (
    <div className="ps-ai-consent__backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="ps-ai-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ps-ai-consent-title"
        tabIndex={-1}
      >
        <div className="ps-ai-consent__eyebrow">AI enrichment</div>
        <h2 id="ps-ai-consent-title" className="ps-ai-consent__title">
          Enable AI enrichment for new snaps?
        </h2>
        <p className="ps-ai-consent__copy">
          PwrSnap will send a downsampled copy of each new screenshot or
          sampled video frames to your configured AI provider to generate
          titles, descriptions, tags, and OCR text.
        </p>
        <p className="ps-ai-consent__copy">
          Existing captures are not sent automatically. You can turn this off
          from the Library status bar at any time.
        </p>
        <div className="ps-ai-consent__actions">
          <button
            ref={cancelRef}
            type="button"
            className="ps-ai-consent__btn"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ps-ai-consent__btn is-primary"
            onClick={onAccept}
          >
            Enable AI enrichment
          </button>
        </div>
      </section>
    </div>
  );
}
