import { Library } from "./features/library/Library";
import { FloatOver } from "./features/float-over/FloatOver";
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

const STAGE = readStage();
document.body.dataset.stage = STAGE;

export function App() {
  if (STAGE === "tray") {
    return <TrayMenu activeMode="region" />;
  }
  if (STAGE === "float-over") {
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
