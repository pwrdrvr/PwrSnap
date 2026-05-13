// Settings window chrome — ported from design/src/Settings.jsx's
// `TitleBar` component (lines 58–75).
//
// Real macOS traffic lights are drawn by Electron via
// `titleBarStyle: "hiddenInset"` over this row; the `pss__lights`
// span is a visual placeholder retained from the design so the
// breadcrumb sits in the right horizontal slot. It's kept off in
// CSS via `visibility: hidden` to avoid stacking on top of the OS
// traffic lights.

import type { ReactElement } from "react";
import { PwrSnapMark } from "../shared/BrandMark";

type SettingsTitleBarProps = {
  here: string;
};

export function SettingsTitleBar({ here }: SettingsTitleBarProps): ReactElement {
  return (
    <header className="pss__titlebar">
      <span className="pss__lights" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="pss__title-brand">
        <PwrSnapMark size={14} />
        <span>
          Pwr<span className="a">Snap</span>
        </span>
      </span>
      <span className="pss__title-crumb">
        Settings <span className="sep">›</span> <span className="here">{here}</span>
      </span>
    </header>
  );
}
