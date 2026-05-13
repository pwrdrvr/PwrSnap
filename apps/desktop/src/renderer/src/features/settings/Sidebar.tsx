// Settings sidebar nav. Ported from design/src/Settings.jsx's
// `Sidebar` function (lines 80–103).
//
// Reads the category catalog from `settings-categories.ts` so the
// design / router / tests share a single source of truth. Clicking
// an item updates the URL hash; `useActivePage` listens for
// `hashchange` in `SettingsApp` and re-renders.

import { Fragment, type ReactElement } from "react";
import type { SettingsPage } from "@pwrsnap/shared";
import { SETTINGS_CATEGORIES } from "./settings-categories";
import { setActivePage } from "./useActivePage";

type SidebarProps = {
  active: SettingsPage;
};

export function Sidebar({ active }: SidebarProps): ReactElement {
  return (
    <aside className="pss__sidebar">
      {SETTINGS_CATEGORIES.map((cat) => (
        <Fragment key={cat.group}>
          <div className="pss__sb-section">{cat.group}</div>
          {cat.items.map((it) => (
            <button
              key={it.id}
              className={"pss__sb-nav" + (it.id === active ? " is-active" : "")}
              type="button"
              onClick={() => {
                setActivePage(it.id);
              }}
            >
              {it.name}
            </button>
          ))}
        </Fragment>
      ))}
    </aside>
  );
}
