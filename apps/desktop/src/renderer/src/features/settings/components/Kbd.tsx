import type { ReactElement, ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }): ReactElement {
  return <span className="ps-kbd">{children}</span>;
}
