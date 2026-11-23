import type { ReactElement } from "react";

type SwitchProps = {
  on: boolean;
  onChange?: ((next: boolean) => void) | undefined;
  /** Accessible name. The Row label beside a switch is not tied to it, so
   *  without this a screen reader announces an unnamed switch. */
  label?: string | undefined;
  descriptionId?: string | undefined;
  /** Shown but not operable: there is nothing it could turn on. */
  disabled?: boolean | undefined;
};

export function Switch({ on, onChange, label, descriptionId, disabled }: SwitchProps): ReactElement {
  const cls = "pss__switch" + (on ? " is-on" : "");
  if (onChange === undefined) {
    return <span className={cls} role="img" aria-label={on ? "On" : "Off"} />;
  }
  return (
    <button
      type="button"
      className={cls}
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-describedby={descriptionId}
      disabled={disabled === true}
      onClick={() => onChange(!on)}
    />
  );
}
