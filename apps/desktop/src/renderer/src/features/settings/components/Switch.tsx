import type { ReactElement } from "react";

type SwitchProps = {
  on: boolean;
  disabled?: boolean;
  onChange?: ((next: boolean) => void) | undefined;
  /** Accessible name. The Row label beside a switch is not tied to it, so
   *  without this a screen reader announces an unnamed switch. */
  label?: string | undefined;
};

export function Switch({ on, onChange, label, disabled = false }: SwitchProps): ReactElement {
  const cls = "pss__switch" + (on ? " is-on" : "");
  if (onChange === undefined) {
    return <span className={cls} role="img" aria-label={on ? "On" : "Off"} />;
  }
  return (
    <button
      type="button"
      className={cls}
      role="switch"
      disabled={disabled}
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}
