import type { ReactElement } from "react";
import { Kbd } from "./Kbd";

type HkProps = {
  keys: string[];
  inactive?: boolean;
};

export function Hk({ keys, inactive = false }: HkProps): ReactElement {
  return (
    <span className={`pss__hk${inactive ? " is-inactive" : ""}`} aria-label={keys.join("+")}>
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
