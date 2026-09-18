// Settings window chrome. Matches the library's `.psl__topbar` so
// the two surfaces read as the same app — unframed brand mark
// + PwrSnapWordmark, then the breadcrumb. Real macOS traffic lights
// are drawn by Electron via `titleBarStyle: "hiddenInset"`; left
// padding on `.pss__titlebar` clears them.

import type { ReactElement } from "react";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { WindowControls } from "../shared/WindowControls";
import { paintsOwnCaptionButtons, rendererPlatform } from "../../lib/window-chrome";

type SettingsTitleBarProps = {
  here: string;
  /** Set on a child screen (AI Providers › Codex): the page it belongs to,
   *  rendered as a crumb that returns to that page's hub. */
  parent?: { label: string; onOpen: () => void };
};

export function SettingsTitleBar({ here, parent }: SettingsTitleBarProps): ReactElement {
  return (
    <header className="pss__titlebar">
      <div className="pss__title-brand">
        <span className="pss__title-mark">
          <PwrSnapMark size={18} />
        </span>
        <PwrSnapWordmark />
      </div>
      <span className="pss__title-crumb">
        Settings <span className="sep">›</span>{" "}
        {parent !== undefined ? (
          <>
            <button type="button" className="pss__title-crumb-link" onClick={parent.onOpen}>
              {parent.label}
            </button>{" "}
            <span className="sep">›</span>{" "}
          </>
        ) : null}
        <span className="here">{here}</span>
      </span>
      {/* Linux: a frameless window gets neither traffic lights nor a
          `titleBarOverlay` — nobody draws min/max/close but us. */}
      {paintsOwnCaptionButtons(rendererPlatform()) ? <WindowControls /> : null}
    </header>
  );
}
