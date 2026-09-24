// Confirmation modal for Settings → Hotkeys → "Reset to defaults".
// Lists every binding that will change, with current → default deltas
// the user can review before committing. Cancel keeps everything as-is.
//
// Focus management: focus starts on Cancel, so Escape + Enter both have the
// safe default ("keep my settings, do nothing"); Tab stays inside and focus
// goes back to "Reset to defaults" on close (`useModal`). Clicking the
// backdrop also cancels. None of it applies while the reset is being written.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useModal } from "../../../lib/useModal";
import { Hk, HkUnset } from "./Hk";
import {
  acceleratorToDisplayKeys,
  type ShortcutPlatform
} from "@pwrsnap/shared";

export type HotkeyChange = {
  /** Stable identifier — e.g. "quickCapture". */
  key: string;
  /** Human label rendered in the diff list — e.g. "Quick Capture". */
  label: string;
  /** Accelerator the user currently has. Empty string = unbound. */
  current: string;
  /** Accelerator the reset will write. Empty string = unbound. */
  next: string;
};

export type HotkeyResetModalProps = {
  changes: HotkeyChange[];
  platform: ShortcutPlatform;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function HotkeyResetModal({
  changes,
  platform,
  onCancel,
  onConfirm
}: HotkeyResetModalProps): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dialogRef = useModal({
    onClose: () => {
      if (!submitting) onCancel();
    },
    initialFocusRef: cancelRef
  });

  const confirm = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (confirmError) {
      if (mountedRef.current) {
        const detail =
          confirmError instanceof Error && confirmError.message.trim() !== ""
            ? `${confirmError.message} `
            : "";
        setError(`${detail}Your existing shortcuts are still active.`);
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const count = changes.length;
  const noun = count === 1 ? "hotkey" : "hotkeys";

  return (
    <div
      className="pss__modal-backdrop"
      onClick={() => {
        if (!submitting) onCancel();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="pss__modal"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-busy={submitting}
        aria-labelledby="pss-reset-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pss__modal-hdr">
          <div className="pss__modal-eyebrow">Confirm reset</div>
          <h2 id="pss-reset-title" className="pss__modal-title">
            Reset {count} {noun} to defaults?
          </h2>
          <p className="pss__modal-sub">
            The bindings below will be replaced. This change is immediate but you
            can rebind any chord from this page after.
          </p>
        </header>

        <div className="pss__modal-body">
          <ul className="pss__diff-list">
            {changes.map((change) => (
              <li className="pss__diff-row" key={change.key}>
                <span className="pss__diff-label">{change.label}</span>
                <span className="pss__diff-chord">
                  <HkSlot accel={change.current} platform={platform} />
                </span>
                <span className="pss__diff-arrow" aria-hidden="true">
                  →
                </span>
                <span className="pss__diff-chord">
                  <HkSlot accel={change.next} platform={platform} />
                </span>
              </li>
            ))}
          </ul>
          {error !== null ? (
            <p className="pss__modal-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="pss__modal-footer">
          <button
            ref={cancelRef}
            type="button"
            className="pss__top-btn is-muted"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pss__top-btn is-active"
            onClick={() => void confirm()}
            disabled={submitting}
          >
            {submitting ? "Resetting…" : `Reset ${count} ${noun}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function HkSlot({
  accel,
  platform
}: {
  accel: string;
  platform: ShortcutPlatform;
}): ReactElement {
  if (accel === "") return <HkUnset />;
  return <Hk keys={acceleratorToDisplayKeys(accel, platform)} />;
}
