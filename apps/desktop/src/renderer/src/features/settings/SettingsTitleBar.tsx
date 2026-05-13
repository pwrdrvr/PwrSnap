// Settings window chrome. Matches the library's `.psl__topbar` so
// the two surfaces read as the same app — 22×22 framed brand mark
// + PwrSnapWordmark, then the breadcrumb. Real macOS traffic lights
// are drawn by Electron via `titleBarStyle: "hiddenInset"`; left
// padding on `.pss__titlebar` clears them.

import type { ReactElement } from "react";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";

type SettingsTitleBarProps = {
  here: string;
};

export function SettingsTitleBar({ here }: SettingsTitleBarProps): ReactElement {
  return (
    <header className="pss__titlebar">
      <div className="pss__title-brand">
        <span className="pss__title-mark">
          <PwrSnapMark size={18} />
        </span>
        <PwrSnapWordmark />
      </div>
      <span className="pss__title-crumb">
        Settings <span className="sep">›</span> <span className="here">{here}</span>
      </span>
    </header>
  );
}
