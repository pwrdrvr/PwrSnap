import { Library } from "./features/library/Library";
import { FloatOver } from "./features/float-over/FloatOver";
import { FloatOverForCapture } from "./features/float-over/FloatOverForCapture";
import { RegionSelector } from "./features/region/RegionSelector";
import { TrayMenu } from "./features/tray/TrayMenu";
import { dispatch } from "./lib/pwrsnap";
import sampleSrc from "./assets/sample-1.png";

type Stage = "library" | "float-over" | "tray" | "region";

function readStage(): Stage {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const v = params.get("stage");
  if (v === "tray" || v === "float-over" || v === "region") return v;
  return "library";
}

function readCaptureId(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  return params.get("capture");
}

const STAGE = readStage();
const CAPTURE_ID = readCaptureId();
document.body.dataset.stage = STAGE;

export function App() {
  if (STAGE === "tray") {
    return <TrayMenu activeMode="region" />;
  }
  if (STAGE === "float-over") {
    if (CAPTURE_ID !== null) {
      return <FloatOverForCapture captureId={CAPTURE_ID} />;
    }
    // Fallback for the legacy "open with no capture" path. Once Phase
    // 1.5 fully lands, this branch is unreachable.
    return (
      <FloatOver
        src={sampleSrc}
        srcW={2880}
        srcH={1800}
        onDismiss={() => {
          void dispatch("float-over:dismiss", {});
        }}
      />
    );
  }
  if (STAGE === "region") {
    return <RegionSelector />;
  }
  return (
    <div className="app-shell">
      <Library />
    </div>
  );
}
