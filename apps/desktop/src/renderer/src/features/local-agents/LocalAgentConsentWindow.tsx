import { WindowControls } from "../shared/WindowControls";
import { paintsOwnCaptionButtons, rendererPlatform } from "../../lib/window-chrome";
import { LocalAgentConsent } from "./LocalAgentConsent";

export function LocalAgentConsentWindow(): React.JSX.Element {
  return (
    <>
      {paintsOwnCaptionButtons(rendererPlatform()) ? (
        <div className="ps-consent-chrome">
          <WindowControls />
        </div>
      ) : null}
      <LocalAgentConsent />
    </>
  );
}
