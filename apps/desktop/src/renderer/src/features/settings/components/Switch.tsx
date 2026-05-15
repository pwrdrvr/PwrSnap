import type { ReactElement } from "react";

type SwitchProps = {
  on: boolean;
  onChange?: ((next: boolean) => void) | undefined;
};

export function Switch({ on, onChange }: SwitchProps): ReactElement {
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
      onClick={() => onChange(!on)}
    />
  );
}
