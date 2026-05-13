// Pill toggle. Mirrors design/src/Settings.jsx lines 153–156.
// When `onChange` is supplied, the switch renders as a real button
// (Enter / Space toggle for free); otherwise it's a read-only
// visual.

import type { ReactElement, ReactNode } from "react";

type SwitchProps = {
  on: boolean;
  onChange?: (next: boolean) => void;
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

type SwitchRowProps = {
  on: boolean;
  onChange?: (next: boolean) => void;
  children: ReactNode;
};

export function SwitchRow({ on, onChange, children }: SwitchRowProps): ReactElement {
  return (
    <span className="pss__switch-row">
      <Switch on={on} {...(onChange !== undefined ? { onChange } : {})} />
      <span>{children}</span>
    </span>
  );
}
