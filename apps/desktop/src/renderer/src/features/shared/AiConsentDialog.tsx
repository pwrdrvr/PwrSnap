import { useLayoutEffect, useRef, type ReactElement } from "react";
import "./AiConsentDialog.css";

export type AiConsentDialogProps = {
  readonly onAccept: () => void;
  readonly onCancel: () => void;
};

export function AiConsentDialog({
  onAccept,
  onCancel
}: AiConsentDialogProps): ReactElement {
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // `aria-modal` describes the accessibility tree; it does not move or
  // hold focus. Without this, focus stayed on the control that opened the
  // dialog (the AI switch, or the Library's AI toggle), under the
  // backdrop, and Tab walked on through the page behind it with every
  // ring hidden. Same shape as ChatApprovalModal: start on the safe
  // choice, pull focus back if it escapes, and hand it back on close.
  useLayoutEffect(() => {
    const restoreTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const containFocus = (event: FocusEvent): void => {
      const dialog = dialogRef.current;
      if (dialog === null || dialog.contains(event.target as Node | null)) return;
      cancelRef.current?.focus();
    };
    document.addEventListener("focusin", containFocus, true);
    return () => {
      document.removeEventListener("focusin", containFocus, true);
      if (restoreTarget?.isConnected === true) restoreTarget.focus();
    };
  }, []);

  return (
    <div className="ps-ai-consent__backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="ps-ai-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ps-ai-consent-title"
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
