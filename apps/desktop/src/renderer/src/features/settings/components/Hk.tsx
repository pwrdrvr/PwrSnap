// Keyboard-shortcut readout. Mirrors design/src/Settings.jsx lines
// 142–149. For Slice D the hotkey rows are read-only — the trailing
// `Edit` label from the design is dropped (the page footer explains
// why). The shape stays the same so a future editable mode is a
// drop-in.

import type { ReactElement } from "react";
import { Kbd } from "./Kbd";

type HkProps = {
  keys: string[];
};

export function Hk({ keys }: HkProps): ReactElement {
  return (
    <span className="pss__hk" aria-label={keys.join("+")}>
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </span>
  );
}

export function HkUnset(): ReactElement {
  return (
    <span className="pss__hk is-unset" aria-label="Not set">
      Not set
    </span>
  );
}
