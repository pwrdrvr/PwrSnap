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
