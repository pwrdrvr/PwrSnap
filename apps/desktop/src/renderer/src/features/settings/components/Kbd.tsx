// One key in a keyboard-shortcut readout (⌘, ⇧, P, etc.).
// Mirrors design/src/Settings.jsx line 141 — same `ps-kbd` class
// the tray + library already use, so styling is shared.

import type { ReactElement, ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }): ReactElement {
  return <span className="ps-kbd">{children}</span>;
}
