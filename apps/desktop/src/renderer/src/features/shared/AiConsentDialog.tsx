import type { ReactElement } from "react";
import "./AiConsentDialog.css";

export type AiConsentDialogProps = {
  readonly onAccept: () => void;
  readonly onCancel: () => void;
};

export function AiConsentDialog({
  onAccept,
  onCancel
}: AiConsentDialogProps): ReactElement {
  return (
    <div className="ps-ai-consent__backdrop" role="presentation">
      <section
        className="ps-ai-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ps-ai-consent-title"
      >
        <div className="ps-ai-consent__eyebrow">Codex enrichment</div>
        <h2 id="ps-ai-consent-title" className="ps-ai-consent__title">
          Let Codex read new snaps?
        </h2>
        <p className="ps-ai-consent__copy">
          PwrSnap will send a downsampled copy of each new screenshot or
          sampled video frames to your configured Codex provider to generate
          titles, descriptions, tags, and OCR text.
        </p>
        <p className="ps-ai-consent__copy">
          Existing captures are not sent automatically. You can turn this off
          from the Library status bar at any time.
        </p>
        <div className="ps-ai-consent__actions">
          <button
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
            Enable Codex
          </button>
        </div>
      </section>
    </div>
  );
}
