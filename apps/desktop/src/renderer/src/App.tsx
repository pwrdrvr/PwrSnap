import { Editor } from "./features/editor/Editor";
import { AppDocumentWindow } from "./features/documents/AppDocumentWindow";
import { Library } from "./features/library/Library";
import { CartProvider } from "./features/library/CartContext";
import { FloatOverHost } from "./features/float-over/FloatOverHost";
import { RecordingController } from "./features/recording/RecordingController";
import { RegionSelector } from "./features/region/RegionSelector";
import { SettingsApp } from "./features/settings/SettingsApp";
import { SizzleApp } from "./features/sizzle/SizzleApp";
import { TrayMenu } from "./features/tray/TrayMenu";
import { AppUpdateBanner } from "./features/update/AppUpdateBanner";
import { RendererErrorBoundary } from "./RendererErrorBoundary";
import { useAppearanceSync } from "./lib/useAppearance";

type Stage =
  | "library"
  | "float-over"
  | "tray"
  | "region"
  | "edit"
  | "settings"
  | "sizzle"
  | "document"
  | "recording-controller";
type AppDocumentKind = "changelog" | "third-party-licenses";

function readStage(): Stage {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const v = params.get("stage");
  if (
    v === "tray" ||
    v === "float-over" ||
    v === "region" ||
    v === "edit" ||
    v === "settings" ||
    v === "sizzle" ||
    v === "document" ||
    v === "recording-controller"
  ) {
    return v;
  }
  return "library";
}

function readDocumentKind(): AppDocumentKind | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const kind = params.get("kind");
  if (kind === "changelog" || kind === "third-party-licenses") {
    return kind;
  }
  return null;
}

function readCaptureId(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  // Edit windows pass `captureId=<id>`. Float-over no longer uses the
  // hash for captureId — main drives it via `events:float-over:state`
  // IPC so the renderer stays mounted across captures.
  return params.get("captureId");
}

const STAGE = readStage();
const CAPTURE_ID = readCaptureId();
const DOCUMENT_KIND = readDocumentKind();
document.body.dataset.stage = STAGE;

// Distinct document.title per stage. Every PwrSnap window loads
// the same `index.html` whose `<title>` tag would otherwise stamp
// EVERY window as "PwrSnap" — including the ones that show up in
// the dock right-click menu's window list. Tray, float-over, and
// the region selector are hidden via `skipTaskbar: true` so their
// titles don't matter, but the library + edit windows are
// user-facing and need to read sensibly when the user is hunting
// for one in the dock list. setting document.title overrides the
// HTML one and propagates through Electron's BrowserWindow.title.
const TITLE_BY_STAGE: Record<Stage, string> = {
  library: "PwrSnap",
  tray: "PwrSnap Tray",
  "float-over": "PwrSnap Toast",
  region: "PwrSnap Capture",
  edit: "PwrSnap Editor",
  settings: "PwrSnap Settings",
  sizzle: "PwrSnap Sizzle Reels",
  "recording-controller": "PwrSnap Recording",
  document:
    DOCUMENT_KIND === "third-party-licenses"
      ? "PwrSnap Third-party Licenses"
      : "PwrSnap Changelog"
};
document.title = TITLE_BY_STAGE[STAGE] ?? "PwrSnap";

export function App() {
  // Wire the appearance / theme system once per BrowserWindow. The
  // hook keeps `<html data-theme>` in sync with the persisted
  // Settings.appearance.theme, listens for OS `prefers-color-scheme`
  // flips while theme === "system", and propagates cross-window
  // theme changes via the Settings broadcast. Return value is unused
  // at this level — the Appearance settings page reads from its own
  // `useSettings` snapshot to render the segmented control.
  useAppearanceSync();

  const app = (() => {
    if (STAGE === "tray") {
      return <TrayMenu activeMode="auto" />;
    }
    if (STAGE === "float-over") {
      return <FloatOverHost />;
    }
    if (STAGE === "region") {
      return <RegionSelector />;
    }
    if (STAGE === "settings") {
      return <SettingsApp />;
    }
    if (STAGE === "sizzle") {
      return <SizzleApp />;
    }
    if (STAGE === "recording-controller") {
      return <RecordingController />;
    }
    if (STAGE === "document") {
      return <AppDocumentWindow kind={DOCUMENT_KIND} />;
    }
    if (STAGE === "edit") {
      if (CAPTURE_ID === null) {
        return (
          <div style={{ padding: 24, color: "var(--danger-text)", font: "500 13px var(--font-sans)" }}>
            Editor opened without a captureId — close this window and try again.
          </div>
        );
      }
      return <Editor captureId={CAPTURE_ID} />;
    }
    return (
      <div className="app-shell">
        <AppUpdateBanner />
        <CartProvider>
          <Library />
        </CartProvider>
      </div>
    );
  })();

  return <RendererErrorBoundary stage={STAGE}>{app}</RendererErrorBoundary>;
}
