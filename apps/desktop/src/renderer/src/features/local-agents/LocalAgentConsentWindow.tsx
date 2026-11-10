import { WindowControls } from "../shared/WindowControls";
import { paintsOwnCaptionButtons, rendererPlatform } from "../../lib/window-chrome";
import { LocalAgentConsent } from "./LocalAgentConsent";

/**
 * The consent window has no title bar of its own: a centred column whose body
 * scrolls. This strip is its title bar on EVERY platform. macOS draws its
 * traffic lights and Windows its `titleBarOverlay` straight onto whatever is
 * under them, so without an opaque strip the heading scrolled up under the
 * stoplights. It is also the window's drag region.
 *
 * Only Linux gets caption buttons in it: a frameless Linux window has none
 * unless we paint them, and on the other two the OS already draws them.
 */
export function LocalAgentConsentWindow(): React.JSX.Element {
  return (
    <>
      <div className="ps-consent-chrome">
        {paintsOwnCaptionButtons(rendererPlatform()) ? <WindowControls /> : null}
      </div>
      <LocalAgentConsent />
    </>
  );
}
