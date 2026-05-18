// Confirmation modal for Settings → Hotkeys → "Reset to defaults".
// Lists every binding that will change, with current → default deltas
// the user can review before committing. Cancel keeps everything as-is.
//
// Focus management: the Cancel button autoFocuses on mount, so Escape
// + Enter both have the safe default ("keep my settings, do nothing").
// Clicking the backdrop also cancels.

import { useEffect, useRef, type ReactElement } from "react";
import { Hk, HkUnset } from "./Hk";
import { acceleratorToDisplayKeys } from "../pages/hotkeys-display";

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
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function HotkeyResetModal({
  changes,
  onCancel,
  onConfirm
}: HotkeyResetModalProps): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const count = changes.length;
  const noun = count === 1 ? "hotkey" : "hotkeys";

  return (
    <div
      className="pss__modal-backdrop"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="pss__modal"
        role="dialog"
        aria-modal="true"
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
                  <HkSlot accel={change.current} />
                </span>
                <span className="pss__diff-arrow" aria-hidden="true">
                  →
                </span>
                <span className="pss__diff-chord">
                  <HkSlot accel={change.next} />
                </span>
              </li>
            ))}
          </ul>
        </div>

        <footer className="pss__modal-footer">
          <button
            ref={cancelRef}
            type="button"
            className="pss__top-btn is-muted"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pss__top-btn is-active"
            onClick={() => void onConfirm()}
          >
            Reset {count} {noun}
          </button>
        </footer>
      </div>
    </div>
  );
}

function HkSlot({ accel }: { accel: string }): ReactElement {
  if (accel === "") return <HkUnset />;
  return <Hk keys={acceleratorToDisplayKeys(accel)} />;
}
